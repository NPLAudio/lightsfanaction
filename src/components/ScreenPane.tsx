import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Disclosure } from '@/components/Disclosure'
import { EffectCard, EffectOptions } from '@/components/EffectControls'
import { IS_TAURI, invoke } from '@/lib/hybrid'
import { LCD_SIZE, drawImage, drawLive, rgba, type Fit } from '@/lib/lcd'
import { drawThemed, resolveTheme } from '@/lib/lcdTheme'
import type { Assignment, Device } from '@/lib/types'
import { sendToKraken } from '@/lcdLive'
import { useStore } from '@/store'

/**
 * The cooler's display as an item in the lighting list: a live preview of the screen, what it shows (picked like
 * any effect, with Stats only, Match cooler lighting, Picture and the cooler's own screen as extra choices), and the
 * screen's own settings.
 */
export function ScreenPane({ dev, a }: { dev: Device; a: Assignment }) {
  const sensors = useStore((s) => s.sensors)
  const liveError = useStore((s) => s.lcdError)
  const canvas = useRef<HTMLCanvasElement>(null)
  const sensorsRef = useRef(sensors)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [fit, setFit] = useState<Fit>('cover')
  const [backlight, setBacklight] = useState(80)
  const [orientation, setOrientation] = useState(0)
  const [busy, setBusy] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(IS_TAURI ? null : 'The screen can only be controlled from the desktop app.')
  const picture = a.effectId === 'picture'

  useEffect(() => {
    sensorsRef.current = sensors
  }, [sensors])

  const render = useCallback(() => {
    const ctx = canvas.current?.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    if (picture) {
      if (img) drawImage(ctx, img, img.naturalWidth, img.naturalHeight, fit)
      else {
        ctx.fillStyle = '#10111a'
        ctx.fillRect(0, 0, LCD_SIZE, LCD_SIZE)
      }
      return
    }
    if (a.effectId === 'builtin') {
      ctx.fillStyle = '#10111a'
      ctx.fillRect(0, 0, LCD_SIZE, LCD_SIZE)
      ctx.fillStyle = '#8a90aa'
      ctx.textAlign = 'center'
      ctx.font = '600 34px "Segoe UI", sans-serif'
      ctx.fillText("The cooler's own screen", LCD_SIZE / 2, LCD_SIZE / 2 + 12)
      return
    }
    const theme = resolveTheme()
    if (theme) drawThemed(ctx, sensorsRef.current, theme, performance.now() / 1000)
    else drawLive(ctx, sensorsRef.current)
  }, [a.effectId, picture, img, fit])

  useEffect(() => {
    render()
    if (picture || a.effectId === 'builtin') return
    const t = setInterval(render, 100)
    return () => clearInterval(t)
  }, [render, picture, a.effectId])

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<{ brightness: number; orientation: number }>('kraken_info')
      .then((i) => {
        setBacklight(i.brightness)
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

  const applyDisplay = (b: number, o: number) =>
    void run('Display updated', () => invoke('kraken_display', { brightness: b, orientation: o }))

  // choosing the cooler's own screen hands it back straight away
  const chose = (effectId: string) => {
    if (effectId === 'builtin') void run('Back to the built-in screen', () => invoke('kraken_liquid'))
  }

  const realTemps = sensors.some((s) => /liquid|coolant|water/i.test(s.name))

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{dev.name}</h1>
        <p className="text-sm text-muted-foreground">The pump display, always live. Choose what it shows; the cooler's lights are their own item in this list.</p>
      </div>

      <Card>
        <CardContent className="grid place-items-center py-6">
          <div className="aspect-square w-full max-w-72 overflow-hidden rounded-full bg-black ring-1 ring-border">
            <canvas ref={canvas} width={LCD_SIZE} height={LCD_SIZE} className="size-full" aria-label="Screen preview" />
          </div>
        </CardContent>
      </Card>

      <EffectCard dev={dev} a={a} onChoose={chose} />

      {picture && (
        <Card>
          <CardContent className="space-y-4">
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
            <Button
              disabled={busy || !img || !!unavailable}
              onClick={() => {
                render()
                void run('Sent to the cooler', () => sendToKraken(rgba(canvas.current!)))
              }}
            >
              {busy ? 'Sending…' : 'Send to cooler'}
            </Button>
          </CardContent>
        </Card>
      )}

      {!picture && a.effectId !== 'builtin' && <EffectOptions dev={dev} a={a} />}

      {!realTemps && a.effectId !== 'picture' && a.effectId !== 'builtin' && (
        <p className="text-sm text-muted-foreground">No liquid temperature yet. Fan control must be on to read it.</p>
      )}
      {unavailable ? (
        <p className="text-sm text-destructive">
          {unavailable} If NZXT CAM is running, close it: only one program can use the screen at a time.
        </p>
      ) : (
        liveError && <p className="text-sm text-destructive">{liveError}</p>
      )}

      <Disclosure title="Display options" summary={`Backlight ${backlight}% · rotated ${orientation * 90}°`}>
        <div className="space-y-2">
          <div className="flex items-center">
            <Label className="flex-1">Backlight</Label>
            <span className="text-sm tabular-nums text-muted-foreground">{backlight}%</span>
          </div>
          <Slider
            value={backlight}
            min={0}
            max={100}
            aria-label="Screen backlight"
            disabled={!!unavailable}
            onValueChange={(v) => setBacklight(Array.isArray(v) ? v[0] : v)}
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
              applyDisplay(backlight, o)
            }}
            variant="outline"
            spacing={0}
          >
            {[0, 1, 2, 3].map((o) => (
              <ToggleGroupItem key={o} value={String(o)} disabled={!!unavailable}>
                {o * 90}°
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </Disclosure>
    </div>
  )
}
