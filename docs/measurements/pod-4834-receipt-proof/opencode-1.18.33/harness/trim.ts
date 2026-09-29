// Trim a timeline or model log for committing: drop pure-noise records, shorten the system prompt.
// Usage: bun trim.ts timeline <in> <out> | bun trim.ts model <in> <out> <fromMs> <toMs>
import { readFileSync, writeFileSync } from 'node:fs'
const [mode, inp, out, from, to] = process.argv.slice(2)
const lines = readFileSync(inp, 'utf8').split('\n').filter(Boolean)
const keep: string[] = []
for (const l of lines) {
  const r = JSON.parse(l)
  if (mode === 'model') {
    if (from && (r.at < Number(from) || r.at > Number(to))) continue
    r.messages = (r.messages ?? []).map((m: any) => m.role === 'system' ? { role: 'system', content: `<system prompt, ${JSON.stringify(m.content).length} chars, omitted>` } : m)
    keep.push(JSON.stringify(r)); continue
  }
  const t = r.frame?.type ?? r.input?.type ?? r.row?.type ?? ''
  if (/session\.updated|session\.diff|catalog\.updated|reference\.updated|integration\.updated|plugin\.added/.test(t)) continue
  if (r.kind === 'hook' && (r.hook === 'tool.definition' || r.hook === 'experimental.chat.system.transform' || r.hook === 'shell.env')) continue
  if (r.kind === 'sse' && r.brief) continue
  if (r.kind === 'http.send' && r.label?.startsWith('poll')) continue
  if (r.kind === 'http.reply' && r.label?.startsWith('poll')) continue
  if (r.frame?.type === 'session.created' || r.input?.type === 'session.created') { r.frame && (r.frame.properties = { sessionID: r.frame.properties?.sessionID }); r.input && (r.input.properties = { sessionID: r.input.properties?.sessionID }) }
  keep.push(JSON.stringify(r))
}
writeFileSync(out, keep.join('\n') + '\n')
console.log(`${mode}: ${lines.length} -> ${keep.length}`)
