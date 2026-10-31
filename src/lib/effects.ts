import { audio, bandAt, beatEnv } from './audio'
import type { Effect, Led, ParamValue, RGB } from './types'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const frac = (v: number) => v - Math.floor(v)

export function hsv(h: number, s: number, v: number): RGB {
  h = frac(h) * 6
  const i = Math.floor(h)
  const f = h - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  const m: RGB[] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]]
  const c = m[i % 6]
  return [c[0] * 255, c[1] * 255, c[2] * 255]
}

export function hex(s: ParamValue): RGB {
  const v = String(s).replace('#', '')
  const n = parseInt(v.length === 3 ? v.replace(/./g, '$&$&') : v, 16) || 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const mix = (a: RGB, b: RGB, k: number): RGB => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
]
const scale = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k]

function hash(a: number, b = 0) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function noise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y)
  const xf = x - xi, yf = y - yi
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

const num = (p: Record<string, ParamValue>, k: string) => Number(p[k])
const angle = (l: Led) => frac(Math.atan2(l.y - 0.5, l.x - 0.5) / (Math.PI * 2) + 0.5)

const sensitivity = { key: 'sensitivity', label: 'Sensitivity', type: 'range', min: 30, max: 200, step: 5, default: 100 } as const
const speed = { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 100, step: 1, default: 40 } as const

