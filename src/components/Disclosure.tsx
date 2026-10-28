import { useState, type ReactNode } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

interface Props {
  title: string
  /** one line shown next to the title while closed, so the section can be skipped without opening it */
  summary?: ReactNode
  /** small flag on the right, e.g. "Needs setup" */
  badge?: ReactNode
  defaultOpen?: boolean
  className?: string
  children: ReactNode
}

/** A section that stays out of the way until asked for. */
export function Disclosure({ title, summary, badge, defaultOpen = false, className, children }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('rounded-xl border bg-card', className)}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="text-sm font-medium">{title}</span>
        {!open && summary && <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{summary}</span>}
        {(open || !summary) && <span className="flex-1" />}
        {badge}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 px-4 pt-1 pb-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
