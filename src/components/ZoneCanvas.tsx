import { useEffect, useRef, useState } from 'react'
import { DeviceCanvas } from '@/components/LedCanvas'
import type { Device } from '@/lib/types'
import type { Zone } from '@/lib/zoneState'
import { useZones } from '@/lib/zoneState'
import { cn } from '@/lib/utils'

/** Canvas units a device moves by when snapping, and per arrow-key press. */
export const SNAP = 0.025

interface Props {
  zone: Zone
  devices: Device[]
  selected: string | null
  snap: boolean
  onSelect: (deviceId: string | null) => void
}

/**
 * The zone's canvas, drawn to scale: each placed device is a live preview of its own LEDs that can be dragged where
 * it really sits (inside the case, on the desk pad). The effect flows across all of them.
 */
export function ZoneCanvas({ zone, devices, selected, snap, onSelect }: Props) {
  const patch = useZones((s) => s.patchPlacement)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const drag = useRef<{ id: string; px: number; py: number; x: number; y: number } | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const height = width / zone.aspect
  const round = (v: number) => (snap ? Math.round(v / SNAP) * SNAP : v)

  const move = (id: string, x: number, y: number) =>
    patch(id, { x: Math.min(zone.aspect, Math.max(0, round(x))), y: Math.min(1, Math.max(0, round(y))) })

  return (
    <div
      ref={box}
      className="relative w-full overflow-hidden rounded-xl border bg-muted/30"
      style={{
        aspectRatio: String(zone.aspect),
        backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)',
        backgroundSize: `${height * 0.1}px ${height * 0.1}px`,
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onSelect(null)
      }}
      role="group"
      aria-label={`${zone.name} canvas`}
    >
      {zone.members.map((m) => {
        const d = devices.find((x) => x.id === m.deviceId)
        if (!d) return null
        const w = Math.max(16, (m.w / zone.aspect) * width)
        const h = Math.max(16, m.h * height)
        const on = m.deviceId === selected
        return (
          <div
            key={m.deviceId}
            tabIndex={0}
            role="button"
            aria-label={`${d.name}, drag to move, arrow keys nudge`}
            aria-pressed={on}
            title={d.name}
            className={cn(
              'absolute cursor-grab touch-none rounded-md outline-none active:cursor-grabbing focus-visible:ring-3 focus-visible:ring-ring/50',
              on ? 'ring-2 ring-primary' : 'ring-1 ring-white/10 hover:ring-white/30',
            )}
            style={{
              left: (m.x / zone.aspect) * width - w / 2,
              top: m.y * height - h / 2,
              width: w,
              height: h,
              transform: `rotate(${m.rot}deg)`,
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              drag.current = { id: m.deviceId, px: e.clientX, py: e.clientY, x: m.x, y: m.y }
              onSelect(m.deviceId)
            }}
            onPointerMove={(e) => {
              const s = drag.current
              if (!s || s.id !== m.deviceId) return
              move(m.deviceId, s.x + ((e.clientX - s.px) / width) * zone.aspect, s.y + (e.clientY - s.py) / height)
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? SNAP * 4 : SNAP
              const by: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
              const d2 = by[e.key]
              if (!d2) return
              e.preventDefault()
              move(m.deviceId, m.x + d2[0], m.y + d2[1])
            }}
          >
            <div className="pointer-events-none">
              <DeviceCanvas device={d} width={w} height={h} pad={Math.min(6, Math.floor(Math.min(w, h) / 4))} />
            </div>
          </div>
        )
      })}
      {zone.members.length === 0 && (
        <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
          Nothing placed yet. Add a device below, then drag it to where it sits.
        </p>
      )}
    </div>
  )
}
