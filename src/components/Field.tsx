import { useId, type ReactNode } from 'react'
import { InfoIcon } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Label with an optional "?" tooltip, so explanations are there when wanted and not otherwise. */
export function Hint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger className="text-muted-foreground hover:text-foreground" aria-label={text}>
        <InfoIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{text}</TooltipContent>
    </Tooltip>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  hint?: string
  disabled?: boolean
  onChange(v: number): void
}

export function SliderField({ label, value, min, max, step = 1, unit = '', hint, disabled, onChange }: SliderProps) {
  const id = useId()
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id} className="text-sm">{label}</Label>
        {hint && <Hint text={hint} />}
        <span className="ml-auto text-sm tabular-nums text-muted-foreground">{value}{unit}</span>
      </div>
      <Slider
        id={id}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      />
    </div>
  )
}

interface SwitchProps {
  label: string
  description?: ReactNode
  checked: boolean
  disabled?: boolean
  onChange(v: boolean): void
}

/** A setting row: text on the left, switch on the right. */
export function SwitchField({ label, description, checked, disabled, onChange }: SwitchProps) {
  const id = useId()
  return (
    <div className="flex items-start gap-4">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={id} className="text-sm">{label}</Label>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}
