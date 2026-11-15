import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { defaultParams, effectById } from './effects'
import { ledsFor } from './layout'
import type { Assignment, Device, ParamValue, RGB } from './types'

/**
 * Zones: a canvas with devices placed on it (the inside of a case, a desk pad). One effect plays across the whole
 * canvas and every device shows the part of it under its LEDs, so a rainbow or falling code flows from one device
 * to the next. A zone can follow another zone's effect, so several canvases share one look. Devices that are not
 * in a zone keep their own effect, as before.
 *
 * Coordinates are in canvas units: the canvas is `aspect` wide and 1 tall, and a placement is a box centered at
 * (x, y), `w` by `h`, turned by `rot` degrees.
 */

export interface Placement {
  deviceId: string
  x: number
  y: number
  w: number
  h: number
  rot: number
}

export interface Zone {
  id: string
  name: string
  /** canvas width divided by its height */
  aspect: number
  effect: Assignment
  /** the zone whose effect this one plays, instead of its own */
  syncTo: string | null
  members: Placement[]
}

export const ASPECTS: { label: string; value: number }[] = [
  { label: 'Wide (16:10)', value: 1.6 },
  { label: 'Ultrawide (21:9)', value: 21 / 9 },
  { label: 'Square', value: 1 },
  { label: 'Tall (3:4, like a case)', value: 0.75 },
]

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** What a device measures on a canvas when first placed. */
export function defaultSize(d: Device): { w: number; h: number } {
  if (d.layout === 'ring') return { w: 0.24, h: 0.24 }
  // typical proportions of the real thing, as width by height in canvas units
  switch (d.kind) {
    case 'keyboard':
      return { w: 0.9, h: 0.3 }
    case 'mouse':
      return { w: 0.1, h: 0.18 }
    case 'gpu':
      return { w: 0.8, h: 0.22 }
    case 'ram':
      return { w: 0.28, h: 0.05 }
    case 'fan':
      return { w: 0.24, h: 0.24 }
    case 'strip':
      return { w: 0.6, h: 0.04 }
  }
  return d.layout === 'strip' ? { w: 0.6, h: 0.04 } : { w: 0.4, h: 0.2 }
}

/** Width over height of common components, for the proportions menu. */
export const RATIOS: { label: string; value: number }[] = [
  { label: 'Square (1:1)', value: 1 },
  { label: 'Standard (4:3)', value: 4 / 3 },
  { label: 'Wide (16:9)', value: 16 / 9 },
  { label: 'Keyboard (3:1)', value: 3 },
  { label: 'Graphics card (4:1)', value: 4 },
  { label: 'Memory stick (6:1)', value: 6 },
  { label: 'Light strip (15:1)', value: 15 },
  { label: 'Tall (1:3)', value: 1 / 3 },
]

/** Where an LED of a placed device sits on the zone's canvas, as 0 to 1 across and down it. */
export function ledPoint(p: Placement, lx: number, ly: number, aspect: number): [number, number] {
  const dx = (lx - 0.5) * p.w
  const dy = (ly - 0.5) * p.h
  const a = (p.rot * Math.PI) / 180
  const cx = p.x + dx * Math.cos(a) - dy * Math.sin(a)
  const cy = p.y + dx * Math.sin(a) + dy * Math.cos(a)
  return [clamp01(cx / aspect), clamp01(cy)]
}

/** The zone whose effect this zone plays: itself, or the end of its chain of followed zones. */
export function rootZone(zones: Zone[], zone: Zone): Zone {
  let z = zone
  for (let hops = 0; hops < zones.length && z.syncTo; hops++) {
    const next = zones.find((o) => o.id === z.syncTo)
    if (!next || next.id === zone.id) break
    z = next
  }
  return z
}

export const zoneEffect = (zones: Zone[], zone: Zone): Assignment => rootZone(zones, zone).effect

/** Which zone (and where in it) each device is placed. A device in two zones belongs to the first. */
export function memberMap(zones: Zone[]): Map<string, { zone: Zone; placement: Placement }> {
  const out = new Map<string, { zone: Zone; placement: Placement }>()
  for (const zone of zones) for (const placement of zone.members) if (!out.has(placement.deviceId)) out.set(placement.deviceId, { zone, placement })
  return out
}

