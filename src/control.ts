import { deckDevices, useDecks, type DeckReport } from './lib/deckState'
import { EFFECTS } from './lib/effects'
import { IS_TAURI, invoke } from './lib/hybrid'
import type { FanMode } from './lib/types'
import { kindEnabled, useSettings } from './settings'
import { useStore } from './store'

/**
 * Bridge for the local control API (see src-tauri/src/control.rs), used by the Stream Deck plugin.
 * It publishes a snapshot about once a second and carries out the few commands the API accepts.
 * Commands are checked here as well: unknown fields and values are ignored, and nothing sets a fan speed.
 */

const PUBLISH_MS = 1000

export interface Snapshot {
  v: 1
  at: number
  sensors: { id: string; name: string; value: number }[]
  fans: { id: string; name: string; kind: string; rpm: number; pct: number; mode: FanMode; controlled: boolean; warning?: string; note?: string }[]
  devices: { id: string; name: string; kind: string; effectId: string; brightness: number }[]
  effects: { id: string; name: string }[]
}

export function snapshot(): Snapshot {
  const { sensors, live, rawFans, fans, fanInfo, devices, assignments } = useStore.getState()
  const prefs = useSettings.getState()
  return {
    v: 1,
    at: Date.now(),
    sensors: sensors.map((s) => ({ id: s.id, name: s.name, value: s.value })),
    // every fan is listed so it can be shown; only those the app controls can be commanded
    fans: fanInfo.map((i) => {
      const controlled = kindEnabled(i.kind, prefs)
      const l = live[i.id]
      const raw = rawFans.find((x) => x.id === i.id)
      return {
        id: i.id,
        name: i.name,
        kind: i.kind,
        rpm: l?.rpm ?? raw?.rpm ?? 0,
        pct: Math.round(l?.pct ?? raw?.pct ?? 0),
        mode: fans.find((f) => f.id === i.id)?.mode ?? 'curve',
        controlled,
        warning: l?.warning,
        note: l?.note,
      }
    }),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      effectId: assignments[d.id]?.effectId ?? '',
      brightness: assignments[d.id]?.brightness ?? 100,
    })),
    effects: EFFECTS.filter((e) => !e.screenOnly).map((e) => ({ id: e.id, name: e.name })),
  }
}

/** Fan mode before "full speed" was switched on from outside, so toggling restores it. */
const modeBefore = new Map<string, FanMode>()

function targetDevices(device: unknown): string[] {
  const all = useStore.getState().devices.map((d) => d.id)
  if (device === 'all' || device === undefined) return all
  return typeof device === 'string' && all.includes(device) ? [device] : []
}

function targetFans(fan: unknown): string[] {
  const { fans, fanInfo } = useStore.getState()
  const prefs = useSettings.getState()
  const kinds = new Map(fanInfo.map((i) => [i.id, i.kind]))
  const usable = fans.filter((f) => {
    const kind = kinds.get(f.id)
    return kind !== undefined && kindEnabled(kind, prefs)
  })
  if (fan === 'all' || fan === undefined) return usable.map((f) => f.id)
  return usable.some((f) => f.id === fan) ? [fan as string] : []
}

export function runCommand(c: Record<string, unknown>) {
  const store = useStore.getState()
  switch (c.cmd) {
    case 'effect': {
      if (typeof c.effect !== 'string' || !EFFECTS.some((e) => e.id === c.effect && !e.screenOnly)) return
      store.setEffectFor(targetDevices(c.device), c.effect)
      return
    }
    case 'brightness': {
      const ids = targetDevices(c.device)
      if (typeof c.value === 'number' && Number.isFinite(c.value)) {
        store.setBrightnessFor(ids, Math.min(100, Math.max(0, Math.round(c.value))))
      } else if (typeof c.delta === 'number' && Number.isFinite(c.delta)) {
        // relative changes apply to each device separately, so a mixed set keeps its differences
        for (const id of ids) {
          const now = store.assignments[id]?.brightness ?? 100
          store.setBrightnessFor([id], Math.min(100, Math.max(0, Math.round(now + (c.delta as number)))))
        }
      }
      return
    }
    case 'fanMode': {
      if (c.mode !== 'curve' && c.mode !== 'full' && c.mode !== 'toggle') return
      for (const id of targetFans(c.fan)) {
        const f = useStore.getState().fans.find((x) => x.id === id)
        if (!f) continue
        const want: FanMode = c.mode === 'toggle' ? (f.mode === 'full' ? (modeBefore.get(id) ?? 'curve') : 'full') : c.mode
        if (want === f.mode) continue
        if (want === 'full') modeBefore.set(id, f.mode)
        store.patchFan(id, { mode: want })
      }
      return
    }
  }
}

/** Checks a deck report from the plugin: sizes and keys must be sane, so a bad report cannot create a huge device. */
export function parseDecks(payload: unknown): DeckReport[] {
  const list = (payload as { decks?: unknown } | null)?.decks
  if (!Array.isArray(list)) return []
  const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined)
  const out: DeckReport[] = []
  for (const d of list.slice(0, 8)) {
    const columns = int(d?.columns, 1, 16)
    const rows = int(d?.rows, 1, 8)
    if (typeof d?.id !== 'string' || !d.id || d.id.length > 80 || columns === undefined || rows === undefined) continue
    const seen = new Set<string>()
    const keys: DeckReport['keys'] = []
    for (const k of Array.isArray(d.keys) ? d.keys.slice(0, columns * rows) : []) {
      const column = int(k?.column, 0, columns - 1)
      const row = int(k?.row, 0, rows - 1)
      if (column === undefined || row === undefined || seen.has(column + ',' + row)) continue
      seen.add(column + ',' + row)
      keys.push({ column, row })
    }
    out.push({ id: d.id, name: typeof d.name === 'string' && d.name ? d.name.slice(0, 60) : 'Stream Deck', columns, rows, keys })
  }
  return out
}

/** Brings the Stream Deck devices in the lighting list in line with the decks and settings. */
function syncDecks() {
  const { decks, settings } = useDecks.getState()
  useStore.getState().syncDecks(deckDevices(decks, settings))
}

const sameDecks = (a: DeckReport[], b: DeckReport[]) => JSON.stringify(a) === JSON.stringify(b)
/** The plugin reports about every 5 seconds; this long without one and its decks are gone. */
const DECKS_STALE_MS = 20000

let started = false
export function startControl() {
  if (started) return
  started = true
  // device list follows the decks and their settings
  let last = ''
  useDecks.subscribe((s) => {
    const key = JSON.stringify([s.decks, s.settings])
    if (key !== last) {
      last = key
      syncDecks()
    }
  })
  if (!IS_TAURI) return
  setInterval(() => {
    if (useStore.getState().ready) void invoke('control_publish', { json: JSON.stringify(snapshot()) }).catch(() => undefined)
  }, PUBLISH_MS)
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen<Record<string, unknown>>('control-command', (e) => {
      if (e.payload && typeof e.payload === 'object') runCommand(e.payload)
    })
    void listen<unknown>('decks-report', (e) => {
      const next = parseDecks(e.payload)
      const prev = useDecks.getState().decks
      useDecks.getState().setDecks(sameDecks(prev, next) ? prev : next) // a repeat report only refreshes the clock
    })
  })
  setInterval(() => {
    const { decks, seenAt, setDecks } = useDecks.getState()
    if (decks.length && performance.now() - seenAt > DECKS_STALE_MS) setDecks([])
  }, 5000)
}
