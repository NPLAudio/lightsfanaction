import { fetchState, type Snapshot } from './api.js'

type Listener = (state: Snapshot | undefined) => void

const INTERVAL_MS = 1000
/** A snapshot older than this means the app's window has stopped publishing (it is closed or hung). */
const STALE_MS = 6000

let latest: Snapshot | undefined
let timer: ReturnType<typeof setInterval> | undefined
let busy = false
const listeners = new Set<Listener>()

export const current = () => latest

async function tick() {
  if (busy) return
  busy = true
  try {
    const s = await fetchState()
    latest = s && Date.now() - s.at < STALE_MS ? s : undefined
    for (const l of listeners) l(latest)
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
