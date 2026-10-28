import { backend, sim } from '../lib/backend'
import { IS_TAURI } from '../lib/hybrid'
import { CurveEditor } from '../components/CurveEditor'
import { CRITICAL_TEMP, CURVE_PRESETS, PUMP_MIN_PCT, defaultCritical, evalCurve } from '../lib/curve'
import type { FanCalibration, FanMode } from '../lib/types'
import { useStore } from '../store'
import { useRef, useState } from 'react'
import { CalibrationStopped, calibrateFan, calibrateMany, useBatch, type CalProgress } from '../calibrate'
import { previewFan } from '../engine'

const MODES: { id: FanMode; label: string }[] = [
  { id: 'curve', label: 'Curve' },
  { id: 'manual', label: 'Manual' },
  { id: 'full', label: 'Full speed' },
]

function Slider(props: { label: string; value: number; min: number; max: number; unit: string; step?: number; onChange(v: number): void; hint?: string }) {
  const id = `s-${props.label.replace(/\W/g, '')}`
  return (
    <div className="row" title={props.hint}>
      <label htmlFor={id}>{props.label}</label>
      <input id={id} type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <output>{props.value}{props.unit}</output>
    </div>
  )
}

function HardwarePanel() {
  const busy = backend.hwState === 'connecting'
  const enable = async () => {
    await backend.enableHw()
    if (backend.hwOn) await useStore.getState().init()
  }
  const disable = async () => {
    await backend.disableHw()
    await useStore.getState().init()
  }

  if (backend.hwOn) {
    return (
      <div className="notice">
        <span>
          Controlling real fans through LibreHardwareMonitor.
          {!backend.hwElevated && ' Not running as administrator, so motherboard fans and many sensors are unavailable.'}
        </span>
        <button className="btn" onClick={() => void disable()}>Hand back to firmware</button>
      </div>
    )
  }
  return (
    <div className="notice">
      <span>
        {IS_TAURI
          ? 'These fans and temperatures are simulated. Real control needs administrator rights for the hardware driver; fans return to firmware control whenever the app closes.'
          : 'Fans and temperatures are simulated. Run the desktop app to control real hardware.'}
        {backend.hwError && <b className="err"> {backend.hwError}</b>}
      </span>
      {IS_TAURI && (
        <button className="btn primary" disabled={busy} onClick={() => void enable()}>
          {busy ? 'Waiting for permission…' : 'Enable hardware control'}
        </button>
      )}
    </div>
  )
}

const WARNINGS = {
  stalled: 'Not turning at the speed it was given. The floor was raised; check the fan.',
  ignored: 'The hardware is not following commands. Another program may control this fan, or its controller ignores software speeds.',
} as const

