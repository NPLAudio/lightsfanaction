import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { backend } from './lib/backend'
import { CURVE_PRESETS } from './lib/curve'
import { defaultParams } from './lib/effects'
import type { Assignment, CurvePoint, Device, FanConfig, FanInfo, FanLive, ParamValue, Sensor } from './lib/types'

interface State {
  devices: Device[]
  fanInfo: FanInfo[]
  ready: boolean
  assignments: Record<string, Assignment>
  selectedDevice: string
  syncAll: boolean
  fans: FanConfig[]
  selectedFan: string
  sensors: Sensor[]
  live: Record<string, FanLive>
  lcdLive: boolean
  lcdError: string | null

  init(): Promise<void>
  selectDevice(id: string): void
  setSyncAll(v: boolean): void
  setEffect(deviceId: string, effectId: string): void
  setParam(deviceId: string, key: string, value: ParamValue): void
  setBrightness(deviceId: string, v: number): void
  selectFan(id: string): void
  patchFan(id: string, patch: Partial<FanConfig>): void
  setCurve(id: string, curve: CurvePoint[]): void
  setLive(sensors: Sensor[], live: Record<string, FanLive>): void
  setLcdLive(on: boolean): void
  setLcdError(e: string | null): void
}

const newAssignment = (effectId: string): Assignment => ({ effectId, params: defaultParams(effectId), brightness: 100 })

const defaultFan = (f: FanInfo): FanConfig => ({
  id: f.id,
  name: f.name,
  sensorId: f.sensorId,
  mode: 'curve',
  curve: CURVE_PRESETS.Balanced.map((p) => ({ ...p })),
  manual: 50,
  minPct: /pump/i.test(f.name) ? 60 : 20,
  hysteresis: 3,
  ramp: 15,
})

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      devices: [],
      fanInfo: [],
      ready: false,
      assignments: {},
      selectedDevice: '',
      syncAll: false,
      fans: [],
      selectedFan: '',
      sensors: [],
      live: {},
      lcdLive: false,
      lcdError: null,

      async init() {
        const [devices, fanInfo] = await Promise.all([backend.listDevices(), backend.listFans()])
        const { assignments, fans, selectedDevice, selectedFan } = get()
        const a = { ...assignments }
        for (const d of devices) a[d.id] ??= newAssignment(d.kind === 'fan' ? 'spin' : 'rainbow')
        const f = fanInfo.map((i) => fans.find((x) => x.id === i.id) ?? defaultFan(i))
        set({
          devices,
          fanInfo,
          assignments: a,
          fans: f,
          selectedDevice: devices.some((d) => d.id === selectedDevice) ? selectedDevice : (devices[0]?.id ?? ''),
          selectedFan: f.some((x) => x.id === selectedFan) ? selectedFan : (f[0]?.id ?? ''),
          ready: true,
        })
      },

      selectDevice: (id) => set({ selectedDevice: id }),
      setSyncAll: (syncAll) => set({ syncAll }),

      setEffect(deviceId, effectId) {
        const { devices, syncAll, assignments } = get()
        const a = { ...assignments }
        for (const id of syncAll ? devices.map((d) => d.id) : [deviceId]) {
          a[id] = { ...newAssignment(effectId), brightness: a[id]?.brightness ?? 100 }
        }
        set({ assignments: a })
      },

      setParam(deviceId, key, value) {
        const { devices, syncAll, assignments } = get()
        const a = { ...assignments }
        const src = a[deviceId]
        for (const id of syncAll ? devices.map((d) => d.id) : [deviceId]) {
          if (a[id].effectId === src.effectId) a[id] = { ...a[id], params: { ...a[id].params, [key]: value } }
        }
        set({ assignments: a })
      },

      setBrightness(deviceId, v) {
        const { devices, syncAll, assignments } = get()
        const a = { ...assignments }
        for (const id of syncAll ? devices.map((d) => d.id) : [deviceId]) a[id] = { ...a[id], brightness: v }
        set({ assignments: a })
      },

      selectFan: (id) => set({ selectedFan: id }),
      patchFan: (id, patch) => set({ fans: get().fans.map((f) => (f.id === id ? { ...f, ...patch } : f)) }),
      setCurve: (id, curve) => get().patchFan(id, { curve }),
      setLive: (sensors, live) => set({ sensors, live }),
      setLcdLive: (lcdLive) => set({ lcdLive }),
      setLcdError: (lcdError) => set({ lcdError }),
    }),
    {
      name: 'lightsfanaction',
      partialize: (s) => ({
        assignments: s.assignments,
        selectedDevice: s.selectedDevice,
        syncAll: s.syncAll,
        fans: s.fans,
        selectedFan: s.selectedFan,
        lcdLive: s.lcdLive,
      }),
    },
  ),
)
