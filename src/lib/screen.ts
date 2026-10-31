import { effectById } from './effects'
import type { Assignment, Device } from './types'

export const SCREEN_ID = 'kraken-lcd'

/**
 * What the cooler screen should wear: an effect with its settings, or null for stats only. "Match" takes the
 * effect the Kraken's own lights are using (and falls back to stats if it has none), at the screen's brightness.
 */
export function screenTheme(devices: Device[], assignments: Record<string, Assignment>): Assignment | null {
  const screen = devices.find((d) => d.kind === 'screen')
  const a = screen && assignments[screen.id]
  if (!a || a.effectId === 'stats') return null
  if (a.effectId === 'match') {
    const lights = devices.find((d) => d.kind !== 'screen' && /kraken/i.test(d.name))
    const own = lights && assignments[lights.id]
    return own && !effectById(own.effectId).screenOnly ? { ...own, brightness: a.brightness } : null
  }
  return a
}
