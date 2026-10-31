import { useState } from 'react'
import { KeyboardIcon, LightbulbIcon, MemoryStickIcon, LayoutGridIcon, MonitorIcon, MousePointerIcon, FanIcon, CpuIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { DeviceCanvas } from '@/components/LedCanvas'
import { Disclosure } from '@/components/Disclosure'
import { EffectCard, EffectOptions } from '@/components/EffectControls'
import { DeckPane } from '@/components/DeckPane'
import { ScreenPane } from '@/components/ScreenPane'
import { SwitchField } from '@/components/Field'
import { backend } from '@/lib/backend'
import { IS_TAURI, invoke } from '@/lib/hybrid'
import { useSettings } from '@/settings'
import { effectById } from '@/lib/effects'
import type { Device } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useStore } from '@/store'

const ICON: Record<Device['kind'], typeof KeyboardIcon> = {
  keyboard: KeyboardIcon,
  fan: FanIcon,
  gpu: MonitorIcon,
  ram: MemoryStickIcon,
  strip: LightbulbIcon,
  mouse: MousePointerIcon,
  screen: MonitorIcon,
  deck: LayoutGridIcon,
}

function previewSize(d: Device, big: boolean) {
  const wide = d.layout === 'grid' || d.layout === 'custom'
  if (!big) return d.layout === 'ring' ? { w: 36, h: 36 } : wide ? { w: 72, h: 28 } : { w: 72, h: 18 }
  return d.layout === 'ring' ? { w: 220, h: 220 } : wide ? { w: 640, h: 190 } : { w: 640, h: 80 }
}

function ZoneSizes({ dev }: { dev: Device }) {
  const zones = (dev.zones ?? []).filter((z) => z.max > z.min)
  const [draft, setDraft] = useState<Record<number, number>>({})
  const [err, setErr] = useState('')
  if (!zones.length || backend.rgbCount === 0) return null
  const needsSetup = zones.some((z) => z.ledCount === 0)

  const apply = async (zi: number, n: number) => {
    try {
      await backend.resizeZone(dev, zi, n)
      await useStore.getState().init()
      setErr('')
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <Disclosure
      title="Addressable headers"
      summary={zones.map((z) => `${z.name}: ${z.ledCount}`).join(' · ')}
      defaultOpen={needsSetup}
      badge={needsSetup ? <Badge variant="secondary">Needs setup</Badge> : undefined}
    >
      <p className="text-sm text-muted-foreground">
        How many LEDs are plugged into each header. A header set to 0 stays dark.
      </p>
      {zones.map((z) => {
        const value = draft[z.index] ?? z.ledCount
        return (
          <div key={z.index} className="flex items-center gap-3">
            <Label htmlFor={`zone-${z.index}`} className="w-32 shrink-0 text-sm">{z.name}</Label>
            <Input
              id={`zone-${z.index}`}
              type="number"
              min={z.min}
              max={z.max}
              value={value}
              className="w-24"
              onChange={(e) => setDraft({ ...draft, [z.index]: Number(e.target.value) })}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={value === z.ledCount}
              onClick={() => void apply(z.index, Math.min(z.max, Math.max(z.min, value)))}
            >
              Apply
            </Button>
          </div>
        )
      })}
      {err && <p className="text-sm text-destructive">{err}</p>}
    </Disclosure>
  )
}

/** Sends nothing to this device, for a device that misbehaves when written to (a monitor that blanks, say). */
function LeaveAlone({ dev }: { dev: Device }) {
  const left = useSettings((s) => s.leaveAlone)
  const set = useSettings((s) => s.set)
  const on = left.includes(dev.id)
  return (
    <SwitchField
      label="Leave this device alone"
      description="Sends it nothing at all. It keeps whatever lighting it has on its own."
      checked={on}
      onChange={(v) => {
        set({ leaveAlone: v ? [...left, dev.id] : left.filter((id) => id !== dev.id) })
        if (IS_TAURI) void invoke('activity_log', { line: `${dev.name}: ${v ? 'left alone' : 'lighting resumed'}` }).catch(() => undefined)
      }}
    />
  )
}

export function LightingPage() {
  const { devices, assignments, selectedDevice, syncAll } = useStore()
  const { selectDevice, setSyncAll } = useStore()
  const dev = devices.find((d) => d.id === selectedDevice)
  const a = dev && assignments[dev.id]
  const left = useSettings((s) => s.leaveAlone)

  if (!dev || !a) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm space-y-2">
          <CpuIcon className="mx-auto size-8 text-muted-foreground" />
          <p className="font-medium">No lighting devices found</p>
          <p className="text-sm text-muted-foreground">
            Start OpenRGB and turn on its SDK Server, then use Rescan in the status menu at the top right.
          </p>
        </div>
      </div>
    )
  }

  const big = previewSize(dev, true)

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[17rem_1fr]">
      <aside className="flex min-h-0 flex-col border-b md:border-r md:border-b-0">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-medium">Devices</span>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Sync all
            <Switch checked={syncAll} onCheckedChange={setSyncAll} aria-label="Apply changes to every device" />
          </label>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <ul className="space-y-1 px-2 pb-3">
            {devices.map((d) => {
              const Icon = ICON[d.kind]
              const s = previewSize(d, false)
              const on = d.id === dev.id
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => selectDevice(d.id)}
                    aria-pressed={on}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                      on && 'bg-muted',
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{d.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {left.includes(d.id) ? 'Left alone' : effectById(assignments[d.id]?.effectId).name}
                      </span>
                    </span>
                    <DeviceCanvas device={d} width={s.w} height={s.h} />
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      </aside>

      <ScrollArea className="min-h-0">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {dev.kind === 'screen' ? (
            <ScreenPane dev={dev} a={a} />
          ) : dev.kind === 'deck' ? (
            <DeckPane dev={dev} a={a} />
          ) : (
            <>
          <div>
            <h1 className="text-xl font-semibold">{dev.name}</h1>
            <p className="text-sm text-muted-foreground">
              {dev.ledCount} LEDs{syncAll ? ' · changes apply to every device' : ''}
            </p>
            {dev.note && <p className="mt-1 text-sm text-muted-foreground">{dev.note}</p>}
          </div>

          <Card>
            <CardContent className="grid place-items-center overflow-hidden py-6">
              <DeviceCanvas device={dev} width={big.w} height={big.h} />
            </CardContent>
          </Card>

          <EffectCard dev={dev} a={a} />

          <EffectOptions dev={dev} a={a} />

          <ZoneSizes key={dev.id} dev={dev} />

          <Card>
            <CardContent>
              <LeaveAlone dev={dev} />
            </CardContent>
          </Card>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
