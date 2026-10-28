import { CheckIcon, CircleAlertIcon, Loader2Icon, MinusIcon, ThermometerIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cancelBatch, useBatch, type BatchStatus } from '@/calibrate'

const ICON: Record<BatchStatus, typeof CheckIcon> = {
  queued: MinusIcon,
  cooling: ThermometerIcon,
  running: Loader2Icon,
  done: CheckIcon,
  failed: CircleAlertIcon,
  skipped: MinusIcon,
}

const LABEL: Record<BatchStatus, string> = {
  queued: 'Waiting',
  cooling: 'Cooling down',
  running: 'Measuring',
  done: 'Done',
  failed: 'Not measured',
  skipped: 'Skipped',
}

/** Progress of a multi-fan calibration. Stays until closed so the results can be read. */
export function BatchPanel({ onClose }: { onClose(): void }) {
  const { running, items, current } = useBatch()
  const finished = items.filter((i) => i.status === 'done' || i.status === 'failed' || i.status === 'skipped').length

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="flex-1 text-sm font-medium">
            {running ? `Calibrating ${items.length} fans` : 'Calibration finished'}
          </h2>
          {running ? (
            <Button size="sm" variant="outline" onClick={cancelBatch}>Cancel</Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          )}
        </div>
        <Progress value={items.length ? (finished / items.length) * 100 : 0} />
        <ul className="space-y-2">
          {items.map((i) => {
            const Icon = ICON[i.status]
            return (
              <li key={i.id} className="grid grid-cols-[1rem_10rem_1fr] items-baseline gap-x-3 text-sm">
                <Icon className={i.status === 'running' ? 'size-4 animate-spin' : 'size-4 text-muted-foreground'} />
                <span className="truncate font-medium">{i.name}</span>
                <span className="text-muted-foreground">
                  {LABEL[i.status]}
                  {i.status === 'running' && current ? `: ${current.phase}, ${current.pct}% to ${current.rpm} RPM` : i.text ? ` · ${i.text}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
