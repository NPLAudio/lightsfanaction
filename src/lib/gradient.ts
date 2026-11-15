import type { ParamValue, RGB } from './types'

/**
 * A color gradient stored as plain text ("#ff0000@0,#0000ff@1": color, then where it sits from 0 to 1), so it can
 * be an effect setting like any other: saved, synced between devices and sent to the Stream Deck plugin as is.
 */

export interface Stop {
  /** position along the gradient, 0 to 1 */
  at: number
  rgb: RGB
}

export const MAX_STOPS = 8

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function hexToRgb(s: string): RGB {
  const v = s.replace('#', '')
  const n = parseInt(v.length === 3 ? v.replace(/./g, '$&$&') : v, 16) || 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

export function serialize(stops: Stop[]): string {
  return stops.map((s) => `${rgbToHex(s.rgb)}@${+s.at.toFixed(4)}`).join(',')
}

/** Stops from saved text, in order; null if it does not hold at least two usable stops. */
export function parse(text: string): Stop[] | null {
  const stops: Stop[] = []
  for (const part of text.split(',')) {
    const m = /^\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})@([0-9.]+)\s*$/.exec(part)
    if (!m) return null
    stops.push({ at: clamp01(Number(m[2])), rgb: hexToRgb(m[1]) })
  }
  if (stops.length < 2 || stops.length > MAX_STOPS * 2) return null
  return stops.sort((a, b) => a.at - b.at)
}

const good = new Map<string, Stop[]>()
const defaults = new Map<string, Stop[]>()
const PLAIN: Stop[] = [{ at: 0, rgb: [0, 0, 0] }, { at: 1, rgb: [255, 255, 255] }]

/** `value` if it is a good gradient, else `fallback` (older saved settings have none). Called for every LED of every frame. */
export function stopsOf(value: ParamValue | undefined, fallback: string): Stop[] {
  if (typeof value === 'string') {
    const hit = good.get(value)
    if (hit) return hit
    const stops = parse(value)
    if (stops) {
      if (good.size > 200) good.clear() // dragging a stop makes many one-off gradients
      good.set(value, stops)
      return stops
    }
  }
  let d = defaults.get(fallback)
  if (!d) {
    d = parse(fallback) ?? PLAIN
    defaults.set(fallback, d)
  }
  return d
}

/** The color at `u` along the stops. A cyclic gradient wraps: the last stop fades back into the first. */
export function sampleStops(stops: Stop[], u: number, cyclic = false): RGB {
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (cyclic) {
    u -= Math.floor(u)
    if (u < first.at || u > last.at) {
      const span = first.at + 1 - last.at
      const k = span <= 0 ? 0 : (u >= last.at ? u - last.at : u + 1 - last.at) / span
      return lerp(last.rgb, first.rgb, k)
    }
  } else {
    if (u <= first.at) return first.rgb
    if (u >= last.at) return last.rgb
  }
  for (let i = 1; i < stops.length; i++) {
    const b = stops[i]
    if (u <= b.at) {
      const a = stops[i - 1]
      return lerp(a.rgb, b.rgb, b.at === a.at ? 0 : (u - a.at) / (b.at - a.at))
    }
  }
  return last.rgb
}

export function sampleGradient(value: ParamValue | undefined, fallback: string, u: number, cyclic = false): RGB {
  return sampleStops(stopsOf(value, fallback), u, cyclic)
}

function lerp(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

/** A CSS background that shows the gradient left to right. */
export function gradientCss(stops: Stop[], cyclic = false): string {
  const at = (s: Stop) => `rgb(${Math.round(s.rgb[0])},${Math.round(s.rgb[1])},${Math.round(s.rgb[2])}) ${+(s.at * 100).toFixed(2)}%`
  const parts = stops.map(at)
  if (cyclic) {
    // show the seam the effect wraps across
    parts.push(`rgb(${Math.round(stops[0].rgb[0])},${Math.round(stops[0].rgb[1])},${Math.round(stops[0].rgb[2])}) 100%`)
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

/** Evenly spaced stops from a function over 0 to 1 (a cyclic ramp stops just short of 1, where it would repeat). */
export function ramp(count: number, f: (u: number) => RGB, cyclic = false): string {
  return serialize(Array.from({ length: count }, (_, i) => {
    const u = cyclic ? i / count : i / (count - 1)
    return { at: u, rgb: f(u) }
  }))
}

export const PRESETS: { name: string; stops: string }[] = [
  { name: 'Rainbow', stops: '#ff0000@0,#ffff00@0.1667,#00ff00@0.3333,#00ffff@0.5,#0000ff@0.6667,#ff00ff@0.8333' },
  { name: 'Ocean', stops: '#001a4d@0,#0066ff@0.35,#00d4ff@0.7,#b8fff4@1' },
  { name: 'Sunset', stops: '#2b0a4d@0,#c2185b@0.35,#ff6a00@0.7,#ffd166@1' },
  { name: 'Neon', stops: '#ff2d95@0,#7c5cff@0.5,#00e5ff@1' },
  { name: 'Matrix', stops: '#e8ffe8@0,#00ff41@0.12,#00b82e@0.45,#004d14@0.8,#000a02@1' },
  { name: 'Fire', stops: '#140000@0,#ff2800@0.5,#ffd228@1' },
  { name: 'Aurora', stops: '#35d98f@0,#2bd9c7@0.35,#5a7bf0@0.7,#b366ff@1' },
  { name: 'Ice', stops: '#0a1a33@0,#4aa8ff@0.5,#ffffff@1' },
  { name: 'Candy', stops: '#ff5fa2@0,#ffb3d9@0.33,#b388ff@0.66,#5ad1ff@1' },
  { name: 'Forest', stops: '#04210f@0,#1b7a3a@0.5,#b5e86b@1' },
]
