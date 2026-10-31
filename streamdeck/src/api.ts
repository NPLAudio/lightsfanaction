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
