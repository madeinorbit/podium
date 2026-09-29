// Watches a scratch CODEX_HOME and logs, in FILE ORDER with the time each line was first seen
// (its write time to within the poll interval), every new line of every rollout file and of
// history.jsonl, plus every change of Codex's durable queue table (queue_1.sqlite queued_items).
// Usage: CODEX_HOME=... WATCH_LOG=... bun watch-history.ts
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { Database } from 'bun:sqlite'

const HOME = process.env.CODEX_HOME!
const LOG = process.env.WATCH_LOG!
const POLL = 10
const offsets = new Map<string, { bytes: number; line: number; rest: string }>()
const log = (o: unknown) => appendFileSync(LOG, `${JSON.stringify(o)}\n`)

function files(): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(join(HOME, 'sessions'))
  walk(join(HOME, 'archived_sessions'))
  if (existsSync(join(HOME, 'history.jsonl'))) out.push(join(HOME, 'history.jsonl'))
  return out
}

function pollFiles() {
  const at = Date.now()
  for (const f of files()) {
    const size = statSync(f).size
    const st = offsets.get(f) ?? { bytes: 0, line: 0, rest: '' }
    if (size < st.bytes) {
      log({ at, file: basename(f), event: 'truncated', from: st.bytes, to: size })
      st.bytes = 0
      st.rest = ''
    }
    if (size > st.bytes) {
      const buf = readFileSync(f).subarray(st.bytes, size).toString('utf8')
      st.bytes = size
      const parts = (st.rest + buf).split('\n')
      st.rest = parts.pop() ?? ''
      for (const l of parts) {
        st.line++
        let rec: unknown = l
        try {
          rec = JSON.parse(l)
        } catch {}
        log({ at, file: basename(f), line: st.line, rec })
      }
    }
    offsets.set(f, st)
  }
}

let db: Database | undefined
let lastQueue = ''
function pollQueue() {
  const p = join(HOME, 'queue_1.sqlite')
  if (!existsSync(p)) return
  try {
    db ??= new Database(p, { readonly: true })
    const rows = db.query('select id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms from queued_items order by thread_id, queue_order').all()
    const s = JSON.stringify(rows)
    if (s !== lastQueue) {
      lastQueue = s
      log({ at: Date.now(), file: 'queue_1.sqlite:queued_items', rows })
    }
  } catch (e) {
    db = undefined
  }
}

log({ at: Date.now(), event: 'watch-start', home: 'CODEX_HOME' })
let tick = 0
setInterval(() => {
  pollFiles()
  if (tick++ % 5 === 0) pollQueue()
}, POLL)
