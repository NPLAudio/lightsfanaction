import { Fragment } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AudioStatusLine } from '@/components/AudioStatusLine'
import { Disclosure } from '@/components/Disclosure'
import { FadeBar } from '@/components/FadeBar'
import { GradientField } from '@/components/GradientField'
import { SliderField } from '@/components/Field'
import { defaultParams, effectById, effectsFor } from '@/lib/effects'
import type { Assignment, Device, ParamValue } from '@/lib/types'
import { useStore } from '@/store'

/** Where changes go, when they are not for the device's own effect (a zone's effect, say). */
export interface EffectActions {
  setEffect(effectId: string): void
  setBrightness(value: number): void
  setParam(key: string, value: ParamValue): void
}

interface Props {
  dev: Device
  a: Assignment
  actions?: EffectActions
}

/** The effect picker and brightness for one device (the cooler's screen included). */
export function EffectCard({ dev, a, actions, onChoose }: Props & { onChoose?: (effectId: string) => void }) {
  const storeEffect = useStore((s) => s.setEffect)
  const storeBrightness = useStore((s) => s.setBrightness)
  const setEffect = (id: string, effectId: string) => (actions ? actions.setEffect(effectId) : storeEffect(id, effectId))
  const setBrightness = (id: string, v: number) => (actions ? actions.setBrightness(v) : storeBrightness(id, v))
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
export function EffectOptions({ dev, a, actions }: Props) {
  const storeParam = useStore((s) => s.setParam)
  const setParam = (id: string, key: string, v: ParamValue) => (actions ? actions.setParam(key, v) : storeParam(id, key, v))
  const fx = effectById(a.effectId)
  if (fx.params.length === 0) return null
  // the fade bars sit under the last color picker, so a change there shows right away
  const lastColor = fx.params.map((p) => p.type).lastIndexOf('color')
  return (
    <Disclosure
      key={`${dev.id}-${fx.id}`}
      title="Effect options"
      summary={fx.params.map((p) => p.label).join(' · ')}
      defaultOpen={fx.params.length <= 2 || fx.params.some((p) => p.type === 'gradient')}
    >
      {fx.params.map((p, index) => (
        <Fragment key={p.key}>
          {p.type === 'gradient' ? (
            <GradientField
              label={p.label}
              value={a.params[p.key]}
              fallback={String(p.default)}
              cyclic={p.cyclic}
              onChange={(v) => setParam(dev.id, p.key, v)}
            />
          ) : p.type === 'color' ? (
          <div className="flex items-center gap-3">
            <Label htmlFor={`p-${p.key}`} className="flex-1 text-sm">{p.label}</Label>
            <input
              id={`p-${p.key}`}
              type="color"
              value={String(a.params[p.key] ?? p.default)}
              onChange={(e) => setParam(dev.id, p.key, e.target.value)}
              className="h-8 w-12 cursor-pointer rounded-md border bg-transparent p-0.5"
            />
          </div>
          ) : (
            <SliderField
              label={p.label}
              value={Number(a.params[p.key] ?? p.default)}
              min={p.min ?? 0}
              max={p.max ?? 100}
              step={p.step}
              onChange={(v) => setParam(dev.id, p.key, v)}
            />
          )}
          {index === lastColor && fx.fades?.map((f) => <FadeBar key={f.label} fade={f} params={{ ...defaultParams(fx.id), ...a.params }} />)}
        </Fragment>
      ))}
    </Disclosure>
  )
}