function RpmGraph({ cal }: { cal: FanCalibration }) {
  const W = 240, H = 90, pad = 6
  const pts = cal.map
  const max = Math.max(cal.maxRpm, 1)
  const x = (pct: number) => pad + (pct / 100) * (W - pad * 2)
  const y = (rpm: number) => H - pad - (rpm / max) * (H - pad * 2)
  const d = pts.map((m, i) => `${i ? 'L' : 'M'}${x(m.pct)},${y(m.rpm)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rpm-graph" role="img" aria-label="Measured speed against duty">
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {pts.map((m) => (
        <circle key={m.pct} cx={x(m.pct)} cy={y(m.rpm)} r="3" fill="var(--accent-2)" />
      ))}
    </svg>
  )
}

function CalibrationPanel({ fanId, pump }: { fanId: string; pump: boolean }) {
  const cal = useStore((s) => s.calibrations[fanId])
  const setCalibration = useStore((s) => s.setCalibration)
  const [progress, setProgress] = useState<CalProgress | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const running = progress !== null
  const batchRunning = useBatch((s) => s.running)

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
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="editor-head">
        <h2>Calibration</h2>
        {running ? (
          <button className="btn" onClick={() => abort.current?.abort()}>Cancel</button>
        ) : (
          <button className="btn primary" disabled={pump || batchRunning} onClick={() => void start()}>
            {cal ? 'Calibrate again' : 'Calibrate this fan'}
          </button>
        )}
      </div>
      {pump && <p className="muted note">Pumps are never calibrated: stopping one can damage the CPU.</p>}
      {!running && !cal && !pump && (
        <p className="muted note">
          Measures the speed at 100%, where the fan stalls on the way down, and what it takes to restart. The floor,
          stop and start points then follow the fan instead of a guess. It takes a couple of minutes, and the fan speeds
          up and slows down during the test. It stops by itself if the system warms up.
        </p>
      )}
      {running && progress && (
        <div>
          <p className="muted note">
            {progress.phase}: <b>{progress.pct}%</b> to {progress.rpm} RPM
          </p>
          <span className="bar"><i style={{ width: `${Math.min(100, (progress.done / progress.total) * 100)}%` }} /></span>
        </div>
      )}
      {cal && !running && (
        <>
          <div className="cal-grid">
            <span className="muted">Top speed</span><b>{cal.maxRpm} RPM</b>
            <span className="muted">Minimum running</span><b>{cal.minRunPct}%</b>
            <span className="muted">Stalls at</span><b>{cal.stopPct > 0 ? `${cal.stopPct}%` : 'never'}</b>
            <span className="muted">Restart needs</span><b>{cal.startPct > 0 ? `${cal.startPct}%` : 'n/a'}</b>
          </div>
          <RpmGraph cal={cal} />
          <button className="chip" onClick={() => setCalibration(fanId, null)}>Clear measurements</button>
        </>
      )}
      {message && <p className={`muted note ${message.ok ? '' : 'err'}`}>{message.text}</p>}
    </div>
  )
}

function ListenTest({ fanId, maxPct, onUse }: { fanId: string; maxPct: number; onUse(v: number): void }) {
  const [pct, setPct] = useState(maxPct < 100 ? maxPct : 50)
  const [playing, setPlaying] = useState(false)
  const play = (v: number) => {
    setPct(v)
    if (playing) previewFan(fanId, v, 20)
  }
  return (
    <div className="listen">
      <p className="muted note">
        Listen test: run the fan at a fixed speed for 20 seconds, find the loudest speed you can live with, then use it
        as the quiet cap.
      </p>
      <div className="row">
        <label htmlFor="listen">Test speed</label>
        <input id="listen" type="range" min={0} max={100} value={pct} onChange={(e) => play(Number(e.target.value))} />
        <output>{pct}%</output>
      </div>
      <div className="lcd-actions" style={{ marginTop: 8 }}>
        <button
          className="btn"
          onClick={() => {
            if (playing) {
              previewFan(fanId, null)
              setPlaying(false)
            } else {
              previewFan(fanId, pct, 20)
              setPlaying(true)
              setTimeout(() => setPlaying(false), 20000)
            }
          }}
        >
          {playing ? 'Stop test' : 'Play'}
        </button>
        <button className="btn" onClick={() => onUse(pct)}>Use {pct}% as quiet cap</button>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Waiting',
  cooling: 'Cooling down',
  running: 'Measuring',
  done: 'Done',
  failed: 'Not measured',
  skipped: 'Skipped',
}

function BatchPanel({ onClose }: { onClose(): void }) {
  const { running, items, current } = useBatch()
  const finished = items.filter((i) => i.status === 'done' || i.status === 'failed' || i.status === 'skipped').length
  return (
    <div className="panel batch">
      <div className="editor-head">
        <h2>Calibrating {items.length} fans</h2>
        {running ? (
          <button className="btn" onClick={() => batchAbort?.abort()}>Cancel</button>
        ) : (
          <button className="btn" onClick={onClose}>Close</button>
        )}
      </div>
      <span className="bar"><i style={{ width: `${items.length ? (finished / items.length) * 100 : 0}%` }} /></span>
      <ul className="batch-list">
        {items.map((i) => (
          <li key={i.id} className={`b-${i.status}`}>
            <span className="b-name">{i.name}</span>
            <span className="b-status">{STATUS_LABEL[i.status]}</span>
            <span className="muted b-text">
              {i.status === 'running' && current ? `${current.phase}: ${current.pct}% to ${current.rpm} RPM` : i.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

let batchAbort: AbortController | null = null

export function FansPage() {
  const { fans, live, sensors, selectedFan, selectFan, patchFan, setCurve } = useStore()
  const [stress, setStress] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showBatch, setShowBatch] = useState(false)
  const batchRunning = useBatch((s) => s.running)
  const batchItems = useBatch((s) => s.items)
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const fan = fans.find((f) => f.id === selectedFan)
  if (!fan) return null
  const temp = sensors.find((s) => s.id === fan.sensorId)?.value
  const emergency =
    fan.criticalTemp ??
    Math.min(CRITICAL_TEMP, ...[fan.sensorId, ...fan.extraSensorIds].map((id) => defaultCritical(sensors.find((x) => x.id === id)?.name ?? '')))
  const l = live[fan.id]

  return (
    <div className="main wide">
      <header className="page-head">
        <div>
          <h1>Fans</h1>
          <p className="muted">Speed follows a temperature curve. Drag points, click to add, double-click to remove.</p>
        </div>
        {!backend.hwOn && (
          <button
            className={`btn ${stress ? 'hot' : ''}`}
            onClick={() => {
              sim.stress = !stress
              setStress(!stress)
            }}
          >
            {stress ? 'Stop stress test' : 'Simulate heavy load'}
          </button>
        )}
      </header>

      <HardwarePanel />


      <div className="sensors">
        {sensors.map((s) => (
          <div key={s.id} className={`sensor ${s.value >= CRITICAL_TEMP ? 'crit' : ''}`}>
            <span className="muted">{s.name}</span>
            <strong>{s.value.toFixed(1)}°C</strong>
          </div>
        ))}
      </div>

      <div className="fan-tools">
        <button className="chip" disabled={batchRunning} onClick={() => setSelected(new Set(fans.filter((f) => !f.pump).map((f) => f.id)))}>
          Select all fans
        </button>
        <button className="chip" disabled={batchRunning || selected.size === 0} onClick={() => setSelected(new Set())}>Clear selection</button>
        <button
          className="btn primary"
          disabled={batchRunning || selected.size === 0}
          title="Measures the selected fans one after another"
          onClick={() => {
            batchAbort = new AbortController()
            setShowBatch(true)
            void calibrateMany([...selected], batchAbort.signal)
          }}
        >
          Calibrate selected ({selected.size})
        </button>
      </div>

      {showBatch && batchItems.length > 0 && <BatchPanel onClose={() => setShowBatch(false)} />}

      <div className="fan-cards">
        {fans.map((f) => {
          const lv = live[f.id]
          return (
            <div key={f.id} className="fan-wrap">
              <label className="fan-select" title="Select for calibration">
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  disabled={batchRunning}
                  aria-label={`Select ${f.name}`}
                  onChange={() => toggle(f.id)}
                />
              </label>
            <button className={`fan-card ${f.id === fan.id ? 'on' : ''}`} onClick={() => selectFan(f.id)}>
              <span className="fan-name">{f.name}</span>
              <span className="rpm">{lv ? lv.rpm : '–'}<small> RPM</small></span>
              <span className="bar"><i style={{ width: `${lv?.pct ?? 0}%` }} /></span>
              <span className="muted">{lv?.pct ?? 0}% · {lv?.note ?? f.mode}</span>
              {lv?.warning && <span className="warn-badge" title={WARNINGS[lv.warning]}>{lv.warning === 'stalled' ? 'Stalled' : 'Not responding'}</span>}
            </button>
            </div>
          )
        })}
      </div>

      <div className="editor">
        <div className="panel">
          <div className="editor-head">
            <h2>{fan.name}</h2>
            <div className="seg" role="group" aria-label="Control mode">
              {MODES.map((m) => (
                <button key={m.id} className={fan.mode === m.id ? 'on' : ''} onClick={() => patchFan(fan.id, { mode: m.id })}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {fan.mode === 'curve' && (
            <>
              <CurveEditor
                points={fan.curve}
                onChange={(c) => setCurve(fan.id, c)}
                temp={temp}
                pct={l?.pct}
              />
              <div className="presets">
                <span className="muted">Presets</span>
                {Object.entries(CURVE_PRESETS).map(([name, pts]) => (
                  <button key={name} className="chip" onClick={() => setCurve(fan.id, pts.map((p) => ({ ...p })))}>{name}</button>
                ))}
              </div>
            </>
          )}
          {fan.mode === 'manual' && (
            <div className="big-dial">
              <strong>{fan.manual}%</strong>
              <input type="range" min={0} max={100} value={fan.manual} aria-label="Fixed fan speed" onChange={(e) => patchFan(fan.id, { manual: Number(e.target.value) })} />
            </div>
          )}
          {fan.mode === 'full' && <p className="muted pad">Running at 100% until you switch modes.</p>}
        </div>

        <div className="panel side">
          <h2>Settings</h2>
          {l?.warning && <p className="warn-note">{WARNINGS[l.warning]}</p>}
          <div className="row">
            <label htmlFor="src">Temperature source</label>
            <select id="src" value={fan.sensorId} onChange={(e) => patchFan(fan.id, { sensorId: e.target.value, extraSensorIds: fan.extraSensorIds.filter((x) => x !== e.target.value) })}>
              {sensors.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <details className="more-sources">
            <summary>Also follow ({fan.extraSensorIds.length})</summary>
            <div className="seg" role="group" aria-label="How sources combine" style={{ margin: '6px 0' }}>
              <button className={fan.mix === 'max' ? 'on' : ''} onClick={() => patchFan(fan.id, { mix: 'max' })}>Hottest</button>
              <button className={fan.mix === 'avg' ? 'on' : ''} onClick={() => patchFan(fan.id, { mix: 'avg' })}>Average</button>
            </div>
            {sensors.filter((s) => s.id !== fan.sensorId).map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={fan.extraSensorIds.includes(s.id)}
                  onChange={(e) =>
                    patchFan(fan.id, {
                      extraSensorIds: e.target.checked ? [...fan.extraSensorIds, s.id] : fan.extraSensorIds.filter((x) => x !== s.id),
                    })
                  }
                />
                {s.name}
              </label>
            ))}
          </details>
          <label className="check">
            <input type="checkbox" checked={fan.pump} onChange={(e) => patchFan(fan.id, { pump: e.target.checked, minPct: e.target.checked ? Math.max(fan.minPct, PUMP_MIN_PCT) : fan.minPct })} />
            This is a pump (never below {PUMP_MIN_PCT}%)
          </label>
          <Slider label="Minimum speed" value={fan.minPct} min={0} max={60} unit="%" hint="0% lets the fan stop completely at low temperatures" onChange={(v) => patchFan(fan.id, { minPct: fan.pump ? Math.max(v, PUMP_MIN_PCT) : v })} />
          <Slider label="Quiet cap" value={fan.maxPct} min={20} max={100} unit="%" hint="Highest speed while it is not getting hot" onChange={(v) => patchFan(fan.id, { maxPct: v })} />
          <Slider label="Smoothing" value={fan.smoothSec} min={0} max={30} unit=" s" hint="Averages the temperature over this long, so spikes do not change the speed" onChange={(v) => patchFan(fan.id, { smoothSec: v })} />
          <Slider label="Hysteresis" value={fan.hysteresis} min={0} max={10} unit="°C" hint="Temperature must fall this far before the fan slows" onChange={(v) => patchFan(fan.id, { hysteresis: v })} />
          <Slider label="Speed-up rate" value={fan.stepUp} min={1} max={100} unit="%/s" hint="Highest rate the speed may rise" onChange={(v) => patchFan(fan.id, { stepUp: v })} />
          <Slider label="Slow-down rate" value={fan.stepDown} min={1} max={30} unit="%/s" hint="Highest rate the speed may fall" onChange={(v) => patchFan(fan.id, { stepDown: v })} />
          <Slider label="Hold after speeding up" value={fan.holdSec} min={0} max={60} unit=" s" hint="Keeps the speed this long before it may slow down, to avoid pumping" onChange={(v) => patchFan(fan.id, { holdSec: v })} />
          <Slider label="Emergency temperature" value={emergency} min={40} max={110} unit="°C" hint="At or above this the fan runs at 100%, whatever else is set" onChange={(v) => patchFan(fan.id, { criticalTemp: v })} />
          <p className="muted note">
            Safety: at {emergency}°C, or if a source cannot be read, this fan goes to 100%.
            {temp !== undefined && fan.mode === 'curve' && <> Curve says <b>{Math.round(evalCurve(fan.curve, temp))}%</b> at {temp.toFixed(0)}°C.</>}
          </p>
          <ListenTest fanId={fan.id} maxPct={fan.maxPct} onUse={(v) => patchFan(fan.id, { maxPct: Math.max(20, v) })} />
        </div>
      </div>
      <CalibrationPanel fanId={fan.id} pump={fan.pump} />
    </div>
  )
}
