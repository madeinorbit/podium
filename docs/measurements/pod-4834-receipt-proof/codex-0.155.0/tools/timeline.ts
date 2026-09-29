// Merges one run's logs (frames, hooks, history lines in file order, model requests, marks) into
// one time-ordered, compact timeline. Times are ms after the first mark whose label contains
// argv[3] (default: the first mark). Usage: bun timeline.ts <run-dir> [> timeline.txt] [anchor]
import { existsSync, readFileSync } from 'node:fs'

const R = process.argv[2]
const anchorLabel = process.argv[3]
const read = (f: string) =>
  existsSync(`${R}/log/${f}`)
    ? readFileSync(`${R}/log/${f}`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
const short = (s: unknown, n = 70) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s)
  return t && t.length > n ? `${t.slice(0, n)}…(${t.length})` : t
}
const textOf = (content: any): string =>
  Array.isArray(content) ? content.map((c: any) => c.text ?? `[${c.type}]`).join('') : String(content ?? '')
const rows: { at: number; src: string; s: string }[] = []

for (const f of read('frames.jsonl')) {
  if (f.dir === 'mark') {
    rows.push({ at: f.at, src: 'MARK', s: `${f.label} ${short(f.extra, 200)}` })
    continue
  }
  const fr = f.frame
  const m = fr.method
  if (m && /delta|tokenUsage|rateLimits|remoteControl/.test(m)) continue
  let s: string
  if (m && fr.id !== undefined) s = `${f.dir === 'out' ? '→' : '←'} req#${fr.id} ${m} ${short(fr.params, 160)}`
  else if (m) {
    const p = fr.params ?? {}
    const item = p.item
    s = `${f.dir === 'out' ? '→' : '←'} ${m}` +
      (item ? ` ${item.type} id=${item.id}${item.clientId !== undefined ? ` clientId=${item.clientId}` : ''}${item.type === 'userMessage' ? ` "${short(textOf(item.content), 60)}"` : ''}` : '') +
      (p.turn ? ` turn=${p.turn.id} status=${p.turn.status}${p.turn.error ? ` err=${short(p.turn.error, 80)}` : ''}` : '') +
      (p.turnId && !p.turn ? ` turnId=${p.turnId}` : '') +
      (p.run ? ` hook=${p.run.eventName} status=${p.run.status}` : '') +
      (p.status ? ` status=${short(p.status, 60)}` : '') +
      (m === 'error' || m === 'warning' ? ` ${short(p, 160)}` : '')
  } else s = `${f.dir === 'out' ? '→' : '←'} resp#${fr.id} ${short(fr.result ?? fr.error, 200)}`
  rows.push({ at: f.at, src: `RPC:${f.tag ?? ''}`, s })
}
for (const h of read('hooks.jsonl')) {
  const p = h.payload ?? {}
  rows.push({ at: h.at, src: 'HOOK', s: `${h.ev} turn_id=${p.turn_id ?? '-'}${p.prompt !== undefined ? ` prompt="${short(p.prompt, 60)}"` : ''}${p.source ? ` source=${p.source}` : ''}${p.reason ? ` reason=${p.reason}` : ''}${p.tool_input ? ` tool=${short(p.tool_input, 40)}` : ''}` })
}
for (const r of read('history.jsonl')) {
  if (r.event) continue
  if (r.rows) {
    rows.push({ at: r.at, src: 'QUEUEDB', s: `queued_items=${short(r.rows.map((x: any) => ({ id: x.id, order: x.queue_order, p: JSON.parse(x.payload_json) })), 300)}` })
    continue
  }
  const rec = r.rec ?? {}
  const pl = rec.payload ?? {}
  let d = `${rec.type}`
  if (rec.type === 'response_item') {
    d += `/${pl.type}${pl.role ? `:${pl.role}` : ''}`
    if (pl.type === 'message') d += ` "${short(textOf(pl.content), 70)}"`
    if (pl.id) d += ` id=${pl.id}`
    if (pl.call_id) d += ` call=${pl.call_id}`
  } else if (rec.type === 'event_msg') {
    d += `/${pl.type}`
    if (pl.message !== undefined) d += ` "${short(pl.message, 60)}"`
    if (pl.turn_id) d += ` turn=${pl.turn_id}`
    if (pl.client_id !== undefined) d += ` client_id=${pl.client_id}`
    for (const k of ['id', 'item_id', 'reason']) if (pl[k] !== undefined) d += ` ${k}=${short(pl[k], 50)}`
  } else if (rec.type === 'turn_context') d += ` turn=${pl.turn_id ?? '-'}`
  else if (r.file === 'history.jsonl') d = `history.jsonl ts=${rec.ts} "${short(rec.text, 60)}"`
  else d += ` ${short(pl, 90)}`
  rows.push({ at: r.at, src: `FILE:${r.file === 'history.jsonl' ? 'hist' : `rollout#${r.line}`}`, s: `${d}${rec.timestamp ? ` [ts ${rec.timestamp}]` : ''}` })
}
for (const q of read('model-requests.jsonl')) {
  if (q.event) {
    rows.push({ at: q.at, src: 'MODEL', s: `#${q.idx ?? ''} ${q.event}${q.mode ? ` ${q.mode}` : ''}` })
    continue
  }
  const users = (q.input ?? []).filter((i: any) => i.type === 'message' && i.role === 'user').map((i: any) => short(textOf(i.content), 40))
  const last = q.input?.at(-1)
  rows.push({ at: q.at, src: 'MODEL', s: `#${q.idx} request mode=${q.mode} items=${q.input?.length} lastItem=${last?.type}${last?.role ? `:${last.role}` : ''} users(last3)=${JSON.stringify(users.slice(-3))}` })
}
rows.sort((a, b) => a.at - b.at)
const marks = rows.filter((r) => r.src === 'MARK')
const anchor = (anchorLabel ? marks.find((m) => m.s.includes(anchorLabel)) : marks[0])?.at ?? rows[0]?.at ?? 0
for (const r of rows) console.log(`${String(r.at - anchor).padStart(7)}  ${r.src.padEnd(15)} ${r.s}`)
