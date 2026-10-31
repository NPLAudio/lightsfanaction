/**
 * What the PC is playing, as the sound-reactive effects see it. The numbers come from the app's audio
 * listener (see src-tauri/src/audio.rs); nothing here touches Tauri, so effects can import it freely.
 */

export const BANDS = 32

export interface Beat {
  /** performance.now() / 1000 when it was heard */
  t: number
  /** 0 to 1 */
  s: number
}

export const audio = {
  /** 0 to 1 per frequency band, lowest first */
  bands: new Array<number>(BANDS).fill(0),
  bass: 0,
  mid: 0,
  treble: 0,
  level: 0,
  /** the loudest recent level, falling slowly, for peak markers */
  peak: 0,
  /** grows with the music's energy, so flowing effects move faster when it is loud */
  drift: 0,
  beats: [] as Beat[],
  /** when levels last arrived; they read as silence once this goes stale */
  at: 0,
}

export interface Levels {
  bands: number[]
  bass: number
  mid: number
  treble: number
  level: number
  beats: number
  beat_strength: number
}

const STALE_SECONDS = 0.5
const KEEP_BEATS_SECONDS = 2.5
let lastBeatCount: number | undefined

function noteBeat(t: number, s: number) {
  audio.beats.push({ t, s })
  if (audio.beats.length > 12) audio.beats.shift()
}

/** Takes levels from the listener. */
export function setLevels(l: Levels, t: number) {
  for (let i = 0; i < BANDS; i++) audio.bands[i] = l.bands[i] ?? 0
  audio.bass = l.bass
  audio.mid = l.mid
  audio.treble = l.treble
  audio.level = l.level
  audio.at = t
  // the first report only sets the baseline; beats from before this moment are not replayed
  if (lastBeatCount !== undefined && l.beats !== lastBeatCount) noteBeat(t, l.beat_strength)
  lastBeatCount = l.beats
}

/** Called once per rendered frame: ages things, and drops to silence if the listener went quiet. */
export function tickAudio(t: number, dt: number) {
  if (t - audio.at > STALE_SECONDS) {
    audio.bands.fill(0)
    audio.bass = audio.mid = audio.treble = audio.level = 0
  }
  while (audio.beats.length && t - audio.beats[0].t > KEEP_BEATS_SECONDS) audio.beats.shift()
  audio.peak = Math.max(audio.level, audio.peak - dt * 0.4)
  audio.drift += dt * (0.02 + audio.level * 0.4)
}

/** A flash that jumps to the beat's strength and fades: 1 right at a beat, near 0 after `1 / rate` seconds. */
export function beatEnv(t: number, rate = 6): number {
  let e = 0
  for (const b of audio.beats) e = Math.max(e, b.s * Math.exp(-Math.max(0, t - b.t) * rate))
  return e
}

/** A band level at a position 0 to 1 across the spectrum, interpolated between bands. */
export function bandAt(u: number): number {
  const x = Math.min(1, Math.max(0, u)) * (BANDS - 1)
  const i = Math.floor(x)
  const a = audio.bands[i]
  const b = audio.bands[Math.min(BANDS - 1, i + 1)]
  return a + (b - a) * (x - i)
}

/** Fake music for the browser preview and the simulator: a 120 BPM kick with a moving melody. */
export function simulateAudio(t: number) {
  const beatPhase = (t * 2) % 1
  const kick = Math.exp(-beatPhase * 7)
  for (let i = 0; i < BANDS; i++) {
    const u = i / (BANDS - 1)
    const body = Math.exp(-u * 3.2) * (0.35 + 0.65 * kick)
    const melody = Math.max(0, Math.sin(t * 1.3 + u * 9)) * 0.45 * (1 - u * 0.4)
    const hats = u > 0.65 ? ((Math.sin(t * 22 + i) + 1) / 2) * 0.35 * (beatPhase > 0.45 && beatPhase < 0.55 ? 1.6 : 0.5) : 0
    audio.bands[i] = Math.min(1, body + melody + hats)
  }
  audio.bass = (audio.bands.slice(0, 5).reduce((a, b) => a + b, 0) / 5)
  audio.mid = audio.bands.slice(8, 20).reduce((a, b) => a + b, 0) / 12
  audio.treble = audio.bands.slice(22).reduce((a, b) => a + b, 0) / 10
  audio.level = audio.bands.reduce((a, b) => a + b, 0) / BANDS
  audio.at = t
  const beat = Math.floor(t * 2)
  if (beat !== lastBeatCount) {
    if (lastBeatCount !== undefined) noteBeat(t, 0.9)
    lastBeatCount = beat
  }
}
