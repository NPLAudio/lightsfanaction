import { useCallback, useEffect, useRef, useState } from 'react'
import { IS_TAURI, invoke } from '../lib/hybrid'
import { LCD_SIZE, drawImage, drawLive, rgba, type Fit } from '../lib/lcd'
import { useStore } from '../store'

type Mode = 'live' | 'image'

const LIVE_EVERY_MS = 5000

export function LcdPage() {
  const sensors = useStore((s) => s.sensors)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<Mode>('live')
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [fit, setFit] = useState<Fit>('cover')
  const [brightness, setBrightness] = useState(80)
  const [orientation, setOrientation] = useState(0)
  const [auto, setAuto] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const sensorsRef = useRef(sensors)
  sensorsRef.current = sensors

  const render = useCallback(() => {
    const ctx = canvas.current?.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    if (mode === 'image' && img) drawImage(ctx, img, img.naturalWidth, img.naturalHeight, fit)
    else if (mode === 'image') {
      ctx.fillStyle = '#0d0e14'
      ctx.fillRect(0, 0, LCD_SIZE, LCD_SIZE)
    } else drawLive(ctx, sensorsRef.current)
  }, [mode, img, fit])

  useEffect(() => {
    render()
    if (mode !== 'live') return
    const t = setInterval(render, 1000)
    return () => clearInterval(t)
  }, [render, mode])

  useEffect(() => {
    if (!IS_TAURI) return
    invoke<{ brightness: number; orientation: number }>('kraken_info')
      .then((i) => {
        setBrightness(i.brightness)
        setOrientation(i.orientation)
      })
      .catch((e) => setStatus({ ok: false, text: String(e) }))
  }, [])

  const run = useCallback(async (what: string, f: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await f()
      setStatus({ ok: true, text: what })
    } catch (e) {
      setStatus({ ok: false, text: String(e) })
      setAuto(false)
    } finally {
      setBusy(false)
    }
  }, [])

  const send = useCallback(() => {
    render()
    return run('Sent to the cooler', () => invoke('kraken_image', rgba(canvas.current!)))
  }, [render, run])

  useEffect(() => {
    if (!auto || mode !== 'live') return
    void send()
    const t = setInterval(() => void send(), LIVE_EVERY_MS)
    return () => clearInterval(t)
  }, [auto, mode, send])

  const applyDisplay = (b: number, o: number) =>
    run('Display updated', () => invoke('kraken_display', { brightness: b, orientation: o }))

  const realTemps = sensors.some((s) => /liquid|coolant|water/i.test(s.name))

  return (
    <div className="main wide">
      <header className="page-head">
        <div>
          <h1>Kraken screen</h1>
          <p className="muted">Show your own image or live temperatures on the pump display.</p>
        </div>
      </header>

      {!IS_TAURI && <div className="notice"><span>The screen can only be controlled from the desktop app.</span></div>}

      <div className="lcd-layout">
        <div className="lcd-preview">
          <canvas ref={canvas} width={LCD_SIZE} height={LCD_SIZE} aria-label="Screen preview" />
        </div>

        <div className="panel">
          <div className="seg" role="group" aria-label="Screen content">
            <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>Live temps</button>
            <button className={mode === 'image' ? 'on' : ''} onClick={() => setMode('image')}>Image</button>
          </div>

          {mode === 'live' ? (
            <>
              {!realTemps && (
                <p className="muted note">
                  No real liquid temperature yet. Enable hardware control on the Fans page to show real readings.
                </p>
              )}
              <label className="switch row-switch">
                <input type="checkbox" checked={auto} disabled={!IS_TAURI} onChange={(e) => setAuto(e.target.checked)} />
                <span>Keep updating every {LIVE_EVERY_MS / 1000} s</span>
              </label>
            </>
          ) : (
            <div className="row" style={{ marginTop: 14 }}>
              <label htmlFor="file">Picture</label>
              <input
                id="file"
                type="file"
                accept="image/*"
                style={{ gridColumn: '2 / 4' }}
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
              <label>Fit</label>
              <div className="seg" style={{ gridColumn: '2 / 4' }}>
                <button className={fit === 'cover' ? 'on' : ''} onClick={() => setFit('cover')}>Fill</button>
                <button className={fit === 'contain' ? 'on' : ''} onClick={() => setFit('contain')}>Fit</button>
              </div>
            </div>
          )}

          <div className="row" style={{ marginTop: 14 }}>
            <label htmlFor="lcd-b">Brightness</label>
            <input id="lcd-b" type="range" min={0} max={100} value={brightness} onChange={(e) => setBrightness(Number(e.target.value))} onPointerUp={() => void applyDisplay(brightness, orientation)} />
            <output>{brightness}%</output>
          </div>
          <div className="row">
            <label>Rotation</label>
            <div className="seg" style={{ gridColumn: '2 / 4' }}>
              {[0, 1, 2, 3].map((o) => (
                <button key={o} className={orientation === o ? 'on' : ''} onClick={() => { setOrientation(o); void applyDisplay(brightness, o) }}>
                  {o * 90}°
                </button>
              ))}
            </div>
          </div>

          <div className="lcd-actions">
            <button className="btn primary" disabled={!IS_TAURI || busy || (mode === 'image' && !img)} onClick={() => void send()}>
              {busy ? 'Sending…' : 'Send to cooler'}
            </button>
            <button className="btn" disabled={!IS_TAURI || busy} onClick={() => { setAuto(false); void run('Back to the built-in screen', () => invoke('kraken_liquid')) }}>
              Restore built-in screen
            </button>
          </div>
          {status && <p className={`muted note ${status.ok ? '' : 'err'}`}>{status.text}</p>}
        </div>
      </div>
    </div>
  )
}
