// Regenerate tables from captured evidence; does not launch CLIs or modify production code.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cases, bytes, sha } from './matrix.ts'

const lanes = process.argv.slice(2)
const read = (path: string): any[] => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
// Literal copy of the strict frame rule; this report is storage evidence, not a reader test.
function frameId(text: string): string | null {
  const entry = text.trimEnd()
  const id = /\[end podium message (msg_[0-9a-f-]+)\]$/i.exec(entry)?.[1]
  if (!id) return null
  const head = `[podium message ${id} · `
  return entry.startsWith(head) || entry.includes(`\n${head}`) ? id : null
}
function textMatches(lane: string, sent: string, recorded: string): boolean {
  if (lane.startsWith('opencode')) {
    const pasted = sent.endsWith('\n') ? sent.slice(0, -1) : sent
    return !!sent && (sent === recorded || recorded === `${pasted} `)
  }
  return !!sent.trim() && sent.trim() === recorded.trim()
}
function change(sent: string, recorded: string): string {
  if (sent === recorded) return 'exact'
  if (sent.trim() === recorded) return 'trim outer whitespace'
  if (recorded === `${sent} `) return 'append SP'
  if (sent.endsWith('\n') && recorded === `${sent.slice(0, -1)} `) return 'final LF → SP'
  if (recorded === sent.replace(/\r\n?/g, '\n')) return 'CRLF/CR → LF'
  if (recorded === sent.replace(/\r\n?/g, '\n').trim()) return 'CRLF/CR → LF; trim'
  if (recorded === sent.replace(/\r\n/g, '\n\n')) return 'CRLF → two LFs'
  if (recorded === sent.replace(/\t/g, '    ')) return 'TAB → 4 SP'
  if (recorded === sent.replace(/\t/g, '')) return 'TAB removed'
  if (recorded === `${sent.replace(/\r\n?/g, '\n')} `) return 'CRLF/CR → LF; append SP'
  if (recorded === `${sent.replace(/\t/g, '    ')} `) return 'TAB → 4 SP; append SP'
  return `changed (first diff byte ${firstDiff(sent, recorded)})`
}
function firstDiff(a: string, b: string): number {
  const x = Buffer.from(a), y = Buffer.from(b)
  let p = 0; while (p < Math.min(x.length, y.length) && x[p] === y[p]) p++
  return p
}
const textOf = (content: any): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(c => c.text ?? '').join('') : content?.text ?? ''
for (const lane of lanes) {
  const base = `${import.meta.dir}/${lane}`
  if (!existsSync(`${base}/observations.jsonl`)) throw new Error(`No capture: ${lane}`)
  const run = JSON.parse(readFileSync(`${base}/run.json`, 'utf8'))
  const observations = read(`${base}/observations.jsonl`)
  const records = read(`${base}/native-records.jsonl`)
  const models = read(`${base}/model-requests.jsonl`)
  const summaries = observations.map(o => {
    const input = cases.find(c => c.name === o.case)!
    const native = records.filter(r => r.label === o.label)
    const prompts = native.filter(r => r.kind === 'prompt')
    const texts: string[] = prompts.flatMap(r => r.texts)
    const modelTexts: string[] = models.filter(r => o.modelRequests.includes(r.n)).flatMap(r =>
      r.messages.filter((m: any) => m.role === 'user').map((m: any) => textOf(m.content)))
    return {
      label: o.label, inputBytes: bytes(input.text), inputSha256: sha(input.text),
      promptRecords: prompts.length,
      stored: prompts.map(r => ({ source: r.source, position: r.position, id: r.id,
        texts: r.texts.map((text: string) => ({ bytes: bytes(text), sha256: sha(text), change: change(input.text, text) })) })),
      frameIdStored: input.framed && texts.length ? texts.some(t => t.includes(input.id)) : null,
      strictFrameMatches: input.framed && texts.length ? texts.some(t => frameId(t) === input.id) : null,
      exactBodyStored: texts.length ? texts.some(t => t.includes(input.body)) : null,
      exactTextStored: texts.length ? texts.some(t => t === input.text) : null,
      currentTextRuleMatches: texts.length ? texts.some(t => textMatches(lane, input.text, t)) : null,
      protocolIdStored: lane.includes('terminal') ? null : native.some(r => r.id === input.id),
      modelExactBody: modelTexts.length ? modelTexts.some(t => t.includes(input.body)) : null,
      modelContainsStored: texts.map(t => modelTexts.some(m => m.includes(t))),
      otherRecords: native.filter(r => r.kind !== 'prompt').map(r => ({ source: r.source, position: r.position, kind: r.kind, id: r.id,
        texts: r.texts.map((t: string) => ({ bytes: bytes(t), sha256: sha(t), first: t.slice(0, 70), last: t.slice(-70) })) })),
      error: o.error, status: o.status, extraEnterAt: o.extraEnterAt, initialSubmitAt: o.initialSubmitAt,
      editorDrainComplete: o.editorDrainComplete,
      editorDrainMs: o.editorDrainedAt ? o.editorDrainedAt - o.sentAt : null,
      observationMs: o.finishedAt - o.sentAt,
    }
  })
  writeFileSync(`${base}/summary.jsonl`, summaries.map(s => JSON.stringify(s)).join('\n') + '\n')
  const yes = (v: boolean | null) => v === null ? '—' : v ? 'yes' : '**no**'
  const md = [`# ${lane} — ${run.version}`, '',
    `Measured ${run.startedAt}–${run.finishedAt ?? 'in progress'}. [Run/config](run.json), [native records](native-records.jsonl), [full model inputs](model-requests.jsonl), [protocol](protocol.jsonl), [machine comparisons](summary.jsonl).`, '',
    'Bytes are UTF-8 after JSON decoding, not JSON escape length. `SP`, `LF`, `CR`, `TAB` mean bytes 20, 0a, 0d, 09. Frame id checks use the native prompt text and the strict closing-line rule. “Text rule” applies the current terminal matching source to native text (Codex/Grok readers trim it). It is not a test of the full delivery pipeline.', '',
    '“Model body exact” checks all captured user messages, including auxiliary title requests; it does not establish that the main conversation request carried the body. Missing prompt records have no stored-byte, frame, or matching verdict. Bounded drain/submit timings and errors are in [observations](observations.jsonl) and the machine comparisons. [Method and limits](../README.md).', '',
    '| Method / case | Sent B | Prompt records / stored B | Storage change | Body exact | Frame matches | Text rule | Model body exact |',
    '|---|---:|---|---|---|---|---|---|',
    ...summaries.map(s => `| ${s.label} | ${s.inputBytes} | ${s.promptRecords} / ${s.stored.flatMap(r => r.texts.map((t: any) => t.bytes)).join(', ') || '—'} | ${s.stored.flatMap(r => r.texts.map((t: any) => t.change)).join('; ') || 'no prompt'} | ${yes(s.exactBodyStored)} | ${yes(s.strictFrameMatches)} | ${yes(s.currentTextRuleMatches)} | ${yes(s.modelExactBody)} |`), '',
  ].join('\n')
  writeFileSync(`${base}/results.md`, md)
  console.log(`${lane}: ${summaries.length} cases, ${summaries.filter(s => s.exactTextStored).length} exact, ${summaries.filter(s => s.promptRecords === 0).length} without a record, ${summaries.filter(s => s.promptRecords > 1).length} split, ${summaries.filter(s => s.strictFrameMatches === false).length} failed stored frames, ${summaries.filter(s => s.currentTextRuleMatches === false).length} text-rule misses`)
}
