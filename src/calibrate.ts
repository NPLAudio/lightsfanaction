import { calibrating, fanTemps } from './engine'
import { backend } from './lib/backend'
import { useStore } from './store'
import type { FanCalibration } from './lib/types'

/** Duty steps for the sweep down; fine steps near where fans usually stall. */
const SWEEP = [100, 80, 65, 50, 40, 35, 30, 25, 20, 15, 10, 5, 0]
/** Steps up when looking for the duty that restarts a stopped fan. */
const RESTART = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60]
const MARGIN = 5
/** Stop if the fan's temperature source climbs this far during the sweep. */
const MAX_RISE = 20
/** Only start when the source is at least this far below its emergency temperature. */
const START_HEADROOM = 35
/** Abort when the source gets this close to its emergency temperature. */
const ABORT_HEADROOM = 15

export interface CalProgress {
  phase: string
  pct: number
  rpm: number
  done: number
  total: number
  points: { pct: number; rpm: number }[]
}

export interface CalOutcome {
  cal?: FanCalibration
  message: string
}

export class CalibrationStopped extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Measures one fan: speed at 100%, the duty where it stalls on the way down, and the duty needed to
 * get it turning again. Skips pumps, refuses to start when the system is warm, aborts if the
 * temperature climbs, and always hands the fan back to the normal controller.
 */
export async function calibrateFan(
  fanId: string,
  onProgress: (p: CalProgress) => void,
  signal: AbortSignal,
): Promise<CalOutcome> {
  const fan = useStore.getState().fans.find((f) => f.id === fanId)
  if (!fan) throw new CalibrationStopped('That fan is not available.')
  if (fan.pump || /pump/i.test(fan.name)) {
    throw new CalibrationStopped('Pumps are not calibrated: stopping one can damage the CPU.')
  }
  if (calibrating.size > 0) throw new CalibrationStopped('Another calibration is already running.')

  // simulated hardware answers instantly, so it does not need real spin-up and spin-down time
  const fast = backend.simulated && !backend.hwOn
  const settleMin = fast ? 3 : 5
  const settleMax = fast ? 5 : 14

  const startInfo = fanTemps.get(fanId)
  if (startInfo?.temp === undefined) throw new CalibrationStopped('No temperature reading for this fan, so it is not safe to start.')
  if (startInfo.temp > startInfo.critical - START_HEADROOM) {
    throw new CalibrationStopped(`The system is too warm (${startInfo.temp.toFixed(0)}°C). Let it idle and try again.`)
  }
  const startTemp = startInfo.temp

  const points: { pct: number; rpm: number }[] = []
  let done = 0
  const total = SWEEP.length + RESTART.length + 1
  const report = (phase: string, pct: number, rpm: number) => onProgress({ phase, pct, rpm, done, total, points: [...points] })

  const checkSafe = () => {
    if (signal.aborted) throw new CalibrationStopped('Cancelled.')
    const info = fanTemps.get(fanId)
    if (info?.temp === undefined) throw new CalibrationStopped('Lost the temperature reading, so calibration stopped.')
    if (info.temp >= info.critical - ABORT_HEADROOM) {
      throw new CalibrationStopped(`It got hot (${info.temp.toFixed(0)}°C), so calibration stopped.`)
    }
    if (info.temp - startTemp > MAX_RISE) {
      throw new CalibrationStopped(`Temperature rose ${MAX_RISE}°C during the test, so calibration stopped.`)
    }
  }

  const rpmNow = () => useStore.getState().live[fanId]?.rpm ?? 0

  /** Holds `pct`, then waits until the reported speed stops changing (or the time is up). */
  const settle = async (pct: number, min = settleMin, max = settleMax): Promise<number> => {
    calibrating.set(fanId, pct)
    const started = Date.now()
    const samples: number[] = []
    let lastLive = useStore.getState().live[fanId]
    while (Date.now() - started < max * 1000) {
      await sleep(500)
      checkSafe()
      const live = useStore.getState().live[fanId]
      if (live === lastLive) continue // no new reading yet
      lastLive = live
      samples.push(live?.rpm ?? 0)
      report('settling', pct, live?.rpm ?? 0)
      if ((Date.now() - started) / 1000 < min || samples.length < 3) continue
      const recent = samples.slice(-3)
      const tol = Math.max(30, Math.max(...recent) * 0.03)
      if (Math.max(...recent) - Math.min(...recent) <= tol) break
    }
    const recent = samples.slice(-3)
    return recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : rpmNow()
  }

  try {
    report('starting', 100, 0)
    const maxRpm = await settle(100, settleMin, settleMax)
    done++
    points.push({ pct: 100, rpm: maxRpm })
    if (maxRpm <= 0) {
      return { message: 'This fan reports no speed even at 100%, so it cannot be measured. It needs a speed (tach) signal.' }
    }

    let stopPct = 0
    let lowestRunning = 100
    for (const pct of SWEEP.slice(1)) {
      const rpm = await settle(pct)
      done++
      points.push({ pct, rpm })
      report('sweeping down', pct, rpm)
      if (rpm > 0) {
        lowestRunning = pct
      } else {
        stopPct = pct
        break
      }
    }

    let startPct = 0
    if (stopPct > 0) {
      for (const pct of RESTART.filter((p) => p >= stopPct)) {
        const rpm = await settle(pct, 3, Math.min(settleMax, 8))
        done++
        report('finding the restart point', pct, rpm)
        if (rpm > 0) {
          startPct = pct
          break
        }
      }
      if (startPct === 0) startPct = 60
    }
    done = total

    const cal: FanCalibration = {
      at: Date.now(),
      tach: true,
      maxRpm,
      minRunPct: stopPct > 0 ? Math.min(60, lowestRunning + MARGIN) : 0,
      stopPct: stopPct > 0 ? stopPct : 0,
      startPct: stopPct > 0 ? Math.min(100, startPct + MARGIN) : 0,
      map: points.sort((a, b) => b.pct - a.pct),
    }
    const message =
      stopPct > 0
        ? `Spins up to ${maxRpm} RPM. It stalled at ${stopPct}% and restarted at about ${startPct}%. With a safety margin the floor is ${cal.minRunPct}% and the kick-start duty ${cal.startPct}%.`
        : `Spins up to ${maxRpm} RPM and keeps turning even at 0%, so it never stalls.`
    return { cal, message }
  } finally {
    calibrating.delete(fanId)
  }
}
