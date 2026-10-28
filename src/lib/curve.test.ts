import { describe, expect, it } from 'vitest'
import {
  CURVE_PRESETS,
  PUMP_MIN_PCT,
  defaultCritical,
  evalCurve,
  initialRuntime,
  mixTemps,
  stepFan,
  type FanRuntime,
} from './curve'
import type { FanCalibration, FanConfig } from './types'

const cfg = (over: Partial<FanConfig> = {}): FanConfig => ({
  id: 'f',
  name: 'Fan',
  sensorId: 't',
  extraSensorIds: [],
  mix: 'max',
  mode: 'curve',
  curve: [{ t: 30, p: 20 }, { t: 60, p: 50 }, { t: 80, p: 100 }],
  manual: 50,
  minPct: 20,
  maxPct: 100,
  hysteresis: 3,
  smoothSec: 0,
  stepUp: 100,
  stepDown: 100,
  holdSec: 0,
  pump: false,
  ...over,
})

/** Runs the controller with a constant temperature for `seconds`, one tick per second. */
function run(c: FanConfig, temp: number | undefined, rt: FanRuntime, seconds: number, cal?: FanCalibration, t0 = 0) {
  let r = rt
  let last = { pct: Math.round(rt.pct), note: undefined as string | undefined }
  for (let i = 1; i <= seconds; i++) {
    const out = stepFan(c, cal, { temp, now: t0 + i, dt: 1, critical: 90 }, r)
    r = out.rt
    last = { pct: out.pct, note: out.note }
  }
  return { rt: r, ...last }
}

describe('evalCurve', () => {
  const pts = [{ t: 30, p: 20 }, { t: 60, p: 50 }, { t: 80, p: 100 }]
  it('clamps outside the points and interpolates inside', () => {
    expect(evalCurve(pts, 10)).toBe(20)
    expect(evalCurve(pts, 45)).toBe(35)
    expect(evalCurve(pts, 95)).toBe(100)
  })
  it('runs flat out with no points', () => {
    expect(evalCurve([], 40)).toBe(100)
  })
  it('presets are sorted and in range', () => {
    for (const p of Object.values(CURVE_PRESETS)) {
      expect(p.map((x) => x.t)).toEqual([...p.map((x) => x.t)].sort((a, b) => a - b))
      expect(p.every((x) => x.p >= 0 && x.p <= 100)).toBe(true)
    }
  })
})

describe('mixTemps', () => {
  it('takes the max or average and ignores bad readings', () => {
    expect(mixTemps([40, 70, NaN], 'max')).toBe(70)
    expect(mixTemps([40, 70], 'avg')).toBe(55)
    expect(mixTemps([], 'max')).toBeUndefined()
  })
})

describe('defaultCritical', () => {
  it('is lower for liquid and higher for hot spots', () => {
    expect(defaultCritical('NZXT Kraken · Liquid')).toBe(55)
    expect(defaultCritical('GPU Hot Spot')).toBe(100)
    expect(defaultCritical('CPU Package')).toBe(90)
  })
})

describe('fail-safes', () => {
  it('goes to 100% immediately with no temperature', () => {
    const out = stepFan(cfg(), undefined, { temp: undefined, now: 1, dt: 1, critical: 90 }, initialRuntime(40, 25, 0))
    expect(out.pct).toBe(100)
    expect(out.note).toMatch(/no temperature/)
  })
  it('goes to 100% immediately at the emergency temperature, ignoring slew limits and the quiet cap', () => {
    const c = cfg({ stepUp: 1, maxPct: 40 })
    const out = stepFan(c, undefined, { temp: 91, now: 1, dt: 1, critical: 90 }, initialRuntime(50, 30, 0))
    expect(out.pct).toBe(100)
    expect(out.note).toBe('emergency')
  })
  it('uses the raw reading for the emergency check even when the average is low', () => {
    const c = cfg({ smoothSec: 60 })
    const out = stepFan(c, undefined, { temp: 95, now: 1, dt: 1, critical: 90 }, initialRuntime(40, 25, 0))
    expect(out.pct).toBe(100)
  })
  it('full mode ignores everything', () => {
    expect(run(cfg({ mode: 'full' }), 30, initialRuntime(30, 20, 0), 1).pct).toBe(100)
  })
})

describe('curve following', () => {
  it('rises toward the curve value at the step-up rate', () => {
    const c = cfg({ stepUp: 10 })
    const r = run(c, 60, initialRuntime(60, 20, 0), 2)
    expect(r.pct).toBe(40) // 20 -> 30 -> 40 on the way to 50
  })
  it('falls no faster than the step-down rate', () => {
    const c = cfg({ stepDown: 5 })
    const r = run(c, 30, initialRuntime(60, 50, 0), 3)
    expect(r.pct).toBe(35)
  })
  it('holds after speeding up before it slows down', () => {
    const c = cfg({ holdSec: 10, stepUp: 100 })
    let r = run(c, 70, initialRuntime(70, 20, 0), 1) // jumps up at t=1
    const up = r.pct
    r = run(c, 30, r.rt, 5, undefined, 1) // cooler, but still inside the hold window
    expect(r.pct).toBe(up)
    expect(r.note).toBe('holding')
    r = run(c, 30, r.rt, 10, undefined, 6) // hold expired
    expect(r.pct).toBeLessThan(up)
  })
  it('ignores changes smaller than 2%', () => {
    const c = cfg()
    const r = run(c, 45.5, initialRuntime(45.5, 36, 0), 3) // curve says 35.8
    expect(r.pct).toBe(36)
  })
})

