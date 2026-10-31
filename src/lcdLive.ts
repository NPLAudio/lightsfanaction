import { IS_TAURI, invoke } from './lib/hybrid'
import { LCD_SIZE, drawLive, rgba } from './lib/lcd'
import { drawThemed, resolveTheme } from './lib/lcdTheme'
import type { Sensor } from './lib/types'
import { simulatorActive } from './settings'
import { useStore } from './store'

/** Image uploads run one at a time; the cooler cannot take two transfers at once. */
let chain: Promise<unknown> = Promise.resolve()
export function sendToKraken(bytes: Uint8Array): Promise<void> {
  const run = chain.then(() => invoke<void>('kraken_image', bytes))
  chain = run.catch(() => undefined)
  return run
}

const FRAME_MS = 80
/** An unchanged picture is still resent this often, in case the cooler missed a frame. */
const RESEND_MS = 5000
/** After a failure (NZXT CAM holding the screen, say), wait this long before trying again. */
const RETRY_MS = 5000
/** Seconds a displayed reading takes to catch up with the real one, so the gauge glides instead of jumping. */
const EASE_SECONDS = 0.5

/**
 * Keeps the cooler's screen showing the temperatures, always: plain stats, or the theme chosen for the screen
 * device in the lighting list. Frames go through the fast streaming path, so the gauge glides and themes animate.
 * Nothing is sent while the picture is unchanged. Only a held picture (or the cooler's own screen) pauses it.
 */
export function startLcdLoop() {
  if (!IS_TAURI) return
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = LCD_SIZE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  let last: Uint8Array | null = null
  let lastSentAt = 0
  let retryAt = 0
  let busy = false
  const shown = new Map<string, number>()
  let lastAt = performance.now()

  useStore.subscribe((s, prev) => {
    // coming back from a held picture: show the live screen right away
    if (!s.lcdStatic && prev.lcdStatic) last = null
  })

  /** Readings eased toward their real values. */
  const eased = (sensors: Sensor[], dt: number): Sensor[] => {
    const k = 1 - Math.exp(-dt / EASE_SECONDS)
    return sensors.map((x) => {
      const prev = shown.get(x.id)
      const v = prev === undefined ? x.value : prev + (x.value - prev) * k
      shown.set(x.id, v)
      return { ...x, value: v }
    })
  }

  setInterval(async () => {
    const s = useStore.getState()
    // no cooler screen, a simulator, a held picture, or a recent failure: nothing to do
    if (busy || s.lcdStatic || simulatorActive(IS_TAURI) || !s.devices.some((d) => d.kind === 'screen')) return
    const now = performance.now()
    if (now < retryAt) return
    const dt = Math.min(1, (now - lastAt) / 1000)
    lastAt = now
    const readings = eased(s.sensors, dt)
    const theme = resolveTheme()
    if (theme) drawThemed(ctx, readings, theme, now / 1000)
    else drawLive(ctx, readings)
    const bytes = rgba(canvas)
    if (last && now - lastSentAt < RESEND_MS && bytes.every((v, i) => v === last![i])) return
    busy = true
    try {
      await invoke<void>('kraken_stream_frame', bytes)
      last = bytes
      lastSentAt = now
      s.setLcdError(null)
    } catch (e) {
      s.setLcdError(String(e))
      retryAt = now + RETRY_MS
      last = null
    } finally {
      busy = false
    }
  }, FRAME_MS)
}
