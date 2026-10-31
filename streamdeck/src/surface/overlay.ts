import type { JsonObject } from '@elgato/utils'
import type { KeyAction } from '@elgato/streamdeck'
import type { Tile } from '../render.js'

/**
 * Keys with another action (a temperature, a fan) that have chosen to draw over the lighting display: they join
 * their deck's lighting picture, and their own readout is drawn on top of their part of it. The display module
 * draws them each frame; if the lighting goes away they draw themselves normally again.
 */
export interface OverlayKey {
  id: string
  action: KeyAction<JsonObject>
  deviceId: string
  deviceName: string
  column: number
  row: number
  columns: number
  rows: number
  /** what the key currently shows */
  tile: () => Tile
  /** draw the key by itself, without lighting behind it */
  plain: () => void
}

export const overlayKeys = new Map<string, OverlayKey>()

let listener: (() => void) | undefined

/** Told whenever the set of overlay keys changes. */
export function onOverlayChange(fn: () => void) {
  listener = fn
}

export function setOverlay(key: OverlayKey) {
  overlayKeys.set(key.id, key)
  listener?.()
}

export function removeOverlay(id: string) {
  if (overlayKeys.delete(id)) listener?.()
}
