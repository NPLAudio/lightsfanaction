import { useCallback, useEffect, useRef, useState } from 'react'
import { MonitorIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Disclosure } from '@/components/Disclosure'
import { IS_TAURI, invoke } from '@/lib/hybrid'
import { effectById, effectsFor } from '@/lib/effects'
import { LCD_SIZE, drawImage, drawLive, rgba, type Fit } from '@/lib/lcd'
import { drawThemed, resolveTheme } from '@/lib/lcdTheme'
import { sendToKraken } from '@/lcdLive'
import { useStore } from '@/store'

type Mode = 'live' | 'image'

export function ScreenPage() {
  const sensors = useStore((s) => s.sensors)
  const liveError = useStore((s) => s.lcdError)
  const held = useStore((s) => s.lcdStatic)
  const screen = useStore((s) => s.devices.find((d) => d.kind === 'screen'))
  const screenEffect = useStore((s) => (screen ? s.assignments[screen.id]?.effectId : undefined))
  const canvas = useRef<HTMLCanvasElement>(null)
  const sensorsRef = useRef(sensors)
  const [mode, setMode] = useState<Mode>(held ? 'image' : 'live')
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [fit, setFit] = useState<Fit>('cover')
  const [brightness, setBrightness] = useState(80)
  const [orientation, setOrientation] = useState(0)
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(IS_TAURI ? null : 'The screen can only be controlled from the desktop app.')

  useEffect(() => {
    sensorsRef.current = sensors
  }, [sensors])

  const render = useCallback(() => {
    const ctx = canvas.current?.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    if (mode === 'image' && img) drawImage(ctx, img, img.naturalWidth, img.naturalHeight, fit)
    else if (mode === 'image') {
      ctx.fillStyle = '#10111a'
      ctx.fillRect(0, 0, LCD_SIZE, LCD_SIZE)
    } else {
      const theme = resolveTheme()
      if (theme) drawThemed(ctx, sensorsRef.current, theme, performance.now() / 1000)
      else drawLive(ctx, sensorsRef.current)
    }
  }, [mode, img, fit])

  useEffect(() => {
    render()
    if (mode === 'image') return
    const t = setInterval(render, 100)
    return () => clearInterval(t)
  }, [render, mode])

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<{ brightness: number; orientation: number }>('kraken_info')
      .then((i) => {
        setBrightness(i.brightness)
        setOrientation(i.orientation)
        setUnavailable(null)
      })
      .catch((e) => setUnavailable(String(e)))
  }, [])

  const run = useCallback(async (done: string, f: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await f()
      toast.success(done)
    } catch (e) {
      toast.error('The cooler did not accept that', { description: String(e) })
    } finally {
      setBusy(false)
    }
  }, [])

  const send = () => {
    render()
    useStore.getState().setLcdStatic(true) // the live screen would overwrite a picture
    void run('Sent to the cooler', () => sendToKraken(rgba(canvas.current!)))
  }

  const applyDisplay = (b: number, o: number) =>
    void run('Display updated', () => invoke('kraken_display', { brightness: b, orientation: o }))

  const realTemps = sensors.some((s) => /liquid|coolant|water/i.test(s.name))

  if (unavailable) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="max-w-sm space-y-2">
          <MonitorIcon className="mx-auto size-8 text-muted-foreground" />
          <p className="font-medium">No cooler screen available</p>
          <p className="text-sm text-muted-foreground">{unavailable}</p>
          <p className="text-sm text-muted-foreground">If NZXT CAM is running, close it: only one program can use the screen at a time.</p>
        </div>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto grid max-w-4xl gap-6 p-6 md:grid-cols-[18rem_1fr]">
        <div className="mx-auto aspect-square w-full max-w-72 overflow-hidden rounded-full bg-black ring-1 ring-border">
          <canvas ref={canvas} width={LCD_SIZE} height={LCD_SIZE} className="size-full" aria-label="Screen preview" />
        </div>

        <div className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Cooler screen</h1>
            <p className="text-sm text-muted-foreground">Live temperatures, themed to match your lighting if you like, or a picture on the pump display.</p>
          </div>

          <Tabs
            value={mode}
            onValueChange={(v) => {
              setMode(v as Mode)
              // coming back to the live screen resumes it; a picture only takes over once it is sent
              if (v === 'live') useStore.getState().setLcdStatic(false)
            }}
          >
            <TabsList>
              <TabsTrigger value="live">Live</TabsTrigger>
              <TabsTrigger value="image">Picture</TabsTrigger>
            </TabsList>
          </Tabs>

          <Card>
            <CardContent className="space-y-4">
              {mode === 'live' ? (
                <>
                  <div className="space-y-2">
                    <Label>Screen shows</Label>
                    <Select
                      value={screenEffect ?? 'stats'}
                      onValueChange={(v) => v && screen && useStore.getState().setEffect(screen.id, v)}
                      items={effectsFor('screen').map((e) => ({ value: e.id, label: e.name }))}
                      disabled={!screen}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {effectsFor('screen').map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            {e.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-sm text-muted-foreground">
                      {effectById(screenEffect ?? 'stats').description} The screen is always live, even with the window
                      closed. The same choice is in the lighting list under Kraken display, with its effect options.
                    </p>
                  </div>
                  {held && (
                    <p className="text-sm text-muted-foreground">
                      The screen is showing a held picture or the built-in display. Switch to this tab to resume the live screen.
                    </p>
                  )}
                  {!realTemps && (
                    <p className="text-sm text-muted-foreground">No liquid temperature yet. Fan control must be on to read it.</p>
                  )}
                  {liveError && <p className="text-sm text-destructive">{liveError}</p>}
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="picture">Picture</Label>
                    <Input
                      id="picture"
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        const url = URL.createObjectURL(f)
                        const i = new Image()
                        i.onload = () => {
                          setImg(i)
                          URL.revokeObjectURL(url)
                        }
                        i.src = url
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <Label className="flex-1">Fit</Label>
                    <ToggleGroup value={[fit]} onValueChange={(v) => v[0] && setFit(v[0] as Fit)} variant="outline" spacing={0}>
                      <ToggleGroupItem value="cover">Fill</ToggleGroupItem>
                      <ToggleGroupItem value="contain">Fit</ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-2">
                {mode === 'image' && (
                  <Button disabled={busy || !img} onClick={send}>
                    {busy ? 'Sending…' : 'Send to cooler'}
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    useStore.getState().setLcdStatic(true)
                    void run('Back to the built-in screen', () => invoke('kraken_liquid'))
                  }}
                >
                  Restore built-in screen
                </Button>
              </div>
            </CardContent>
          </Card>

          <Disclosure title="Display options" summary={`Brightness ${brightness}% · rotated ${orientation * 90}°`}>
            <div className="space-y-2">
              <div className="flex items-center">
                <Label className="flex-1">Brightness</Label>
                <span className="text-sm tabular-nums text-muted-foreground">{brightness}%</span>
              </div>
              <Slider
                value={brightness}
                min={0}
                max={100}
                aria-label="Screen brightness"
                onValueChange={(v) => setBrightness(Array.isArray(v) ? v[0] : v)}
                onValueCommitted={(v) => applyDisplay(Array.isArray(v) ? v[0] : v, orientation)}
              />
            </div>
            <div className="flex items-center gap-3">
              <Label className="flex-1">Rotation</Label>
              <ToggleGroup
                value={[String(orientation)]}
                onValueChange={(v) => {
                  if (!v[0]) return
                  const o = Number(v[0])
                  setOrientation(o)
                  applyDisplay(brightness, o)
                }}
                variant="outline"
                spacing={0}
              >
                {[0, 1, 2, 3].map((o) => (
                  <ToggleGroupItem key={o} value={String(o)}>{o * 90}°</ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </Disclosure>
        </div>
      </div>
    </ScrollArea>
  )
}
