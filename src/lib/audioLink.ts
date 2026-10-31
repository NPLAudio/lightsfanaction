import { useSettings } from '@/settings'
import { IS_TAURI, invoke } from './hybrid'
import { setLevels, useAudioStatus, type AudioStatus, type Levels } from './audio'

/** Connects the app's audio listener to `audio`, and keeps it running only while an effect needs it. */

let listening = false
let active: boolean | undefined

function sendDevice() {
  void invoke('audio_set_device', { device: useSettings.getState().audioDevice }).catch(() => undefined)
}

export function setAudioActive(on: boolean) {
  if (!IS_TAURI || on === active) return
  active = on
  void invoke('audio_set_active', { on }).catch(() => (active = undefined))
  if (on && !listening) {
    listening = true
    sendDevice()
    useSettings.subscribe((s, prev) => {
      if (s.audioDevice !== prev.audioDevice) sendDevice()
    })
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<Levels>('audio-levels', (e) => setLevels(e.payload, performance.now() / 1000))
      void listen<AudioStatus>('audio-status', (e) => useAudioStatus.setState({ status: e.payload }))
    })
  }
}
