import type { Assignment, Backend, Device, DeviceKind, FanInfo, HardwareState, RGB, Sensor } from './types'
import type { InvokeArgs } from '@tauri-apps/api/core'
import { hwEffectFor } from './hwEffects'
import { Q6_ANSI_POSITIONS } from './keychronQ6'
import { SimBackend } from './sim'
import { simulatorActive, useSettings } from '../settings'

interface RgbDevice {
  index: number
  name: string
  kind: number
  led_count: number
  cols: number | null
  zones: { name: string; led_count: number; min_leds: number; max_leds: number }[]
}

const ZONES_KEY = 'lfa-zone-sizes'
const zoneKey = (device: string, zone: string) => `${device}|${zone}`
function savedZones(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(ZONES_KEY) ?? '{}')
  } catch {
    return {}
  }
}

const KIND: Record<number, DeviceKind> = { 1: 'ram', 2: 'gpu', 3: 'fan', 4: 'strip', 5: 'keyboard', 6: 'mouse' }

interface HwRaw {
  sensors: Sensor[]
  fans: { id: string; name: string; rpm: number; pct: number }[]
}

export type HwState = 'off' | 'connecting' | 'on' | 'error'

export const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/**
 * Lighting comes from a running OpenRGB server when the app runs inside Tauri; everything else
 * (and lighting when OpenRGB is unreachable) falls back to the simulator.
 */
export class HybridBackend implements Backend {
  readonly sim = new SimBackend()
  rgbError: string | null = null
  private rgbDevices = new Map<string, number>()
  private pending = new Map<number, number[]>()
  private listeners = new Set<() => void>()

  hwState: HwState = 'off'
  hwError: string | null = null
  hwElevated = false
  private hwRaw: HwRaw | null = null
  private hwSet = new Map<string, number>()

  constructor() {
    if (IS_TAURI) setInterval(() => void this.flush(), 50)
  }

  get rgbConnected() {
    return this.rgbDevices.size > 0
  }
  get hwOn() {
    return this.hwState === 'on'
  }
  /** Fan control is wanted whenever the setting is on and we are not pretending. */
  get hwWanted() {
    return IS_TAURI && useSettings.getState().controlFans && !this.simActive
  }
  /** Fake devices, fans and temperatures stand in for hardware (browser, or the developer switch). */
  get simActive() {
    return simulatorActive(IS_TAURI)
  }
  get rgbCount() {
    return this.rgbDevices.size
  }

  /** Starts the elevated sidecar (UAC prompt) and switches fans and sensors to real hardware. */
  async enableHw() {
    if (!IS_TAURI) return
    this.hwState = 'connecting'
    this.hwError = null
    this.changed()
    try {
      this.hwElevated = await invoke<boolean>('hw_start', { lhmDir: useSettings.getState().lhmDir || null })
      // starting the fan service opens the cooler's USB link, which resets its lighting: apply it again
      this.hwKeys.clear()
      this.hwRaw = await invoke<HwRaw>('hw_apply', { set: [] })
      this.hwState = 'on'
    } catch (e) {
      this.hwState = 'error'
      this.hwError = String(e)
    }
    this.changed()
  }

