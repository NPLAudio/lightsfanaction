import type { JsonObject } from '@elgato/utils'
import { action, SingletonAction, streamDeck, type KeyAction, type WillAppearEvent, type WillDisappearEvent } from '@elgato/streamdeck'
import { openFrames, postDecks, type DeckKeys, type Frame } from '../api.js'
import { OFFLINE, tileSvg } from '../render.js'
import { pngUri } from './png.js'
import { patternFor, type RGB, type Source } from './source.js'

/**
 * The lighting display key. Drop it on any key and that key shows its own part of one picture spanning every
 * display key on the same deck, laid out by the keys' columns and rows, as if the keys were a single screen. The
 * picture is Lights Fan Action's lighting for that deck: the deck appears in the app's lighting list, where its
 * effect, detail and gaps are chosen.
 *
 * Only keys that carry this action are ever drawn on: every other key keeps whatever you configured for it.
 */

type Detail = 'color' | 'smooth' | 'full'

interface Settings {
  /** edge length in pixels of the image sent for each key */
  size: number
  /** show a built-in test pattern drawn here instead of the app's lighting */
  testPattern: boolean
  /** test pattern only: images per second */
  fps: number
  /** test pattern only */
  detail: Detail
  /** test pattern only: space between keys, as a percentage of a key's width */
  gap: number
  pattern: string
}

const DEFAULTS: Settings = { size: 96, testPattern: false, fps: 12, detail: 'smooth', gap: 20, pattern: 'sweep' }
/** Grid of samples behind a "smooth" test-pattern key, scaled up to the full image. */
const SMOOTH = 8
/** Frames from the app older than this mean it is gone (it sends many a second while lighting is running). */
const STALE_MS = 4000
const REPORT_MS = 5000

let settings: Settings = { ...DEFAULTS }
let source: Source = patternFor(settings.pattern)

function apply(raw: Partial<Record<keyof Settings, unknown>> | undefined) {
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
  settings = {
    size: [48, 72, 96, 144].includes(Number(raw?.size)) ? Number(raw?.size) : DEFAULTS.size,
    testPattern: raw?.testPattern === true,
    fps: n(raw?.fps, 1, 30, DEFAULTS.fps),
    detail: raw?.detail === 'color' || raw?.detail === 'full' ? raw.detail : 'smooth',
    gap: n(raw?.gap, 0, 60, DEFAULTS.gap),
    pattern: typeof raw?.pattern === 'string' ? raw.pattern : DEFAULTS.pattern,
  }
  source = patternFor(settings.pattern)
  restart()
}

interface Key {
  action: KeyAction<JsonObject>
  deviceId: string
  deviceName: string
  column: number
  row: number
  columns: number
  rows: number
}

const keys = new Map<string, Key>()

// ---- pictures from the app -----------------------------------------------------------------------------------------

const latest = new Map<string, Frame>()
const drawing = new Set<string>()
let lastFrameAt = 0
let connected = false
let shownOffline = false
let stopFrames: (() => void) | undefined
let reportTimer: ReturnType<typeof setInterval> | undefined

/** Scales a g x g block of samples up to size x size by blending between neighbors. */
export function upscale(samples: Uint8Array, offset: number, g: number, size: number, out: Uint8Array) {
  if (g === 1) {
    for (let i = 0; i < size * size * 3; i += 3) {
      out[i] = samples[offset]
      out[i + 1] = samples[offset + 1]
      out[i + 2] = samples[offset + 2]
    }
    return
  }
  const at = (gx: number, gy: number, ch: number) => samples[offset + (Math.min(g - 1, Math.max(0, gy)) * g + Math.min(g - 1, Math.max(0, gx))) * 3 + ch]
  for (let y = 0; y < size; y++) {
    const fy = ((y + 0.5) / size) * g - 0.5
    const y1 = Math.floor(fy)
    const ty = fy - y1
    for (let x = 0; x < size; x++) {
      const fx = ((x + 0.5) / size) * g - 0.5
      const x1 = Math.floor(fx)
      const tx = fx - x1
      const i = (y * size + x) * 3
      for (let ch = 0; ch < 3; ch++) {
        const top = at(x1, y1, ch) * (1 - tx) + at(x1 + 1, y1, ch) * tx
        const bottom = at(x1, y1 + 1, ch) * (1 - tx) + at(x1 + 1, y1 + 1, ch) * tx
        out[i + ch] = top * (1 - ty) + bottom * ty
      }
    }
  }
}

