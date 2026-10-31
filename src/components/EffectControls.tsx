import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AudioStatusLine } from '@/components/AudioStatusLine'
import { Disclosure } from '@/components/Disclosure'
import { SliderField } from '@/components/Field'
import { effectById, effectsFor } from '@/lib/effects'
import type { Assignment, Device } from '@/lib/types'
import { useStore } from '@/store'

interface Props {
  dev: Device
  a: Assignment
}

/** The effect picker and brightness for one device (the cooler's screen included). */
export function EffectCard({ dev, a, onChoose }: Props & { onChoose?: (effectId: string) => void }) {
  const setEffect = useStore((s) => s.setEffect)
  const setBrightness = useStore((s) => s.setBrightness)
  const fx = effectById(a.effectId)
  const choices = effectsFor(dev.kind)
  return (
    <Card>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label>{dev.kind === 'screen' ? 'Screen shows' : 'Effect'}</Label>
          <Select
            value={a.effectId}
            onValueChange={(v) => {
              if (!v) return
              setEffect(dev.id, v)
              onChoose?.(v)
            }}
            items={choices.map((e) => ({ value: e.id, label: e.name }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">{fx.description}</p>
          {fx.reactive && <AudioStatusLine />}
        </div>
        <SliderField label="Brightness" value={a.brightness} min={0} max={100} unit="%" onChange={(v) => setBrightness(dev.id, v)} />
      </CardContent>
    </Card>
  )
}

/** The chosen effect's own settings, tucked away unless there are only one or two. */
export function EffectOptions({ dev, a }: Props) {
  const setParam = useStore((s) => s.setParam)
  const fx = effectById(a.effectId)
  if (fx.params.length === 0) return null
  return (
    <Disclosure
      key={`${dev.id}-${fx.id}`}
      title="Effect options"
      summary={fx.params.map((p) => p.label).join(' · ')}
      defaultOpen={fx.params.length <= 2}
    >
      {fx.params.map((p) =>
        p.type === 'color' ? (
          <div key={p.key} className="flex items-center gap-3">
            <Label htmlFor={`p-${p.key}`} className="flex-1 text-sm">{p.label}</Label>
            <input
              id={`p-${p.key}`}
              type="color"
              value={String(a.params[p.key])}
              onChange={(e) => setParam(dev.id, p.key, e.target.value)}
              className="h-8 w-12 cursor-pointer rounded-md border bg-transparent p-0.5"
            />
          </div>
        ) : (
          <SliderField
            key={p.key}
            label={p.label}
            value={Number(a.params[p.key])}
            min={p.min ?? 0}
            max={p.max ?? 100}
            step={p.step}
            onChange={(v) => setParam(dev.id, p.key, v)}
          />
        ),
      )}
    </Disclosure>
  )
}
