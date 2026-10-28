import type { CurvePoint, FanCalibration, FanConfig, MixMode } from './types'

export const T_MIN = 20
export const T_MAX = 100

export function evalCurve(points: CurvePoint[], temp: number): number {
  if (points.length === 0) return 100
  if (temp <= points[0].t) return points[0].p
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    if (temp <= b.t) return b.t === a.t ? b.p : a.p + ((b.p - a.p) * (temp - a.t)) / (b.t - a.t)
  }
  return points[points.length - 1].p
}

export const CURVE_PRESETS: Record<string, CurvePoint[]> = {
  Silent: [{ t: 30, p: 20 }, { t: 50, p: 25 }, { t: 65, p: 40 }, { t: 80, p: 70 }, { t: 90, p: 100 }],
  Balanced: [{ t: 30, p: 25 }, { t: 45, p: 35 }, { t: 60, p: 55 }, { t: 75, p: 80 }, { t: 85, p: 100 }],
  Performance: [{ t: 30, p: 40 }, { t: 45, p: 55 }, { t: 60, p: 75 }, { t: 70, p: 100 }, { t: 100, p: 100 }],
}

/** Emergency temperature when nothing more specific is known. */
export const CRITICAL_TEMP = 90
/** A pump that slows too much cooks the CPU, so it never goes below this. */
export const PUMP_MIN_PCT = 60
/** The quiet cap is ignored this many degrees below the emergency temperature. */
const CAP_RELEASE = 10
/** Changes smaller than this are not worth rewriting the fan for. */
const MIN_CHANGE = 2
const DEFAULT_KICK_PCT = 40
const KICK_SECONDS = 2

/** Emergency temperature for a sensor, going by its name. */
export function defaultCritical(sensorName: string): number {
  if (/liquid|coolant|water/i.test(sensorName)) return 55
  if (/hot ?spot|junction/i.test(sensorName)) return 100
  return CRITICAL_TEMP
}

export function mixTemps(values: number[], mix: MixMode): number | undefined {
  const v = values.filter(Number.isFinite)
  if (!v.length) return undefined
  return mix === 'avg' ? v.reduce((a, b) => a + b, 0) / v.length : Math.max(...v)
}

export interface FanRuntime {
  /** temperature the curve is currently evaluated at (held by hysteresis) */
  anchor: number
  /** averaged temperature */
  smooth: number
  /** commanded duty, unrounded */
  pct: number
  /** time (s) of the last speed increase, for the hold time */
  lastUp: number
  /** until this time (s) the fan is held at its start duty */
  kickUntil: number
  /** extra floor added after a stall, 0..30 */
  boost: number
}

export function initialRuntime(temp: number | undefined, pct: number, _now?: number): FanRuntime {
  const t = temp !== undefined && Number.isFinite(temp) ? temp : NaN
  return { anchor: t, smooth: t, pct, lastUp: Number.NEGATIVE_INFINITY, kickUntil: 0, boost: 0 }
}

export interface StepInput {
  /** mixed raw temperature, or undefined when no source can be read */
  temp: number | undefined
  /** seconds, any monotonic clock */
  now: number
  /** seconds since the previous tick */
  dt: number
  /** emergency temperature for this fan's sources */
  critical: number
}

export interface StepResult {
  rt: FanRuntime
  /** integer duty to send */
  pct: number
  /** set when the output is not simply what the curve says */
  note?: string
}

/**
 * One control tick, pure so it can be tested. Order of operations:
 * fail-safes, temperature smoothing, curve with hysteresis, quiet cap, floors and zero-RPM
 * start/stop thresholds, kick-start, then speed limits (up fast, down slow with a hold time).
 */
export function stepFan(cfg: FanConfig, cal: FanCalibration | undefined, inp: StepInput, rt: FanRuntime): StepResult {
  const { temp, now, dt, critical } = inp
  const next: FanRuntime = { ...rt }
  const immediate = (pct: number, note?: string): StepResult => {
    next.pct = pct
    if (pct > rt.pct) next.lastUp = now
    return { rt: next, pct: Math.round(pct), note }
  }

  if (cfg.mode === 'full') return immediate(100)
  if (temp === undefined || !Number.isFinite(temp)) return immediate(100, 'no temperature reading')

  const alpha = cfg.smoothSec > 0 ? 1 - Math.exp(-Math.max(dt, 0) / cfg.smoothSec) : 1
  next.smooth = Number.isFinite(rt.smooth) ? rt.smooth + (temp - rt.smooth) * alpha : temp
  const hot = Math.max(temp, next.smooth)
  if (hot >= critical) {
    next.anchor = temp
    return immediate(100, 'emergency')
  }

  const running = rt.pct > 0
  const floor = Math.min(100, Math.max(cfg.minPct, cal?.minRunPct ?? 0, cfg.pump ? PUMP_MIN_PCT : 0) + rt.boost)
  const allowStop = !cfg.pump && cfg.minPct === 0 && rt.boost === 0
  const startAt = Math.max(cal?.startPct ?? 20, 1)
  const stopAt = Math.max(startAt - 5, 1)
  let note: string | undefined

  let target: number
  if (cfg.mode === 'manual') {
    target = cfg.manual
  } else {
    const t = next.smooth
    if (!Number.isFinite(rt.anchor) || t >= rt.anchor || rt.anchor - t > cfg.hysteresis) next.anchor = t
    else next.anchor = rt.anchor
    target = evalCurve(cfg.curve, next.anchor)
    if (target > cfg.maxPct && hot < critical - CAP_RELEASE) {
      target = cfg.maxPct
      note = 'quiet cap'
    }
  }

  // floors, and the stop/start thresholds that keep a zero-RPM fan from chattering
  if (cfg.mode === 'manual' ? cfg.manual === 0 && !cfg.pump : allowStop) {
    if (cfg.mode === 'manual') target = 0
    else if (running) target = target < stopAt ? 0 : Math.max(target, floor)
    else target = target >= startAt ? Math.max(target, floor) : 0
  } else {
    target = Math.max(target, floor)
  }
  target = Math.min(target, 100)

  // starting from a stop: hold a higher duty briefly so the fan reliably spins up
  if (!running && target > 0 && rt.kickUntil <= now) {
    next.kickUntil = now + KICK_SECONDS
  }
  if (target > 0 && now < next.kickUntil) {
    const kick = Math.max(target, cal?.startPct ?? DEFAULT_KICK_PCT)
    next.pct = kick
    next.lastUp = now
    return { rt: next, pct: Math.round(kick), note: 'kick-start' }
  }

  let out = rt.pct
  if (target > 0 && target < 100 && Math.abs(target - rt.pct) < MIN_CHANGE) {
    out = rt.pct // too small a change to bother the fan with
  } else if (target > rt.pct) {
    out = Math.min(target, rt.pct + cfg.stepUp * dt)
    next.lastUp = now
  } else if (target < rt.pct) {
    if (now - rt.lastUp < cfg.holdSec) {
      note ??= 'holding'
    } else {
      out = Math.max(target, rt.pct - cfg.stepDown * dt)
    }
  }
  next.pct = out
  return { rt: next, pct: Math.round(out), note }
}
