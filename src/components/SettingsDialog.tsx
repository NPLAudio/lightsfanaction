import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SwitchField } from '@/components/Field'
import { IS_TAURI, invoke } from '@/lib/hybrid'
import { useSettings } from '@/settings'
import pkg from '../../package.json'

interface Props {
  open: boolean
  onOpenChange(open: boolean): void
}

async function autostart() {
  return import('@tauri-apps/plugin-autostart')
}

export function SettingsDialog({ open, onOpenChange }: Props) {
  const s = useSettings()
  const [login, setLogin] = useState(false)
  const taps = useRef(0)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    if (!open || !IS_TAURI) return
    void autostart().then((a) => a.isEnabled()).then(setLogin).catch(() => setLogin(false))
  }, [open])

  // the Rust side decides what the close button does, so tell it whenever the setting changes
  useEffect(() => {
    if (IS_TAURI) void invoke('set_close_to_tray', { on: s.closeToTray }).catch(() => undefined)
  }, [s.closeToTray])

  const toggleLogin = async (on: boolean) => {
    try {
      const a = await autostart()
      if (on) await a.enable()
      else await a.disable()
      setLogin(on)
    } catch (e) {
      toast.error('Could not change the startup setting', { description: String(e) })
    }
  }

  const tapVersion = () => {
    taps.current += 1
    if (taps.current >= 7 && !s.devUnlocked) {
      s.set({ devUnlocked: true })
      toast('Developer options unlocked')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Changes apply immediately.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="general" className="px-6 pb-6">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="fans">Fans</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
            {s.devUnlocked && <TabsTrigger value="dev">Developer</TabsTrigger>}
          </TabsList>

          <TabsContent value="general" className="space-y-5 pt-4">
            <SwitchField
              label="Start with Windows"
              description="Starts quietly in the tray when you sign in."
              checked={login}
              disabled={!IS_TAURI}
              onChange={(v) => void toggleLogin(v)}
            />
            <SwitchField
              label="Keep running in the tray when closed"
              description="Lighting and fan control carry on after you close the window. Quit from the tray icon."
              checked={s.closeToTray}
              onChange={(v) => s.set({ closeToTray: v })}
            />
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">Stream Deck</p>
              <p className="text-sm text-muted-foreground">
                Keys and dials for temperatures, fan speeds, cooler status, lighting effects and brightness. Show the
                plugin file, then double-click it to install it into the Stream Deck app.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!IS_TAURI}
                onClick={() =>
                  void invoke('show_streamdeck_plugin').catch((e) =>
                    toast.error('Could not find the Stream Deck plugin', { description: String(e) }),
                  )
                }
              >
                Show plugin file
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="fans" className="space-y-5 pt-4">
            <SwitchField
              label="Control fans"
              description="Needs administrator permission. Turned off, every fan stays on its own firmware settings."
              checked={s.controlFans}
              disabled={!IS_TAURI || s.useSimulator}
              onChange={(v) => s.set({ controlFans: v })}
            />
            <div className="space-y-2">
              <Label htmlFor="lhm-dir" className="text-sm">LibreHardwareMonitor folder</Label>
              <Input
                id="lhm-dir"
                placeholder="Found automatically"
                value={s.lhmDir}
                disabled={!IS_TAURI}
                onChange={(e) => s.set({ lhmDir: e.target.value })}
              />
              <p className="text-sm text-muted-foreground">
                Fan control reads LibreHardwareMonitor, which is installed separately. Only fill this in if it lives
                somewhere unusual. Because fan control runs with administrator rights it must be a folder only
                administrators can change, such as one under Program Files.
              </p>
            </div>
            <Separator />
            <p className="text-sm text-muted-foreground">
              Anything switched off here is hidden and left alone: the app never changes its speed.
            </p>
            <SwitchField
              label="Include pumps"
              description="Show and control liquid cooler pumps. A pump never drops below 60%."
              checked={s.includePumps}
              onChange={(v) => s.set({ includePumps: v })}
            />
            <SwitchField
              label="Include graphics card fans"
              description="Show and control the fans on the graphics card."
              checked={s.includeGpuFans}
              onChange={(v) => s.set({ includeGpuFans: v })}
            />
          </TabsContent>

          <TabsContent value="about" className="space-y-4 pt-4">
            <div>
              <p className="font-medium">Lights Fan Action</p>
              <button type="button" onClick={tapVersion} className="text-sm text-muted-foreground outline-none">
                Version {pkg.version}
              </button>
            </div>
            <p className="text-sm text-muted-foreground">
              Open-source lighting and fan control. Lighting goes through OpenRGB; fan and temperature access uses
              LibreHardwareMonitor.
            </p>
            <Separator />
            {confirmReset ? (
              <div className="flex items-center gap-2">
                <span className="text-sm">Reset every setting?</span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    s.reset()
                    setConfirmReset(false)
                    toast('Settings reset')
                  }}
                >
                  Reset
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmReset(true)}>Reset settings</Button>
            )}
          </TabsContent>

          {s.devUnlocked && (
            <TabsContent value="dev" className="space-y-5 pt-4">
              <SwitchField
                label="Use simulated hardware"
                description="Fake devices, fans and temperatures. Real hardware is left alone while this is on."
                checked={s.useSimulator}
                onChange={(v) => s.set({ useSimulator: v })}
              />
              <Separator />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  s.set({ devUnlocked: false, useSimulator: false })
                  taps.current = 0
                }}
              >
                Hide developer options
              </Button>
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
