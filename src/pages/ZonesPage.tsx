import { useState } from 'react'
import { PlusIcon, ShapesIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { EffectCard, EffectOptions, type EffectActions } from '@/components/EffectControls'
import { SliderField } from '@/components/Field'
import { ZoneCanvas } from '@/components/ZoneCanvas'
import type { Device } from '@/lib/types'
import { ASPECTS, memberMap, rootZone, useZones, zoneEffect, type Zone } from '@/lib/zoneState'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'

/** Stands in for the zone where the effect controls expect a device (they only need a kind and a name). */
const asDevice = (z: Zone): Device => ({ id: z.id, name: z.name, kind: 'strip', layout: 'strip', ledCount: 0 })

function PlacementPanel({ zone, device }: { zone: Zone; device: Device }) {
  const patch = useZones((s) => s.patchPlacement)
  const unplace = useZones((s) => s.unplace)
  const m = zone.members.find((x) => x.deviceId === device.id)
  if (!m) return null
  const ring = device.layout === 'ring'
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{device.name}</p>
            <p className="text-xs text-muted-foreground">Drag it on the canvas, or use the arrow keys when it is focused.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => unplace(device.id)}>Remove from zone</Button>
        </div>
        <SliderField
          label={ring ? 'Size' : 'Width'}
          value={Math.round(m.w * 100)}
          min={2}
          max={200}
          unit="%"
          onChange={(v) => patch(device.id, ring ? { w: v / 100, h: v / 100 } : { w: v / 100 })}
        />
        {!ring && (
          <SliderField label="Height" value={Math.round(m.h * 100)} min={2} max={100} unit="%" onChange={(v) => patch(device.id, { h: v / 100 })} />
        )}
        <SliderField label="Rotation" value={Math.round(m.rot)} min={0} max={359} unit="°" onChange={(v) => patch(device.id, { rot: v })} />
      </CardContent>
    </Card>
  )
}

function ZonePane({ zone }: { zone: Zone }) {
  const zones = useZones((s) => s.zones)
  const { rename, remove, setAspect, setSync, place, setEffect, setParam, setBrightness } = useZones.getState()
  const devices = useStore((s) => s.devices)
  const [selected, setSelected] = useState<string | null>(null)
  const [snap, setSnap] = useState(true)
  const [confirm, setConfirm] = useState(false)

  const eligible = devices.filter((d) => d.kind !== 'screen' && d.kind !== 'deck')
  const placed = memberMap(zones)
  const root = rootZone(zones, zone)
  const actions: EffectActions = {
    setEffect: (id) => setEffect(zone.id, id),
    setBrightness: (v) => setBrightness(zone.id, v),
    setParam: (k, v) => setParam(zone.id, k, v),
  }
  const fx = zoneEffect(zones, zone)
  const selectedDevice = eligible.find((d) => d.id === selected && zone.members.some((m) => m.deviceId === d.id))
  const others = zones.filter((z) => z.id !== zone.id && rootZone(zones, z).id !== zone.id)

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="zone-name">Zone name</Label>
          <Input id="zone-name" value={zone.name} onChange={(e) => rename(zone.id, e.target.value)} />
        </div>
        <Button
          variant="outline"
          onClick={() => {
            if (!confirm) return setConfirm(true)
            setConfirm(false)
            remove(zone.id)
          }}
          onBlur={() => setConfirm(false)}
        >
          {confirm ? 'Click again to delete' : 'Delete zone'}
        </Button>
      </div>

      <ZoneCanvas zone={zone} devices={eligible} selected={selected} snap={snap} onSelect={setSelected} />

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Snap to grid
          <Switch checked={snap} onCheckedChange={setSnap} aria-label="Snap devices to the grid" />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Label className="text-sm text-muted-foreground">Canvas shape</Label>
          <Select
            value={String(ASPECTS.find((a) => a.value === zone.aspect)?.value ?? zone.aspect)}
            onValueChange={(v) => v && setAspect(zone.id, Number(v))}
            items={ASPECTS.map((a) => ({ value: String(a.value), label: a.label }))}
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASPECTS.map((a) => (
                <SelectItem key={a.label} value={String(a.value)}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-2">
          <Label>Add a device</Label>
          <Select
            value=""
            onValueChange={(id) => {
              const d = eligible.find((x) => x.id === id)
              if (!d) return
              place(zone.id, d)
              setSelected(d.id)
            }}
            items={eligible.map((d) => ({ value: d.id, label: d.name }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={eligible.length ? 'Choose a device to place…' : 'No devices to place'} />
            </SelectTrigger>
            <SelectContent>
              {eligible.map((d) => {
                const where = placed.get(d.id)?.zone
                return (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                    {where && where.id !== zone.id ? ` (now in ${where.name})` : where ? ' (already here)' : ''}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            A placed device plays this zone's effect instead of its own. Take it out of the zone and it goes back to its own.
          </p>
        </CardContent>
      </Card>

      {selectedDevice && <PlacementPanel zone={zone} device={selectedDevice} />}

      <Card>
        <CardContent className="space-y-2">
          <Label>Same look as another zone</Label>
          <Select
            value={zone.syncTo ?? 'none'}
            onValueChange={(v) => v && setSync(zone.id, v === 'none' ? null : v)}
            items={[{ value: 'none', label: 'No, this zone has its own effect' }, ...others.map((z) => ({ value: z.id, label: z.name }))]}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No, this zone has its own effect</SelectItem>
              {others.map((z) => (
                <SelectItem key={z.id} value={z.id}>
                  {z.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {zone.syncTo && (
            <p className="text-sm text-muted-foreground">
              Playing {root.name}'s effect. Changing it below changes it there too. Each zone still spreads it over its own canvas.
            </p>
          )}
        </CardContent>
      </Card>

      <EffectCard dev={asDevice(zone)} a={fx} actions={actions} />
      <EffectOptions dev={asDevice(zone)} a={fx} actions={actions} />
    </div>
  )
}

export function ZonesPage() {
  const zones = useZones((s) => s.zones)
  const add = useZones((s) => s.add)
  const [picked, setPicked] = useState<string | null>(null)
  const zone = zones.find((z) => z.id === picked) ?? zones[0]

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[17rem_1fr]">
      <aside className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium">Zones</span>
          <Button size="sm" variant="outline" onClick={() => setPicked(add(`Zone ${zones.length + 1}`))}>
            <PlusIcon /> New
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <ul className="space-y-1 px-2 pb-3">
            {zones.map((z) => (
              <li key={z.id}>
                <button
                  type="button"
                  onClick={() => setPicked(z.id)}
                  aria-pressed={z.id === zone?.id}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                    z.id === zone?.id && 'bg-muted',
                  )}
                >
                  <ShapesIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{z.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {z.members.length} {z.members.length === 1 ? 'device' : 'devices'}
                      {z.syncTo ? ' · synced' : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </aside>

      <ScrollArea className="min-h-0">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {zone ? (
            <ZonePane key={zone.id} zone={zone} />
          ) : (
            <div className="grid place-items-center py-16 text-center">
              <div className="max-w-sm space-y-3">
                <ShapesIcon className="mx-auto size-8 text-muted-foreground" />
                <p className="font-medium">No zones yet</p>
                <p className="text-sm text-muted-foreground">
                  A zone is a canvas for a place, like the inside of your case or your desk pad. Put devices on it where they really sit and one
                  effect flows across all of them.
                </p>
                <Button onClick={() => setPicked(add('Case'))}>
                  <PlusIcon /> Create a zone
                </Button>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
