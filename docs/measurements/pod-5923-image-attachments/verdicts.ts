// What Podium's reader and send proof make of each measured case (POD-5923):
// the prompt entries the reader yields, and whether the first one is the send.
// Runs against whatever sources are checked out, so it reads the same records
// before and after a change.  bun docs/measurements/pod-5923-image-attachments/verdicts.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeCodeManifest } from '../../../packages/harness/src/adapters/claude-code/index.ts'
import {
  claudeRecordReceipts,
  claudeRecordToItems,
} from '../../../packages/harness/src/adapters/claude-code/transcript.ts'
import { codexManifest } from '../../../packages/harness/src/adapters/codex/index.ts'
import { codexRecordToItems } from '../../../packages/harness/src/adapters/codex/transcript.ts'
import { grokManifest } from '../../../packages/harness/src/adapters/grok/index.ts'
import { grokRecordToItems } from '../../../packages/harness/src/adapters/grok/transcript.ts'
import type { TranscriptItem } from '../../../packages/model/src/index.ts'

const lanes = [
  ['claude-2.1.283', 'claude'],
  ['claude-2.1.286', 'claude'],
  ['claude-2.1.295', 'claude'],
  ['codex-0.162.0', 'codex'],
  ['grok-1.0.46', 'grok'],
] as const
const manifests = { claude: claudeCodeManifest, codex: codexManifest, grok: grokManifest }
for (const [label, program] of lanes) {
  const echo = manifests[program].runtime.terminal.acceptCorrelation!['transcript-echo']!
  const matches = (typed: string, item: TranscriptItem) =>
    echo.entryMatches
      ? echo.entryMatches(typed, item)
      : !!echo.textMatches?.(typed, echo.typedText(item))
  let previous: unknown
  const out: string[] = []
  for (const line of readFileSync(join(import.meta.dir, `${label}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)) {
    const row = JSON.parse(line)
    const items: TranscriptItem[] = []
    for (const { source, record } of row.records) {
      if (program === 'grok') {
        if (!source.endsWith('/updates.jsonl')) continue
        items.push(...grokRecordToItems(record, previous))
        previous = record
      } else if (program === 'codex') items.push(...codexRecordToItems(record))
      else items.push(...claudeRecordReceipts(record), ...claudeRecordToItems(record))
    }
    const entries = items.filter((item) => item.queued !== true && echo.accepts(item))
    const queued = items.filter((item) => item.queued === true)
    const first = entries[0]
    out.push(
      `| ${label} | ${row.case} | ${entries.length} | ${first && matches(row.typed, first) ? 'yes' : 'NO'} |` +
        ` ${queued.length ? (matches(row.typed, queued[0]!) ? 'yes' : 'NO') : '—'} |`,
    )
  }
  console.log(out.join('\n'))
}
