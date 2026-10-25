import { backend } from './lib/backend'
import { stepFan, type FanRuntime } from './lib/curve'
import { effectById } from './lib/effects'
import { ledsFor } from './lib/layout'
import type { FanLive, RGB } from './lib/types'
import { useStore } from './store'

/** Latest rendered frame per device; previews read this instead of re-rendering. */
export const frames = new Map<string, RGB[]>()

const FRAME_MS = 33
const FAN_MS = 1000

function renderFrames() {
  const { devices, assignments } = useStore.getState()
  const t = performance.now() / 1000
  for (const d of devices) {
    const a = assignments[d.id]
    if (!a) continue
    const fx = effectById(a.effectId)
    const k = a.brightness / 100
    const out = ledsFor(d).map((led): RGB => {
      const c = fx.render(led, t, a.params)
      return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)]
    })
    frames.set(d.id, out)
    backend.setLeds(d.id, out)
  }
}

const runtime = new Map<string, FanRuntime>()
let lastFan = performance.now()
let busy = false

async function fanTick() {
  if (busy) return
  busy = true
  try {
    const now = performance.now()
    const dt = (now - lastFan) / 1000
    lastFan = now
    const hw = await backend.readState()
    const { fans, setLive } = useStore.getState()
    const live: Record<string, FanLive> = {}
    for (const f of fans) {
      const temp = hw.sensors.find((s) => s.id === f.sensorId)?.value
      const prev = runtime.get(f.id) ?? { anchor: temp ?? 0, pct: 50 }
      const next = stepFan(f, temp, prev, dt)
      runtime.set(f.id, next)
      backend.setFan(f.id, next.pct)
      live[f.id] = { id: f.id, pct: next.pct, rpm: hw.fans.find((x) => x.id === f.id)?.rpm ?? 0 }
    }
    setLive(hw.sensors, live)
  } finally {
    busy = false
  }
}

let started = false
export function startEngine() {
  if (started) return
  started = true
  setInterval(renderFrames, FRAME_MS)
  setInterval(fanTick, FAN_MS)
  void fanTick()
}
