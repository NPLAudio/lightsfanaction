import { IS_TAURI, invoke } from './hybrid'
import { setLevels, type Levels } from './audio'

/** Connects the app's audio listener to `audio`, and keeps it running only while an effect needs it. */

let listening = false
let active: boolean | undefined

export function setAudioActive(on: boolean) {
  if (!IS_TAURI || on === active) return
  active = on
  void invoke('audio_set_active', { on }).catch(() => (active = undefined))
  if (on && !listening) {
    listening = true
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<Levels>('audio-levels', (e) => setLevels(e.payload, performance.now() / 1000)),
    )
  }
}
