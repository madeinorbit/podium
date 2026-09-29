// Per send: the first time each signal naming it appeared, in ms after the send (HTTP request start or Enter).
// Usage: bun signals.ts <timeline.jsonl> [model-requests.jsonl]
import { readFileSync } from 'node:fs'
const [file, modelFile] = process.argv.slice(2)
const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => ({ ...JSON.parse(l), line: i })).sort((a, b) => a.at - b.at || a.line - b.line)
const models = modelFile ? readFileSync(modelFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : recs.filter((r) => r.kind === 'model')
const flat = (c: any) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? '').join('') : ''
type Send = { label: string; at: number; id?: string; text: string }
const sends: Send[] = []
for (const r of recs) {
  if (r.kind === 'http.send' && r.method === 'POST' && /prompt/.test(r.path)) sends.push({ label: r.label, at: r.at, id: r.body?.messageID ?? r.body?.id, text: r.body?.parts?.[0]?.text ?? r.body?.prompt?.text ?? r.body?.text ?? '' })
}
// TUI: an Enter mark; its text is the next prompt-history line or user part inserted after it.
for (const r of recs) {
  if (r.kind !== 'mark' || !/\.enter/.test(r.name ?? '')) continue
  const part = recs.find((x) => x.at >= r.at && x.kind === 'db' && x.table === 'part' && x.change === 'insert' && x.row.data?.type === 'text' && recs.some((m) => m.kind === 'db' && m.table === 'message' && m.row.id === x.row.m && m.row.data?.role === 'user'))
  const msg = recs.find((x) => x.at >= r.at && x.kind === 'db' && x.table === 'message' && x.change === 'insert' && x.row.data?.role === 'user')
  sends.push({ label: r.name, at: r.at, id: msg?.row.id, text: part?.row.data?.text ?? '' })
}
sends.sort((a, b) => a.at - b.at)
const first = (after: number, pred: (r: any) => boolean) => { const r = recs.find((x) => x.at >= after && pred(x)); return r ? r.at - after : undefined }
const fmt = (v?: number) => (v === undefined ? '—' : `+${v}`)
console.log('| send | our id? | reply | chat.message | msg row | text part | SSE msg.updated | admitted (ev/row) | prompted/delivered (ev/row) | model request |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const s of sends) {
  const at = s.at, id = s.id
  const reply = recs.find((x) => x.at >= at && x.kind === 'http.reply' && x.label === s.label)
  const hook = first(at, (x) => x.kind === 'hook' && x.hook === 'chat.message' && (id ? x.output?.message?.id === id || x.input?.messageID === id : true))
  const row = id ? first(at, (x) => x.kind === 'db' && x.table === 'message' && x.change === 'insert' && x.row.id === id) : undefined
  const part = id ? first(at, (x) => x.kind === 'db' && x.table === 'part' && x.change === 'insert' && x.row.m === id && x.row.data?.type === 'text') : undefined
  const sseMsg = id ? first(at, (x) => x.kind === 'sse' && x.frame?.type === 'message.updated' && x.frame?.properties?.info?.id === id) : undefined
  const admEv = id ? first(at, (x) => x.kind === 'sse' && (x.frame?.type === 'session.next.prompt.admitted' && x.frame?.data?.messageID === id || x.frame?.type === 'session.inbox.enqueued' && x.frame?.data?.inboxID === id)) : undefined
  const admRow = id ? first(at, (x) => x.kind === 'db' && (x.table === 'session_input' || x.table === 'session_inbox') && x.change === 'insert' && x.row.id === id) : undefined
  const proEv = id ? first(at, (x) => x.kind === 'sse' && (x.frame?.type === 'session.next.prompted' && x.frame?.data?.messageID === id || x.frame?.type === 'session.inbox.delivered' && x.frame?.data?.inboxID === id)) : undefined
  const proRow = id ? first(at, (x) => x.kind === 'db' && x.table === 'session_message' && x.change === 'insert' && x.row.id === id) : undefined
  const key = s.text.trim().slice(0, 24)
  const m = key ? models.find((m: any) => m.at >= at && m.hasTools && (m.messages ?? []).some((x: any) => x.role === 'user' && flat(x.content).includes(key))) : undefined
  const modelAt = m ? m.at - at : (key ? recs.find((x) => x.kind === 'model' && x.at >= at && x.hasTools && (x.users ?? []).some((u: string) => u.includes(key)))?.at - at : undefined)
  const v2 = admEv !== undefined || admRow !== undefined
  console.log(`| ${s.label} | ${id ? (/^msg_[0-9a-f]{8}-/.test(id) ? 'ours' : 'program') : '—'} | ${reply ? `${reply.status} ${fmt(reply.at - at)}` : '—'} | ${fmt(hook)} | ${v2 ? '—' : fmt(row)} | ${v2 ? '—' : fmt(part)} | ${fmt(sseMsg)} | ${v2 ? `${fmt(admEv)} / ${fmt(admRow)}` : '—'} | ${v2 ? `${fmt(proEv)} / ${fmt(proRow)}` : '—'} | ${Number.isFinite(modelAt) ? fmt(modelAt) : '—'} |`)
}
