import { beforeEach, describe, expect, it } from 'vitest'
import { effectById } from './effects'
import type { Device } from './types'
import { defaultSize, ledPoint, memberMap, renderMember, rootZone, useZones, zoneEffect } from './zoneState'

const strip: Device = { id: 'strip', name: 'Strip', kind: 'strip', layout: 'strip', ledCount: 5 }
const fan: Device = { id: 'fan', name: 'Fan', kind: 'fan', layout: 'ring', ledCount: 8 }

beforeEach(() => useZones.setState({ zones: [] }))

describe('placing on a canvas', () => {
  it('maps a device point to the canvas, turned about its center', () => {
    const p = { deviceId: 'a', x: 0.8, y: 0.5, w: 0.4, h: 0.1, rot: 0 }
    // the left end of a 0.4 wide device centered at 0.8 sits at 0.6; the canvas is 1.6 wide
    expect(ledPoint(p, 0, 0.5, 1.6)[0]).toBeCloseTo(0.6 / 1.6)
    expect(ledPoint(p, 0.5, 0.5, 1.6)).toEqual([0.5, 0.5])
    // turned a quarter turn, the same end now sits above the center
    const turned = ledPoint({ ...p, rot: 90 }, 0, 0.5, 1.6)
    expect(turned[0]).toBeCloseTo(0.8 / 1.6)
    expect(turned[1]).toBeCloseTo(0.3)
  })

  it('keeps points on the canvas', () => {
    const p = { deviceId: 'a', x: 0, y: 0, w: 1, h: 1, rot: 0 }
    expect(ledPoint(p, 0, 0, 1)).toEqual([0, 0])
  })

  it('lights each device by where it sits, not by itself', () => {
    const a = { effectId: 'rainbow', params: { ...effectById('rainbow').params.reduce((o, q) => ({ ...o, [q.key]: q.default }), {}) }, brightness: 100 }
    // two identical strips, side by side: they should not match, because they sit under different parts of the canvas
    const left = renderMember(a, strip, { deviceId: 'strip', x: 0.2, y: 0.5, w: 0.2, h: 0.05, rot: 0 }, 1.6, 0)
    const right = renderMember(a, strip, { deviceId: 'strip', x: 1.3, y: 0.5, w: 0.2, h: 0.05, rot: 0 }, 1.6, 0)
    expect(left).not.toEqual(right)
    expect(left).toHaveLength(5)
  })

  it('scales by the zone brightness', () => {
    const a = { effectId: 'solid', params: { color: '#ff0000' }, brightness: 50 }
    expect(renderMember(a, strip, { deviceId: 'strip', x: 0.5, y: 0.5, w: 0.2, h: 0.05, rot: 0 }, 1, 0)[0]).toEqual([128, 0, 0])
  })

  it('sizes devices sensibly to start with', () => {
    expect(defaultSize(fan).w).toBe(defaultSize(fan).h)
    expect(defaultSize(strip).w).toBeGreaterThan(defaultSize(strip).h * 5)
  })
})

describe('zones', () => {
  it('put a device in one zone at a time', () => {
    const { add, place } = useZones.getState()
    const a = add('Case')
    const b = add('Desk')
    place(a, fan)
    place(b, fan)
    const { zones } = useZones.getState()
    expect(zones.find((z) => z.id === a)!.members).toHaveLength(0)
    expect(memberMap(zones).get('fan')!.zone.id).toBe(b)
  })

  it('share an effect when one follows another, and edit the shared one', () => {
    const { add, setSync, setEffect } = useZones.getState()
    const a = add('Case')
    const b = add('Desk')
    setSync(b, a)
    setEffect(b, 'matrix')
    const { zones } = useZones.getState()
    expect(zones.find((z) => z.id === a)!.effect.effectId).toBe('matrix')
    expect(zoneEffect(zones, zones.find((z) => z.id === b)!).effectId).toBe('matrix')
  })

  it('refuse to follow in a circle', () => {
    const { add, setSync } = useZones.getState()
    const a = add('A')
    const b = add('B')
    setSync(b, a)
    setSync(a, b)
    const { zones } = useZones.getState()
    expect(zones.find((z) => z.id === a)!.syncTo).toBeNull()
    expect(rootZone(zones, zones[1]).id).toBe(a)
  })

  it('let go of followers when the zone they follow is deleted', () => {
    const { add, setSync, remove } = useZones.getState()
    const a = add('A')
    const b = add('B')
    setSync(b, a)
    remove(a)
    expect(useZones.getState().zones[0].syncTo).toBeNull()
  })

  it('keep devices in the same relative place when the canvas changes shape', () => {
    const { add, place, setAspect } = useZones.getState()
    const a = add('Case')
    place(a, fan)
    const before = useZones.getState().zones[0].members[0].x / 1.6
    setAspect(a, 1)
    expect(useZones.getState().zones[0].members[0].x / 1).toBeCloseTo(before)
  })
})
