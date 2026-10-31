import type { JsonObject } from '@elgato/utils'
import { action, type DialDownEvent, type DialRotateEvent, type KeyDownEvent } from '@elgato/streamdeck'
import { send, type Snapshot } from './api.js'
import { LiveAction, type View } from './base.js'
import { current, refreshSoon } from './poller.js'
import { OFFLINE, fit, tempTone } from './render.js'

const PREFIX = 'com.nplaudio.lightsfanaction'
const OFFLINE_VIEW: View = { tile: OFFLINE, dial: { title: 'Lights Fan Action', value: 'Offline' } }

const DEVICE_ALL = 'all'
const devices = (s: Snapshot | undefined, id: unknown) =>
  !s ? [] : id === undefined || id === DEVICE_ALL || id === '' ? s.devices : s.devices.filter((d) => d.id === id)

const deviceItems = (s: Snapshot | undefined) => [
  { label: 'All devices', value: DEVICE_ALL },
  ...(s?.devices ?? []).map((d) => ({ label: d.name, value: d.id })),
]

/** Sends a command, then asks for a fresh snapshot so the key reflects it without waiting a full second. */
async function run(c: Parameters<typeof send>[0]) {
  await send(c)
  refreshSoon()
}

// ---- temperature -------------------------------------------------------------------------------

type SensorSettings = {
  sensorId?: string
  warmAt?: number
  hotAt?: number
}

@action({ UUID: `${PREFIX}.sensor` })
export class SensorAction extends LiveAction<SensorSettings> {
  view(state: Snapshot | undefined, s: SensorSettings): View {
    if (!state) return OFFLINE_VIEW
    // no sensor chosen: follow whichever is hottest right now
    const sensor = s.sensorId
      ? state.sensors.find((x) => x.id === s.sensorId)
      : state.sensors.reduce<Snapshot['sensors'][number] | undefined>((a, b) => (!a || b.value > a.value ? b : a), undefined)
    if (!sensor) return { tile: { label: 'Temperature', value: '--', sub: 'Pick a sensor', tone: 'off' }, dial: { title: 'Temperature', value: '--' } }
    const t = Math.round(sensor.value)
    const label = s.sensorId ? sensor.name : 'Hottest'
    return {
      tile: { label, value: `${t}°`, sub: s.sensorId ? undefined : fit(sensor.name, 12), tone: tempTone(t, s.warmAt ?? 70, s.hotAt ?? 85) },
      dial: { title: sensor.name, value: `${t} °C`, indicator: Math.max(0, Math.min(100, t)) },
    }
  }

  override items(source: string, state: Snapshot | undefined) {
    if (source !== 'getSensors') return []
    return [{ label: 'Hottest (automatic)', value: '' }, ...(state?.sensors ?? []).map((x) => ({ label: `${x.name} (${Math.round(x.value)}°C)`, value: x.id }))]
  }
}

// ---- fans --------------------------------------------------------------------------------------

type FanSettings = {
  fanId?: string
}

function fanTargets(state: Snapshot, id: unknown) {
  return id === DEVICE_ALL ? state.fans.filter((f) => f.controlled) : state.fans.filter((f) => f.id === id)
}

function toggleFans(id: unknown) {
  const state = current()
  if (!state || !id) return
  const fans = fanTargets(state, id).filter((f) => f.controlled)
  if (fans.length === 0) return
  // everything already at full speed: give each fan its previous mode back; otherwise push them all to full
  const allFull = fans.every((f) => f.mode === 'full')
  void run({ cmd: 'fanMode', fan: String(id), mode: allFull ? 'toggle' : 'full' })
}

@action({ UUID: `${PREFIX}.fan` })
export class FanAction extends LiveAction<FanSettings> {
  view(state: Snapshot | undefined, s: FanSettings): View {
    if (!state) return OFFLINE_VIEW
    if (!s.fanId) return { tile: { label: 'Fan', value: '--', sub: 'Pick a fan', tone: 'off' }, dial: { title: 'Fan', value: 'Pick a fan' } }
    const fans = fanTargets(state, s.fanId)
    if (fans.length === 0) return { tile: { label: 'Fan', value: '--', sub: 'Not found', tone: 'off' }, dial: { title: 'Fan', value: 'Not found' } }

    const label = s.fanId === DEVICE_ALL ? 'All fans' : fans[0].name
    const rpm = Math.round(fans.reduce((a, f) => a + f.rpm, 0) / fans.length)
    const pct = Math.round(fans.reduce((a, f) => a + f.pct, 0) / fans.length)
    const bad = fans.some((f) => f.warning)
    const full = fans.every((f) => f.controlled && f.mode === 'full')
    const firmware = fans.every((f) => !f.controlled)
    const stopped = fans.some((f) => f.controlled && f.pct > 25 && f.rpm === 0)
    return {
      tile: {
        label,
        value: `${rpm}`,
        sub: firmware ? 'rpm · auto' : `rpm · ${pct}%`,
        tone: bad ? 'hot' : stopped ? 'warn' : firmware ? 'off' : 'ok',
        badge: full ? 'FULL' : undefined,
      },
      dial: { title: label, value: `${rpm} rpm`, indicator: firmware ? undefined : Math.max(0, Math.min(100, pct)) },
    }
  }

  override items(source: string, state: Snapshot | undefined) {
    if (source !== 'getFans') return []
    return [
      { label: 'All controlled fans', value: DEVICE_ALL },
      ...(state?.fans ?? []).map((f) => ({ label: f.controlled ? f.name : `${f.name} (firmware, read only)`, value: f.id })),
    ]
  }

  override onKeyDown(ev: KeyDownEvent<FanSettings>) {
    toggleFans(ev.payload.settings.fanId)
  }

