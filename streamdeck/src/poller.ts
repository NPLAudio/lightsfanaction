import streamDeck from '@elgato/streamdeck'
import { fetchState, lastWhy, type Snapshot } from './api.js'

type Listener = (state: Snapshot | undefined) => void

const INTERVAL_MS = 1000
/** A snapshot older than this means the app's window has stopped publishing (it is closed or hung). */
const STALE_MS = 6000

let latest: Snapshot | undefined
let timer: ReturnType<typeof setInterval> | undefined
let busy = false
let busySince = 0
let linkUp = true
/** A poll that has not finished by now is stuck; polling carries on regardless. */
const STUCK_MS = 10000
const listeners = new Set<Listener>()

export const current = () => latest

async function tick() {
  if (busy && Date.now() - busySince < STUCK_MS) return
  busy = true
  busySince = Date.now()
  try {
    const s = await fetchState()
    const stale = s !== undefined && Date.now() - s.at >= STALE_MS
    latest = s && !stale ? s : undefined
    // say in the plugin log when the link to the app goes away or comes back, and why
    if (latest && !linkUp) streamDeck.logger.info('link to the app restored')
    else if (!latest && linkUp) streamDeck.logger.warn(`link to the app lost: ${stale ? `its state is ${Math.round((Date.now() - s!.at) / 1000)} s old (the app window stopped publishing)` : lastWhy}`)
    linkUp = latest !== undefined
    for (const l of listeners) l(latest)
  } catch (e) {
    streamDeck.logger.error(`poll failed: ${e}`)
    latest = undefined // never let a failed poll take the plugin down; the next one tries again
  } finally {
    busy = false
  }
}

/** Polls while at least one listener exists, so a deck with no keys from this plugin on screen costs nothing. */
export function subscribe(l: Listener): () => void {
  listeners.add(l)
  if (!timer) {
    timer = setInterval(() => void tick(), INTERVAL_MS)
    void tick()
  } else l(latest)
  return () => {
    listeners.delete(l)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

export function refreshSoon() {
  setTimeout(() => void tick(), 250)
}
