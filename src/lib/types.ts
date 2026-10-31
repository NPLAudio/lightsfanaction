export type RGB = [number, number, number]

export type DeviceKind = 'keyboard' | 'fan' | 'gpu' | 'ram' | 'strip' | 'mouse'
export type Layout = 'strip' | 'ring' | 'grid' | 'custom'

export interface Zone {
  index: number
  name: string
  ledCount: number
  min: number
  max: number
}

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  layout: Layout
  ledCount: number
  /** grid only */
  cols?: number
  /** custom only: one [x, y] per LED, in 0..1 */
  positions?: [number, number][]
  /** shown under the device name, e.g. a limitation of its firmware */
  note?: string
  /** OpenRGB zones; only those with min < max can be resized */
  zones?: Zone[]
}

export interface Led {
  i: number
  n: number
  /** normalized position, 0..1 */
  x: number
  y: number
}

export type ParamValue = number | string

export interface ParamDef {
  key: string
  label: string
  type: 'range' | 'color'
  min?: number
  max?: number
  step?: number
  default: ParamValue
}

export interface Effect {
  /** follows the music; needs the audio listener running */
  reactive?: boolean
  id: string
  name: string
  description: string
  params: ParamDef[]
  render: (led: Led, t: number, p: Record<string, ParamValue>) => RGB
}

export interface Assignment {
  effectId: string
  params: Record<string, ParamValue>
  brightness: number
}

export interface Sensor {
  id: string
  name: string
  value: number
  unit: '°C'
}

export interface CurvePoint {
  /** temperature, °C */
  t: number
  /** fan duty, % */
  p: number
}

export type FanMode = 'curve' | 'manual' | 'full'

export type MixMode = 'max' | 'avg'

export interface FanConfig {
  id: string
  name: string
  /** first temperature source; kept for older saved configs */
  sensorId: string
  /** extra sources, combined with `mix`; the first entry is sensorId */
  extraSensorIds: string[]
  mix: MixMode
  mode: FanMode
  curve: CurvePoint[]
  manual: number
  /** lowest duty while running; 0 allows the fan to stop */
  minPct: number
  /** quiet cap: curves never go above this unless it is getting hot */
  maxPct: number
  /** degrees the temperature must fall before the fan slows down */
  hysteresis: number
  /** seconds over which the temperature reading is averaged */
  smoothSec: number
  /** max duty increase per second */
  stepUp: number
  /** max duty decrease per second */
  stepDown: number
  /** seconds the fan holds its speed after speeding up before it may slow down */
  holdSec: number
  /** overrides the automatic emergency temperature for this fan's sources */
  criticalTemp?: number
  /** pumps never stop and never go below PUMP_MIN_PCT */
  pump: boolean
}

/** What a sweep measured for one fan. */
export interface FanCalibration {
  at: number
  /** false when the fan never reported a speed, so stalls cannot be detected */
  tach: boolean
  maxRpm: number
  /** lowest duty that kept the fan turning, plus a safety margin */
  minRunPct: number
  /** duty at which the fan stopped on the way down (100 if it never did) */
  stopPct: number
  /** duty needed to get it turning again from a stop */
  startPct: number
  /** measured duty to RPM points, descending duty */
  map: { pct: number; rpm: number }[]
}

export type FanWarning = 'stalled' | 'ignored'

export interface FanLive {
  id: string
  rpm: number
  /** duty we commanded this tick */
  pct: number
  /** duty the hardware reported back, when it reports one */
  reported?: number
  warning?: FanWarning
  /** why the speed is not what the curve says: "emergency", "kick-start", "quiet cap" ... */
  note?: string
}

export interface HardwareState {
  sensors: Sensor[]
  fans: { id: string; rpm: number; pct?: number }[]
}

export type FanKind = 'case' | 'pump' | 'gpu'

export interface FanInfo {
  kind: FanKind
  id: string
  name: string
  maxRpm: number
  sensorId: string
}

export interface Backend {
  listDevices(): Promise<Device[]>
  setLeds(deviceId: string, colors: RGB[]): void
  listFans(): Promise<FanInfo[]>
  setFan(fanId: string, pct: number): void
  readState(): Promise<HardwareState>
}
