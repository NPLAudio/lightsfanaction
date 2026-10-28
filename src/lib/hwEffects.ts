import { hex } from './effects'
import type { ParamValue, RGB } from './types'

/** A device's own built-in effect that stands in for one of ours. */
export interface HwEffect {
  /** mode names to try in order; the first one the device has is used */
  modes: string[]
  colors?: RGB[]
  /** 0 to 1 of the mode's own speed range */
  speed?: number
}

const SPECTRUM: RGB[] = [
  [255, 0, 0],
  [255, 160, 0],
  [255, 255, 0],
  [0, 255, 0],
  [0, 200, 255],
  [0, 0, 255],
  [200, 0, 255],
]

/**
 * Seconds per cycle of the Kraken's built-in Breathing at its five speed settings, counted by eye on a
 * 2024 Elite (1, 2, 3, 5 and 7 cycles in 12 s).
 */
const BREATHING_PERIODS = [12, 6, 4, 2.4, 12 / 7]

/** The setting (as 0 to 1 of the five-step range) whose period is closest, in ratio, to a wanted one. */
function nearestBreathingSpeed(periodSeconds: number): number {
  let best = 0
  let bestGap = Infinity
  BREATHING_PERIODS.forEach((p, i) => {
    const gap = Math.abs(Math.log(p / periodSeconds))
    if (gap < bestGap) {
      bestGap = gap
      best = i
    }
  })
  return best / (BREATHING_PERIODS.length - 1)
}

/**
 * Some devices (the Kraken cooler) take lighting updates far too slowly for streamed animation: a ring
 * follows about one a second. They animate smoothly on their own, so for them an effect is translated to the
 * nearest built-in mode and sent once.
 */
export function hwEffectFor(effectId: string, p: Record<string, ParamValue>): HwEffect {
  const speed = Math.min(1, Math.max(0, Number(p.speed ?? 40) / 100))
  switch (effectId) {
    case 'solid':
      return { modes: ['Static'], colors: [hex(p.color)] }
    case 'rainbow':
      return { modes: ['Rainbow Wave', 'Super Rainbow'], speed }
    case 'spin':
      return { modes: ['Super Rainbow', 'Rainbow Flow', 'Rainbow Wave'], speed }
    case 'cycle':
      return { modes: ['Rainbow Pulse', 'Fading'], colors: SPECTRUM, speed }
    case 'breathing': {
      // our Breathing turns at 0.5 + 0.04 * speed radians a second; pick the built-in speed that comes closest
      const period = (2 * Math.PI) / (0.5 + 0.04 * Number(p.speed ?? 40))
      return { modes: ['Breathing', 'Pulsing'], colors: [hex(p.color)], speed: nearestBreathingSpeed(period) }
    }
    case 'gradient':
      return { modes: ['Fading', 'Alternating'], colors: [hex(p.a), hex(p.b)], speed }
    case 'comet':
      return { modes: ['Marquee', 'Cover Marquee'], colors: [hex(p.color)], speed }
    case 'fire':
      return { modes: ['Candle'], colors: [[255, 90, 0]], speed }
    case 'aurora':
      return { modes: ['Rainbow Flow', 'Super Rainbow'], speed }
    case 'sparkle':
      return { modes: ['Starry Night'], colors: [hex(p.color)], speed: Math.min(1, Number(p.rate ?? 6) / 20) }
    default:
      return { modes: ['Rainbow Wave'], speed }
  }
}
