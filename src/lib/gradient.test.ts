import { describe, expect, it } from 'vitest'
import { EFFECTS, defaultParams, effectById, hsv } from './effects'
import { PRESETS, gradientCss, parse, sampleStops, serialize, stopsOf } from './gradient'
import type { Led } from './types'

const led = (x: number, y: number, extra: Partial<Led> = {}): Led => ({ i: 0, n: 1, x, y, ...extra })

describe('gradient text', () => {
  it('round-trips and sorts its stops', () => {
    const stops = parse('#0000ff@1,#ff0000@0')!
    expect(stops.map((s) => s.at)).toEqual([0, 1])
    expect(serialize(stops)).toBe('#ff0000@0,#0000ff@1')
  })

  it('refuses text that is not a gradient, and falls back', () => {
    expect(parse('')).toBeNull()
    expect(parse('#ff0000@0')).toBeNull()
    expect(parse('red@0,blue@1')).toBeNull()
    expect(stopsOf(undefined, '#000000@0,#ffffff@1')).toHaveLength(2)
    expect(stopsOf(42, '#000000@0,#ffffff@1')[1].rgb).toEqual([255, 255, 255])
  })

  it('has only usable presets', () => {
    for (const p of PRESETS) expect(parse(p.stops), p.name).not.toBeNull()
    expect(gradientCss(parse(PRESETS[0].stops)!)).toContain('linear-gradient(90deg')
  })
})

describe('sampling', () => {
  const stops = parse('#000000@0,#ff0000@0.5,#ffffff@1')!

  it('blends between stops and holds at the ends', () => {
    expect(sampleStops(stops, 0.25)).toEqual([127.5, 0, 0])
    expect(sampleStops(stops, -1)).toEqual([0, 0, 0])
    expect(sampleStops(stops, 2)).toEqual([255, 255, 255])
  })

  it('wraps the last stop back into the first when cyclic', () => {
    const loop = parse('#ff0000@0,#0000ff@0.5')!
    expect(sampleStops(loop, 0.75, true)).toEqual([127.5, 0, 127.5])
    expect(sampleStops(loop, 1.25, true)).toEqual(sampleStops(loop, 0.25, true))
  })
})

describe('themes with editable colors', () => {
  it('keep their original look by default', () => {
    // the rainbow's default stops are the pure hues, so it matches an HSV rainbow
    const p = defaultParams('rainbow')
    for (const x of [0, 0.2, 0.5, 0.9]) {
      const got = effectById('rainbow').render(led(x, 0.5), 0, p)
      const want = hsv(x * (p.width as number) / 100 + 0.5 * 0.3 * (p.width as number) / 100, 1, 1)
      got.forEach((v, n) => expect(v).toBeCloseTo(want[n], 0))
    }
  })

  it('use the colors the user picks', () => {
    const p = { ...defaultParams('fire'), colors: '#0000ff@0,#0000ff@1' }
    for (let i = 0; i < 20; i++) {
      const c = effectById('fire').render(led(i / 20, 0.5), i, p)
      expect(c).toEqual([0, 0, 255])
    }
  })

  it('still draw when an older saved setting has no gradient', () => {
    for (const fx of EFFECTS.filter((e) => e.params.some((q) => q.type === 'gradient'))) {
      const p = Object.fromEntries(Object.entries(defaultParams(fx.id)).filter(([k]) => k !== 'colors'))
      const c = fx.render(led(0.3, 0.5), 1, p)
      expect(c.every(Number.isFinite), fx.id).toBe(true)
    }
  })

  it('give every default a valid gradient', () => {
    for (const fx of EFFECTS) for (const q of fx.params) if (q.type === 'gradient') expect(parse(String(q.default)), `${fx.id}.${q.key}`).not.toBeNull()
  })
})

describe('matrix rain', () => {
  const fx = effectById('matrix')
  const p = defaultParams('matrix')

  /** y of the brightest spot in a column over a stretch of time */
  const headAt = (t: number) => {
    let best = 0
    let at = -1
    for (let r = 0; r < 100; r++) {
      const c = fx.render(led(0.5 / 16, r / 99), t, p)
      const v = c[0] + c[1] + c[2]
      if (v > best) {
        best = v
        at = r / 99
      }
    }
    return at
  }

  it('has heads that fall', () => {
    // a head moves down (or wraps back to the top); watch a short while and require net downward motion
    let down = 0
    let prev = headAt(0)
    for (let t = 0.05; t < 1; t += 0.05) {
      const now = headAt(t)
      if (now > prev) down++
      prev = now
    }
    expect(down).toBeGreaterThan(8)
  })

  it('leaves the space between trails dark', () => {
    let dark = 0
    for (let r = 0; r < 100; r++) {
      const c = fx.render(led(0.5 / 16, r / 99), 3, p)
      if (c[0] + c[1] + c[2] < 40) dark++
    }
    expect(dark).toBeGreaterThan(20)
  })

  it('runs along a strip, since a strip has no down', () => {
    const lit = Array.from({ length: 60 }, (_, i) => fx.render(led(i / 59, 0.5, { line: true, n: 60, i }), 2, p)).filter((c) => c[1] > 100)
    expect(lit.length).toBeGreaterThan(0)
    expect(lit.length).toBeLessThan(60)
  })
})
