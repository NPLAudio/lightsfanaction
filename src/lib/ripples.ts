import { settingsFor, useDecks, type DeckReport, DECK_PREFIX } from './deckState'
import type { RGB } from './types'

/**
 * Key-press ripples: pressing a display key sends a ring of light spreading across the deck, on top of whatever
 * effect is playing. The ring is drawn in key units, so it is round on the real keys whatever the deck's shape.
 */

interface Ripple {
  deck: string
  /** where it started, in key widths from the deck's top-left corner (gaps included) */
  x: number
  y: number
  at: number
}

/** Seconds a ripple lasts. */
const LIFE = 1.3
/** Key widths a second the ring travels. */
const SPEED = 5.5
/** Key widths across the bright part of the ring. */
const WIDTH = 0.8
const MAX = 12

const ripples: Ripple[] = []

export function addRipple(deckId: string, column: number, row: number, gap: number, now: number) {
  ripples.push({ deck: deckId, x: column * (1 + gap) + 0.5, y: row * (1 + gap) + 0.5, at: now })
  if (ripples.length > MAX) ripples.shift()
}

export function clearRipples() {
  ripples.length = 0
}

/** Lightens `colors` (the deck's frame, one per sample in `positions`) where live ripples pass. */
export function applyRipples(deck: DeckReport, gap: number, positions: [number, number][], colors: RGB[], now: number) {
  while (ripples.length && (now - ripples[0].at) / 1000 > LIFE) ripples.shift()
  const mine = ripples.filter((r) => r.deck === deck.id)
  if (mine.length === 0) return
  const w = deck.columns + (deck.columns - 1) * gap
  const h = deck.rows + (deck.rows - 1) * gap
  for (let i = 0; i < colors.length; i++) {
    const kx = positions[i][0] * w
    const ky = positions[i][1] * h
    let k = 0
    for (const r of mine) {
      const age = (now - r.at) / 1000
      const ring = Math.exp(-(((Math.hypot(kx - r.x, ky - r.y) - age * SPEED) / WIDTH) ** 2)) * (1 - age / LIFE) ** 1.5
      if (ring > k) k = ring
    }
    if (k > 0.01) {
      const c = colors[i]
      const lift = Math.min(1, k * 1.1) * 0.85
      colors[i] = [c[0] + (255 - c[0]) * lift, c[1] + (255 - c[1]) * lift, c[2] + (255 - c[2]) * lift]
    }
  }
}

/** The ripples for a deck's lighting device, if the deck has them on. */
export function applyDeckRipples(deviceId: string, positions: [number, number][], colors: RGB[], now: number) {
  if (!deviceId.startsWith(DECK_PREFIX)) return
  const { decks, settings } = useDecks.getState()
  const deck = decks.find((d) => DECK_PREFIX + d.id === deviceId)
  if (!deck) return
  const s = settingsFor(settings, deck.id)
  if (s.ripples) applyRipples(deck, s.gap / 100, positions, colors, now)
}
