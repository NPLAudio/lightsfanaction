import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { backend } from './lib/backend'
import { CURVE_PRESETS, PUMP_MIN_PCT } from './lib/curve'
import { defaultParams, effectById } from './lib/effects'
import type {
  Assignment,
  CurvePoint,
  Device,
  FanCalibration,
  FanConfig,
  FanInfo,
  FanLive,
  HardwareState,
  ParamValue,
  Sensor,
} from './lib/types'

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
  /** Every fan reading, including fans left to their firmware (which have no `live` entry). */
  rawFans: HardwareState['fans']
  calibrations: Record<string, FanCalibration>
  lcdError: string | null

  init(): Promise<void>
  selectDevice(id: string): void
  setSyncAll(v: boolean): void
  setEffect(deviceId: string, effectId: string): void
  /** Like setEffect/setBrightness, but for an explicit set of devices (remote control), ignoring "sync all". */
  setEffectFor(deviceIds: string[], effectId: string): void
  setBrightnessFor(deviceIds: string[], v: number): void
  setParam(deviceId: string, key: string, value: ParamValue): void
  setBrightness(deviceId: string, v: number): void
  selectFan(id: string): void
  patchFan(id: string, patch: Partial<FanConfig>): void
  setCurve(id: string, curve: CurvePoint[]): void
  setLive(sensors: Sensor[], live: Record<string, FanLive>, rawFans?: HardwareState['fans']): void
  setCalibration(id: string, cal: FanCalibration | null): void
  setLcdError(e: string | null): void
}

const newAssignment = (effectId: string): Assignment => ({ effectId, params: defaultParams(effectId), brightness: 100 })

const defaultFan = (f: FanInfo): FanConfig => {
  const pump = f.kind === 'pump' || /pump/i.test(f.name)
  return {
    id: f.id,
    name: f.name,
    sensorId: f.sensorId,
    extraSensorIds: [],
    mix: 'max',
    mode: 'curve',
    curve: CURVE_PRESETS.Balanced.map((p) => ({ ...p })),
    manual: 50,
    minPct: pump ? PUMP_MIN_PCT : 20,
    maxPct: 100,
    hysteresis: 3,
    smoothSec: 5,
    stepUp: 20,
    stepDown: 3,
    holdSec: 10,
    pump,
  }
}

/** Fills in settings added since a config was saved; the old `ramp` became the step-down rate. */
function migrateFan(saved: Partial<FanConfig> & { ramp?: number }, info: FanInfo): FanConfig {
  const base = defaultFan(info)
  const { ramp, ...rest } = saved
  return { ...base, ...rest, stepDown: rest.stepDown ?? (ramp ? Math.min(ramp, 10) : base.stepDown) }
}

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
      rawFans: [],
      calibrations: {},
      lcdError: null,

      async init() {
        const [devices, fanInfo] = await Promise.all([backend.listDevices(), backend.listFans()])
        const { assignments, fans, selectedDevice, selectedFan } = get()
        const a = { ...assignments }
        for (const d of devices) a[d.id] ??= newAssignment(d.kind === 'fan' ? 'spin' : d.kind === 'screen' ? 'stats' : 'rainbow')
        const present = fanInfo.map((i) => {
          const saved = fans.find((x) => x.id === i.id)
          return saved ? migrateFan(saved, i) : defaultFan(i)
        })
        // keep the settings of fans that are not reachable right now (hardware control still starting,
        // or switched off) so they are not lost; the UI and engine only use fans that are present
        const f = [...present, ...fans.filter((x) => !fanInfo.some((i) => i.id === x.id))]
        set({
          devices,
          fanInfo,
          assignments: a,
          fans: f,
          selectedDevice: devices.some((d) => d.id === selectedDevice) ? selectedDevice : (devices[0]?.id ?? ''),
          selectedFan: present.some((x) => x.id === selectedFan) ? selectedFan : (present[0]?.id ?? selectedFan),
          ready: true,
        })
      },

      selectDevice: (id) => set({ selectedDevice: id }),
      setSyncAll: (syncAll) => set({ syncAll }),

      setEffect(deviceId, effectId) {
        const { devices, syncAll, assignments } = get()
        const a = { ...assignments }
        // "Stats only" and the like belong to the screen alone, even with sync all on
        const ids = effectById(effectId).screenOnly || !syncAll ? [deviceId] : devices.map((d) => d.id)
        for (const id of ids) {
          a[id] = { ...newAssignment(effectId), brightness: a[id]?.brightness ?? 100 }
        }
        set({ assignments: a })
      },

      setEffectFor(deviceIds, effectId) {
        const a = { ...get().assignments }
        if (effectById(effectId).screenOnly) return
        for (const id of deviceIds) a[id] = { ...newAssignment(effectId), brightness: a[id]?.brightness ?? 100 }
        set({ assignments: a })
      },

      setBrightnessFor(deviceIds, v) {
        const a = { ...get().assignments }
        for (const id of deviceIds) if (a[id]) a[id] = { ...a[id], brightness: v }
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
      setLive: (sensors, live, rawFans = []) => set({ sensors, live, rawFans }),
      setCalibration(id, cal) {
        const next = { ...get().calibrations }
        if (cal) next[id] = cal
        else delete next[id]
        set({ calibrations: next })
      },
      setLcdError: (lcdError) => set({ lcdError }),
    }),
    {
      name: 'lightsfanaction',
      partialize: (s) => ({
        assignments: s.assignments,
        selectedDevice: s.selectedDevice,
        syncAll: s.syncAll,
        fans: s.fans,
        calibrations: s.calibrations,
        selectedFan: s.selectedFan,
      }),
    },
  ),
)
