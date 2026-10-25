import type { CurvePoint, FanConfig } from './types'

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

/** At or above this the fan runs flat out regardless of config. */
export const CRITICAL_TEMP = 90

export interface FanRuntime {
  anchor: number
  pct: number
}

/**
 * One control tick. Hysteresis holds the effective temperature until the real one
 * drops by `hysteresis` degrees, so the fan does not hunt around a curve point.
 */
export function stepFan(cfg: FanConfig, temp: number | undefined, rt: FanRuntime, dt: number): FanRuntime {
  let target: number
  let anchor = rt.anchor
  if (cfg.mode === 'full' || temp === undefined || !Number.isFinite(temp)) {
    target = 100 // no sensor reading: fail safe
  } else if (cfg.mode === 'manual') {
    target = cfg.manual
  } else if (temp >= CRITICAL_TEMP) {
    target = 100
    anchor = temp
  } else {
    if (temp >= anchor || anchor - temp > cfg.hysteresis) anchor = temp
    target = evalCurve(cfg.curve, anchor)
  }
  if (target > 0 && target < cfg.minPct) target = cfg.minPct
  if (cfg.mode === 'curve' && cfg.minPct === 0 && target < 5) target = 0
  const max = Math.max(1, cfg.ramp) * dt
  // speed up fast when hot; the ramp limit only slows the way down
  const pct = target >= rt.pct ? Math.min(target, rt.pct + max * 3) : Math.max(target, rt.pct - max)
  return { anchor, pct: Math.round(pct) }
}
