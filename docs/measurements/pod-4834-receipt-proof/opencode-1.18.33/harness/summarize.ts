// Compact, time-sorted view of a timeline. Usage: bun summarize.ts <timeline> [fromMark] [toMark] [--all]
import { readFileSync } from 'node:fs'
const [file, from, to] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const all = process.argv.includes('--all')
const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => ({ ...JSON.parse(l), line: i + 1 }))
recs.sort((a, b) => a.at - b.at || a.line - b.line)
const startIdx = from ? recs.findIndex((r) => r.kind === 'mark' && r.name === from) : 0
const endIdx = to ? recs.findIndex((r) => r.kind === 'mark' && r.name === to) : recs.length - 1
const t0 = recs[startIdx]?.at ?? recs[0].at
const cut = (s: unknown, n = 70) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t && t.length > n ? t.slice(0, n) + '…' : t }
const sh = (id?: string) => (id ? String(id).replace(/^(msg|prt|ses|evt)_(0000000000000?)?/, '$1:').slice(0, 14) : '-')
for (const r of recs.slice(startIdx, endIdx + 1)) {
  const d = `+${String(r.at - t0).padStart(6)}`
  let s = ''
  switch (r.kind) {
    case 'mark': s = `MARK ${r.name} ${r.id ? sh(r.id) : ''}`; break
    case 'http.send': if (r.label?.startsWith('poll')) continue; s = `HTTP> ${r.label} ${r.method} ${r.path.replace(/ses_\w+/, 'S')} ${cut(r.body?.prompt?.text ?? r.body?.parts?.[0]?.text ?? '', 40)}`; break
    case 'http.reply': if (r.label?.startsWith('poll')) continue; s = `HTTP< ${r.label} ${r.status} ${r.ms}ms ${Array.isArray(r.body?.data) && r.body.data[0]?.type ? `[${r.body.data.map((m: any) => `${m.type}:${sh(m.id)}${m.text ? '(' + cut(m.text, 24) + ')' : ''}`).join(' ')}]` : Array.isArray(r.body) ? `[${r.body.map((m: any) => !m.info ? cut(m, 60) : `${m.info.role[0]}:${sh(m.info.id)}(${(m.parts ?? []).map((p: any) => p.type[0] + (p.text ? ':' + cut(p.text, 20) : '')).join(',')})`).join(' ')}]` : cut(r.body, 220)}`; break
    case 'sse': {
      if (r.brief) { if (!all) continue; s = `SSE ${r.type}`; break }
      const f = r.frame; const p = f.properties ?? f.data ?? {}
      if (r.label !== 'v1-event') {
        if (!all && /session\.updated|heartbeat|text\.delta|reasoning\.delta|catalog|reference|integration/.test(f.type ?? '')) continue
        s = `SSE[${r.label}] ${f.type} seq=${f.seq ?? f.data?.seq ?? ''} ${cut(f.data ?? f, 230)}`; break
      }
      const t = f.type
      if (!all && (t === 'session.updated' || t === 'session.diff' || t === 'server.heartbeat')) continue
      const info = p.info ?? {}; const part = p.part ?? {}
      s = `SSE[${r.label}] ${t} ${info.id ? `${info.role} ${sh(info.id)}${info.time?.completed ? ' completed' : ''}` : ''}${part.id ? `${part.type} ${sh(part.id)} of ${sh(part.messageID)} ${cut(part.text ?? part.state?.status ?? '', 30)}` : ''}${p.status ? JSON.stringify(p.status) : ''}${t?.startsWith('session.') && !info.id ? ' ' + cut(p, 160) : ''}`
      break
    }
    case 'db': {
      const row = r.row; const dd = row.data ?? {}
      if (!all && r.table === 'event' && /session\.updated|session\.diff/.test(row.type)) continue
      if (r.table === 'event') s = `DB event#${row.seq} ${row.type} ${cut(dd.info?.id ?? dd.part?.id ?? dd.messageID ?? dd.id ?? '', 40)}`
      else if (r.table === 'message') s = `DB message ${r.change} ${dd.role} ${sh(row.id)} tc=${row.tc - t0} ${dd.time?.completed ? 'completed' : ''} ${dd.error ? 'ERR ' + cut(dd.error, 60) : ''}`
      else if (r.table === 'part') s = `DB part ${r.change} ${dd.type} ${sh(row.id)} of ${sh(row.m)} tc=${row.tc - t0} ${cut(dd.text ?? dd.state?.status ?? '', 40)}`
      else s = `DB ${r.table} ${r.change} ${cut(row, 240)}`
      break
    }
    case 'hook': {
      if (!all && (r.hook === 'tool.definition' || r.hook === 'experimental.chat.system.transform')) continue
      if (r.hook === 'event') { const t = r.input?.type; if (!all && /session\.updated|session\.diff|message\.part\.delta/.test(t)) continue; s = `HOOK event ${t} ${sh(r.input?.properties?.info?.id ?? r.input?.properties?.part?.id)}${r.input?.properties?.status ? JSON.stringify(r.input.properties.status) : ''}` }
      else if (r.hook === 'experimental.chat.messages.transform') s = `HOOK messages.transform ${r.output.messages.map((m: any) => `${m.role[0]}:${sh(m.id)}`).join(' ')}`
      else s = `HOOK ${r.hook} ${cut({ ...r.input, ...(r.hook === 'chat.message' ? { parts: r.output?.parts?.map((p: any) => `${p.type}:${sh(p.id)}:${cut(p.text, 20)}`) } : {}) }, 200)}`
      break
    }
    case 'model': s = `MODEL #${r.idx} ${r.mode} tools=${r.hasTools} n=${r.nMsgs} last=${r.lastRole} users=${cut(r.users.slice(-3), 160)}`; break
    case 'idle': s = `IDLE ${sh(r.lastId)}`; break
    default: s = `${r.kind} ${cut({ ...r, at: undefined, kind: undefined, line: undefined }, 200)}`
  }
  console.log(`${d} ${s}`)
}
