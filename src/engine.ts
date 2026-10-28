import { backend } from './lib/backend'
import { IS_TAURI, invoke } from './lib/hybrid'
import { CRITICAL_TEMP, defaultCritical, initialRuntime, mixTemps, stepFan, type FanRuntime } from './lib/curve'
import { effectById } from './lib/effects'
import { ledsFor } from './lib/layout'
import type { FanLive, RGB } from './lib/types'
import { kindEnabled, useSettings } from './settings'
import { useStore } from './store'

/** Latest rendered frame per device; previews read this instead of re-rendering. */
export const frames = new Map<string, RGB[]>()

const FRAME_MS = 33
const FAN_MS = 1000

let trace = false

function renderFrames() {
  if (trace) void invoke('trace_ping')
  const { devices, assignments } = useStore.getState()
  const t = performance.now() / 1000
  for (const d of devices) {
    const a = assignments[d.id]
    if (!a) continue
    const fx = effectById(a.effectId)
    const k = a.brightness / 100
    const out = ledsFor(d).map((led): RGB => {
      const c = fx.render(led, t, a.params)
      return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]
    })
    frames.set(d.id, out)
    backend.syncEffect(d.id, a)
    backend.setLeds(d.id, out)
  }
}

const runtime = new Map<string, FanRuntime>()
let lastFan = performance.now()
let busy = false

/** Fans a calibration sweep is driving right now, with the duty it wants. The normal loop leaves them alone. */
export const calibrating = new Map<string, number>()
/** Short manual tests ("listen test"); cancelled when it gets hot or the time is up. */
const previews = new Map<string, { pct: number; until: number }>()
/** Latest control temperature and emergency limit per fan, for calibration to watch. */
export const fanTemps = new Map<string, { temp?: number; critical: number }>()

export function previewFan(id: string, pct: number | null, seconds = 20) {
  if (pct === null) previews.delete(id)
  else previews.set(id, { pct, until: performance.now() / 1000 + seconds })
}

interface Watch {
  seenRpm: boolean
  stalledFor: number
  kicked: boolean
  okFor: number
  mismatch: number
  /** what we told the hardware on earlier ticks */
  sent?: number
  sentAt: number
  prevSent?: number
}
const watches = new Map<string, Watch>()
const STALL_MIN_PCT = 25
const STALL_KICK_AFTER = 6
const STALL_BOOST_AFTER = 8
const MISMATCH_TOLERANCE = 10
const MISMATCH_TICKS = 8
/** Many fans and coolers have their own minimum duty (often 20 to 25%), so a low request being
 * lifted is the hardware's limit, not a fan ignoring us. Only requests at or above this are checked. */
const MISMATCH_MIN_COMMAND = 30
const REFRESH_SECONDS = 15

