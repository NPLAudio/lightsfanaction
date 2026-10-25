import { useEffect, useMemo, useRef } from 'react'
import { frames } from '../engine'
import { effectById } from '../lib/effects'
import { ledsFor } from '../lib/layout'
import type { Device, Led, ParamValue, RGB } from '../lib/types'

interface Props {
  leds: Led[]
  getColors: () => RGB[] | undefined
  width: number
  height: number
  pad?: number
}

export function LedCanvas({ leds, getColors, width, height, pad = 14 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const getRef = useRef(getColors)
  getRef.current = getColors

  const pts = useMemo(() => {
    const w = width - pad * 2, h = height - pad * 2
    return leds.map((l) => ({ x: pad + l.x * w, y: pad + l.y * h }))
  }, [leds, width, height, pad])

  const radius = useMemo(() => {
    let min = Infinity
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
        if (d > 0 && d < min) min = d
      }
    }
    return Math.max(2, Math.min(min * 0.42, 14, (Math.min(width, height) - pad) / 4))
  }, [pts, width, height, pad])

  useEffect(() => {
    const cv = ref.current!
    const dpr = window.devicePixelRatio || 1
    cv.width = width * dpr
    cv.height = height * dpr
    const ctx = cv.getContext('2d')!
    ctx.scale(dpr, dpr)
    let raf = 0
    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      const colors = getRef.current()
      if (colors) {
        for (let i = 0; i < pts.length; i++) {
          const c = colors[i] ?? [0, 0, 0]
          const col = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
          const lum = (c[0] + c[1] + c[2]) / 765
          ctx.shadowColor = col
          ctx.shadowBlur = radius * 2.2 * lum
          ctx.fillStyle = lum < 0.02 ? 'rgba(255,255,255,0.06)' : col
          ctx.beginPath()
          ctx.arc(pts[i].x, pts[i].y, radius, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.shadowBlur = 0
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [pts, radius, width, height])

  return <canvas ref={ref} style={{ width, height }} aria-hidden />
}

export function DeviceCanvas({ device, width, height }: { device: Device; width: number; height: number }) {
  const leds = useMemo(() => ledsFor(device), [device])
  return <LedCanvas leds={leds} width={width} height={height} getColors={() => frames.get(device.id)} />
}

const STRIP: Led[] = Array.from({ length: 28 }, (_, i) => ({ i, n: 28, x: i / 27, y: 0.5 }))

/** Small live preview of an effect, used on the effect gallery cards. */
export function EffectPreview({ effectId, params }: { effectId: string; params: Record<string, ParamValue> }) {
  const fx = effectById(effectId)
  return (
    <LedCanvas
      leds={STRIP}
      width={188}
      height={28}
      pad={6}
      getColors={() => {
        const t = performance.now() / 1000
        return STRIP.map((l) => fx.render(l, t, params))
      }}
    />
  )
}
