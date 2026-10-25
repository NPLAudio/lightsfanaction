import { backend, sim } from '../lib/backend'
import { IS_TAURI } from '../lib/hybrid'
import { CurveEditor } from '../components/CurveEditor'
import { CRITICAL_TEMP, CURVE_PRESETS, evalCurve } from '../lib/curve'
import type { FanMode } from '../lib/types'
import { useStore } from '../store'
import { useState } from 'react'

const MODES: { id: FanMode; label: string }[] = [
  { id: 'curve', label: 'Curve' },
  { id: 'manual', label: 'Manual' },
  { id: 'full', label: 'Full speed' },
]

function Slider(props: { label: string; value: number; min: number; max: number; unit: string; onChange(v: number): void; hint?: string }) {
  const id = `s-${props.label.replace(/\W/g, '')}`
  return (
    <div className="row" title={props.hint}>
      <label htmlFor={id}>{props.label}</label>
      <input id={id} type="range" min={props.min} max={props.max} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
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

export function FansPage() {
  const { fans, live, sensors, selectedFan, selectFan, patchFan, setCurve } = useStore()
  const [stress, setStress] = useState(false)
  const fan = fans.find((f) => f.id === selectedFan)
  if (!fan) return null
  const temp = sensors.find((s) => s.id === fan.sensorId)?.value
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

      <div className="fan-cards">
        {fans.map((f) => {
          const lv = live[f.id]
          return (
            <button key={f.id} className={`fan-card ${f.id === fan.id ? 'on' : ''}`} onClick={() => selectFan(f.id)}>
              <span className="fan-name">{f.name}</span>
              <span className="rpm">{lv ? lv.rpm : '–'}<small> RPM</small></span>
              <span className="bar"><i style={{ width: `${lv?.pct ?? 0}%` }} /></span>
              <span className="muted">{lv?.pct ?? 0}% · {f.mode}</span>
            </button>
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
          <div className="row">
            <label htmlFor="src">Temperature source</label>
            <select id="src" value={fan.sensorId} onChange={(e) => patchFan(fan.id, { sensorId: e.target.value })}>
              {sensors.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <Slider label="Minimum speed" value={fan.minPct} min={0} max={60} unit="%" hint="0% lets the fan stop completely at low temperatures" onChange={(v) => patchFan(fan.id, { minPct: v })} />
          <Slider label="Hysteresis" value={fan.hysteresis} min={0} max={10} unit="°C" hint="Temperature must fall this far before the fan slows" onChange={(v) => patchFan(fan.id, { hysteresis: v })} />
          <Slider label="Ramp-down rate" value={fan.ramp} min={1} max={50} unit="%/s" hint="Limits how quickly the fan slows down" onChange={(v) => patchFan(fan.id, { ramp: v })} />
          <p className="muted note">
            Safety: at {CRITICAL_TEMP}°C or if the sensor is lost, this fan goes to 100%.
            {temp !== undefined && fan.mode === 'curve' && <> Curve says <b>{Math.round(evalCurve(fan.curve, temp))}%</b> at {temp.toFixed(0)}°C.</>}
          </p>
        </div>
      </div>
    </div>
  )
}
