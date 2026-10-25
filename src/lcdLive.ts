import { IS_TAURI, invoke } from './lib/hybrid'
import { LCD_SIZE, drawLive, rgba } from './lib/lcd'
import { useStore } from './store'

const CHECK_MS = 500

let chain: Promise<unknown> = Promise.resolve()

/** Uploads run one at a time; the cooler cannot take two transfers at once. */
export function sendToKraken(bytes: Uint8Array): Promise<void> {
  const run = chain.then(() => invoke<void>('kraken_image', bytes))
  chain = run.catch(() => undefined)
  return run
}

/**
 * Keeps the cooler's screen showing current temperatures. The frame is redrawn twice a second and
 * only uploaded when what is displayed (whole-degree readings) actually changed.
 */
export function startLcdLoop() {
  if (!IS_TAURI) return
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = LCD_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  let last: Uint8Array | null = null
  let busy = false

  useStore.subscribe((s, prev) => {
    if (s.lcdLive && !prev.lcdLive) last = null
  })

  setInterval(async () => {
    const s = useStore.getState()
    if (!s.lcdLive || busy) return
    drawLive(ctx, s.sensors)
    const bytes = rgba(canvas)
    if (last && bytes.every((v, i) => v === last![i])) return
    busy = true
    try {
      await sendToKraken(bytes)
      last = bytes
      s.setLcdError(null)
    } catch (e) {
      s.setLcdLive(false)
      s.setLcdError(String(e))
    } finally {
      busy = false
    }
  }, CHECK_MS)
}
