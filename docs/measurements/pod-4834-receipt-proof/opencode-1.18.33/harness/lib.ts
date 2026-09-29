// Shared measurement harness for OpenCode serve (v1 and v2 HTTP).
// Every record goes to ONE timeline file (JSONL, `at` = epoch ms) so order is file order.
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

export const SP = process.env.SP!
export const WORK = `${SP}/work`
export const DB = process.env.OC_DB ?? `${SP}/home/.local/share/opencode/opencode.db`
export let OUT = `${SP}/logs/timeline.jsonl`
export const setOut = (f: string) => { OUT = f }
export const log = (kind: string, rec: Record<string, unknown>) =>
  appendFileSync(OUT, JSON.stringify({ at: Date.now(), kind, ...rec }) + '\n')
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const newId = () => `msg_${randomUUID()}`
export const partIdFor = (m: string) => `prt_000000000000${m.slice(4)}`

export const env = { ...process.env } as Record<string, string>
// A fixed local dummy for servers that demand Basic auth (the beta); never a real credential.
const AUTH = process.env.OPENCODE_SERVER_PASSWORD ? { authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME ?? 'opencode'}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` } : {}
export const authHeaders = AUTH as Record<string, string>

export async function startServer(bin: string, port: number, tag: string): Promise<ChildProcess> {
  const p = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { env, cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stdout!.on('data', (d) => log('server.stdout', { tag, text: String(d).slice(0, 500) }))
  p.stderr!.on('data', (d) => log('server.stderr', { tag, text: String(d).slice(0, 500) }))
  p.on('exit', (code, sig) => log('server.exit', { tag, pid: p.pid, code, sig }))
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: authHeaders, signal: AbortSignal.timeout(2000) }); if (r.ok) break } catch {}
    await sleep(250)
  }
  log('server.ready', { tag, pid: p.pid, port, bin })
  return p
}

export class Api {
  constructor(public base: string, public dirQuery = true) {}
  q(path: string) {
    if (!this.dirQuery || path.startsWith('/api/')) return `${this.base}${path}`
    return `${this.base}${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(WORK)}`
  }
  async call(method: string, path: string, body?: unknown, label?: string) {
    const sent = Date.now()
    log('http.send', { label, method, path, body })
    let status = 0, text = ''
    try {
      const r = await fetch(this.q(path), { method, headers: { ...authHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
      status = r.status; text = await r.text()
    } catch (e) { text = `FETCH-ERROR ${String(e)}` }
    let json: unknown = undefined
    try { json = JSON.parse(text) } catch {}
    log('http.reply', { label, method, path, status, ms: Date.now() - sent, body: json ?? text.slice(0, 2000) })
    return { status, json: json as any, text }
  }
}

/** Log every SSE frame of a stream, with its receive time. */
export function sse(url: string, label: string, stop: AbortSignal) {
  ;(async () => {
    try {
      const r = await fetch(url, { headers: authHeaders, signal: stop })
      log('sse.open', { label, url, status: r.status })
      const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = ''
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true })
        for (;;) {
          const i = buf.indexOf('\n\n'); if (i < 0) break
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            let d: any; try { d = JSON.parse(line.slice(5).trim()) } catch { d = line }
            if (d?.type === 'message.part.delta' || d?.type === 'session.text.delta') { log('sse', { label, type: d.type, brief: true }); continue }
            if (d?.type === 'plugin.added') continue
            log('sse', { label, frame: d })
          }
        }
      }
      log('sse.end', { label })
    } catch (e) { log('sse.end', { label, err: String(e).slice(0, 200) }) }
  })()
}

/** Poll the database; log each NEW or CHANGED row of the watched tables, in rowid (insert) order. */
export function dbWatch(stop: AbortSignal, everyMs = 25) {
  const seen = new Map<string, string>()
  const tables: Array<[string, string]> = [
    ['message', `select rowid r, id, session_id s, time_created tc, time_updated tu, data from message order by rowid`],
    ['part', `select rowid r, id, message_id m, session_id s, time_created tc, time_updated tu, data from part order by rowid`],
    ['session_input', `select rowid r, id, session_id s, prompt, delivery, admitted_seq a, promoted_seq p, time_created tc from session_input order by rowid`],
    ['session_inbox', `select rowid r, * from session_inbox order by rowid`],
    ['session_pending', `select rowid r, * from session_pending order by rowid`],
    ['session_message', `select rowid r, id, session_id s, type, seq, time_created tc, time_updated tu, data from session_message order by rowid`],
    ['event', `select rowid r, id, aggregate_id s, seq, type, data from event order by rowid`],
  ]
  ;(async () => {
    let first = true
    while (!stop.aborted) {
      let d: Database | undefined
      try { d = new Database(DB, { readonly: true }) } catch { await sleep(everyMs); continue }
      for (const [t, sql] of tables) {
        let rows: any[]
        try { rows = d.query(sql).all() as any[] } catch { continue }
        const present = new Set<string>()
        for (const row of rows) {
          const key = `${t}:${row.id ?? row.r}`; present.add(key); const val = JSON.stringify(row)
          const prev = seen.get(key)
          if (prev === val) continue
          seen.set(key, val)
          if (first) continue
          let data: any = row.data; try { data = JSON.parse(row.data) } catch {}
          if (t === 'part' && data?.type === 'text' && typeof data.text === 'string' && data.text.length > 400) data = { ...data, text: data.text.slice(0, 400) + `…(${data.text.length} chars)` }
          log('db', { table: t, change: prev ? 'update' : 'insert', row: { ...row, data } })
        }
        for (const key of [...seen.keys()]) if (key.startsWith(`${t}:`) && !present.has(key)) { log('db', { table: t, change: 'delete', row: JSON.parse(seen.get(key)!) }); seen.delete(key) }
      }
      d.close()
      first = false
      await sleep(everyMs)
    }
  })()
}

/** Tail a JSONL file written by another process (hooks, fake model) into the timeline. */
export function tail(file: string, kind: string, stop: AbortSignal, map: (r: any) => any = (r) => r) {
  const { statSync, openSync, readSync, closeSync } = require('node:fs')
  let pos = 0; try { pos = statSync(file).size } catch {}
  let rest = ''
  ;(async () => {
    while (!stop.aborted) {
      try {
        const size = statSync(file).size
        if (size > pos) {
          const fd = openSync(file, 'r'); const buf = Buffer.alloc(size - pos); readSync(fd, buf, 0, buf.length, pos); closeSync(fd); pos = size
          rest += buf.toString('utf8')
          const lines = rest.split('\n'); rest = lines.pop()!
          for (const l of lines) { if (!l.trim()) continue; let r: any; try { r = JSON.parse(l) } catch { continue } const m = map(r); if (m) appendFileSync(OUT, JSON.stringify({ at: r.at, kind, seenAt: Date.now(), ...m }) + '\n') }
        }
      } catch {}
      await sleep(25)
    }
  })()
}

export const hookMap = (r: any) => {
  if (r.hook === 'event' && (r.input?.type === 'plugin.added' || r.input?.type === 'message.part.delta' || r.input?.type === 'session.diff' || r.input?.type === 'catalog.updated')) return null
  if (r.hook === 'tool.definition' || r.hook === 'experimental.chat.system.transform') return { hook: r.hook }
  return { hook: r.hook, input: r.input, output: r.output }
}
export const modelMap = (r: any) => ({ idx: r.idx, mode: r.mode, hasTools: r.hasTools, nMsgs: r.nMsgs, lastRole: r.lastRole, users: r.users })
