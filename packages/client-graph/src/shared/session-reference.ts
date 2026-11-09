import { parseSessionRef } from '@podium/protocol'

type RefFields = {
  refRepoId?: unknown
  refSeq?: unknown
  refLetter?: unknown
  refDraft?: unknown
  displayRef?: unknown
}
export function sessionReferenceKey(row: RefFields): string | undefined {
  if (typeof row.refRepoId !== 'string')
    return typeof row.displayRef === 'string'
      ? directSessionReferenceKey(row.displayRef)
      : undefined
  if (typeof row.refSeq === 'number' && typeof row.refLetter === 'string' && row.refLetter)
    return JSON.stringify([row.refRepoId, row.refSeq, row.refLetter])
  if (typeof row.refDraft === 'number')
    return JSON.stringify([row.refRepoId, 'draft', row.refDraft])
  return undefined
}
export function referenceKey(repoId: string, ref: string): string | undefined {
  const parsed = parseSessionRef(ref)
  return (
    (parsed &&
      sessionReferenceKey({
        refRepoId: repoId,
        refSeq: parsed.seq,
        refLetter: parsed.letter,
        refDraft: parsed.draft,
      })) ||
    undefined
  )
}

/** Directly-fed records may declare their complete reference without join keys.
 * File that exact identity at ingestion, in the same index as normalized refs. */
export function directSessionReferenceKey(ref: string): string | undefined {
  const parsed = parseSessionRef(ref.trim())
  return parsed
    ? JSON.stringify([
        'displayRef',
        parsed.prefix,
        parsed.seq ?? 'draft',
        parsed.letter ?? parsed.draft,
      ])
    : undefined
}
