import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Device } from './types'

/**
 * Stream Decks that have display keys on them. The plugin reports each deck and the keys carrying its display key;
 * the app makes one lighting device per deck, with a pixel for every sample point of those keys, laid out in the
 * deck's own geometry so an effect flows across the keys as if they were one screen.
 */

export interface DeckReport {
  /** the Stream Deck software's id for the device */
  id: string
  name: string
  columns: number
  rows: number
  /** keys that carry a display key */
  keys: { column: number; row: number }[]
}

export type DeckDetail = 'color' | 'smooth' | 'fine'

export interface DeckSettings {
  /** frames a second sent to the deck */
  fps: number
  detail: DeckDetail
  /** space between keys as a percentage of a key's width */
  gap: number
  /** pressing a display key sends a ripple across the deck */
  ripples: boolean
}

export const DEFAULT_DECK: DeckSettings = { fps: 15, detail: 'smooth', gap: 20, ripples: true }

/** Samples across and down each key. */
export const DETAIL_GRID: Record<DeckDetail, number> = { color: 1, smooth: 8, fine: 16 }

export const DECK_PREFIX = 'deck-'
export const deckDeviceId = (id: string) => DECK_PREFIX + id

interface DeckStore {
  decks: DeckReport[]
  /** when the plugin last reported (ms since the page loaded), so decks vanish if it goes quiet */
  seenAt: number
  settings: Record<string, DeckSettings>
  setDecks(decks: DeckReport[]): void
  patch(id: string, p: Partial<DeckSettings>): void
}

export const useDecks = create<DeckStore>()(
  persist(
    (set, get) => ({
      decks: [],
      seenAt: 0,
      settings: {},
      setDecks: (decks) => set({ decks, seenAt: performance.now() }),
      patch: (id, p) => set({ settings: { ...get().settings, [id]: { ...settingsFor(get().settings, id), ...p } } }),
    }),
    { name: 'lfa-decks', partialize: (s) => ({ settings: s.settings }) },
  ),
)

export function settingsFor(all: Record<string, DeckSettings>, id: string): DeckSettings {
  return { ...DEFAULT_DECK, ...all[id] }
}

/** The keys in a fixed order (row by row), and where each of their sample points sits on the deck's canvas. */
export function deckLayout(deck: DeckReport, s: DeckSettings) {
  const g = DETAIL_GRID[s.detail]
  const gap = s.gap / 100
  const width = deck.columns + (deck.columns - 1) * gap
  const height = deck.rows + (deck.rows - 1) * gap
  const keys = [...deck.keys].sort((a, b) => a.row - b.row || a.column - b.column)
  const positions: [number, number][] = []
  for (const k of keys) {
    for (let j = 0; j < g; j++) {
      for (let i = 0; i < g; i++) {
        positions.push([(k.column * (1 + gap) + (i + 0.5) / g) / width, (k.row * (1 + gap) + (j + 0.5) / g) / height])
      }
    }
  }
  return { g, keys, positions }
}

export function deckDevices(decks: DeckReport[], settings: Record<string, DeckSettings>): Device[] {
  return decks.map((d) => {
    const { positions } = deckLayout(d, settingsFor(settings, d.id))
    return {
      id: deckDeviceId(d.id),
      name: d.name,
      kind: 'deck',
      layout: 'custom',
      ledCount: positions.length,
      positions,
      note:
        d.keys.length === 0
          ? 'Drop a Lighting display key on a key to include it.'
          : `${d.keys.length} of ${d.columns * d.rows} keys carry a Lighting display key. Other keys are never touched.`,
    }
  })
}

// developer console hook, for trying the deck page without a deck: __lfaDecks.getState().setDecks([...])
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __lfaDecks?: typeof useDecks }).__lfaDecks = useDecks
