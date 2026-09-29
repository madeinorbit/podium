import type { TranscriptItem } from '@podium/model'
import { claudeRecordToItems } from '../../../adapters/claude-code/transcript.js'

/** Receipt proof is the session file, never its stdout replay or lifecycle. */
export function claudeTranscriptReceipts(
  bytes: Uint8Array,
  sessionId: string,
  wanted: ReadonlySet<string>,
): Map<string, TranscriptItem> {
  const found = new Map<string, TranscriptItem>()
  const lines = new TextDecoder().decode(bytes).split('\n')
  // Claude appends JSONL. A partially written last line is not a record yet.
  lines.pop()
  for (const line of lines) {
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) continue
      record = parsed as Record<string, unknown>
    } catch {
      continue
    }
    if (record.isReplay === true || record.isSidechain === true) continue
    if (record.sessionId !== undefined && record.sessionId !== sessionId) continue
    if (typeof record.uuid !== 'string' || !record.uuid) continue
    const attachment = record.attachment as Record<string, unknown> | undefined
    const sourceUuid = record.type === 'user'
      ? record.uuid
      : record.type === 'attachment' && attachment?.type === 'queued_command'
        ? attachment.source_uuid
        : undefined
    if (typeof sourceUuid !== 'string' || !wanted.has(sourceUuid) || found.has(sourceUuid)) continue
    const item = claudeRecordToItems(record).find((entry) => entry.role === 'user')
    if (item) found.set(sourceUuid, item)
  }
  return found
}
