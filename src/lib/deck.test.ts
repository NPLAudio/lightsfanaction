import { beforeEach, describe, expect, it } from 'vitest'
import { parseDecks } from '../control'
import { DEFAULT_DECK, DETAIL_GRID, deckDevices, deckLayout, type DeckReport } from './deckState'
import { useStore } from '../store'

const xl: DeckReport = {
  id: 'xl1',
  name: 'Stream Deck XL',
  columns: 8,
  rows: 4,
  keys: [
    { column: 1, row: 0 },
    { column: 0, row: 1 },
    { column: 0, row: 0 },
  ],
}

describe('a Stream Deck as a lighting device', () => {
  it('has a sample point for every spot on every display key, in row-by-row key order', () => {
    const { g, keys, positions } = deckLayout(xl, { ...DEFAULT_DECK, detail: 'smooth' })
    expect(g).toBe(DETAIL_GRID.smooth)
    expect(keys.map((k) => [k.column, k.row])).toEqual([[0, 0], [1, 0], [0, 1]])
    expect(positions).toHaveLength(3 * 8 * 8)
  })

  it('places keys by position on one shared canvas, with the gap between them', () => {
    const none = deckLayout({ ...xl, keys: [{ column: 0, row: 0 }, { column: 1, row: 0 }] }, { ...DEFAULT_DECK, detail: 'color', gap: 0 })
    // two keys across a deck 8 wide, no gap: centers at 0.5/8 and 1.5/8
    expect(none.positions[0][0]).toBeCloseTo(0.5 / 8)
    expect(none.positions[1][0]).toBeCloseTo(1.5 / 8)
    const gapped = deckLayout({ ...xl, keys: [{ column: 0, row: 0 }, { column: 1, row: 0 }] }, { ...DEFAULT_DECK, detail: 'color', gap: 50 })
    // the second key sits further along once there is space between keys
    expect(gapped.positions[1][0] - gapped.positions[0][0]).toBeGreaterThan(1 / 8)
    // and nothing leaves the canvas
    const all = Array.from({ length: 32 }, (_, i) => ({ column: i % 8, row: Math.floor(i / 8) }))
    for (const [x, y] of deckLayout({ ...xl, keys: all }, { ...DEFAULT_DECK, detail: 'fine', gap: 60 }).positions) {
      expect(x).toBeGreaterThan(0)
      expect(x).toBeLessThan(1)
      expect(y).toBeGreaterThan(0)
      expect(y).toBeLessThan(1)
    }
  })

  it('becomes one custom-layout device per deck', () => {
    const [d] = deckDevices([xl], {})
    expect(d).toMatchObject({ id: 'deck-xl1', kind: 'deck', layout: 'custom', name: 'Stream Deck XL' })
    expect(d.ledCount).toBe(d.positions!.length)
    expect(d.note).toContain('3 of 32')
  })
})

describe('deck reports from the plugin', () => {
  it('keeps good decks and drops bad ones', () => {
    const decks = parseDecks({
      decks: [
        { id: 'a', name: 'XL', columns: 8, rows: 4, keys: [{ column: 0, row: 0 }, { column: 0, row: 0 }, { column: 9, row: 0 }, { column: 1, row: 1 }] },
        { id: '', columns: 8, rows: 4, keys: [] },
        { id: 'b', columns: 99, rows: 4, keys: [] },
        { id: 'c', name: 'Mini', columns: 3, rows: 2 },
      ],
    })
    expect(decks.map((d) => d.id)).toEqual(['a', 'c'])
    expect(decks[0].keys).toEqual([{ column: 0, row: 0 }, { column: 1, row: 1 }]) // duplicate and out-of-range keys dropped
    expect(decks[1].keys).toEqual([])
  })

  it('ignores anything that is not a list of decks', () => {
    expect(parseDecks(null)).toEqual([])
    expect(parseDecks({ decks: 'no' })).toEqual([])
    expect(parseDecks({})).toEqual([])
  })
})

describe('decks in the lighting list', () => {
  beforeEach(() => {
    useStore.setState({ ready: true, devices: [{ id: 'a', name: 'Strip', kind: 'strip', layout: 'strip', ledCount: 4 }], assignments: { a: { effectId: 'rainbow', params: {}, brightness: 100 } }, selectedDevice: 'a' })
  })

  it('adds and removes decks without touching other devices', () => {
    useStore.getState().syncDecks(deckDevices([xl], {}))
    expect(useStore.getState().devices.map((d) => d.id)).toEqual(['a', 'deck-xl1'])
    expect(useStore.getState().assignments['deck-xl1'].effectId).toBe('rainbow')
    useStore.getState().setEffect('deck-xl1', 'aurora')
    useStore.getState().syncDecks(deckDevices([{ ...xl, keys: [] }], {}))
    // a deck keeps its chosen effect when its keys change
    expect(useStore.getState().assignments['deck-xl1'].effectId).toBe('aurora')
    useStore.getState().selectDevice('deck-xl1')
    useStore.getState().syncDecks([])
    expect(useStore.getState().devices.map((d) => d.id)).toEqual(['a'])
    expect(useStore.getState().selectedDevice).toBe('a')
  })
})
