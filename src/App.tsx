import { useEffect, useState } from 'react'
import { FanIcon, LightbulbIcon, SettingsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SettingsDialog } from '@/components/SettingsDialog'
import { StatusPopover } from '@/components/StatusPopover'
import { startControl } from '@/control'
import { startEngine } from '@/engine'
import { startLcdLoop } from '@/lcdLive'
import { backend } from '@/lib/backend'
import { IS_TAURI } from '@/lib/hybrid'
import { FansPage } from '@/pages/FansPage'
import { LightingPage } from '@/pages/LightingPage'
import { useSettings } from '@/settings'
import { useStore } from '@/store'

type Page = 'lighting' | 'fans'

/** Brings fan control in line with the settings: on by default, off hands everything back to firmware. */
async function syncHardware() {
  if (backend.hwWanted && !backend.hwOn && backend.hwState !== 'connecting') {
    await backend.enableHw()
    if (backend.hwOn) await useStore.getState().init()
  } else if (!backend.hwWanted && backend.hwState !== 'off') {
    await backend.disableHw()
    await useStore.getState().init()
  }
}

export default function App() {
  const [page, setPage] = useState<Page>('lighting')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const ready = useStore((s) => s.ready)

  useEffect(() => {
    void (async () => {
      await useStore.getState().init()
      startEngine()
      startLcdLoop()
      startControl()
      await syncHardware()
    })()

    // changing the fan switch or the simulator switch takes effect straight away
    const unsub = useSettings.subscribe((s, prev) => {
      if (s.controlFans !== prev.controlFans || s.useSimulator !== prev.useSimulator) {
        void useStore.getState().init().then(syncHardware)
      }
    })

    // the tray menu's "Settings…" item
    let off: (() => void) | undefined
    if (IS_TAURI) {
      void import('@tauri-apps/api/event').then(({ listen }) =>
        listen('open-settings', () => setSettingsOpen(true)).then((u) => (off = u)),
      )
    }
    return () => {
      unsub()
      off?.()
    }
  }, [])

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <div className="flex items-center gap-2.5 pr-2">
          <span
            aria-hidden
            className="size-5 rounded-full"
            style={{ background: 'conic-gradient(var(--primary), var(--brand-teal), oklch(0.7 0.22 350), var(--primary))' }}
          />
          <span className="hidden font-semibold sm:inline">Lights Fan Action</span>
        </div>
        <Tabs value={page} onValueChange={(v) => setPage(v as Page)}>
          <TabsList>
            <TabsTrigger value="lighting"><LightbulbIcon /> Lighting</TabsTrigger>
            <TabsTrigger value="fans"><FanIcon /> Fans</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex-1" />
        <StatusPopover />
        <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon />
        </Button>
      </header>

      <main className="min-h-0 flex-1">
        {!ready ? (
          <p className="p-6 text-sm text-muted-foreground">Looking for devices…</p>
        ) : page === 'lighting' ? (
          <LightingPage />
        ) : (
          <FansPage onOpenSettings={() => setSettingsOpen(true)} />
        )}
      </main>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  )
}
