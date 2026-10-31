import { describe, expect, it } from 'vitest'
import { audio, beatEnv, setLevels, simulateAudio, tickAudio, type Levels } from './audio'
import { EFFECTS, defaultParams } from './effects'
import { ledsFor } from './layout'
import type { Device } from './types'

const levels = (over: Partial<Levels> = {}): Levels => ({
  bands: new Array(32).fill(0.5), bass: 0.5, mid: 0.5, treble: 0.5, level: 0.5, beats: 0, beat_strength: 0, ...over,
})

describe('audio state', () => {
  it('notes a beat only when the count changes, and fades the flash', () => {
    audio.beats.length = 0
    setLevels(levels({ beats: 5 }), 10) // first report is only a baseline
    expect(audio.beats).toHaveLength(0)
    setLevels(levels({ beats: 6, beat_strength: 0.8 }), 10.1)
    expect(audio.beats).toHaveLength(1)
    expect(beatEnv(10.1)).toBeCloseTo(0.8)
    expect(beatEnv(10.6)).toBeLessThan(0.1)
    // a clock reading before the beat never makes the flash larger than the beat
    expect(beatEnv(9)).toBeLessThanOrEqual(0.8)
  })

  it('reads as silence once levels stop arriving', () => {
    setLevels(levels(), 20)
    tickAudio(20.1, 0.1)
    expect(audio.level).toBe(0.5)
    tickAudio(21, 0.9)
    expect(audio.level).toBe(0)
    expect(audio.bands.every((v) => v === 0)).toBe(true)
  })
})

describe('sound-reactive effects', () => {
  const devices: Device[] = [
    { id: 's', name: 's', kind: 'strip', layout: 'strip', ledCount: 30 },
    { id: 'r', name: 'r', kind: 'fan', layout: 'ring', ledCount: 16 },
    { id: 'g', name: 'g', kind: 'keyboard', layout: 'grid', ledCount: 90, cols: 18 },
  ]

  it('always give valid colors, and are alive with music and dark without it', () => {
    for (const fx of EFFECTS.filter((e) => e.reactive)) {
      const p = defaultParams(fx.id)
      for (const d of devices) {
        let loudest = 0
        for (let t = 100; t < 104; t += 0.05) {
          simulateAudio(t)
          tickAudio(t, 0.05)
          for (const l of ledsFor(d)) {
            const c = fx.render(l, t, p)
            for (const v of c) {
              expect(Number.isFinite(v), `${fx.id} on ${d.layout}`).toBe(true)
              expect(v).toBeGreaterThanOrEqual(-0.5)
              expect(v).toBeLessThanOrEqual(255.5)
            }
            loudest = Math.max(loudest, ...c)
          }
        }
        expect(loudest, `${fx.id} on ${d.layout} stayed dark`).toBeGreaterThan(150)
      }
    }
  })

  it('go quiet when nothing is playing', () => {
    tickAudio(300, 1) // stale, so everything zeroes
    audio.beats.length = 0
    for (const id of ['pulse', 'spectrum', 'shockwave', 'sparkle-hi']) {
      const fx = EFFECTS.find((e) => e.id === id)!
      const c = fx.render({ i: 3, n: 30, x: 0.4, y: 0.5 }, 300, defaultParams(id))
      expect(Math.max(...c), `${id} should be dim`).toBeLessThan(90)
    }
  })
})

describe('off effect', () => {
  it('is black on every led and has nothing to adjust', () => {
    const off = EFFECTS.find((e) => e.id === 'off')!
    expect(off.params).toEqual([])
    for (const l of ledsFor({ id: 'x', name: 'x', kind: 'strip', layout: 'strip', ledCount: 10 })) {
      expect(off.render(l, 5, {})).toEqual([0, 0, 0])
    }
  })
})
