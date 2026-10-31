/** Key images are drawn as SVG, so they stay sharp on every key size and on the touch strip. */

export type Tone = 'ok' | 'warn' | 'hot' | 'idle' | 'off'

export interface Tile {
  label: string
  value: string
  sub?: string
  tone?: Tone
  /** small tag in the top right corner, e.g. FULL */
  badge?: string
  /** highlights the key, e.g. the lighting effect that is active */
  active?: boolean
}

const TONES: Record<Tone, string> = {
  ok: '#22c55e',
  warn: '#f59e0b',
  hot: '#ef4444',
  idle: '#7c5cff',
  off: '#52525b',
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Shortens a name to roughly fit the key. */
export function fit(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

function valueSize(v: string): number {
  if (v.length <= 3) return 48
  if (v.length <= 5) return 38
  if (v.length <= 7) return 30
  return v.length <= 9 ? 24 : 19
}

export function tileSvg(t: Tile): string {
  const tone = TONES[t.tone ?? 'idle']
  const ring = t.active ? `<rect x="3" y="3" width="138" height="138" rx="16" fill="none" stroke="#fafafa" stroke-width="4"/>` : ''
  const badge = t.badge
    ? `<rect x="92" y="10" width="44" height="20" rx="10" fill="${tone}"/><text x="114" y="25" font-size="13" font-weight="700" text-anchor="middle" fill="#18181b">${esc(t.badge)}</text>`
    : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144" font-family="Segoe UI, Arial, sans-serif">
<rect width="144" height="144" rx="18" fill="#18181b"/>${ring}
<text x="${t.badge ? 12 : 72}" y="28" font-size="19" text-anchor="${t.badge ? 'start' : 'middle'}" fill="#a1a1aa">${esc(fit(t.label, t.badge ? 8 : 12))}</text>${badge}
<text x="72" y="${t.sub ? 82 : 92}" font-size="${valueSize(t.value)}" font-weight="700" text-anchor="middle" fill="#fafafa">${esc(t.value)}</text>
${t.sub ? `<text x="72" y="112" font-size="19" text-anchor="middle" fill="#d4d4d8">${esc(fit(t.sub, 14))}</text>` : ''}
<rect x="22" y="126" width="100" height="6" rx="3" fill="${tone}"/>
</svg>`
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`
}

/** Shown when the app is not running or has not published yet. */
export const OFFLINE: Tile = { label: 'Lights Fan', value: 'Offline', sub: 'Start app', tone: 'off' }

/** Colors a temperature: green while comfortable, amber when warm, red when hot. */
export function tempTone(c: number, warm = 70, hot = 85): Tone {
  return c >= hot ? 'hot' : c >= warm ? 'warn' : 'ok'
}