export const EFFECTS: Effect[] = [
  {
    id: 'solid',
    name: 'Static',
    description: 'One steady color.',
    params: [{ key: 'color', label: 'Color', type: 'color', default: '#7c5cff' }],
    render: (_l, _t, p) => hex(p.color),
  },
  {
    id: 'off',
    name: 'Off',
    description: 'Lights out. The device stays connected and keeps its place for when you switch back.',
    params: [],
    render: () => [0, 0, 0],
  },
  {
    id: 'rainbow',
    name: 'Rainbow Wave',
    description: 'A rolling spectrum across the device.',
    params: [
      speed,
      { key: 'width', label: 'Width', type: 'range', min: 10, max: 300, step: 5, default: 100 },
    ],
    render: (l, t, p) => hsv((l.x + l.y * 0.3) * (num(p, 'width') / 100) - t * num(p, 'speed') * 0.01, 1, 1),
  },
  {
    id: 'spin',
    name: 'Spectrum Spin',
    description: 'Rainbow that rotates around the center. Best on fans.',
    params: [speed],
    render: (l, t, p) => hsv(angle(l) - t * num(p, 'speed') * 0.01, 1, 1),
  },
  {
    id: 'cycle',
    name: 'Color Cycle',
    description: 'Whole device slowly shifts hue.',
    params: [speed],
    render: (_l, t, p) => hsv(t * num(p, 'speed') * 0.005, 1, 1),
  },
  {
    id: 'breathing',
    name: 'Breathing',
    description: 'Gentle fade in and out.',
    params: [{ key: 'color', label: 'Color', type: 'color', default: '#00e0c6' }, speed],
    render: (_l, t, p) => {
      const k = (Math.sin(t * (0.5 + num(p, 'speed') * 0.04) - Math.PI / 2) + 1) / 2
      return scale(hex(p.color), k * k)
    },
  },
  {
    id: 'gradient',
    name: 'Gradient Flow',
    description: 'Two colors blending and drifting.',
    params: [
      { key: 'a', label: 'Color A', type: 'color', default: '#ff2d95' },
      { key: 'b', label: 'Color B', type: 'color', default: '#2d6bff' },
      speed,
    ],
    render: (l, t, p) =>
      mix(hex(p.a), hex(p.b), (Math.sin((l.x + l.y * 0.4) * Math.PI * 2 - t * num(p, 'speed') * 0.06) + 1) / 2),
  },
  {
    id: 'comet',
    name: 'Comet',
    description: 'A bright head with a fading tail sweeping back and forth.',
    params: [
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { key: 'bg', label: 'Background', type: 'color', default: '#10002b' },
      speed,
    ],
    render: (l, t, p) => {
      const ph = frac((t * num(p, 'speed')) / 100)
      const head = ph < 0.5 ? ph * 2 : 2 - ph * 2
      const d = (l.x - head) * (ph < 0.5 ? 1 : -1)
      const k = d > 0 ? Math.exp(-d * 40) : Math.exp(d * 4)
      return mix(hex(p.bg), hex(p.color), clamp01(k))
    },
  },
  {
    id: 'fire',
    name: 'Inferno',
    description: 'Flickering flames.',
    params: [speed],
    render: (l, t, p) => {
      const h = clamp01(noise(l.x * 4 + l.y * 2, t * num(p, 'speed') * 0.08) * 1.3 - 0.15)
      return h < 0.5 ? mix([20, 0, 0], [255, 40, 0], h * 2) : mix([255, 40, 0], [255, 210, 40], (h - 0.5) * 2)
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Soft greens, teals and violets.',
    params: [speed],
    render: (l, t, p) => {
      const n = noise(l.x * 2.5 + l.y, t * num(p, 'speed') * 0.02)
      return hsv(0.33 + n * 0.45, 0.85, 0.35 + n * 0.65)
    },
  },
  {
    id: 'sparkle',
    name: 'Starlight',
    description: 'Random twinkles over a dim backdrop.',
    params: [
      { key: 'color', label: 'Star', type: 'color', default: '#ffffff' },
      { key: 'bg', label: 'Backdrop', type: 'color', default: '#0b0b3b' },
      { key: 'rate', label: 'Rate', type: 'range', min: 1, max: 20, step: 1, default: 6 },
    ],
    render: (l, t, p) => {
      const rate = num(p, 'rate')
      const slot = Math.floor(t * rate)
      const life = frac(t * rate)
      const lit = hash(l.i, slot) > 0.85 ? 1 - life : 0
      return mix(hex(p.bg), hex(p.color), lit)
    },
  },

  // ---- sound reactive: they follow whatever the PC is playing -------------------------------------
  {
    id: 'pulse',
    name: 'Bass Pulse',
    description: 'Glows with the bass and flashes on every beat.',
    reactive: true,
    params: [
      { key: 'a', label: 'Color A', type: 'color', default: '#ff2d95' },
      { key: 'b', label: 'Color B', type: 'color', default: '#2d6bff' },
      sensitivity,
    ],
    render: (l, t, p) => {
      const g = num(p, 'sensitivity') / 100
      const k = clamp01(0.08 + audio.bass * g * 0.55 + beatEnv(t, 5) * 0.55 * g)
      // the mix drifts toward B in the mids, so the whole device shifts color with the melody
      const c = mix(hex(p.a), hex(p.b), clamp01(l.x * 0.5 + audio.mid * g * 0.8))
      return scale(c, k)
    },
  },
  {
    id: 'spectrum',
    name: 'Spectrum Analyzer',
    description: 'Each part lights with a frequency: bass in the middle, treble toward the edges.',
    reactive: true,
    params: [
      { key: 'hue', label: 'Starting hue', type: 'range', min: 0, max: 360, step: 5, default: 280 },
      { key: 'span', label: 'Hue range', type: 'range', min: 0, max: 360, step: 5, default: 200 },
      sensitivity,
    ],
    render: (l, _t, p) => {
      const g = num(p, 'sensitivity') / 100
      const u = Math.min(1, Math.abs(l.x - 0.5) * 2)
      const v = clamp01(bandAt(u) * g * 1.4)
      return hsv(num(p, 'hue') / 360 - u * (num(p, 'span') / 360), 1 - v * v * 0.25, 0.05 + 0.95 * v ** 1.1)
    },
  },
  {
    id: 'shockwave',
    name: 'Shockwave',
    description: 'Every beat sends a ring of light outward from the center.',
    reactive: true,
    params: [
      { key: 'hue', label: 'Starting hue', type: 'range', min: 0, max: 360, step: 5, default: 190 },
      { key: 'speed', label: 'Ring speed', type: 'range', min: 20, max: 200, step: 5, default: 90 },
      sensitivity,
    ],
    render: (l, t, p) => {
      const g = num(p, 'sensitivity') / 100
      // distance from the center, part straight across so rings (all equally far out) still get a sweep
      const d = Math.hypot(l.x - 0.5, l.y - 0.5) + Math.abs(l.x - 0.5)
      const reach = num(p, 'speed') / 100
      let k = 0
      let hue = 0
      audio.beats.forEach((b, i) => {
        const age = Math.max(0, t - b.t)
        const ring = Math.exp(-(((d - age * reach * 1.1) / 0.2) ** 2)) * b.s * Math.exp(-age * 0.8)
        if (ring > k) {
          k = ring
          hue = i * 0.11
        }
      })
      const glow = audio.level * g * 0.18
      return hsv(num(p, 'hue') / 360 + hue + audio.drift * 0.05, 0.85 - k * 0.3, clamp01(glow + k * g * 1.3))
    },
  },
  {
    id: 'vu',
    name: 'Level Meter',
    description: 'A classic volume meter that fills along the device, with a peak marker.',
    reactive: true,
    params: [{ key: 'bg', label: 'Unlit', type: 'color', default: '#0a0a14' }, sensitivity],
    render: (l, _t, p) => {
      const g = num(p, 'sensitivity') / 100
      const fill = clamp01(audio.level * g * 1.5)
      const pos = l.x
      const peak = clamp01(audio.peak * g * 1.5)
      if (Math.abs(pos - peak) < 0.045 && peak > 0.05) return [255, 255, 255]
      if (pos > fill) return hex(p.bg)
      // green through yellow to red along the meter
      return pos < 0.6 ? mix([0, 220, 60], [255, 220, 0], pos / 0.6) : mix([255, 220, 0], [255, 30, 0], (pos - 0.6) / 0.4)
    },
  },
  {
    id: 'energy',
    name: 'Energy Flow',
    description: 'A flowing rainbow that speeds up and brightens with the music and flashes on beats.',
    reactive: true,
    params: [
      { key: 'hue', label: 'Starting hue', type: 'range', min: 0, max: 360, step: 5, default: 300 },
      { key: 'span', label: 'Hue range', type: 'range', min: 20, max: 360, step: 5, default: 160 },
      sensitivity,
    ],
    render: (l, t, p) => {
      const g = num(p, 'sensitivity') / 100
      const flash = beatEnv(t, 7) * g
      const h = num(p, 'hue') / 360 + (l.x + l.y * 0.3) * (num(p, 'span') / 360) - audio.drift
      return hsv(h, 1 - flash * 0.35, clamp01(0.2 + audio.level * g * 1.1 + flash * 0.5))
    },
  },
  {
    id: 'sparkle-hi',
    name: 'Treble Sparkle',
    description: 'Glows with the bass, and sparkles with cymbals, hi-hats and vocals.',
    reactive: true,
    params: [
      { key: 'color', label: 'Sparkle', type: 'color', default: '#9be8ff' },
      { key: 'bg', label: 'Glow', type: 'color', default: '#3b0a8f' },
      sensitivity,
    ],
    render: (l, t, p) => {
      const g = num(p, 'sensitivity') / 100
      const slot = Math.floor(t * 20)
      const chance = clamp01(audio.treble * g * 0.7 + beatEnv(t, 8) * 0.25)
      const lit = hash(l.i, slot) > 1 - chance ? 1 - frac(t * 20) * 0.8 : 0
      const glow = scale(hex(p.bg), 0.1 + clamp01(audio.bass * g) * 0.9)
      return mix(glow, hex(p.color), lit)
    },
  },
]

export const effectById = (id: string) => EFFECTS.find((e) => e.id === id) ?? EFFECTS[0]

export function defaultParams(effectId: string): Record<string, ParamValue> {
  return Object.fromEntries(effectById(effectId).params.map((d) => [d.key, d.default]))
}

/** Choices that only make sense for a cooler screen, listed first there. */
const SCREEN_CHOICES: Effect[] = [
  {
    id: 'stats',
    name: 'Stats only',
    description: 'Just the temperatures on a plain dark background, with no lighting theme.',
    screenOnly: true,
    params: [],
    render: () => [52, 58, 84],
  },
  {
    id: 'match',
    name: 'Match cooler lighting',
    description: "Wears whichever effect the Kraken's lights are using, with the temperatures built into it.",
    screenOnly: true,
    params: [],
    render: () => [0, 0, 0],
  },
  {
    id: 'picture',
    name: 'Picture',
    description: 'Holds a picture of your own on the screen. It is stored in the cooler, so it stays through restarts.',
    screenOnly: true,
    params: [],
    render: () => [34, 38, 58],
  },
  {
    id: 'builtin',
    name: "Cooler's own screen",
    description: "Hands the screen back to the cooler's built-in display of the liquid temperature.",
    screenOnly: true,
    params: [],
    render: () => [34, 38, 58],
  },
]

EFFECTS.push(...SCREEN_CHOICES)

/** Effects a device of this kind can be given: the screen also gets its own choices, first; lights never do. */
export function effectsFor(kind: string): Effect[] {
  return kind === 'screen' ? [...SCREEN_CHOICES, ...EFFECTS.filter((e) => !e.screenOnly)] : EFFECTS.filter((e) => !e.screenOnly)
}
