// Drives the REAL `codex app-server` (scratch CODEX_HOME from setup-home.sh, fake model server)
// and logs every JSON-RPC frame both ways with its time to FRAMES_LOG. POD-4863.
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

export const R = process.env.R!
export const HOME = `${R}/home`
export const CODEX_HOME = `${HOME}/.codex`
export const WORK = `${R}/work`
const FRAMES_LOG = process.env.FRAMES_LOG!
export const mark = (label: string, extra: unknown = {}) =>
  appendFileSync(FRAMES_LOG, `${JSON.stringify({ at: Date.now(), dir: 'mark', label, extra })}\n`)

export type Srv = ReturnType<typeof startServer>

export function startServer(tag = 'srv') {
  const child: ChildProcess = spawn('codex', ['--dangerously-bypass-hook-trust', 'app-server'], {
    cwd: WORK,
    env: { ...process.env, HOME, CODEX_HOME, FAKE_KEY: 'dummy-not-a-key', HOOK_LOG: process.env.HOOK_LOG },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr!.on('data', (d) => appendFileSync(`${FRAMES_LOG}.stderr`, `${Date.now()} [${tag}] ${d}`))
  const pending = new Map<number, (f: any) => void>()
  const watchers = new Set<(f: any) => void>()
  let nextId = 1
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let f: any
    try {
      f = JSON.parse(line)
    } catch {
      return
    }
    appendFileSync(FRAMES_LOG, `${JSON.stringify({ at: Date.now(), dir: 'in', tag, frame: f })}\n`)
    if (f.id !== undefined && !f.method && pending.has(f.id)) {
      pending.get(f.id)!(f)
      pending.delete(f.id)
    }
    for (const w of [...watchers]) w(f)
  })
  const send = (f: any) => {
    appendFileSync(FRAMES_LOG, `${JSON.stringify({ at: Date.now(), dir: 'out', tag, frame: f })}\n`)
    child.stdin!.write(`${JSON.stringify(f)}\n`)
  }
  const call = (method: string, params: any) => {
    const id = nextId++
    const p = new Promise<any>((r) => pending.set(id, r))
    send({ jsonrpc: '2.0', id, method, params })
    return p
  }
  const waitFor = (pred: (f: any) => boolean, ms = 30000) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => {
        watchers.delete(w)
        reject(new Error('timeout'))
      }, ms)
      const w = (f: any) => {
        if (pred(f)) {
          clearTimeout(t)
          watchers.delete(w)
          resolve(f)
        }
      }
      watchers.add(w)
    })
  const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)))
  return { child, call, send, waitFor, exited }
}

export async function init(srv: Srv) {
  await srv.call('initialize', { clientInfo: { name: 'podium', title: 'Podium', version: '0.0.0' }, capabilities: { experimentalApi: true } })
  srv.send({ jsonrpc: '2.0', method: 'initialized' })
}

export const text = (t: string) => [{ type: 'text', text: t, text_elements: [] }]
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const note = (m: string) => (f: any) => f.method === m
export const turnDone = (turnId: string) => (f: any) => f.method === 'turn/completed' && f.params?.turn?.id === turnId
