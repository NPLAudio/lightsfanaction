import { beforeEach, describe, expect, it } from 'vitest'
import { runCommand, snapshot } from '../control'
import { effectsFor } from './effects'
import { SCREEN_ID, screenTheme } from './screen'
import { useStore } from '../store'
import type { Assignment, Device } from './types'

const dev = (id: string, name: string, kind: Device['kind'] = 'strip'): Device => ({ id, name, kind, layout: 'strip', ledCount: 4 })
const as = (effectId: string, brightness = 100): Assignment => ({ effectId, params: { speed: 40 }, brightness })

const screen = dev(SCREEN_ID, 'Kraken display', 'screen')
const lights = dev('k', 'NZXT Kraken 2024 ELITE Series RGB')

describe('the cooler screen theme', () => {
  it('is stats only, a chosen effect, or the Kraken lights', () => {
    const devices = [lights, screen]
    expect(screenTheme(devices, { k: as('rainbow'), [SCREEN_ID]: as('stats') })).toBeNull()
    expect(screenTheme(devices, { k: as('rainbow'), [SCREEN_ID]: as('aurora', 60) })?.effectId).toBe('aurora')
    // "match" wears the lights' effect, at the screen's own brightness
    expect(screenTheme(devices, { k: as('fire', 100), [SCREEN_ID]: as('match', 40) })).toMatchObject({ effectId: 'fire', brightness: 40 })
  })

  it('falls back to stats when there is nothing to match or no screen', () => {
    expect(screenTheme([screen], { [SCREEN_ID]: as('match') })).toBeNull()
    expect(screenTheme([lights], { k: as('rainbow') })).toBeNull()
  })

  it('offers its own choices only to the screen', () => {
    expect(effectsFor('screen').slice(0, 2).map((e) => e.id)).toEqual(['stats', 'match'])
    expect(effectsFor('strip').some((e) => e.screenOnly)).toBe(false)
    expect(effectsFor('screen').some((e) => e.id === 'rainbow')).toBe(true)
  })
})

describe('screen-only choices never reach the lights', () => {
  beforeEach(() => {
    useStore.setState({
      ready: true,
      devices: [lights, dev('b', 'Keyboard', 'keyboard'), screen],
      assignments: { k: as('rainbow'), b: as('rainbow'), [SCREEN_ID]: as('stats') },
      syncAll: true,
      fanInfo: [],
      fans: [],
    })
  })

  it('setting stats-only with sync all on changes just the screen', () => {
    useStore.getState().setEffect(SCREEN_ID, 'match')
    expect(useStore.getState().assignments.k.effectId).toBe('rainbow')
    expect(useStore.getState().assignments.b.effectId).toBe('rainbow')
    expect(useStore.getState().assignments[SCREEN_ID].effectId).toBe('match')
  })

  it('a normal effect with sync all on does reach the screen too', () => {
    useStore.getState().setEffect('k', 'aurora')
    expect(useStore.getState().assignments[SCREEN_ID].effectId).toBe('aurora')
  })

  it('the remote control cannot set them or list them', () => {
    runCommand({ cmd: 'effect', device: 'all', effect: 'stats' })
    expect(useStore.getState().assignments.k.effectId).toBe('rainbow')
    expect(snapshot().effects.some((e) => e.id === 'stats' || e.id === 'match')).toBe(false)
  })
})
