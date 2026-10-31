import type { JsonObject } from '@elgato/utils'
import { SingletonAction, streamDeck, type DidReceiveSettingsEvent, type SendToPluginEvent, type WillAppearEvent, type WillDisappearEvent } from '@elgato/streamdeck'
import type { Snapshot } from './api.js'
import { current, subscribe } from './poller.js'
import { OFFLINE, tileSvg, type Tile } from './render.js'

export interface Dial {
  title: string
  value: string
  /** 0 to 100, draws the bar under the value */
  indicator?: number
}

export interface View {
  tile: Tile
  dial?: Dial
}

interface Shown {
  action: WillAppearEvent['action']
  settings: JsonObject
  /** last image sent, so an unchanged key is not redrawn every second */
  last?: string
}

const shown = new Map<string, Shown & { render: () => void }>()
let unsubscribe: (() => void) | undefined

function renderAll() {
  for (const s of shown.values()) s.render()
}

function track() {
  unsubscribe ??= subscribe(renderAll)
}

function untrack() {
  if (shown.size === 0) {
    unsubscribe?.()
    unsubscribe = undefined
  }
}

/**
 * Every action here shows something from the app's snapshot: it subscribes while visible, draws a key
 * (or a dial) for the current settings, and redraws only when the picture changes.
 */
export abstract class LiveAction<S extends JsonObject = JsonObject> extends SingletonAction<S> {
  /** What to show for these settings. `state` is undefined while the app is not reachable. */
  abstract view(state: Snapshot | undefined, settings: S): View

  /** Lists for the property inspector's drop-downs, keyed by the datasource name. */
  items(_source: string, _state: Snapshot | undefined): { label: string; value: string }[] {
    return []
  }

  protected draw(id: string) {
    const s = shown.get(id)
    if (!s) return
    const v = this.safeView(current(), s.settings as S)
    const key = JSON.stringify(v)
    if (key === s.last) return
    s.last = key
    if (s.action.isKey()) void s.action.setImage(tileSvg(v.tile))
    else if (s.action.isDial() && v.dial) {
      void s.action.setFeedback({ title: v.dial.title, value: v.dial.value, ...(v.dial.indicator === undefined ? {} : { indicator: v.dial.indicator }) })
    }
  }

  private safeView(state: Snapshot | undefined, settings: S): View {
    try {
      return this.view(state, settings)
    } catch {
      return { tile: OFFLINE, dial: { title: 'Lights Fan Action', value: 'Offline' } }
    }
  }

  override onWillAppear(ev: WillAppearEvent<S>) {
    const id = ev.action.id
    shown.set(id, { action: ev.action, settings: ev.payload.settings, render: () => this.draw(id) })
    track()
    this.draw(id)
  }

  override onWillDisappear(ev: WillDisappearEvent<S>) {
    shown.delete(ev.action.id)
    untrack()
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>) {
    const s = shown.get(ev.action.id)
    if (!s) return
    s.settings = ev.payload.settings
    s.last = undefined
    this.draw(ev.action.id)
  }

  /** Answers the property inspector's drop-down requests. */
  override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, S>) {
    const event = ev.payload.event
    if (typeof event !== 'string') return
    await streamDeck.ui.sendToPropertyInspector({ event, items: this.items(event, current()) })
  }

  /** Settings of a visible action, for handlers that need them. */
  protected settingsOf(id: string): S {
    return (shown.get(id)?.settings ?? {}) as S
  }
}