async function drawDeck(deckId: string) {
  if (drawing.has(deckId)) return // the newest frame is kept and drawn when the one in progress is done
  drawing.add(deckId)
  try {
    for (let f = latest.get(deckId); f; f = latest.get(deckId)) {
      latest.delete(deckId)
      const { meta, bytes } = f
      const per = meta.g * meta.g * 3
      const out = new Uint8Array(settings.size * settings.size * 3)
      const sends: Promise<void>[] = []
      for (const key of keys.values()) {
        if (key.deviceId !== deckId) continue
        const index = meta.keys.findIndex(([c, r]) => c === key.column && r === key.row)
        if (index < 0 || (index + 1) * per > bytes.length) continue // not in this frame yet
        upscale(bytes, index * per, meta.g, settings.size, out)
        sends.push(key.action.setImage(pngUri(settings.size, settings.size, out)))
      }
      await Promise.all(sends)
    }
  } catch (e) {
    streamDeck.logger.warn(`display frame failed: ${e}`)
  } finally {
    drawing.delete(deckId)
  }
}

function onFrame(f: Frame) {
  lastFrameAt = performance.now()
  shownOffline = false
  latest.set(f.meta.deck, f)
  void drawDeck(f.meta.deck)
}

/** Shows the offline picture on every display key, once, until frames come back. */
function showOffline() {
  if (shownOffline) return
  shownOffline = true
  const uri = tileSvg(OFFLINE)
  for (const key of keys.values()) void key.action.setImage(uri)
}

function report() {
  const decks = new Map<string, DeckKeys>()
  for (const k of keys.values()) {
    const d = decks.get(k.deviceId) ?? { id: k.deviceId, name: k.deviceName, columns: k.columns, rows: k.rows, keys: [] }
    d.keys.push({ column: k.column, row: k.row })
    decks.set(k.deviceId, d)
  }
  void postDecks([...decks.values()])
  if (!settings.testPattern && connected && performance.now() - lastFrameAt > STALE_MS) showOffline()
  if (!settings.testPattern && !connected) showOffline()
}

// ---- built-in test pattern -----------------------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | undefined
let busy = false
const started = performance.now()
const stats = { frames: 0, dropped: 0, images: 0, bytes: 0, renderMs: 0, sendMs: 0, since: performance.now() }

function renderTest(k: Key, t: number, out: Uint8Array) {
  const { size, gap, detail } = settings
  const g = gap / 100
  const width = k.columns + (k.columns - 1) * g
  const height = k.rows + (k.rows - 1) * g
  const x0 = k.column * (1 + g)
  const y0 = k.row * (1 + g)
  const c: RGB = [0, 0, 0]
  const at = (u: number, v: number) => source.color((x0 + u) / width, (y0 + v) / height, t, c)
  if (detail === 'color') {
    at(0.5, 0.5)
    for (let i = 0; i < size * size * 3; i += 3) out.set(c, i)
    return
  }
  if (detail === 'full') {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        at((x + 0.5) / size, (y + 0.5) / size)
        out.set(c, (y * size + x) * 3)
      }
    }
    return
  }
  const grid = new Uint8Array(SMOOTH * SMOOTH * 3)
  for (let y = 0; y < SMOOTH; y++) {
    for (let x = 0; x < SMOOTH; x++) {
      at((x + 0.5) / SMOOTH, (y + 0.5) / SMOOTH)
      grid.set([c[0], c[1], c[2]], (y * SMOOTH + x) * 3)
    }
  }
  upscale(grid, 0, SMOOTH, size, out)
}