/** The colors for one placed device: the zone's effect, sampled where each LED sits on the canvas. */
export function renderMember(a: Assignment, d: Device, p: Placement, aspect: number, t: number): RGB[] {
  const fx = effectById(a.effectId)
  const k = a.brightness / 100
  return ledsFor(d).map((led): RGB => {
    const [u, v] = ledPoint(p, led.x, led.y, aspect)
    // the effect sees the canvas, not the device: a strip placed on a desk has no "along" of its own
    const c = fx.render({ i: led.i, n: led.n, x: u, y: v }, t, a.params)
    return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]
  })
}

interface ZoneStore {
  zones: Zone[]
  add(name: string): string
  remove(id: string): void
  rename(id: string, name: string): void
  setAspect(id: string, aspect: number): void
  setSync(id: string, target: string | null): void
  place(zoneId: string, d: Device): void
  patchPlacement(deviceId: string, p: Partial<Omit<Placement, 'deviceId'>>): void
  unplace(deviceId: string): void
  setEffect(zoneId: string, effectId: string): void
  setParam(zoneId: string, key: string, value: ParamValue): void
  setBrightness(zoneId: string, value: number): void
}

let counter = 0
const newId = () => `zone-${Date.now().toString(36)}${(counter++).toString(36)}`

export const useZones = create<ZoneStore>()(
  persist(
    (set, get) => {
      /** Changes the effect of the zone that actually owns it (the one a synced zone follows). */
      const editEffect = (zoneId: string, fn: (a: Assignment) => Assignment) => {
        const { zones } = get()
        const zone = zones.find((z) => z.id === zoneId)
        if (!zone) return
        const root = rootZone(zones, zone)
        set({ zones: zones.map((z) => (z.id === root.id ? { ...z, effect: fn(z.effect) } : z)) })
      }
      return {
        zones: [],
        add: (name) => {
          const id = newId()
          const zone: Zone = {
            id,
            name,
            aspect: 1.6,
            effect: { effectId: 'rainbow', params: defaultParams('rainbow'), brightness: 100 },
            syncTo: null,
            members: [],
          }
          set({ zones: [...get().zones, zone] })
          return id
        },
        remove: (id) =>
          set({ zones: get().zones.filter((z) => z.id !== id).map((z) => (z.syncTo === id ? { ...z, syncTo: null } : z)) }),
        rename: (id, name) => set({ zones: get().zones.map((z) => (z.id === id ? { ...z, name } : z)) }),
        setAspect: (id, aspect) =>
          set({
            zones: get().zones.map((z) => {
              if (z.id !== id || aspect === z.aspect) return z
              // keep every device at the same relative place when the canvas changes shape
              const r = aspect / z.aspect
              return { ...z, aspect, members: z.members.map((m) => ({ ...m, x: m.x * r })) }
            }),
          }),
        setSync: (id, target) => {
          const { zones } = get()
          const zone = zones.find((z) => z.id === id)
          if (!zone) return
          // following a zone that already follows this one would go in a circle
          if (target !== null) {
            const other = zones.find((z) => z.id === target)
            if (!other || other.id === id || rootZone(zones, other).id === id) return
          }
          set({ zones: zones.map((z) => (z.id === id ? { ...z, syncTo: target } : z)) })
        },
        place: (zoneId, d) => {
          const { zones } = get()
          const size = defaultSize(d)
          set({
            zones: zones.map((z) => {
              const without = z.members.filter((m) => m.deviceId !== d.id)
              if (z.id !== zoneId) return { ...z, members: without }
              // new devices fan out from the middle so they do not land exactly on top of each other
              const nudge = (without.length % 5) * 0.04
              const placement: Placement = { deviceId: d.id, x: z.aspect / 2 + nudge, y: 0.5 + nudge, ...size, rot: 0 }
              return { ...z, members: [...without, placement] }
            }),
          })
        },
        patchPlacement: (deviceId, p) =>
          set({ zones: get().zones.map((z) => ({ ...z, members: z.members.map((m) => (m.deviceId === deviceId ? { ...m, ...p } : m)) })) }),
        unplace: (deviceId) => set({ zones: get().zones.map((z) => ({ ...z, members: z.members.filter((m) => m.deviceId !== deviceId) })) }),
        setEffect: (zoneId, effectId) => editEffect(zoneId, (a) => ({ ...a, effectId, params: defaultParams(effectId) })),
        setParam: (zoneId, key, value) => editEffect(zoneId, (a) => ({ ...a, params: { ...a.params, [key]: value } })),
        setBrightness: (zoneId, value) => editEffect(zoneId, (a) => ({ ...a, brightness: value })),
      }
    },
    { name: 'lfa-zones', partialize: (s) => ({ zones: s.zones }) },
  ),
)
