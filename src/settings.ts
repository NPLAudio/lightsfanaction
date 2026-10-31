import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FanKind } from './lib/types'

export interface Settings {
  /** Drive real fans through the hardware service. On by default; needs administrator rights. */
  controlFans: boolean
  /** Pumps are left to their firmware unless this is on. */
  includePumps: boolean
  /** Graphics card fans are left to their firmware unless this is on. */
  includeGpuFans: boolean
  /** Closing the window keeps the app running from the tray. */
  closeToTray: boolean
  /** Revealed by tapping the version in About; hides developer-only options. */
  devUnlocked: boolean
  /** Developer option: fake devices, fans and temperatures. Off unless asked for. */
  useSimulator: boolean
  /** Output device the sound-reactive effects listen to. Empty means the Windows default. */
  audioDevice: string
  /** Folder LibreHardwareMonitor is installed in. Empty means look in the usual places. */
  lhmDir: string
}

interface SettingsStore extends Settings {
  set(patch: Partial<Settings>): void
  reset(): void
}

export const DEFAULT_SETTINGS: Settings = {
  controlFans: true,
  includePumps: false,
  includeGpuFans: false,
  closeToTray: true,
  devUnlocked: false,
  useSimulator: false,
  audioDevice: '',
  lhmDir: '',
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    { name: 'lfa-settings' },
  ),
)

/** Whether fans of this kind are shown and controlled under the given settings. */
export function kindEnabled(kind: FanKind, s: Pick<Settings, 'includePumps' | 'includeGpuFans'>): boolean {
  if (kind === 'pump') return s.includePumps
  if (kind === 'gpu') return s.includeGpuFans
  return true
}

/** The simulator runs in the browser (no hardware there at all) or when a developer turns it on. */
export function simulatorActive(isTauri: boolean): boolean {
  return !isTauri || useSettings.getState().useSimulator
}
