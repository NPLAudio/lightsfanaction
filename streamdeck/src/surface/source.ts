/**
 * What the display keys show. A source colors one point of the deck's canvas, where x and y run 0 to 1 across the
 * whole canvas (the keys as one screen) and `t` is seconds. The test patterns are used until the app's lighting
 * frames are streamed in.
 */

export type RGB = [number, number, number]

export interface Source {
  color(x: number, y: number, t: number, out: RGB): void
}

const frac = (v: number) => v - Math.floor(v)

function hsv(h: number, s: number, v: number, out: RGB) {
  h = frac(h) * 6
  const i = Math.floor(h)
  const f = h - i
  const p = v * (1 - s)
  const q = v * (1 - s * f)
  const t = v * (1 - s * (1 - f))
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]
  out[0] = r * 255
  out[1] = g * 255
  out[2] = b * 255
}

/** A rolling rainbow across the whole deck. */
const wave: Source = {
  color(x, y, t, out) {
    hsv(x * 1.2 + y * 0.25 - t * 0.2, 1, 1, out)
  },
}

/** A bright bar sweeping left to right over a dim gradient: shows seams, tearing and lag between keys at a glance. */
const sweep: Source = {
  color(x, y, t, out) {
    hsv(x * 0.6 + 0.55, 0.8, 0.28 + 0.12 * y, out)
    const bar = frac(t * 0.4) * 1.3 - 0.15
    const k = Math.exp(-(((x - bar) / 0.035) ** 2))
    out[0] += (255 - out[0]) * k
    out[1] += (255 - out[1]) * k
    out[2] += (255 - out[2]) * k
  },
}

export const PATTERNS: Record<string, Source> = { wave, sweep }
export const patternFor = (name: unknown): Source => PATTERNS[String(name)] ?? sweep
