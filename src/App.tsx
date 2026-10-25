import { useEffect, useReducer, useState } from 'react'
import { startEngine } from './engine'
import { backend } from './lib/backend'
import { IS_TAURI } from './lib/hybrid'
import { FansPage } from './pages/FansPage'
import { LcdPage } from './pages/LcdPage'
import { LightingPage } from './pages/LightingPage'
import { useStore } from './store'

type Page = 'lighting' | 'fans' | 'lcd'

export default function App() {
  const [page, setPage] = useState<Page>('lighting')
  const ready = useStore((s) => s.ready)

  const [, rerender] = useReducer((n: number) => n + 1, 0)
  useEffect(() => backend.subscribe(rerender), [])

  useEffect(() => {
    void (async () => {
      await useStore.getState().init()
      startEngine()
      // fan control was on last time: bring it back (this shows the UAC prompt again)
      if (IS_TAURI && backend.hwWanted) {
        await backend.enableHw()
        if (backend.hwOn) await useStore.getState().init()
      }
    })()
  }, [])

  return (
    <div className="app">
      <nav className="nav">
        <div className="brand">
          <span className="logo" aria-hidden />
          <b>Lights Fan Action</b>
        </div>
        <button className={page === 'lighting' ? 'on' : ''} onClick={() => setPage('lighting')}>Lighting</button>
        <button className={page === 'fans' ? 'on' : ''} onClick={() => setPage('fans')}>Fans &amp; Cooling</button>
        <button className={page === 'lcd' ? 'on' : ''} onClick={() => setPage('lcd')}>Kraken screen</button>
        <div className="grow" />
        <button
          className={`backend ${backend.rgbConnected ? '' : 'sim'}`}
          title={backend.rgbError ?? (IS_TAURI ? 'Click to rescan OpenRGB' : 'Run the desktop app to reach real hardware')}
          disabled={!IS_TAURI}
          onClick={() => void useStore.getState().init()}
        >
          <i />{backend.name}
        </button>
      </nav>
      <div className="content">
        {!ready ? <p className="muted pad">Looking for devices…</p> : page === 'lighting' ? <LightingPage /> : page === 'fans' ? <FansPage /> : <LcdPage />}
      </div>
    </div>
  )
}
