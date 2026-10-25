import { DeviceCanvas, EffectPreview } from '../components/LedCanvas'
import { EFFECTS, effectById } from '../lib/effects'
import type { Device } from '../lib/types'
import { useStore } from '../store'

const ICON: Record<Device['kind'], string> = {
  keyboard: '⌨', fan: '✺', gpu: '▭', ram: '▤', strip: '━', mouse: '◖',
}

function previewSize(d: Device, big: boolean) {
  if (!big) return d.layout === 'ring' ? { w: 56, h: 56 } : d.layout === 'grid' ? { w: 120, h: 44 } : { w: 120, h: 28 }
  return d.layout === 'ring' ? { w: 260, h: 260 } : d.layout === 'grid' ? { w: 720, h: 200 } : { w: 720, h: 90 }
}

export function LightingPage() {
  const { devices, assignments, selectedDevice, syncAll } = useStore()
  const { selectDevice, setSyncAll, setEffect, setParam, setBrightness } = useStore()
  const dev = devices.find((d) => d.id === selectedDevice)
  const a = dev && assignments[dev.id]
  if (!dev || !a) return null
  const fx = effectById(a.effectId)
  const big = previewSize(dev, true)

  return (
    <div className="split">
      <aside className="rail">
        <div className="rail-head">
          <h2>Devices</h2>
          <label className="switch" title="Apply every change to all devices">
            <input type="checkbox" checked={syncAll} onChange={(e) => setSyncAll(e.target.checked)} />
            <span>Sync all</span>
          </label>
        </div>
        {devices.map((d) => {
          const s = previewSize(d, false)
          return (
            <button key={d.id} className={`dev ${d.id === dev.id ? 'on' : ''}`} onClick={() => selectDevice(d.id)}>
              <span className="dev-name"><i>{ICON[d.kind]}</i>{d.name}</span>
              <span className="dev-fx">{effectById(assignments[d.id]?.effectId).name}</span>
              <DeviceCanvas device={d} width={s.w} height={s.h} />
            </button>
          )
        })}
      </aside>

      <section className="main">
        <header className="page-head">
          <div>
            <h1>{dev.name}</h1>
            <p className="muted">{dev.ledCount} LEDs · {dev.layout}{syncAll ? ' · changes apply to all devices' : ''}</p>
          </div>
        </header>

        <div className="stage">
          <DeviceCanvas device={dev} width={big.w} height={big.h} />
        </div>

        <div className="panel">
          <div className="row">
            <label htmlFor="bright">Brightness</label>
            <input
              id="bright"
              type="range"
              min={0}
              max={100}
              value={a.brightness}
              onChange={(e) => setBrightness(dev.id, Number(e.target.value))}
            />
            <output>{a.brightness}%</output>
          </div>
          {fx.params.map((p) => (
            <div className="row" key={p.key}>
              <label htmlFor={`p-${p.key}`}>{p.label}</label>
              {p.type === 'color' ? (
                <input
                  id={`p-${p.key}`}
                  type="color"
                  value={String(a.params[p.key])}
                  onChange={(e) => setParam(dev.id, p.key, e.target.value)}
                />
              ) : (
                <>
                  <input
                    id={`p-${p.key}`}
                    type="range"
                    min={p.min}
                    max={p.max}
                    step={p.step}
                    value={Number(a.params[p.key])}
                    onChange={(e) => setParam(dev.id, p.key, Number(e.target.value))}
                  />
                  <output>{a.params[p.key]}</output>
                </>
              )}
            </div>
          ))}
        </div>

        <h2 className="section">Effects</h2>
        <div className="gallery">
          {EFFECTS.map((e) => (
            <button
              key={e.id}
              className={`fx ${e.id === a.effectId ? 'on' : ''}`}
              onClick={() => setEffect(dev.id, e.id)}
              aria-pressed={e.id === a.effectId}
            >
              <EffectPreview
                effectId={e.id}
                params={e.id === a.effectId ? a.params : Object.fromEntries(e.params.map((p) => [p.key, p.default]))}
              />
              <strong>{e.name}</strong>
              <span className="muted">{e.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
