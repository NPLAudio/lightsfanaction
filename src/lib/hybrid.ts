import type { Backend, Device, DeviceKind, FanInfo, HardwareState, RGB, Sensor } from './types'
import type { InvokeArgs } from '@tauri-apps/api/core'
import { Q6_ANSI_POSITIONS } from './keychronQ6'
import { SimBackend } from './sim'

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
const HW_FLAG = 'lfa-hw'

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
  get hwWanted() {
    try {
      return localStorage.getItem(HW_FLAG) === '1'
    } catch {
      return false
    }
  }
  get name() {
    const lights = this.rgbConnected ? `OpenRGB · ${this.rgbDevices.size} devices` : IS_TAURI ? 'OpenRGB not found' : 'simulated lights'
    const fans =
      this.hwState === 'on' ? 'hardware fans' : this.hwState === 'connecting' ? 'starting fan control…' : 'simulated fans'
    return `${lights} · ${fans}`
  }
  get simulated() {
    return !this.rgbConnected || !this.hwOn
  }

  /** Starts the elevated sidecar (UAC prompt) and switches fans and sensors to real hardware. */
  async enableHw() {
    if (!IS_TAURI) return
    this.hwState = 'connecting'
    this.hwError = null
    this.changed()
    try {
      this.hwElevated = await invoke<boolean>('hw_start')
      this.hwRaw = await invoke<HwRaw>('hw_apply', { set: [] })
      this.hwState = 'on'
      localStorage.setItem(HW_FLAG, '1')
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
    try {
      localStorage.removeItem(HW_FLAG)
    } catch {
      /* ignore */
    }
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
    const all = [...(await this.listRgb()), ...(await this.listVia())]
    return all.length ? all : this.sim.listDevices()
  }

  private viaPaths = new Map<string, string>()
  private viaPerKey = new Set<string>()
  private viaFrames = new Map<string, number[]>()
  private viaFrameSent = new Map<string, number[]>()
  private viaPending = new Map<string, [number, number, number]>()
  private viaSent = new Map<string, string>()

  /** QMK/VIA keyboards (e.g. Keychron Q-series on stock firmware): one colour for the whole board. */
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
          note: 'Stock firmware can only show one colour at a time, so the keyboard shows the average of this preview.',
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
        this.pending.clear()
        this.sent.clear()
        this.changed()
        if (found.length) {
          return found.map((d): Device => ({
            id: ids[found.indexOf(d)],
            name: d.name,
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

  setLeds(id: string, colors: RGB[]) {
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

  private async flushRgb() {
    if (!this.pending.size || !this.rgbConnected) return
    const frames: [number, number[]][] = []
    for (const [i, rgb] of this.pending) {
      const prev = this.sent.get(i)
      if (!prev || prev.length !== rgb.length || prev.some((v, k) => v !== rgb[k])) frames.push([i, rgb])
    }
    this.pending.clear()
    if (!frames.length) return
    try {
      await invoke('openrgb_update', { frames })
      for (const [i, rgb] of frames) this.sent.set(i, rgb)
    } catch (e) {
      // the Rust side dropped the connection; the user can retry from the status chip
      this.rgbError = String(e)
      this.rgbDevices.clear()
      this.sent.clear()
      this.changed()
    }
  }

  listFans(): Promise<FanInfo[]> {
    if (!this.hwOn || !this.hwRaw) return this.sim.listFans()
    const { sensors, fans } = this.hwRaw
    const find = (re: RegExp) => sensors.find((s) => re.test(s.name))?.id
    return Promise.resolve(
      fans.map((f): FanInfo => {
        const sensorId = /pump/i.test(f.name)
          ? (find(/liquid|coolant|water/i) ?? find(/CPU/i))
          : /gpu/i.test(f.name)
            ? find(/GPU Core/i)
            : (find(/CPU.*(package|tctl|die)/i) ?? find(/liquid|coolant|water/i))
        return { id: f.id, name: f.name, maxRpm: 0, sensorId: sensorId ?? sensors[0]?.id ?? '' }
      }),
    )
  }
  setFan(id: string, pct: number) {
    if (this.hwOn) this.hwSet.set(id, pct)
    else this.sim.setFan(id, pct)
  }
  async readState(): Promise<HardwareState> {
    if (!this.hwOn) return this.sim.readState()
    const set = [...this.hwSet]
    this.hwSet.clear()
    try {
      this.hwRaw = await invoke<HwRaw>('hw_apply', { set })
      return { sensors: this.hwRaw.sensors, fans: this.hwRaw.fans.map((f) => ({ id: f.id, rpm: f.rpm })) }
    } catch (e) {
      // sidecar is gone and has already returned fans to firmware control
      this.hwState = 'error'
      this.hwError = String(e)
      this.changed()
      return { sensors: [], fans: [] }
    }
  }
}

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