describe('hysteresis', () => {
  it('holds the speed until the temperature has fallen by more than the hysteresis', () => {
    const c = cfg({ hysteresis: 3, stepDown: 100 })
    let r = run(c, 60, initialRuntime(60, 50, 0), 2)
    expect(r.pct).toBe(50)
    r = run(c, 58, r.rt, 2, undefined, 2) // 2 degrees down: still inside the band
    expect(r.pct).toBe(50)
    r = run(c, 55, r.rt, 2, undefined, 4) // 5 degrees down: follows
    expect(r.pct).toBeLessThan(50)
  })
})

describe('smoothing', () => {
  it('damps a one-second spike', () => {
    const c = cfg({ smoothSec: 10 })
    let r = run(c, 40, initialRuntime(40, 30, 0), 5)
    const calm = r.pct
    r = run(c, 75, r.rt, 1, undefined, 5) // spike
    expect(r.pct).toBeLessThan(evalCurve(c.curve, 75))
    expect(r.pct).toBeGreaterThanOrEqual(calm)
  })
})

describe('quiet cap', () => {
  it('limits the speed while it is cool enough', () => {
    const r = run(cfg({ maxPct: 40 }), 70, initialRuntime(70, 40, 0), 3)
    expect(r.pct).toBe(40)
    expect(r.note).toBe('quiet cap')
  })
  it('is released within 10 degrees of the emergency temperature', () => {
    const r = run(cfg({ maxPct: 40 }), 82, initialRuntime(82, 40, 0), 3)
    expect(r.pct).toBe(100)
  })
})

describe('floors', () => {
  it('never goes below the minimum or the calibrated minimum run speed', () => {
    const cal: FanCalibration = { at: 0, tach: true, maxRpm: 2000, minRunPct: 35, stopPct: 25, startPct: 40, map: [] }
    expect(run(cfg({ minPct: 20 }), 20, initialRuntime(20, 50, 0), 5).pct).toBe(20)
    expect(run(cfg({ minPct: 20 }), 20, initialRuntime(20, 50, 0), 5, cal).pct).toBe(35)
  })
  it('a pump never stops and never drops below the pump minimum', () => {
    const c = cfg({ pump: true, minPct: 0, stepDown: 100 })
    const r = run(c, 20, initialRuntime(20, 100, 0), 5)
    expect(r.pct).toBe(PUMP_MIN_PCT)
    expect(run(c, 20, initialRuntime(20, 70, 0), 3).pct).toBeGreaterThanOrEqual(PUMP_MIN_PCT)
  })
  it('a stall boost raises the floor and disables stopping', () => {
    const c = cfg({ minPct: 0 })
    const low = cfg({ minPct: 0, curve: [{ t: 30, p: 0 }, { t: 60, p: 50 }] })
    const rt = { ...initialRuntime(20, 0, 0), boost: 10 }
    expect(run(low, 20, rt, 4).pct).toBeGreaterThanOrEqual(10)
    expect(run(c, 20, initialRuntime(20, 0, 0), 4).pct).toBe(20)
  })
})

describe('zero RPM', () => {
  const c = cfg({ minPct: 0, curve: [{ t: 30, p: 0 }, { t: 40, p: 30 }, { t: 60, p: 60 }], stepUp: 100, stepDown: 100 })
  const cal: FanCalibration = { at: 0, tach: true, maxRpm: 2000, minRunPct: 20, stopPct: 15, startPct: 30, map: [] }

  it('stays stopped until the target reaches the start duty (no chatter)', () => {
    let r = run(c, 30, initialRuntime(30, 0, 0), 2, cal)
    expect(r.pct).toBe(0)
    r = run(c, 36, r.rt, 2, cal, 2) // curve says 18: below start duty 30
    expect(r.pct).toBe(0)
  })
  it('kick-starts when it starts, then settles to the target', () => {
    let r = run(c, 45, initialRuntime(45, 0, 0), 1, cal)
    expect(r.note).toBe('kick-start')
    expect(r.pct).toBeGreaterThanOrEqual(30)
    r = run(c, 45, r.rt, 6, cal, 1)
    expect(r.note).not.toBe('kick-start')
    expect(r.pct).toBeGreaterThan(0)
  })
  it('keeps running between the stop and start thresholds, and stops only below the stop threshold', () => {
    // running at 40, curve target falls to 27 (>= stop duty 25): keeps running
    let r = run(c, 39, initialRuntime(39, 40, 0), 3, cal)
    expect(r.pct).toBeGreaterThanOrEqual(20)
    // curve target 6 (< stop duty) lets it stop
    r = run(c, 31, r.rt, 10, cal, 3)
    expect(r.pct).toBe(0)
  })
})

describe('manual mode', () => {
  it('holds the chosen speed, but not below the pump minimum for a pump', () => {
    expect(run(cfg({ mode: 'manual', manual: 55 }), 30, initialRuntime(30, 55, 0), 2).pct).toBe(55)
    expect(run(cfg({ mode: 'manual', manual: 10, pump: true }), 30, initialRuntime(30, 70, 0), 10).pct).toBe(PUMP_MIN_PCT)
  })
})