  async disableHw() {
    try {
      await invoke('hw_stop')
    } catch {
      /* already gone */
    }
    this.hwState = 'off'
    this.hwRaw = null
    this.changed()
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  private changed() {
    this.listeners.forEach((f) => f())
  }

  async listDevices(): Promise<Device[]> {
    const rgb = await this.listRgb()
    const via = await this.listVia()

    // Newer OpenRGB builds list the same Keychron keyboard we can already talk to directly. One keyboard
    // must not appear twice, and two programs must not both drive it: keep the per-key direct connection
    // (real key positions, whole-frame updates), otherwise keep whichever of the two is richer.
    const same = (a: string, b: string) => norm(a) === norm(b)
    const perKey = via.filter((v) => v.layout === 'custom')
    const rgbKept = rgb.filter((d) => !perKey.some((v) => same(v.name, d.name)))
    const viaKept = via.filter((v) => v.layout === 'custom' || !rgbKept.some((d) => same(v.name, d.name)))

    const all = [...rgbKept, ...viaKept]
    return all.length || !this.simActive ? all : this.sim.listDevices()
  }

  private viaPaths = new Map<string, string>()
  private viaPerKey = new Set<string>()
  private viaFrames = new Map<string, number[]>()
  private viaFrameSent = new Map<string, number[]>()
  private viaPending = new Map<string, [number, number, number]>()
  private viaSent = new Map<string, string>()

  /** QMK/VIA keyboards (e.g. Keychron Q-series on stock firmware): one color for the whole board. */
  private async listVia(): Promise<Device[]> {
    this.viaPaths.clear()
    this.viaPerKey.clear()
    if (!IS_TAURI) return []
    try {
      const found = await invoke<{ path: string; name: string; per_key: boolean; led_count: number }[]>('via_list')
      const ids = stableIds(found).map((id) => id.replace('rgb-', 'via-'))
      return found.map((k, i): Device => {
        this.viaPaths.set(ids[i], k.path)
        const q6 = k.per_key && /Q6/i.test(k.name) && k.led_count === Q6_ANSI_POSITIONS.length
        if (q6) {
          this.viaPerKey.add(ids[i])
          return {
            id: ids[i],
            name: k.name,
            kind: 'keyboard',
            layout: 'custom',
            ledCount: k.led_count,
            positions: Q6_ANSI_POSITIONS.map(([x, y]) => [x / 224, y / 64] as [number, number]),
          }
        }
        return {
          id: ids[i],
          name: k.name,
          kind: 'keyboard',
          layout: 'grid',
          cols: 18,
          ledCount: 108,
          note: 'Stock firmware can only show one color at a time, so the keyboard shows the average of this preview.',
        }
      })
    } catch {
      return []
    }
  }

  private async listRgb(): Promise<Device[]> {
    if (IS_TAURI) {
      try {
        let found = await invoke<RgbDevice[]>('openrgb_connect')
        // addressable headers (e.g. motherboard fan lights) report 0 LEDs until told how many
        const wanted = savedZones()
        let resized = false
        for (const d of found) {
          for (const [zi, z] of d.zones.entries()) {
            const n = wanted[zoneKey(d.name, z.name)]
            if (n !== undefined && n !== z.led_count && n >= z.min_leds && n <= z.max_leds) {
              await invoke('openrgb_resize_zone', { device: d.index, zone: zi, count: n })
              resized = true
            }
          }
        }
        if (resized) found = await invoke<RgbDevice[]>('openrgb_connect')
        this.rgbError = null
        const ids = stableIds(found)
        this.rgbDevices = new Map(found.map((d, k) => [ids[k], d.index]))
        this.rgbNames = new Map(found.map((d) => [d.index, d.name]))
        this.hwDevices = new Set(found.filter((d) => /kraken/i.test(d.name)).map((d) => ids[found.indexOf(d)]))
        this.hwKeys.clear()
        this.hwFallback.clear()
        this.pending.clear()
        this.sent.clear()
        this.changed()
        if (found.length) {
          return found.map((d): Device => ({
            id: ids[found.indexOf(d)],
            name: d.name,
            note: /kraken/i.test(d.name)
              ? 'Runs the cooler\'s own built-in effects, so its motion cannot be kept in step with other devices. Solid colors match.'
              : undefined,
            kind: KIND[d.kind] ?? 'strip',
            layout: d.cols ? 'grid' : d.kind === 3 ? 'ring' : 'strip',
            ledCount: d.led_count,
            cols: d.cols ?? undefined,
            zones: d.zones.map((z, index) => ({
              index,
              name: z.name,
              ledCount: z.led_count,
              min: z.min_leds,
              max: z.max_leds,
            })),
          }))
        }
      } catch (e) {
        this.rgbError = String(e)
        this.rgbDevices.clear()
        this.changed()
      }
    }
    return []
  }

  /** Remembers and applies how many LEDs a resizable zone drives. Re-list devices afterwards. */
  async resizeZone(device: Device, zone: number, count: number) {
    const idx = this.rgbDevices.get(device.id)
    if (idx === undefined) return
    await invoke('openrgb_resize_zone', { device: idx, zone, count })
    const saved = savedZones()
    saved[zoneKey(device.name, device.zones![zone].name)] = count
    try {
      localStorage.setItem(ZONES_KEY, JSON.stringify(saved))
    } catch {
      /* not persisted */
    }
  }

  /** Devices that animate on their own (the Kraken) get a built-in effect instead of streamed frames. */
  private hwDevices = new Set<string>()
  private hwFallback = new Set<string>()
  private hwKeys = new Map<string, string>()
  private hwTimers = new Map<string, number>()

  /** Called with every device's current effect; only devices that animate on their own act on it. */
  syncEffect(id: string, a: Assignment) {
    if (!this.hwDevices.has(id)) return
    const key = JSON.stringify([a.effectId, a.params, a.brightness])
    if (this.hwKeys.get(id) === key) return
    this.hwKeys.set(id, key)
    window.clearTimeout(this.hwTimers.get(id))
    // a slider drag changes the effect many times a second; settle before talking to the device
    this.hwTimers.set(id, window.setTimeout(() => void this.applyHwEffect(id, a), 300))
  }

  /** Recent built-in effect results, readable from the developer console as window.__lfaHw. */
  private hwLog(line: string) {
    const w = window as unknown as { __lfaHw?: string[] }
    ;(w.__lfaHw ??= []).push(`${new Date().toISOString().slice(11, 19)} ${line}`)
    if (w.__lfaHw.length > 50) w.__lfaHw.shift()
  }

  private async applyHwEffect(id: string, a: Assignment) {
    const idx = this.rgbDevices.get(id)
    if (idx === undefined) return
    const fx = hwEffectFor(a.effectId, a.params)
    for (const mode of fx.modes) {
      try {
        await invoke('openrgb_set_mode', {
          device: idx,
          mode,
          speed: fx.speed ?? null,
          brightness: a.brightness / 100,
          colors: fx.colors ?? [],
        })
        this.hwFallback.delete(id)
        this.hwLog(`${a.effectId} -> ${mode} ok`)
        return
      } catch (e) {
        /* this device has no such mode: try the next one */
        this.hwLog(`${a.effectId} -> ${mode} failed: ${String(e)}`)
      }
    }
    this.hwFallback.add(id) // nothing close enough: stream frames, slowly
  }

  setLeds(id: string, colors: RGB[]) {
    if (this.hwDevices.has(id) && !this.hwFallback.has(id)) return
    if (this.viaPerKey.has(id)) {
      this.viaFrames.set(id, colors.flat())
      return
    }
    if (this.viaPaths.has(id)) {
      const sum = [0, 0, 0]
      for (const c of colors) for (let k = 0; k < 3; k++) sum[k] += c[k]
      const n = Math.max(1, colors.length)
      this.viaPending.set(id, [Math.round(sum[0] / n), Math.round(sum[1] / n), Math.round(sum[2] / n)])
      return
    }
    const idx = this.rgbDevices.get(id)
    if (idx === undefined) return this.sim.setLeds(id, colors)
    this.pending.set(idx, colors.flat())
  }

  private async flushVia() {
    for (const [id, rgb] of this.viaFrames) {
      const prev = this.viaFrameSent.get(id)
      if (prev && prev.length === rgb.length && prev.every((v, k) => v === rgb[k])) continue
      try {
        await invoke('via_leds', { path: this.viaPaths.get(id), rgb })
        this.viaFrameSent.set(id, rgb)
      } catch {
        this.viaFrameSent.delete(id) // retry next frame
      }
    }
    this.viaFrames.clear()
    for (const [id, rgb] of this.viaPending) {
      const key = rgb.join(',')
      if (this.viaSent.get(id) === key) continue
      this.viaSent.set(id, key)
      try {
        await invoke('via_color', { path: this.viaPaths.get(id), r: rgb[0], g: rgb[1], b: rgb[2] })
      } catch {
        this.viaSent.delete(id) // retry next frame
      }
    }
    this.viaPending.clear()
  }

  private sent = new Map<number, number[]>()
  private flushing = false

  private async flush() {
    // one frame in flight at a time: OpenRGB has no back-pressure, so a slow device (motherboard
    // controllers, coolers) would otherwise fall seconds behind
    if (this.flushing) return
    this.flushing = true
    try {
      await this.flushVia()
      await this.flushRgb()
    } finally {
      this.flushing = false
    }
  }

  private lastRgbAt = new Map<number, number>()
  private rgbNames = new Map<number, string>()

  /**
   * The Kraken applies lighting updates slowly: tested on a 2024 Elite, its ring follows one update a second
   * but ignores faster ones (four a second left it on a stale color), and the flood also starves the
   * fan control that shares its USB link. Everything else takes frames at full speed.
   */
  private rgbInterval(idx: number) {
    return /kraken|nzxt/i.test(this.rgbNames.get(idx) ?? '') ? 1000 : 0
  }

  private async flushRgb() {
    if (!this.pending.size || !this.rgbConnected) return
    const now = performance.now()
    const frames: [number, number[]][] = []
    const later = new Map<number, number[]>()
    for (const [i, rgb] of this.pending) {
      if (now - (this.lastRgbAt.get(i) ?? 0) < this.rgbInterval(i)) {
        later.set(i, rgb) // too soon for this device; the newest frame goes out next time
        continue
      }
      const prev = this.sent.get(i)
      const changed = !prev || prev.length !== rgb.length || prev.some((v, k) => v !== rgb[k])
      // many controllers fall back to their own effect if they hear nothing for a few seconds, so a
      // steady color is repeated now and then
      const stale = now - (this.lastRgbAt.get(i) ?? 0) > KEEPALIVE_MS
      if (changed || stale) frames.push([i, rgb])
    }
    this.pending = later
    if (!frames.length) return
    try {
      await invoke('openrgb_update', { frames })
      for (const [i, rgb] of frames) {
        this.sent.set(i, rgb)
        this.lastRgbAt.set(i, now)
      }
    } catch (e) {
      // the Rust side dropped the connection; the user can retry from the status chip
      this.rgbError = String(e)
      this.rgbDevices.clear()
      this.sent.clear()
      this.changed()
    }
  }

  listFans(): Promise<FanInfo[]> {
    if (!this.hwOn || !this.hwRaw) return this.simActive ? this.sim.listFans() : Promise.resolve([])
    const { sensors, fans } = this.hwRaw
    const find = (re: RegExp) => sensors.find((s) => re.test(s.name))?.id
    return Promise.resolve(
      fans.map((f): FanInfo => {
        const kind = f.id.startsWith('/gpu') ? 'gpu' : /pump/i.test(f.name) ? 'pump' : 'case'
        const sensorId =
          kind === 'pump'
            ? (find(/liquid|coolant|water/i) ?? find(/CPU/i))
            : kind === 'gpu'
              ? find(/GPU Core/i)
              : (find(/CPU.*(package|tctl|die)/i) ?? find(/liquid|coolant|water/i))
        return { id: f.id, name: f.name, kind, maxRpm: 0, sensorId: sensorId ?? sensors[0]?.id ?? '' }
      }),
    )
  }

  private hwRelease = new Set<string>()

  /** Hands one fan back to its own firmware control (used when a fan group is switched off). */
  releaseFan(id: string) {
    this.hwSet.delete(id)
    if (this.hwOn) this.hwRelease.add(id)
  }

  setFan(id: string, pct: number) {
    if (this.hwOn) this.hwSet.set(id, pct)
    else if (this.simActive) this.sim.setFan(id, pct)
  }
  async readState(): Promise<HardwareState> {
    if (!this.hwOn) return this.simActive ? this.sim.readState() : { sensors: [], fans: [] }
    const set = [...this.hwSet]
    const release = [...this.hwRelease]
    this.hwSet.clear()
    this.hwRelease.clear()
    try {
      this.hwRaw = await invoke<HwRaw>('hw_apply', { set, release })
      return { sensors: this.hwRaw.sensors, fans: this.hwRaw.fans.map((f) => ({ id: f.id, rpm: f.rpm, pct: f.pct })) }
    } catch (e) {
      // sidecar is gone and has already returned fans to firmware control
      this.hwState = 'error'
      this.hwError = String(e)
      this.changed()
      return { sensors: [], fans: [] }
    }
  }
}

const KEEPALIVE_MS = 2000

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * OpenRGB numbers devices in detection order, which shifts when a device appears or disappears.
 * Ids built from the name (plus a counter for identical devices) keep saved settings attached.
 */
function stableIds(devs: { name: string }[]): string[] {
  const seen = new Map<string, number>()
  return devs.map((d) => {
    const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const n = seen.get(slug) ?? 0
    seen.set(slug, n + 1)
    return `rgb-${slug}-${n}`
  })
}
