import type { Sensor } from './types'

export const LCD_SIZE = 640

export type Fit = 'cover' | 'contain'

export function drawImage(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, fit: Fit) {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, LCD_SIZE, LCD_SIZE)
  const k = (fit === 'cover' ? Math.max : Math.min)(LCD_SIZE / w, LCD_SIZE / h)
  ctx.drawImage(img, (LCD_SIZE - w * k) / 2, (LCD_SIZE - h * k) / 2, w * k, h * k)
}

const pick = (sensors: Sensor[], re: RegExp) => sensors.find((s) => re.test(s.name))

function tempColor(t: number) {
  // cool teal -> violet -> hot red-orange
  if (t < 40) return '#00e0c6'
  if (t < 60) return '#7c5cff'
  if (t < 75) return '#ffb020'
  return '#ff5a5f'
}

/** Liquid temperature gauge with CPU and GPU readouts underneath. */
export function drawLive(ctx: CanvasRenderingContext2D, sensors: Sensor[]) {
  const c = LCD_SIZE / 2
  ctx.fillStyle = '#0d0e14'
  ctx.fillRect(0, 0, LCD_SIZE, LCD_SIZE)

  const liquid = pick(sensors, /liquid|coolant|water/i)
  const cpu = pick(sensors, /CPU.*(package|tctl|die)/i)
  const gpu = pick(sensors, /GPU Core/i)

  const main = liquid?.value
  const start = Math.PI * 0.75
  const sweep = Math.PI * 1.5
  ctx.lineCap = 'round'
  ctx.lineWidth = 34
  ctx.strokeStyle = '#1c1f2e'
  ctx.beginPath()
  ctx.arc(c, c, 270, start, start + sweep)
  ctx.stroke()
  if (main !== undefined) {
    const frac = Math.min(1, Math.max(0, (main - 20) / 60))
    ctx.strokeStyle = tempColor(main)
    ctx.beginPath()
    ctx.arc(c, c, 270, start, start + sweep * frac)
    ctx.stroke()
  }

  ctx.textAlign = 'center'
  ctx.fillStyle = '#8a90aa'
  ctx.font = '600 34px "Segoe UI", sans-serif'
  ctx.fillText('LIQUID', c, c - 120)
  ctx.fillStyle = '#e8eaf4'
  ctx.font = '700 150px "Segoe UI", sans-serif'
  ctx.fillText(main === undefined ? '--' : `${Math.round(main)}°`, c, c + 20)

  const row = (label: string, v: number | undefined, x: number) => {
    ctx.fillStyle = '#8a90aa'
    ctx.font = '600 30px "Segoe UI", sans-serif'
    ctx.fillText(label, x, c + 130)
    ctx.fillStyle = v === undefined ? '#8a90aa' : tempColor(v)
    ctx.font = '700 64px "Segoe UI", sans-serif'
    ctx.fillText(v === undefined ? '--' : `${Math.round(v)}°`, x, c + 200)
  }
  row('CPU', cpu?.value, c - 110)
  row('GPU', gpu?.value, c + 110)
}

/** Canvas pixels as 4 bytes each; the cooler ignores the fourth. */
export function rgba(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext('2d')!
  return new Uint8Array(ctx.getImageData(0, 0, LCD_SIZE, LCD_SIZE).data.buffer)
}