  override onDialDown(ev: DialDownEvent<FanSettings>) {
    toggleFans(ev.payload.settings.fanId)
  }
}

// ---- cooler ------------------------------------------------------------------------------------

@action({ UUID: `${PREFIX}.cooler` })
export class CoolerAction extends LiveAction {
  view(state: Snapshot | undefined): View {
    if (!state) return OFFLINE_VIEW
    const liquid = state.sensors.find((x) => /liquid|coolant|water/i.test(x.name))
    const pump = state.fans.find((f) => f.kind === 'pump')
    if (!liquid && !pump) {
      return { tile: { label: 'Cooler', value: '--', sub: 'Not found', tone: 'off' }, dial: { title: 'Cooler', value: 'Not found' } }
    }
    const t = liquid ? Math.round(liquid.value) : undefined
    const rpm = pump ? Math.round(pump.rpm) : undefined
    return {
      tile: {
        label: 'Coolant',
        value: t === undefined ? `${rpm}` : `${t}°`,
        sub: t === undefined ? 'pump rpm' : rpm === undefined ? undefined : `pump ${rpm}`,
        tone: t === undefined ? (pump?.warning ? 'hot' : 'ok') : tempTone(t, 38, 45),
      },
      dial: { title: 'Coolant', value: [t === undefined ? '' : `${t} °C`, rpm === undefined ? '' : `${rpm} rpm`].filter(Boolean).join(' · '), indicator: t === undefined ? undefined : Math.max(0, Math.min(100, (t - 20) * 3)) },
    }
  }
}

// ---- lighting ----------------------------------------------------------------------------------

type EffectSettings = {
  device?: string
  effectId?: string
}

@action({ UUID: `${PREFIX}.effect` })
export class EffectAction extends LiveAction<EffectSettings> {
  view(state: Snapshot | undefined, s: EffectSettings): View {
    if (!state) return OFFLINE_VIEW
    const effect = state.effects.find((e) => e.id === s.effectId)
    if (!effect) return { tile: { label: 'Lighting', value: '--', sub: 'Pick an effect', tone: 'off' } }
    const targets = devices(state, s.device)
    const on = targets.length > 0 && targets.every((d) => d.effectId === effect.id)
    const where = !s.device || s.device === DEVICE_ALL ? 'All devices' : (targets[0]?.name ?? 'Not found')
    return { tile: { label: 'Lighting', value: fit(effect.name, 10), sub: where, tone: on ? 'ok' : 'idle', active: on } }
  }

  override items(source: string, state: Snapshot | undefined) {
    if (source === 'getDevices') return deviceItems(state)
    if (source === 'getEffects') return (state?.effects ?? []).map((e) => ({ label: e.name, value: e.id }))
    return []
  }

  override onKeyDown(ev: KeyDownEvent<EffectSettings>) {
    const { device, effectId } = ev.payload.settings
    if (effectId) void run({ cmd: 'effect', device: device || DEVICE_ALL, effect: effectId })
  }
}

type BrightnessSettings = {
  device?: string
  op?: 'set' | 'up' | 'down'
  value?: number
  step?: number
}

/** Brightness a dial press switched off from, so the next press brings it back. */
const before = new Map<string, number>()

function averageBrightness(state: Snapshot, device: unknown) {
  const targets = devices(state, device)
  return targets.length === 0 ? undefined : Math.round(targets.reduce((a, d) => a + d.brightness, 0) / targets.length)
}

@action({ UUID: `${PREFIX}.brightness` })
export class BrightnessAction extends LiveAction<BrightnessSettings> {
  view(state: Snapshot | undefined, s: BrightnessSettings): View {
    if (!state) return OFFLINE_VIEW
    const now = averageBrightness(state, s.device)
    if (now === undefined) return { tile: { label: 'Brightness', value: '--', sub: 'No devices', tone: 'off' }, dial: { title: 'Brightness', value: '--' } }
    const op = s.op ?? 'set'
    const step = s.step ?? 10
    const label = op === 'up' ? 'Brighter' : op === 'down' ? 'Dimmer' : 'Brightness'
    const sub = op === 'set' ? `set ${s.value ?? 100}%` : `${op === 'up' ? '+' : '-'}${step}%`
    return {
      tile: { label, value: `${now}%`, sub, tone: now === 0 ? 'off' : 'idle', active: op === 'set' && now === (s.value ?? 100) },
      dial: { title: 'Brightness', value: `${now}%`, indicator: now },
    }
  }

  override items(source: string, state: Snapshot | undefined) {
    return source === 'getDevices' ? deviceItems(state) : []
  }

  override onKeyDown(ev: KeyDownEvent<BrightnessSettings>) {
    const s = ev.payload.settings
    const device = s.device || DEVICE_ALL
    const step = s.step ?? 10
    if (s.op === 'up') void run({ cmd: 'brightness', device, delta: step })
    else if (s.op === 'down') void run({ cmd: 'brightness', device, delta: -step })
    else void run({ cmd: 'brightness', device, value: s.value ?? 100 })
  }

  override onDialRotate(ev: DialRotateEvent<BrightnessSettings>) {
    const s = ev.payload.settings
    void run({ cmd: 'brightness', device: s.device || DEVICE_ALL, delta: ev.payload.ticks * (s.step ?? 5) })
  }

  override onDialDown(ev: DialDownEvent<BrightnessSettings>) {
    const s = ev.payload.settings
    const state = current()
    const device = s.device || DEVICE_ALL
    const now = state ? averageBrightness(state, device) : undefined
    if (now === undefined) return
    if (now > 0) {
      before.set(ev.action.id, now)
      void run({ cmd: 'brightness', device, value: 0 })
    } else void run({ cmd: 'brightness', device, value: before.get(ev.action.id) ?? 100 })
  }
}
