import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { MAX_STOPS, PRESETS, gradientCss, parse, rgbToHex, hexToRgb, sampleStops, serialize, stopsOf, type Stop } from '@/lib/gradient'
import { cn } from '@/lib/utils'

interface Props {
  label: string
  value: string | number | undefined
  /** what the theme starts with; shown when nothing usable is saved */
  fallback: string
  /** the last color fades back into the first */
  cyclic?: boolean
  onChange: (value: string) => void
}

/**
 * A gradient you can see and shape: the bar is the fade itself, each stop is a handle to drag and recolor, a click on
 * the bar adds a stop, and the ready-made palettes below replace the whole thing.
 */
export function GradientField({ label, value, fallback, cyclic, onChange }: Props) {
  const stops = stopsOf(value, fallback)
  const [picked, setPicked] = useState(0)
  const bar = useRef<HTMLDivElement>(null)
  const drag = useRef<number | null>(null)
  const sel = Math.min(picked, stops.length - 1)

  const commit = (next: Stop[]) => onChange(serialize(next))
  const along = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  const moveTo = (i: number, at: number) => {
    const lo = i > 0 ? stops[i - 1].at : 0
    const hi = i < stops.length - 1 ? stops[i + 1].at : 1
    commit(stops.map((s, k) => (k === i ? { ...s, at: Math.min(hi, Math.max(lo, at)) } : s)))
  }

  const addAt = (at: number) => {
    if (stops.length >= MAX_STOPS) return
    const next = [...stops, { at, rgb: sampleStops(stops, at, false) }].sort((a, b) => a.at - b.at)
    setPicked(next.findIndex((s) => s.at === at))
    commit(next)
  }

  const remove = () => {
    if (stops.length <= 2) return
    commit(stops.filter((_, k) => k !== sel))
    setPicked(Math.max(0, sel - 1))
  }

  const reverse = () => {
    commit([...stops].reverse().map((s) => ({ ...s, at: 1 - s.at })))
    setPicked(stops.length - 1 - sel)
  }

  const current = stops[sel]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-sm">{label}</Label>
        <span className="text-xs text-muted-foreground">{cyclic ? 'loops around' : 'click the bar to add a color'}</span>
      </div>

      <div className="px-3 pb-3">
        <div
          ref={bar}
          className="relative h-8 cursor-copy rounded-md border"
          style={{ background: gradientCss(stops, cyclic) }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            addAt(along(e.clientX))
          }}
          role="group"
          aria-label={`${label} gradient`}
        >
          {stops.map((s, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Color stop ${i + 1} of ${stops.length}`}
              aria-pressed={i === sel}
              className={cn(
                'absolute top-full mt-0.5 size-4 -translate-x-1/2 cursor-grab touch-none rounded-full border-2 shadow outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                i === sel ? 'border-foreground ring-2 ring-ring/60' : 'border-background',
              )}
              style={{ left: `${s.at * 100}%`, background: rgbToHex(s.rgb) }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                drag.current = i
                setPicked(i)
              }}
              onPointerMove={(e) => {
                if (drag.current === i) moveTo(i, along(e.clientX))
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') moveTo(i, s.at - 0.02)
                else if (e.key === 'ArrowRight') moveTo(i, s.at + 0.02)
              }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="color"
          aria-label="Color of the selected stop"
          value={rgbToHex(current.rgb)}
          onChange={(e) => commit(stops.map((s, k) => (k === sel ? { ...s, rgb: hexToRgb(e.target.value) } : s)))}
          className="h-8 w-12 cursor-pointer rounded-md border bg-transparent p-0.5"
        />
        <span className="text-sm text-muted-foreground">Stop {sel + 1} of {stops.length} · {Math.round(current.at * 100)}%</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={reverse}>Reverse</Button>
          <Button size="sm" variant="outline" disabled={stops.length <= 2} onClick={remove}>Remove</Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">Palettes</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => {
                onChange(p.stops)
                setPicked(0)
              }}
              className="space-y-1 rounded-md border p-1 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="block h-4 rounded-sm" style={{ background: gradientCss(parse(p.stops)!, cyclic) }} />
              {p.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
