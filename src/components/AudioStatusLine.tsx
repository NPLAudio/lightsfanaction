import { useAudioStatus } from '@/lib/audio'
import { IS_TAURI } from '@/lib/hybrid'
import { simulatorActive } from '@/settings'

/** Under a sound-reactive effect: what the app is listening to, and whether anything is coming through. */
export function AudioStatusLine() {
  const s = useAudioStatus((x) => x.status)
  if (simulatorActive(IS_TAURI)) {
    return <p className="text-sm text-muted-foreground">Previewing with simulated music.</p>
  }
  if (s.state === 'error') {
    return (
      <p className="text-sm text-destructive">
        Cannot listen{s.message ? `: ${s.message}` : ''}. Pick a sound device in Settings, General.
      </p>
    )
  }
  if (s.state === 'off') return <p className="text-sm text-muted-foreground">Starting to listen…</p>
  return (
    <p className="text-sm text-muted-foreground">
      {s.playing
        ? `Listening to ${s.device}.`
        : `Listening to ${s.device}, but nothing is playing on it. If you hear sound, choose that device in Settings, General.`}
    </p>
  )
}
