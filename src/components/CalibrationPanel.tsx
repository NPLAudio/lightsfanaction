import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { SliderField } from '@/components/Field'
import { CalibrationStopped, calibrateFan, useBatch, type CalProgress } from '@/calibrate'
import { previewFan } from '@/engine'
import type { FanCalibration } from '@/lib/types'
import { useStore } from '@/store'

function RpmGraph({ cal }: { cal: FanCalibration }) {
  const W = 260, H = 90, pad = 8
  const max = Math.max(cal.maxRpm, 1)
  const x = (pct: number) => pad + (pct / 100) * (W - pad * 2)
  const y = (rpm: number) => H - pad - (rpm / max) * (H - pad * 2)
  const d = cal.map.map((m, i) => `${i ? 'L' : 'M'}${x(m.pct)},${y(m.rpm)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-72 rounded-lg bg-muted" role="img" aria-label="Measured speed against duty">
      <path d={d} className="fill-none stroke-primary stroke-2" />
      {cal.map.map((m) => (
        <circle key={m.pct} cx={x(m.pct)} cy={y(m.rpm)} r="3" className="fill-teal" />
      ))}
    </svg>
  )
}

export function CalibrationPanel({ fanId, pump }: { fanId: string; pump: boolean }) {
  const cal = useStore((s) => s.calibrations[fanId])
  const setCalibration = useStore((s) => s.setCalibration)
  const batchRunning = useBatch((s) => s.running)
  const [progress, setProgress] = useState<CalProgress | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const running = progress !== null

  const start = async () => {
    abort.current = new AbortController()
    setMessage(null)
    setProgress({ phase: 'starting', pct: 100, rpm: 0, done: 0, total: 1, points: [] })
    try {
      const out = await calibrateFan(fanId, setProgress, abort.current.signal)
      if (out.cal) setCalibration(fanId, out.cal)
      setMessage({ ok: !!out.cal, text: out.message })
    } catch (e) {
      setMessage({ ok: false, text: e instanceof CalibrationStopped ? e.message : String(e) })
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="space-y-3">
      {pump ? (
        <p className="text-sm text-muted-foreground">Pumps are never calibrated: stopping one can damage the CPU.</p>
      ) : !cal && !running ? (
        <p className="text-sm text-muted-foreground">
          Measures the top speed, where the fan stalls on the way down, and what it takes to restart. It takes a couple
          of minutes, the fan speeds up and slows down meanwhile, and it stops by itself if things get warm.
        </p>
      ) : null}

      {running && progress && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {progress.phase}: <span className="text-foreground">{progress.pct}%</span> to {progress.rpm} RPM
          </p>
          <Progress value={Math.min(100, (progress.done / progress.total) * 100)} />
        </div>
      )}

      {cal && !running && (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Top speed</dt><dd>{cal.maxRpm} RPM</dd>
            <dt className="text-muted-foreground">Minimum running</dt><dd>{cal.minRunPct}%</dd>
            <dt className="text-muted-foreground">Stalls at</dt><dd>{cal.stopPct > 0 ? `${cal.stopPct}%` : 'never'}</dd>
            <dt className="text-muted-foreground">Restart needs</dt><dd>{cal.startPct > 0 ? `${cal.startPct}%` : 'n/a'}</dd>
          </dl>
          <RpmGraph cal={cal} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button size="sm" variant="outline" onClick={() => abort.current?.abort()}>Cancel</Button>
        ) : (
          <Button size="sm" disabled={pump || batchRunning} onClick={() => void start()}>
            {cal ? 'Calibrate again' : 'Calibrate this fan'}
          </Button>
        )}
        {cal && !running && (
          <Button size="sm" variant="ghost" onClick={() => setCalibration(fanId, null)}>Clear measurements</Button>
        )}
      </div>
      {message && <p className={message.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>{message.text}</p>}
    </div>
  )
}

/** Runs the fan at a fixed speed for 20 seconds so the loudest acceptable speed can be found by ear. */
export function ListenTest({ fanId, maxPct, onUse }: { fanId: string; maxPct: number; onUse(v: number): void }) {
  const [pct, setPct] = useState(maxPct < 100 ? maxPct : 50)
  const [playing, setPlaying] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  const change = (v: number) => {
    setPct(v)
    if (playing) previewFan(fanId, v, 20)
  }
  const toggle = () => {
    if (playing) {
      previewFan(fanId, null)
      window.clearTimeout(timer.current)
      setPlaying(false)
    } else {
      previewFan(fanId, pct, 20)
      setPlaying(true)
      timer.current = window.setTimeout(() => setPlaying(false), 20_000)
    }
  }

  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3">
      <p className="text-sm text-muted-foreground">
        Listen test: run the fan at a fixed speed for 20 seconds, find the loudest speed you can live with, and use it as the quiet cap.
      </p>
      <SliderField label="Test speed" value={pct} min={0} max={100} unit="%" onChange={change} />
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={toggle}>{playing ? 'Stop' : 'Play'}</Button>
        <Button size="sm" variant="outline" onClick={() => onUse(pct)}>Use {pct}% as quiet cap</Button>
      </div>
    </div>
  )
}
