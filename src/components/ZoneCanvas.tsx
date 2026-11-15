import { useEffect, useRef, useState } from 'react'
import { DeviceCanvas } from '@/components/LedCanvas'
import type { Device } from '@/lib/types'
import type { Zone } from '@/lib/zoneState'
import { useZones } from '@/lib/zoneState'
import type { Placement } from '@/lib/zoneState'
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
      className="relative w-full rounded-xl border bg-muted/30"
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
              if (e.buttons === 0) return void (drag.current = null)
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
            {on && <Gizmo placement={m} ring={d.layout === 'ring'} aspect={zone.aspect} box={box} height={height} snap={snap} />}
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

const MIN = 0.01
/** [x, y] of each handle in the device's own frame: -1 left/top, 1 right/bottom. Corners come first. */
const HANDLES: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]]
const CURSORS = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize']

interface GizmoProps {
  placement: Placement
  ring: boolean
  aspect: number
  box: React.RefObject<HTMLDivElement | null>
  height: number
  snap: boolean
}

/**
 * Handles on the selected device: eight to resize (corners keep its proportions, hold Shift to stretch freely; the
 * sides stretch one way) and one above it to turn it (snaps to 5 degrees, 15 with Shift). They turn with the device.
 */
function Gizmo({ placement: m, ring, aspect, box, height, snap }: GizmoProps) {
  const patch = useZones((s) => s.patchPlacement)
  const start = useRef<{ hx: number; hy: number; px: number; py: number; m: Placement } | null>(null)
  const turning = useRef(false)

  const resize = (e: React.PointerEvent, hx: number, hy: number) => {
    const s = start.current
    if (!s) return
    if (e.buttons === 0) return void (start.current = null)
    const f = 1 / height // pixels to canvas units, the same both ways
    const a = (s.m.rot * Math.PI) / 180
    const dx = (e.clientX - s.px) * f
    const dy = (e.clientY - s.py) * f
    // the drag in the device's own frame
    const lx = dx * Math.cos(a) + dy * Math.sin(a)
    const ly = -dx * Math.sin(a) + dy * Math.cos(a)
    let w = hx ? Math.max(MIN, s.m.w + hx * lx) : s.m.w
    let h = hy ? Math.max(MIN, s.m.h + hy * ly) : s.m.h
    const keep = ring || (hx !== 0 && hy !== 0 && !e.shiftKey)
    if (keep) {
      const r = s.m.w / s.m.h
      // follow whichever side was dragged further
      if (hx !== 0 && hy !== 0) {
        const k = Math.max(w / s.m.w, h / s.m.h)
        w = Math.max(MIN, s.m.w * k)
        h = Math.max(MIN, s.m.h * k)
      } else if (hx !== 0) h = Math.max(MIN, w / r)
      else w = Math.max(MIN, h * r)
    }
    w = Math.min(w, aspect * 2)
    h = Math.min(h, 2)
    // the opposite edge stays put, so the center moves half of what the size changed
    const sx = hx ? (hx * (w - s.m.w)) / 2 : 0
    const sy = hy ? (hy * (h - s.m.h)) / 2 : 0
    patch(m.deviceId, {
      w,
      h,
      x: s.m.x + sx * Math.cos(a) - sy * Math.sin(a),
      y: s.m.y + sx * Math.sin(a) + sy * Math.cos(a),
    })
  }

  const turn = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const cx = r.left + m.x * height
    const cy = r.top + m.y * height
    let deg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90
    const step = e.shiftKey ? 15 : snap ? 5 : 0
    if (step) deg = Math.round(deg / step) * step
    patch(m.deviceId, { rot: ((Math.round(deg * 10) / 10) % 360 + 360) % 360 })
  }

  const stop = (e: React.PointerEvent) => e.stopPropagation()
  const dot = 'absolute z-10 size-3 -translate-x-1/2 -translate-y-1/2 touch-none rounded-[3px] border border-primary bg-background'

  return (
    <>
      <div className="pointer-events-none absolute left-1/2 -top-6 h-6 w-px -translate-x-1/2 bg-primary/60" />
      <div
        aria-label="Rotate"
        title="Drag to turn (Shift: 15° steps)"
        className="absolute left-1/2 -top-6 z-10 size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border border-primary bg-background active:cursor-grabbing"
        onPointerDown={(e) => {
          e.stopPropagation()
          e.currentTarget.setPointerCapture(e.pointerId)
          turning.current = true
        }}
        onPointerMove={(e) => {
          e.stopPropagation()
          if (turning.current && e.buttons === 0) turning.current = false
          if (turning.current) turn(e)
        }}
        onPointerUp={(e) => {
          e.stopPropagation()
          turning.current = false
        }}
        onPointerCancel={() => (turning.current = false)}
        onLostPointerCapture={() => (turning.current = false)}
      />
      {HANDLES.map(([hx, hy], i) => {
        if (ring && (hx === 0 || hy === 0)) return null
        return (
          <div
            key={i}
            aria-label="Resize"
            className={dot}
            style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor: CURSORS[i] }}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.currentTarget.setPointerCapture(e.pointerId)
              start.current = { hx, hy, px: e.clientX, py: e.clientY, m }
            }}
            onPointerMove={(e) => {
              stop(e)
              resize(e, hx, hy)
            }}
            onPointerUp={(e) => {
              stop(e)
              start.current = null
            }}
            onPointerCancel={() => (start.current = null)}
            onLostPointerCapture={() => (start.current = null)}
          />
        )
      })}
    </>
  )
}
