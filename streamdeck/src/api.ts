import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** What Lights Fan Action publishes (see src/control.ts in the app). */
export interface Snapshot {
  v: 1
  at: number
  sensors: { id: string; name: string; value: number }[]
  fans: { id: string; name: string; kind: string; rpm: number; pct: number; mode: string; controlled: boolean; warning?: string; note?: string }[]
  devices: { id: string; name: string; kind: string; effectId: string; brightness: number }[]
  effects: { id: string; name: string }[]
}

export type Command =
  | { cmd: 'effect'; device: string; effect: string }
  | { cmd: 'brightness'; device: string; value: number }
  | { cmd: 'brightness'; device: string; delta: number }
  | { cmd: 'fanMode'; fan: string; mode: 'curve' | 'full' | 'toggle' }

interface Info {
  port: number
  token: string
}

/** Where the app records its port and token; written fresh at every launch. */
async function readInfo(): Promise<Info | undefined> {
  const base = process.env.LOCALAPPDATA
  if (!base) return undefined
  try {
    const j = JSON.parse(await readFile(join(base, 'Lights Fan Action', 'control.json'), 'utf8'))
    return typeof j.port === 'number' && typeof j.token === 'string' ? { port: j.port, token: j.token } : undefined
  } catch {
    return undefined
  }
}

let info: Info | undefined

async function call(path: string, init?: RequestInit): Promise<Response | undefined> {
  // a stale file (the app restarted on another port) is replaced once, then we give up until the next try
  for (let attempt = 0; attempt < 2; attempt++) {
    info ??= await readInfo()
    if (!info) return undefined
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(3000),
      })
      if (res.status === 401 || res.status === 421) {
        info = undefined
        continue
      }
      return res
    } catch {
      info = undefined
    }
  }
  return undefined
}

export async function fetchState(): Promise<Snapshot | undefined> {
  const res = await call('/state')
  if (!res?.ok) return undefined
  const s = (await res.json()) as Partial<Snapshot>
  return s.v === 1 ? (s as Snapshot) : undefined
}

export async function send(c: Command): Promise<boolean> {
  const res = await call('/command', { method: 'POST', body: JSON.stringify(c) })
  return res?.status === 202
}

export interface DeckKeys {
  id: string
  name: string
  columns: number
  rows: number
  keys: { column: number; row: number }[]
}

/** Tells the app which decks carry display keys, and where. Sent every few seconds, so a quiet plugin makes the decks disappear. */
export async function postDecks(decks: DeckKeys[]): Promise<boolean> {
  const res = await call('/decks', { method: 'POST', body: JSON.stringify({ decks }) })
  return res?.status === 202
}

/** One lighting frame for a deck: `bytes` is 3 bytes a sample, `g` x `g` samples for each key in `keys`, in that order. */
export interface Frame {
  meta: { deck: string; g: number; columns: number; rows: number; keys: [number, number][] }
  bytes: Uint8Array
}

/**
 * Listens for lighting frames from the app and keeps the connection going: when it drops, it tries again. Returns a
 * function that stops listening.
 */
export function openFrames(on: { frame(f: Frame): void; open(): void; close(): void }): () => void {
  let stopped = false
  const abort = new AbortController()

  const run = async () => {
    while (!stopped) {
      info ??= await readInfo()
      if (info) {
        try {
          const res = await fetch(`http://127.0.0.1:${info.port}/frames`, {
            headers: { Authorization: `Bearer ${info.token}` },
            signal: abort.signal,
          })
          if (res.ok && res.body) {
            on.open()
            const decoder = new TextDecoder()
            let pending = ''
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
              pending += decoder.decode(chunk, { stream: true })
              let end: number
              while ((end = pending.indexOf('\n\n')) >= 0) {
                const event = pending.slice(0, end)
                pending = pending.slice(end + 2)
                const line = event.split('\n').find((l) => l.startsWith('data: '))
                if (!line) continue // a comment or keep-alive
                try {
                  const j = JSON.parse(line.slice(6)) as { meta: Frame['meta']; b64: string }
                  on.frame({ meta: j.meta, bytes: Buffer.from(j.b64, 'base64') })
                } catch {
                  /* a damaged event: skip it */
                }
              }
            }
          } else if (res.status === 401 || res.status === 421) {
            info = undefined // the app restarted with a new token
          }
        } catch {
          info = undefined
        }
        on.close()
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 1000))
    }
  }
  void run()
  return () => {
    stopped = true
    abort.abort()
  }
}
