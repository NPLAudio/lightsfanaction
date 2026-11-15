import { hexToRgb, rgbToHex } from '@/lib/gradient'
import type { Fade, ParamValue } from '@/lib/types'

const STEPS = 24

const colorOf = (ref: string, params: Record<string, ParamValue>, fallback: string) =>
  ref.startsWith('#') ? ref : String(params[ref] ?? fallback)

/** A bar showing a fade as the effect draws it (the blend between two colors, or how long a tail lasts). */
export function FadeBar({ fade, params }: { fade: Fade; params: Record<string, ParamValue> }) {
  const from = hexToRgb(colorOf(fade.from, params, '#ffffff'))
  const to = hexToRgb(colorOf(fade.to, params, '#000000'))
  const parts = Array.from({ length: STEPS + 1 }, (_, i) => {
    const u = i / STEPS
    const k = fade.level ? Math.min(1, Math.max(0, fade.level(params, u))) : 1 - u
    const c = from.map((v, n) => v * k + to[n] * (1 - k)) as [number, number, number]
    return `${rgbToHex(c)} ${(u * 100).toFixed(1)}%`
  })
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{fade.label}</span>
      <div className="h-3 rounded-md border" style={{ background: `linear-gradient(90deg, ${parts.join(', ')})` }} role="img" aria-label={`${fade.label} fade`} />
    </div>
  )
}