async function fanTick() {
  if (busy) return
  busy = true
  try {
    const nowMs = performance.now()
    const now = nowMs / 1000
    const dt = Math.max(0.05, (nowMs - lastFan) / 1000)
    lastFan = nowMs
    const hw = await backend.readState()
    const { fans, fanInfo, calibrations, setLive } = useStore.getState()
    const prefs = useSettings.getState()
    const kinds = new Map(fanInfo.map((i) => [i.id, i.kind]))
    const live: Record<string, FanLive> = {}

    for (const f of fans) {
      const kind = kinds.get(f.id)
      if (kind === undefined) continue // not reachable right now
      // pumps and GPU fans are left to their own firmware unless the settings include them
      if (!kindEnabled(kind, prefs)) {
        const w = watches.get(f.id)
        if (w?.sent !== undefined) backend.releaseFan(f.id)
        watches.delete(f.id)
        runtime.delete(f.id)
        continue
      }
      const reading = hw.fans.find((x) => x.id === f.id)
      const rpm = reading?.rpm ?? 0
      const w = watches.get(f.id) ?? { seenRpm: false, stalledFor: 0, kicked: false, okFor: 0, mismatch: 0, sentAt: 0 }
      watches.set(f.id, w)
      if (rpm > 0) w.seenRpm = true

      // sources: every selected sensor must be readable, otherwise treat it as lost (fail-safe)
      const ids = [f.sensorId, ...(f.extraSensorIds ?? [])].filter(Boolean)
      const sources = ids.map((id) => hw.sensors.find((x) => x.id === id))
      const temp = sources.some((x) => !x) ? undefined : mixTemps(sources.map((x) => x!.value), f.mix ?? 'max')
      const critical = f.criticalTemp ?? Math.min(...sources.map((x) => (x ? defaultCritical(x.name) : CRITICAL_TEMP)), CRITICAL_TEMP)
      fanTemps.set(f.id, { temp, critical })

      let pct: number
      let note: string | undefined
      const manualDrive = calibrating.get(f.id)
      const prev = previews.get(f.id)
      // calibration and listen tests deliberately sweep through speeds the hardware may refuse
      const testing = manualDrive !== undefined || (prev !== undefined && now < prev.until)
      if (manualDrive !== undefined) {
        pct = manualDrive
        note = 'calibrating'
        runtime.delete(f.id)
      } else if (prev && now < prev.until && !(temp !== undefined && temp >= critical - 10)) {
        pct = prev.pct
        note = 'listen test'
        runtime.delete(f.id)
      } else {
        if (prev) previews.delete(f.id)
        const cal = calibrations[f.id]
        const rt = runtime.get(f.id) ?? initialRuntime(temp, reading?.pct ?? 50, now)
        rt.boost = Math.min(rt.boost, 30)
        const out = stepFan(f, cal, { temp, now, dt, critical }, rt)
        runtime.set(f.id, out.rt)
        pct = out.pct
        note = out.note

        // a fan that should be turning but reports no speed: kick it, then raise its floor, then warn
        const expectTach = cal ? cal.tach : w.seenRpm
        if (expectTach && pct >= STALL_MIN_PCT && rpm === 0 && out.note !== 'kick-start') w.stalledFor += dt
        else w.stalledFor = 0
        if (w.stalledFor >= STALL_KICK_AFTER && !w.kicked) {
          out.rt.kickUntil = now + 3
          w.kicked = true
        } else if (w.stalledFor >= STALL_KICK_AFTER + STALL_BOOST_AFTER) {
          out.rt.boost = Math.min(30, out.rt.boost + 10)
          w.stalledFor = STALL_KICK_AFTER
        }
      }

      // write only on change (plus a periodic refresh), and remember what the hardware was told
      if (pct !== w.sent || now - w.sentAt > REFRESH_SECONDS) {
        w.prevSent = w.sent
        w.sent = pct
        w.sentAt = now
        backend.setFan(f.id, pct)
      }

      // verify: the hardware should report roughly what we last told it
      const reported = reading?.pct
      const applied = w.prevSent ?? w.sent
      const checkable = !testing && applied !== undefined && applied >= MISMATCH_MIN_COMMAND
      if (reported !== undefined && checkable && Math.abs(reported - applied) > MISMATCH_TOLERANCE) w.mismatch++
      else w.mismatch = 0

      let warning: FanLive['warning']
      if (w.stalledFor > 0 && w.kicked && (runtime.get(f.id)?.boost ?? 0) > 0) warning = 'stalled'
      if (w.mismatch >= MISMATCH_TICKS) warning = 'ignored'
      if (rpm > 0) {
        w.okFor += dt
        if (w.okFor > 10) w.kicked = false
      } else w.okFor = 0

      live[f.id] = { id: f.id, pct, rpm, reported, warning, note }
    }
    setLive(hw.sensors, live)
  } finally {
    busy = false
  }
}

let started = false
export function startEngine() {
  if (started) return
  started = true
  if (IS_TAURI) void invoke<boolean>('trace_enabled').then((on) => (trace = on)).catch(() => undefined)
  setInterval(renderFrames, FRAME_MS)
  setInterval(fanTick, FAN_MS)
  void fanTick()
}