async function testFrame() {
  if (busy) {
    stats.dropped++
    return
  }
  busy = true
  try {
    const t = (performance.now() - started) / 1000
    const buffer = new Uint8Array(settings.size * settings.size * 3)
    const r0 = performance.now()
    const images: { key: Key; uri: string }[] = []
    for (const key of keys.values()) {
      renderTest(key, t, buffer)
      images.push({ key, uri: pngUri(settings.size, settings.size, buffer) })
    }
    stats.renderMs += performance.now() - r0
    const s0 = performance.now()
    const sends: Promise<void>[] = []
    for (const { key, uri } of images) {
      stats.bytes += uri.length
      sends.push(key.action.setImage(uri))
    }
    await Promise.all(sends)
    stats.sendMs += performance.now() - s0
    stats.images += images.length
    stats.frames++
  } catch (e) {
    streamDeck.logger.warn(`test frame failed: ${e}`)
  } finally {
    busy = false
  }
}

function testReport() {
  const secs = (performance.now() - stats.since) / 1000
  if (secs < 5 || stats.frames + stats.dropped === 0) return
  const f = Math.max(1, stats.frames)
  streamDeck.logger.info(
    `test pattern: ${keys.size} keys, ${(stats.frames / secs).toFixed(1)} frames/s done (${(stats.dropped / secs).toFixed(1)}/s skipped), ` +
      `${(stats.images / secs).toFixed(0)} images/s, ${(stats.bytes / 1024 / secs).toFixed(0)} KB/s, ` +
      `draw ${(stats.renderMs / f).toFixed(1)} ms/frame, hand-off ${(stats.sendMs / f).toFixed(1)} ms/frame`,
  )
  stats.frames = stats.dropped = stats.images = stats.bytes = stats.renderMs = stats.sendMs = 0
  stats.since = performance.now()
}

// ---- lifecycle -----------------------------------------------------------------------------------------------------

function restart() {
  if (timer) clearInterval(timer)
  timer = undefined
  if (reportTimer) clearInterval(reportTimer)
  reportTimer = undefined
  stopFrames?.()
  stopFrames = undefined
  connected = false
  if (keys.size === 0) return

  if (settings.testPattern) {
    // the deck is not listed in the app while a test pattern is on, so there is nothing to report
    let n = 0
    // a self-correcting timer: setInterval alone runs slow on Windows
    let next = performance.now()
    const tick = () => {
      void testFrame()
      if (++n % Math.max(1, Math.round(settings.fps)) === 0) testReport()
      next += 1000 / settings.fps
      timer = setTimeout(tick, Math.max(0, next - performance.now())) as unknown as ReturnType<typeof setInterval>
    }
    timer = setTimeout(tick, 0) as unknown as ReturnType<typeof setInterval>
    return
  }

  lastFrameAt = performance.now()
  shownOffline = false
  stopFrames = openFrames({
    frame: onFrame,
    open: () => {
      connected = true
    },
    close: () => {
      connected = false
    },
  })
  report()
  reportTimer = setInterval(report, REPORT_MS)
}

@action({ UUID: 'com.nplaudio.lightsfanaction.display' })
export class DisplayKeyAction extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent) {
    if (!ev.action.isKey()) return
    const at = ev.action.coordinates
    if (!at) return // part of a multi-action: nothing to place
    const device = ev.action.device
    const { columns, rows } = device.size
    keys.set(ev.action.id, { action: ev.action, deviceId: device.id, deviceName: device.name, column: at.column, row: at.row, columns, rows })
    void ev.action.setTitle('')
    // a changed set of keys is reported straight away; the rest of the work carries on
    if (timer || reportTimer || stopFrames) {
      if (!settings.testPattern) report()
    } else restart()
  }

  override onWillDisappear(ev: WillDisappearEvent) {
    keys.delete(ev.action.id)
    if (keys.size === 0) restart()
    else if (!settings.testPattern) report()
  }
}

streamDeck.settings
  .getGlobalSettings()
  .then((g) => apply(g as Record<string, unknown>))
  .catch(() => undefined)
streamDeck.settings.onDidReceiveGlobalSettings((ev) => apply(ev.settings as Record<string, unknown>))
