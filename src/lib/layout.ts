import type { Device, Led } from './types'

const cache = new Map<string, Led[]>()

export function ledsFor(d: Device): Led[] {
  const key = `${d.layout}:${d.ledCount}:${d.cols ?? 0}`
  const hit = cache.get(key)
  if (hit) return hit
  const n = d.ledCount
  const out: Led[] = []
  for (let i = 0; i < n; i++) {
    if (d.layout === 'ring') {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2
      out.push({ i, n, x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) })
    } else if (d.layout === 'grid') {
      const cols = d.cols ?? Math.ceil(Math.sqrt(n))
      const rows = Math.ceil(n / cols)
      out.push({ i, n, x: cols > 1 ? (i % cols) / (cols - 1) : 0.5, y: rows > 1 ? Math.floor(i / cols) / (rows - 1) : 0.5 })
    } else {
      out.push({ i, n, x: n > 1 ? i / (n - 1) : 0.5, y: 0.5 })
    }
  }
  cache.set(key, out)
  return out
}
