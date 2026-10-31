import { effectById } from './effects'
import { screenTheme } from './screen'
import { LCD_SIZE } from './lcd'
import type { ParamValue, Sensor } from './types'
import { useStore } from '@/store'

/**
 * A cooler screen that wears the lighting effect: the effect itself paints the background and the temperature
 * gauge is drawn in its live colors, so the screen and the lights read as one scene. Stats-only mode (drawLive in
 * lcd.ts) is separate and never looks at the effect.
 */

export interface Theme {
  effectId: string
  params: Record<string, ParamValue>
  /** 0 to 100, the lighting brightness */
  brightness: number
}

/** Resolution the effect is rendered at before being scaled up; the soft look suits glows and gradients. */
const GRID = 72
/** How much of the effect's brightness the background keeps, so numbers stay readable. */
const BACKDROP = 0.7

let bg: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } | undefined

function backdrop() {
  if (!bg) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = GRID
    const ctx = canvas.getContext('2d')!
    bg = { canvas, ctx, data: ctx.createImageData(GRID, GRID) }
  }
  return bg
}

/** The theme the screen device is wearing, or null for stats only. */
export function resolveTheme(): Theme | null {
  const { devices, assignments } = useStore.getState()
  const a = screenTheme(devices, assignments)
  return a ? { effectId: a.effectId, params: a.params, brightness: a.brightness } : null
}

const pick = (sensors: Sensor[], re: RegExp) => sensors.find((s) => re.test(s.name))

const mixc = (a: number[], b: number[], k: number): number[] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
const css = (c: number[]) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`
const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/** The hot end of the scale: from the effect's color to red as the liquid heats up. */
function heat(c: number[], liquid: number | undefined): number[] {
  if (liquid === undefined || liquid < 42) return c
  return mixc(c, [255, 70, 60], Math.min(1, (liquid - 42) / 10))
}

export function drawThemed(ctx: CanvasRenderingContext2D, sensors: Sensor[], theme: Theme, t: number) {
  const fx = effectById(theme.effectId)
  const k = (theme.brightness / 100) * BACKDROP
  const { canvas, ctx: bctx, data } = backdrop()
  const px = data.data
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const c = fx.render({ i: y * GRID + x, n: GRID * GRID, x: x / (GRID - 1), y: y / (GRID - 1) }, t, theme.params)
      const o = (y * GRID + x) * 4
      px[o] = Math.min(255, c[0] * k)
      px[o + 1] = Math.min(255, c[1] * k)
      px[o + 2] = Math.min(255, c[2] * k)
      px[o + 3] = 255
    }
  }
  bctx.putImageData(data, 0, 0)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, LCD_SIZE, LCD_SIZE)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, LCD_SIZE, LCD_SIZE)

  const c = LCD_SIZE / 2
  // a dark pool behind the numbers
  const pool = ctx.createRadialGradient(c, c, 40, c, c, 330)
  pool.addColorStop(0, 'rgba(6,7,12,0.72)')
  pool.addColorStop(0.6, 'rgba(6,7,12,0.55)')
  pool.addColorStop(1, 'rgba(6,7,12,0)')
  ctx.fillStyle = pool
  ctx.fillRect(0, 0, LCD_SIZE, LCD_SIZE)

  const liquid = pick(sensors, /liquid|coolant|water/i)?.value
  const cpu = pick(sensors, /CPU.*(package|tctl|die)/i)?.value
  const gpu = pick(sensors, /GPU Core/i)?.value

  // the gauge is painted with the effect's own colors, sampled along the arc as it plays
  const R = 270
  const start = Math.PI * 0.75
  const sweep = Math.PI * 1.5
  const frac = liquid === undefined ? 0 : Math.min(1, Math.max(0, (liquid - 20) / 60))
  ctx.lineCap = 'butt'
  ctx.lineWidth = 34
  ctx.strokeStyle = 'rgba(255,255,255,0.13)'
  ctx.beginPath()
  ctx.arc(c, c, R, start, start + sweep)
  ctx.stroke()

  const accent = (a: number): number[] => {
    const col = fx.render({ i: 0, n: 1, x: 0.5 + (R / LCD_SIZE) * Math.cos(a), y: 0.5 + (R / LCD_SIZE) * Math.sin(a) }, t, theme.params)
    // keep it visible whatever the effect is doing at that moment
    const lift = Math.max(0, 1 - luma(col) / 140)
    return mixc(col, [170, 178, 210], lift * 0.8)
  }
  const SEGMENTS = 54
  const filled = Math.round(SEGMENTS * frac)
  for (let i = 0; i < filled; i++) {
    const a0 = start + (sweep * i) / SEGMENTS
    const a1 = start + (sweep * (i + 1)) / SEGMENTS + 0.006
    ctx.strokeStyle = css(heat(accent((a0 + a1) / 2), liquid))
    ctx.beginPath()
    ctx.arc(c, c, R, a0, a1)
    ctx.stroke()
  }
  // a bright cap where the reading is
  if (filled > 0) {
    const a = start + (sweep * filled) / SEGMENTS
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(c + R * Math.cos(a), c + R * Math.sin(a), 13, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.textAlign = 'center'
  ctx.shadowColor = 'rgba(0,0,0,0.6)'
  ctx.shadowBlur = 14
  const label = css(accent(start + sweep * 0.5))
  ctx.fillStyle = label
  ctx.font = '600 34px "Segoe UI", sans-serif'
  ctx.fillText('LIQUID', c, c - 120)
  ctx.fillStyle = '#fff'
  ctx.font = '700 150px "Segoe UI", sans-serif'
  ctx.fillText(liquid === undefined ? '--' : `${Math.round(liquid)}°`, c, c + 20)

  const row = (name: string, v: number | undefined, x: number, a: number) => {
    ctx.fillStyle = css(accent(a))
    ctx.font = '600 30px "Segoe UI", sans-serif'
    ctx.fillText(name, x, c + 130)
    ctx.fillStyle = v !== undefined && v >= 80 ? '#ff6b6b' : '#fff'
    ctx.font = '700 64px "Segoe UI", sans-serif'
    ctx.fillText(v === undefined ? '--' : `${Math.round(v)}°`, x, c + 200)
  }
  row('CPU', cpu, c - 110, start + sweep * 0.15)
  row('GPU', gpu, c + 110, start + sweep * 0.85)
  ctx.shadowBlur = 0
}
