import { invoke } from './hybrid'
import { DECK_PREFIX, deckLayout, settingsFor, useDecks } from './deckState'
import type { RGB } from './types'

/** Sends a deck's rendered frame to the Stream Deck plugin, at the deck's own rate, never queuing behind a slow one. */

const sentAt = new Map<string, number>()
const inFlight = new Set<string>()

export function publishDeckFrame(deviceId: string, colors: RGB[], now: number) {
  if (!deviceId.startsWith(DECK_PREFIX)) return
  const { decks, settings } = useDecks.getState()
  const deck = decks.find((d) => DECK_PREFIX + d.id === deviceId)
  if (!deck || deck.keys.length === 0) return
  const s = settingsFor(settings, deck.id)
  if (inFlight.has(deviceId) || now - (sentAt.get(deviceId) ?? 0) < 1000 / s.fps) return
  const { g, keys } = deckLayout(deck, s)
  if (colors.length !== keys.length * g * g) return // layout changed since this frame was drawn
  sentAt.set(deviceId, now)
  const bytes = new Uint8Array(colors.length * 3)
  for (let i = 0; i < colors.length; i++) {
    bytes[i * 3] = colors[i][0]
    bytes[i * 3 + 1] = colors[i][1]
    bytes[i * 3 + 2] = colors[i][2]
  }
  const meta = { deck: deck.id, g, columns: deck.columns, rows: deck.rows, keys: keys.map((k) => [k.column, k.row]) }
  inFlight.add(deviceId)
  void invoke<void>('deck_frame', bytes, { headers: { 'x-meta': JSON.stringify(meta) } })
    .catch(() => undefined)
    .finally(() => inFlight.delete(deviceId))
}
