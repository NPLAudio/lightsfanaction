import { useMemo, useState } from 'react'
import { ChevronDownIcon, FanIcon, Loader2Icon, ThermometerIcon, TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BatchPanel } from '@/components/BatchPanel'
import { CalibrationPanel, ListenTest } from '@/components/CalibrationPanel'
import { CurveEditor } from '@/components/CurveEditor'
import { Disclosure } from '@/components/Disclosure'
import { SliderField, SwitchField } from '@/components/Field'
import { startBatch, useBatch } from '@/calibrate'
import { backend } from '@/lib/backend'
import { CRITICAL_TEMP, CURVE_PRESETS, PUMP_MIN_PCT, defaultCritical, evalCurve } from '@/lib/curve'
import { IS_TAURI } from '@/lib/hybrid'
import type { FanConfig, FanLive, FanMode, Sensor } from '@/lib/types'
import { cn } from '@/lib/utils'
import { kindEnabled, useSettings } from '@/settings'
import { useStore } from '@/store'

const WARNINGS = {
  stalled: 'Not turning at the speed it was given. The floor was raised; check the fan.',
  ignored: 'The hardware is not following commands. Another program may control this fan, or its controller ignores software speeds.',
} as const

function shortTemps(sensors: Sensor[]) {
  const pick = (re: RegExp, label: string) => {
    const s = sensors.find((x) => re.test(x.name))
    return s ? `${label} ${Math.round(s.value)}°` : null
  }
  const parts = [pick(/CPU.*(package|tctl|die)/i, 'CPU'), pick(/GPU Core/i, 'GPU'), pick(/liquid|coolant|water/i, 'Liquid')].filter(Boolean)
  return parts.length ? parts.join(' · ') : sensors.slice(0, 3).map((s) => `${Math.round(s.value)}°`).join(' · ')
}

function FanCard({
  fan,
  live,
  active,
  selecting,
  checked,
  onSelect,
  onCheck,
}: {
  fan: FanConfig
  live?: FanLive
  active: boolean
  selecting: boolean
  checked: boolean
  onSelect(): void
  onCheck(): void
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={selecting ? onCheck : onSelect}
        aria-pressed={active}
        className={cn(
          'flex h-full w-full flex-col gap-2 rounded-xl border bg-card p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50',
          active && !selecting && 'border-primary ring-1 ring-primary',
        )}
      >
        <span className="truncate pr-6 text-sm font-medium">{fan.name}</span>
        <span className="text-2xl font-semibold tabular-nums">
          {live ? live.rpm : '–'}
          <span className="ml-1 text-xs font-normal text-muted-foreground">RPM</span>
        </span>
        <Progress value={live?.pct ?? 0} />
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {live?.pct ?? 0}% · {live?.note ?? fan.mode}
          {live?.warning && (
            <Badge variant="destructive" title={WARNINGS[live.warning]}>
              <TriangleAlertIcon /> {live.warning === 'stalled' ? 'Stalled' : 'Not responding'}
            </Badge>
          )}
        </span>
      </button>
      {selecting && (
        <Checkbox
          checked={checked}
          onCheckedChange={onCheck}
          aria-label={`Select ${fan.name}`}
          className="absolute top-3 right-3"
        />
      )}
    </div>
  )
}

function Summary({ children }: { children: React.ReactNode }) {
  return <span className="ml-3 truncate text-xs font-normal text-muted-foreground">{children}</span>
}

