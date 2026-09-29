// Compare the sent text, the stored part text, the hook text and the text the model got, per S7 case.
import { readFileSync } from 'node:fs'
const [tl, modelLog] = process.argv.slice(2)
const recs = readFileSync(tl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const models = readFileSync(modelLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const sends = recs.filter((r) => r.kind === 'http.send' && r.method === 'POST' && /^S7\./.test(r.label ?? ''))
const flat = (c: any) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b.text ?? '').join('') : ''
for (const s of sends) {
  const sent: string = s.body?.parts?.[0]?.text ?? s.body?.prompt?.text ?? s.body?.text
  const id: string = s.body?.messageID ?? s.body?.id
  const after = recs.filter((r) => r.kind === 'http.reply' && r.label === 'S7.after').at(-1)?.body
  const stored = Array.isArray(after) ? after.find((m: any) => m.info?.id === id)?.parts?.find((p: any) => p.type === 'text')?.text : Array.isArray(after?.data) ? after.data.find((m: any) => m.id === id)?.text : undefined
  const v2stored = recs.filter((r) => r.kind === 'db' && (r.table === 'session_input' || r.table === 'session_inbox') && r.row.id === id).map((r) => JSON.parse(r.row.prompt ?? r.row.payload).text).at(-1)
  const hook = recs.filter((r) => r.kind === 'hook' && r.hook === 'chat.message' && r.input?.messageID === id).map((r) => r.output?.parts?.[0]?.text).at(-1)
  const m = models.find((m) => m.hasTools && m.messages?.some((x: any) => x.role === 'user' && flat(x.content).includes(sent.trim().slice(0, 20))))
  const inModel = m ? m.messages.filter((x: any) => x.role === 'user').map((x: any) => flat(x.content)).find((t: string) => t.includes(sent.trim().slice(0, 20))) : undefined
  const cmp = (x?: string) => x === undefined ? 'absent' : x === sent ? 'IDENTICAL' : x.length > 200 && x.length === sent.length ? 'same length, differs' : `DIFFERS: ${JSON.stringify(x.slice(0, 120))} (len ${x.length} vs ${sent.length})`
  console.log(`${s.label} len=${sent.length} storedHistory=${cmp(stored)} v2input=${cmp(v2stored)} hook=${cmp(hook)} model=${cmp(inModel)}`)
}
