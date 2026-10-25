import type { Backend, Device, DeviceKind, FanInfo, HardwareState, RGB, Sensor } from './types'
import type { InvokeArgs } from '@tauri-apps/api/core'
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
    if (IS_TAURI) setInterval(() => void this.flush(), 33)
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
        this.rgbDevices = new Map(found.map((d) => [`rgb-${d.index}`, d.index]))
        this.pending.clear()
        this.changed()
        if (found.length) {
          return found.map((d): Device => ({
            id: `rgb-${d.index}`,
            name: d.name,
            kind: KIND[d.kind] ?? 'strip',
            layout: d.cols ? 'grid' : d.kind === 3 || /kraken/i.test(d.name) ? 'ring' : 'strip',
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
    return this.sim.listDevices()
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
    const idx = this.rgbDevices.get(id)
    if (idx === undefined) return this.sim.setLeds(id, colors)
    this.pending.set(idx, colors.flat())
  }

  private async flush() {
    if (!this.pending.size || !this.rgbConnected) return
    const frames = [...this.pending].map(([i, rgb]) => [i, rgb])
    this.pending.clear()
    try {
      await invoke('openrgb_update', { frames })
    } catch (e) {
      // the Rust side dropped the connection; the user can retry from the status chip
      this.rgbError = String(e)
      this.rgbDevices.clear()
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
