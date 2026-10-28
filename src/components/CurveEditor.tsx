import { useRef, useState } from 'react'
import { T_MAX, T_MIN, evalCurve } from '@/lib/curve'
import type { CurvePoint } from '@/lib/types'
import { cn } from '@/lib/utils'

const W = 640, H = 300
const M = { l: 44, r: 16, t: 14, b: 34 }
const PW = W - M.l - M.r, PH = H - M.t - M.b

const sx = (t: number) => M.l + ((t - T_MIN) / (T_MAX - T_MIN)) * PW
const sy = (p: number) => M.t + (1 - p / 100) * PH
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface Props {
  points: CurvePoint[]
  onChange(p: CurvePoint[]): void
  temp?: number
  pct?: number
}

/** Drag points to shape the curve, click empty space to add one, double-click or right-click a point to remove it. */
export function CurveEditor({ points, onChange, temp, pct }: Props) {
  const svg = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<number | null>(null)

  const toData = (e: { clientX: number; clientY: number }): CurvePoint => {
    const r = svg.current!.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    const y = ((e.clientY - r.top) / r.height) * H
    return {
      t: Math.round(T_MIN + ((x - M.l) / PW) * (T_MAX - T_MIN)),
      p: Math.round((1 - (y - M.t) / PH) * 100),
    }
  }

  const move = (e: React.PointerEvent) => {
    if (drag === null) return
    const d = toData(e)
    const lo = drag > 0 ? points[drag - 1].t + 1 : T_MIN
    const hi = drag < points.length - 1 ? points[drag + 1].t - 1 : T_MAX
    const next = points.slice()
    next[drag] = { t: clamp(d.t, lo, hi), p: clamp(d.p, 0, 100) }
    onChange(next)
  }

  const addPoint = (e: React.PointerEvent) => {
    const d = toData(e)
    if (d.t <= T_MIN || d.t >= T_MAX || points.some((p) => Math.abs(p.t - d.t) < 3)) return
    const next = [...points, { t: d.t, p: clamp(d.p, 0, 100) }].sort((a, b) => a.t - b.t)
    onChange(next)
    setDrag(next.findIndex((p) => p.t === d.t))
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const remove = (i: number) => {
    if (points.length <= 2) return
    onChange(points.filter((_, k) => k !== i))
  }

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t)},${sy(p.p)}`).join(' ')
  const area = `${path} L${sx(points[points.length - 1].t)},${sy(0)} L${sx(points[0].t)},${sy(0)} Z`

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full touch-none select-none"
      role="img"
      aria-label="Fan speed against temperature. Drag the points to change it."
      onPointerMove={move}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
    >
      <defs>
        <linearGradient id="cv-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--primary)" stopOpacity="0.35" />
          <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((p) => (
        <g key={p}>
          <line x1={M.l} x2={W - M.r} y1={sy(p)} y2={sy(p)} className="stroke-border" />
          <text x={M.l - 8} y={sy(p) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">{p}%</text>
        </g>
      ))}
      {[20, 30, 40, 50, 60, 70, 80, 90, 100].map((t) => (
        <g key={t}>
          <line x1={sx(t)} x2={sx(t)} y1={M.t} y2={H - M.b} className="stroke-border" />
          <text x={sx(t)} y={H - M.b + 18} textAnchor="middle" className="fill-muted-foreground text-[11px]">{t}°</text>
        </g>
      ))}
      <rect x={M.l} y={M.t} width={PW} height={PH} fill="transparent" onPointerDown={addPoint} />
      <path d={area} fill="url(#cv-fill)" pointerEvents="none" />
      <path d={path} className="fill-none stroke-primary stroke-3" strokeLinejoin="round" pointerEvents="none" />

      {temp !== undefined && (
        <g pointerEvents="none">
          <line x1={sx(temp)} x2={sx(temp)} y1={M.t} y2={H - M.b} className="stroke-teal opacity-70" strokeDasharray="4 4" />
          <circle cx={sx(temp)} cy={sy(pct ?? evalCurve(points, temp))} r={6} className="fill-teal" />
        </g>
      )}

      {points.map((p, i) => (
        <g key={i}>
          <circle
            cx={sx(p.t)}
            cy={sy(p.p)}
            r={drag === i ? 9 : 7}
            className={cn('cursor-grab fill-background stroke-teal stroke-3 hover:fill-teal', drag === i && 'cursor-grabbing')}
            onPointerDown={(e) => {
              e.stopPropagation()
              setDrag(i)
              ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
            }}
            onDoubleClick={() => remove(i)}
            onContextMenu={(e) => {
              e.preventDefault()
              remove(i)
            }}
          />
          {drag === i && (
            <text x={sx(p.t)} y={sy(p.p) - 14} textAnchor="middle" className="fill-foreground text-xs font-semibold">
              {p.t}° → {p.p}%
            </text>
          )}
        </g>
      ))}
    </svg>
  )
}
