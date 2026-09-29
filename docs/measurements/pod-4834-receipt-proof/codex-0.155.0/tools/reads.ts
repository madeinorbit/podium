// Summarises every thread/read and thread/queue/list result of a run: per turn its status and
// its user items with clientId and text. Usage: bun reads.ts <run-dir>
import { readFileSync } from 'node:fs'

const R = process.argv[2]
const lines = readFileSync(`${R}/log/frames.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const t0 = lines.find((l) => l.dir === 'mark')?.at ?? 0
const short = (s: string, n = 50) => (s.length > n ? `${JSON.stringify(s.slice(0, n))}…(${s.length})` : JSON.stringify(s))
for (const l of lines) {
  if (l.dir !== 'mark') continue
  if (l.label.startsWith('thread/read')) {
    console.log(`+${l.at - t0} ${l.label}:`)
    for (const t of l.extra.result?.thread?.turns ?? []) {
      const users = t.items.filter((i: any) => i.type === 'userMessage').map((i: any) => `${i.clientId ?? 'null'}=${short(i.content.map((c: any) => c.text).join(''))}`)
      console.log(`   turn ${t.id} ${t.status}${t.error ? ` error=${JSON.stringify(t.error).slice(0, 120)}` : ''} startedAt=${t.startedAt} users=[${users.join(', ')}] items=${t.items.map((i: any) => i.type).join(',')}`)
    }
    if (l.extra.error) console.log(`   error ${JSON.stringify(l.extra.error)}`)
  }
  if (l.label.startsWith('thread/queue/list')) console.log(`+${l.at - t0} ${l.label}: ${JSON.stringify((l.extra.result?.data ?? []).map((q: any) => q.clientUserMessageId))}`)
}
