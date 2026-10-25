import type { Backend, Device, FanInfo, HardwareState, RGB } from './types'

const DEVICES: Device[] = [
  { id: 'kb', name: 'Mechanical Keyboard', kind: 'keyboard', layout: 'grid', ledCount: 90, cols: 18 },
  { id: 'fan1', name: 'Front Fan 1', kind: 'fan', layout: 'ring', ledCount: 12 },
  { id: 'fan2', name: 'Front Fan 2', kind: 'fan', layout: 'ring', ledCount: 12 },
  { id: 'fan3', name: 'Rear Fan', kind: 'fan', layout: 'ring', ledCount: 12 },
  { id: 'gpu', name: 'Graphics Card', kind: 'gpu', layout: 'strip', ledCount: 20 },
  { id: 'ram', name: 'Memory', kind: 'ram', layout: 'strip', ledCount: 10 },
  { id: 'strip', name: 'Desk LED Strip', kind: 'strip', layout: 'strip', ledCount: 60 },
]

const FANS: FanInfo[] = [
  { id: 'cpu', name: 'CPU Fan', maxRpm: 2200, sensorId: 'cpu' },
  { id: 'front', name: 'Front Intake', maxRpm: 1500, sensorId: 'gpu' },
  { id: 'rear', name: 'Rear Exhaust', maxRpm: 1500, sensorId: 'cpu' },
  { id: 'pump', name: 'Pump', maxRpm: 3000, sensorId: 'water' },
]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Fake hardware with a crude thermal model, so curves can be tuned with no hardware attached. */
export class SimBackend implements Backend {
  name = 'Simulated hardware'
  simulated = true
  stress = false
  private duty: Record<string, number> = { cpu: 40, front: 40, rear: 40, pump: 60 }
  private temps: Record<string, number> = { cpu: 38, gpu: 36, mobo: 33, water: 30 }
  private last = performance.now()

  listDevices() {
    return Promise.resolve(DEVICES)
  }
  listFans() {
    return Promise.resolve(FANS)
  }
  setLeds(_id: string, _colors: RGB[]) {}
  setFan(id: string, pct: number) {
    this.duty[id] = clamp(pct, 0, 100)
  }

  private cooling(sensorId: string) {
    const fans = FANS.filter((f) => f.sensorId === sensorId)
    if (!fans.length) return 0.3
    return fans.reduce((a, f) => a + this.duty[f.id], 0) / fans.length / 100
  }

  readState(): Promise<HardwareState> {
    const now = performance.now()
    const dt = Math.min(2, (now - this.last) / 1000)
    this.last = now
    const wob = (s: number) => (Math.sin(now / s) + 1) / 2
    const load = this.stress ? 1 : 0.15 + 0.2 * wob(7000)
    const heat: Record<string, number> = { cpu: 40 * load, gpu: 45 * load, mobo: 12 * load, water: 22 * load }
    const ambient = 24
    for (const k of Object.keys(this.temps)) {
      // equilibrium = ambient + heat / (0.25 + 1.4 * airflow); relax toward it
      const eq = ambient + (heat[k] * 2) / (0.25 + 1.4 * this.cooling(k === 'mobo' ? 'cpu' : k))
      this.temps[k] += (eq - this.temps[k]) * (1 - Math.exp(-dt / 6)) + (Math.random() - 0.5) * 0.15
    }
    return Promise.resolve({
      sensors: [
        { id: 'cpu', name: 'CPU Package', value: this.temps.cpu, unit: '°C' },
        { id: 'gpu', name: 'GPU Core', value: this.temps.gpu, unit: '°C' },
        { id: 'mobo', name: 'Motherboard', value: this.temps.mobo, unit: '°C' },
        { id: 'water', name: 'Coolant', value: this.temps.water, unit: '°C' },
      ],
      fans: FANS.map((f) => ({
        id: f.id,
        rpm: this.duty[f.id] < 5 ? 0 : Math.round((f.maxRpm * (0.15 + 0.85 * (this.duty[f.id] / 100))) / 10) * 10,
      })),
    })
  }
}
