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

const speed = { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 100, step: 1, default: 40 } as const

export const EFFECTS: Effect[] = [
  {
    id: 'solid',
    name: 'Static',
    description: 'One steady colour.',
    params: [{ key: 'color', label: 'Colour', type: 'color', default: '#7c5cff' }],
    render: (_l, _t, p) => hex(p.color),
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
    description: 'Rainbow that rotates around the centre. Best on fans.',
    params: [speed],
    render: (l, t, p) => hsv(angle(l) - t * num(p, 'speed') * 0.01, 1, 1),
  },
  {
    id: 'cycle',
    name: 'Colour Cycle',
    description: 'Whole device slowly shifts hue.',
    params: [speed],
    render: (_l, t, p) => hsv(t * num(p, 'speed') * 0.005, 1, 1),
  },
  {
    id: 'breathing',
    name: 'Breathing',
    description: 'Gentle fade in and out.',
    params: [{ key: 'color', label: 'Colour', type: 'color', default: '#00e0c6' }, speed],
    render: (_l, t, p) => {
      const k = (Math.sin(t * (0.5 + num(p, 'speed') * 0.04) - Math.PI / 2) + 1) / 2
      return scale(hex(p.color), k * k)
    },
  },
  {
    id: 'gradient',
    name: 'Gradient Flow',
    description: 'Two colours blending and drifting.',
    params: [
      { key: 'a', label: 'Colour A', type: 'color', default: '#ff2d95' },
      { key: 'b', label: 'Colour B', type: 'color', default: '#2d6bff' },
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
      { key: 'color', label: 'Colour', type: 'color', default: '#ffffff' },
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
]

export const effectById = (id: string) => EFFECTS.find((e) => e.id === id) ?? EFFECTS[0]

export function defaultParams(effectId: string): Record<string, ParamValue> {
  return Object.fromEntries(effectById(effectId).params.map((d) => [d.key, d.default]))
}