function FanDetail({ fan, live, sensors }: { fan: FanConfig; live?: FanLive; sensors: Sensor[] }) {
  const { patchFan, setCurve } = useStore()
  const cal = useStore((s) => s.calibrations[fan.id])
  const ids = [fan.sensorId, ...fan.extraSensorIds]
  const names = ids.map((id) => sensors.find((s) => s.id === id)?.name ?? 'unavailable')
  const temp = sensors.find((s) => s.id === fan.sensorId)?.value
  const emergency =
    fan.criticalTemp ?? Math.min(CRITICAL_TEMP, ...ids.map((id) => defaultCritical(sensors.find((x) => x.id === id)?.name ?? '')))
  const sensorItems = sensors.map((s) => ({ value: s.id, label: s.name }))

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold">{fan.name}</h2>
            <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
              <ThermometerIcon className="size-3.5" />
              {fan.extraSensorIds.length ? `Following ${names.length} sensors` : names[0]}
              {temp !== undefined && ` · ${temp.toFixed(0)}°C`}
            </p>
          </div>
          <ToggleGroup
            value={[fan.mode]}
            onValueChange={(v) => v[0] && patchFan(fan.id, { mode: v[0] as FanMode })}
            variant="outline"
            spacing={0}
          >
            <ToggleGroupItem value="curve">Curve</ToggleGroupItem>
            <ToggleGroupItem value="manual">Fixed</ToggleGroupItem>
            <ToggleGroupItem value="full">Full speed</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {live?.warning && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{live.warning === 'stalled' ? 'Fan stalled' : 'Fan not responding'}</AlertTitle>
            <AlertDescription>{WARNINGS[live.warning]}</AlertDescription>
          </Alert>
        )}

        {fan.mode === 'curve' && (
          <div className="space-y-2">
            <CurveEditor points={fan.curve} onChange={(c) => setCurve(fan.id, c)} temp={temp} pct={live?.pct} />
            <div className="flex flex-wrap items-center gap-3">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="outline" size="sm">
                      Preset <ChevronDownIcon />
                    </Button>
                  }
                />
                <DropdownMenuContent align="start">
                  {Object.entries(CURVE_PRESETS).map(([name, pts]) => (
                    <DropdownMenuItem key={name} onClick={() => setCurve(fan.id, pts.map((p) => ({ ...p })))}>
                      {name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {temp !== undefined && (
                <span className="text-sm text-muted-foreground">
                  Curve says <b className="text-foreground">{Math.round(evalCurve(fan.curve, temp))}%</b> at {temp.toFixed(0)}°C
                </span>
              )}
            </div>
          </div>
        )}
        {fan.mode === 'manual' && (
          <div className="space-y-4 py-6">
            <p className="text-center text-5xl font-semibold tabular-nums">{fan.manual}%</p>
            <Slider
              value={fan.manual}
              min={0}
              max={100}
              aria-label="Fixed fan speed"
              onValueChange={(v) => patchFan(fan.id, { manual: Array.isArray(v) ? v[0] : v })}
            />
          </div>
        )}
        {fan.mode === 'full' && <p className="py-6 text-center text-sm text-muted-foreground">Running at 100% until you switch modes.</p>}

        <Accordion multiple className="rounded-xl border px-4">
          <AccordionItem value="source">
            <AccordionTrigger>
              Temperature source<Summary>{fan.extraSensorIds.length ? `${names.length} sensors, ${fan.mix === 'max' ? 'hottest' : 'average'}` : names[0]}</Summary>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              <Select
                value={fan.sensorId}
                items={sensorItems}
                onValueChange={(v) =>
                  v && patchFan(fan.id, { sensorId: v, extraSensorIds: fan.extraSensorIds.filter((x) => x !== v) })
                }
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sensors.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Disclosure title="Also follow other sensors" summary={fan.extraSensorIds.length ? `${fan.extraSensorIds.length} added` : 'None'} className="border-0 bg-muted/30">
                <ToggleGroup
                  value={[fan.mix]}
                  onValueChange={(v) => v[0] && patchFan(fan.id, { mix: v[0] as FanConfig['mix'] })}
                  variant="outline"
                  spacing={0}
                >
                  <ToggleGroupItem value="max">Hottest</ToggleGroupItem>
                  <ToggleGroupItem value="avg">Average</ToggleGroupItem>
                </ToggleGroup>
                <div className="space-y-2">
                  {sensors.filter((s) => s.id !== fan.sensorId).map((s) => (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={fan.extraSensorIds.includes(s.id)}
                        onCheckedChange={(on) =>
                          patchFan(fan.id, {
                            extraSensorIds: on ? [...fan.extraSensorIds, s.id] : fan.extraSensorIds.filter((x) => x !== s.id),
                          })
                        }
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              </Disclosure>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="limits">
            <AccordionTrigger>
              Speed limits<Summary>min {fan.minPct}% · quiet cap {fan.maxPct}%</Summary>
            </AccordionTrigger>
            <AccordionContent className="space-y-4">
              <SliderField
                label="Minimum speed"
                value={fan.minPct}
                min={0}
                max={60}
                unit="%"
                hint="0% lets the fan stop completely at low temperatures."
                onChange={(v) => patchFan(fan.id, { minPct: fan.pump ? Math.max(v, PUMP_MIN_PCT) : v })}
              />
              <SliderField
                label="Quiet cap"
                value={fan.maxPct}
                min={20}
                max={100}
                unit="%"
                hint="The highest speed while things are not getting hot."
                onChange={(v) => patchFan(fan.id, { maxPct: v })}
              />
              <ListenTest fanId={fan.id} maxPct={fan.maxPct} onUse={(v) => patchFan(fan.id, { maxPct: Math.max(20, v) })} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="response">
            <AccordionTrigger>
              Response<Summary>smoothing {fan.smoothSec}s · hold {fan.holdSec}s</Summary>
            </AccordionTrigger>
            <AccordionContent className="space-y-4">
              <SliderField label="Smoothing" value={fan.smoothSec} min={0} max={30} unit=" s" hint="Averages the temperature over this long so spikes do not change the speed." onChange={(v) => patchFan(fan.id, { smoothSec: v })} />
              <SliderField label="Hysteresis" value={fan.hysteresis} min={0} max={10} unit="°C" hint="The temperature must fall this far before the fan slows down." onChange={(v) => patchFan(fan.id, { hysteresis: v })} />
              <SliderField label="Speed-up rate" value={fan.stepUp} min={1} max={100} unit="%/s" hint="The fastest the speed may rise." onChange={(v) => patchFan(fan.id, { stepUp: v })} />
              <SliderField label="Slow-down rate" value={fan.stepDown} min={1} max={30} unit="%/s" hint="The fastest the speed may fall." onChange={(v) => patchFan(fan.id, { stepDown: v })} />
              <SliderField label="Hold after speeding up" value={fan.holdSec} min={0} max={60} unit=" s" hint="Keeps the speed this long before it may slow down, so it does not pump up and down." onChange={(v) => patchFan(fan.id, { holdSec: v })} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="safety">
            <AccordionTrigger>
              Safety<Summary>emergency at {emergency}°C</Summary>
            </AccordionTrigger>
            <AccordionContent className="space-y-4">
              <SliderField
                label="Emergency temperature"
                value={emergency}
                min={40}
                max={110}
                unit="°C"
                hint="At or above this the fan runs at 100%, whatever else is set. It also goes to 100% if a source cannot be read."
                onChange={(v) => patchFan(fan.id, { criticalTemp: v })}
              />
              <SwitchField
                label={`Treat as a pump (never below ${PUMP_MIN_PCT}%)`}
                description="For a pump plugged into an ordinary fan header."
                checked={fan.pump}
                onChange={(v) => patchFan(fan.id, { pump: v, minPct: v ? Math.max(fan.minPct, PUMP_MIN_PCT) : fan.minPct })}
              />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="calibration">
            <AccordionTrigger>
              Calibration<Summary>{cal ? `stalls at ${cal.stopPct ? `${cal.stopPct}%` : 'never'}, restarts at ${cal.startPct ? `${cal.startPct}%` : 'n/a'}` : 'not measured'}</Summary>
            </AccordionTrigger>
            <AccordionContent>
              <CalibrationPanel fanId={fan.id} pump={fan.pump} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  )
}

function EmptyFans({ hiddenCount, onOpenSettings }: { hiddenCount: number; onOpenSettings(): void }) {
  const { controlFans, set } = useSettings()
  const connecting = backend.hwState === 'connecting'
  const retry = async () => {
    await backend.enableHw()
    if (backend.hwOn) await useStore.getState().init()
  }

  let title = 'No fans found'
  let body = 'Nothing controllable was reported by the hardware.'
  let action: React.ReactNode = null

  if (!IS_TAURI && !backend.simActive) {
    body = 'Fan control is only available in the desktop app.'
  } else if (!backend.simActive && !controlFans) {
    title = 'Fan control is off'
    body = 'Every fan is on its own firmware settings. Turn control on to see and tune them.'
    action = <Button size="sm" onClick={() => set({ controlFans: true })}>Turn on fan control</Button>
  } else if (!backend.simActive && connecting) {
    title = 'Waiting for permission'
    body = 'Windows is asking for administrator permission so the app can reach the fans.'
    action = <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
  } else if (!backend.simActive && !backend.hwOn) {
    title = 'Fan control is not running'
    body = backend.hwError ?? 'The hardware service did not start.'
    action = <Button size="sm" onClick={() => void retry()}>Try again</Button>
  } else if (hiddenCount > 0) {
    body = `${hiddenCount} fan${hiddenCount === 1 ? ' is' : 's are'} hidden because pumps and graphics card fans are left alone by default.`
    action = <Button size="sm" variant="outline" onClick={onOpenSettings}>Open settings</Button>
  }

  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-sm space-y-3">
        <FanIcon className="mx-auto size-8 text-muted-foreground" />
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
        <div className="flex justify-center">{action}</div>
      </div>
    </div>
  )
}

export function FansPage({ onOpenSettings }: { onOpenSettings(): void }) {
  const { fans, fanInfo, live, sensors, selectedFan, selectFan } = useStore()
  const prefs = useSettings()
  const batchRunning = useBatch((s) => s.running)
  const batchItems = useBatch((s) => s.items)
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [showBatch, setShowBatch] = useState(false)

  const kinds = useMemo(() => new Map(fanInfo.map((i) => [i.id, i.kind])), [fanInfo])
  const present = fans.filter((f) => kinds.has(f.id))
  const visible = present.filter((f) => kindEnabled(kinds.get(f.id)!, prefs))
  const hiddenCount = present.length - visible.length
  const fan = visible.find((f) => f.id === selectedFan) ?? visible[0]

  if (visible.length === 0 || !fan) return <EmptyFans hiddenCount={hiddenCount} onOpenSettings={onOpenSettings} />

  const toggle = (id: string) =>
    setChecked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const leaveSelect = () => {
    setSelecting(false)
    setChecked(new Set())
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex-1 text-xl font-semibold">Fans</h1>
          {selecting ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setChecked(new Set(visible.filter((f) => !f.pump).map((f) => f.id)))}>
                Select all
              </Button>
              <Button
                size="sm"
                disabled={checked.size === 0 || batchRunning}
                onClick={() => {
                  setShowBatch(true)
                  startBatch([...checked])
                  leaveSelect()
                }}
              >
                Calibrate {checked.size || ''}
              </Button>
              <Button size="sm" variant="ghost" onClick={leaveSelect}>Cancel</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={batchRunning} onClick={() => setSelecting(true)}>
              Calibrate…
            </Button>
          )}
        </div>

        {showBatch && batchItems.length > 0 && <BatchPanel onClose={() => setShowBatch(false)} />}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
          {visible.map((f) => (
            <FanCard
              key={f.id}
              fan={f}
              live={live[f.id]}
              active={f.id === fan.id}
              selecting={selecting}
              checked={checked.has(f.id)}
              onSelect={() => selectFan(f.id)}
              onCheck={() => toggle(f.id)}
            />
          ))}
        </div>

        {hiddenCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {hiddenCount} fan{hiddenCount === 1 ? '' : 's'} hidden and left to firmware (pumps, graphics card).{' '}
            <button type="button" className="underline underline-offset-2" onClick={onOpenSettings}>Change in settings</button>
          </p>
        )}

        {sensors.length > 0 && (
          <Disclosure title="Temperatures" summary={shortTemps(sensors)}>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-6 gap-y-2">
              {sensors.map((s) => (
                <div key={s.id} className="flex items-baseline justify-between gap-3 text-sm">
                  <Label className="truncate font-normal text-muted-foreground">{s.name}</Label>
                  <span className="tabular-nums">{s.value.toFixed(1)}°C</span>
                </div>
              ))}
            </div>
          </Disclosure>
        )}

        <FanDetail key={fan.id} fan={fan} live={live[fan.id]} sensors={sensors} />
      </div>
    </ScrollArea>
  )
}
