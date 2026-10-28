import { useEffect, useReducer } from 'react'
import { Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { backend } from '@/lib/backend'
import { IS_TAURI } from '@/lib/hybrid'
import { useSettings } from '@/settings'
import { useStore } from '@/store'
import { cn } from '@/lib/utils'

type Level = 'ok' | 'wait' | 'attention' | 'dev'

/** Rolls everything that can go wrong into one dot, with the details one click away. */
export function StatusPopover() {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => backend.subscribe(rerender), [])
  const { controlFans, useSimulator } = useSettings()

  const simulated = backend.simActive
  const connecting = backend.hwState === 'connecting'
  const fansWanted = IS_TAURI && controlFans && !simulated
  const fansProblem = fansWanted && !backend.hwOn && !connecting
  const lightsProblem = IS_TAURI && !simulated && backend.rgbCount === 0

  const level: Level = simulated ? 'dev' : connecting ? 'wait' : fansProblem || lightsProblem ? 'attention' : 'ok'
  const label = { ok: 'All connected', wait: 'Starting…', attention: 'Needs attention', dev: 'Simulated' }[level]

  const rescan = () => void useStore.getState().init()
  const retryFans = async () => {
    await backend.enableHw()
    if (backend.hwOn) await useStore.getState().init()
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="gap-2" aria-label={`Status: ${label}`}>
            <span
              className={cn(
                'size-2 rounded-full',
                level === 'ok' && 'bg-emerald-400',
                level === 'wait' && 'animate-pulse bg-warn',
                level === 'attention' && 'bg-warn',
                level === 'dev' && 'bg-primary',
              )}
            />
            <span className="hidden sm:inline">{label}</span>
          </Button>
        }
      />
      <PopoverContent align="end" className="w-80 space-y-3">
        <Row
          title="Lighting"
          ok={backend.rgbCount > 0}
          detail={
            simulated
              ? 'Simulated devices'
              : backend.rgbCount > 0
                ? `OpenRGB, ${backend.rgbCount} device${backend.rgbCount === 1 ? '' : 's'}`
                : (backend.rgbError ?? 'OpenRGB was not found. Start OpenRGB and enable its SDK Server.')
          }
          action={!simulated && IS_TAURI && backend.rgbCount === 0 ? { label: 'Rescan', onClick: rescan } : undefined}
        />
        <Row
          title="Fans"
          ok={backend.hwOn || simulated}
          wait={connecting}
          detail={
            simulated
              ? 'Simulated fans'
              : !controlFans
                ? 'Fan control is off, so fans stay on their own firmware settings.'
                : connecting
                  ? 'Waiting for administrator permission…'
                  : backend.hwOn
                    ? backend.hwElevated
                      ? 'Controlled, with full sensor access'
                      : 'Controlled, but without administrator rights some fans and sensors are missing'
                    : (backend.hwError ?? 'Not running')
          }
          action={fansProblem ? { label: 'Retry', onClick: () => void retryFans() } : undefined}
        />
        {useSimulator && <p className="text-xs text-muted-foreground">The simulator is on (Settings, Developer).</p>}
      </PopoverContent>
    </Popover>
  )
}

function Row({
  title,
  detail,
  ok,
  wait,
  action,
}: {
  title: string
  detail: string
  ok: boolean
  wait?: boolean
  action?: { label: string; onClick(): void }
}) {
  return (
    <div className="flex items-start gap-3">
      <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', ok ? 'bg-emerald-400' : 'bg-warn')} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>
      {wait && <Loader2Icon className="mt-1 size-4 animate-spin text-muted-foreground" />}
      {action && (
        <Button size="sm" variant="outline" onClick={action.onClick}>
          <RefreshCwIcon /> {action.label}
        </Button>
      )}
    </div>
  )
}
