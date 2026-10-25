export type RGB = [number, number, number]

export type DeviceKind = 'keyboard' | 'fan' | 'gpu' | 'ram' | 'strip' | 'mouse'
export type Layout = 'strip' | 'ring' | 'grid'

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
  /** OpenRGB zones; only those with min < max can be resized */
  zones?: Zone[]
}

export interface Led {
  i: number
  n: number
  /** normalised position, 0..1 */
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

export interface FanConfig {
  id: string
  name: string
  sensorId: string
  mode: FanMode
  curve: CurvePoint[]
  manual: number
  /** lowest duty while running; 0 allows the fan to stop */
  minPct: number
  /** degrees the temperature must fall before the fan slows down */
  hysteresis: number
  /** max duty change per second */
  ramp: number
}

export interface FanLive {
  id: string
  rpm: number
  pct: number
}

export interface HardwareState {
  sensors: Sensor[]
  fans: { id: string; rpm: number }[]
}

export interface FanInfo {
  id: string
  name: string
  maxRpm: number
  sensorId: string
}

export interface Backend {
  name: string
  simulated: boolean
  listDevices(): Promise<Device[]>
  setLeds(deviceId: string, colors: RGB[]): void
  listFans(): Promise<FanInfo[]>
  setFan(fanId: string, pct: number): void
  readState(): Promise<HardwareState>
}
