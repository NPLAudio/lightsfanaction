import { beforeEach, describe, expect, it } from 'vitest'
import { runCommand, snapshot } from './control'
import { useStore } from './store'
import type { Device, FanConfig, FanInfo } from './lib/types'

const dev = (id: string): Device => ({ id, name: id, kind: 'strip', layout: 'strip', ledCount: 4 })
const fan = (id: string, mode: FanConfig['mode'] = 'curve'): FanConfig =>
  ({ id, name: id, sensorId: 's', extraSensorIds: [], mix: 'max', mode, curve: [], manual: 50, minPct: 20, maxPct: 100, hysteresis: 3, smoothSec: 5, stepUp: 20, stepDown: 3, holdSec: 10, pump: false })
const info = (id: string, kind: FanInfo['kind'] = 'case'): FanInfo => ({ id, kind, name: id, maxRpm: 2000, sensorId: 's' })

beforeEach(() => {
  useStore.setState({
    ready: true,
    devices: [dev('a'), dev('b')],
    assignments: {
      a: { effectId: 'rainbow', params: {}, brightness: 80 },
      b: { effectId: 'solid', params: {}, brightness: 40 },
    },
    fanInfo: [info('f1'), info('f2'), info('pump', 'pump')],
    fans: [fan('f1'), fan('f2'), fan('pump')],
    rawFans: [{ id: 'pump', rpm: 2400, pct: 60 }],
    live: {},
  })
})

describe('remote commands', () => {
  it('changes the effect on every device, or one, keeping brightness', () => {
    runCommand({ cmd: 'effect', device: 'all', effect: 'breathing' })
    expect(useStore.getState().assignments.a).toMatchObject({ effectId: 'breathing', brightness: 80 })
    expect(useStore.getState().assignments.b).toMatchObject({ effectId: 'breathing', brightness: 40 })
    runCommand({ cmd: 'effect', device: 'b', effect: 'solid' })
    expect(useStore.getState().assignments.a.effectId).toBe('breathing')
    expect(useStore.getState().assignments.b.effectId).toBe('solid')
  })

  it('ignores unknown effects and devices', () => {
    runCommand({ cmd: 'effect', device: 'all', effect: 'does-not-exist' })
    runCommand({ cmd: 'effect', device: 'nope', effect: 'solid' })
    expect(useStore.getState().assignments.a.effectId).toBe('rainbow')
  })

  it('sets and nudges brightness within 0 to 100', () => {
    runCommand({ cmd: 'brightness', device: 'all', value: 250 })
    expect(useStore.getState().assignments.a.brightness).toBe(100)
    runCommand({ cmd: 'brightness', device: 'all', value: 30 })
    runCommand({ cmd: 'brightness', device: 'a', delta: -50 })
    expect(useStore.getState().assignments.a.brightness).toBe(0)
    expect(useStore.getState().assignments.b.brightness).toBe(30)
  })

  it('toggles full speed and restores the previous mode', () => {
    useStore.getState().patchFan('f1', { mode: 'manual' })
    runCommand({ cmd: 'fanMode', fan: 'f1', mode: 'toggle' })
    expect(useStore.getState().fans.find((f) => f.id === 'f1')?.mode).toBe('full')
    runCommand({ cmd: 'fanMode', fan: 'f1', mode: 'toggle' })
    expect(useStore.getState().fans.find((f) => f.id === 'f1')?.mode).toBe('manual')
  })

  it('never commands a fan that is left to its firmware, and refuses other modes', () => {
    runCommand({ cmd: 'fanMode', fan: 'pump', mode: 'full' })
    runCommand({ cmd: 'fanMode', fan: 'all', mode: 'manual' })
    runCommand({ cmd: 'fanMode', fan: 'all', mode: 'full' })
    const modes = Object.fromEntries(useStore.getState().fans.map((f) => [f.id, f.mode]))
    expect(modes).toEqual({ f1: 'full', f2: 'full', pump: 'curve' })
  })

  it('lists every fan in the snapshot, marking the ones it controls', () => {
    const s = snapshot()
    expect(s.fans.map((f) => [f.id, f.controlled])).toEqual([['f1', true], ['f2', true], ['pump', false]])
    expect(s.fans.find((f) => f.id === 'pump')?.rpm).toBe(2400)
  })
})
