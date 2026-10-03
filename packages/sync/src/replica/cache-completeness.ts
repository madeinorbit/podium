import type { CacheMutation } from './ports'
import type { Cursor } from './types'

/** Private cursor metadata. Old snapshot installers replace it with a plain triple. */
export interface ScopedCacheCursor extends Cursor {
  readonly scopeFingerprint?: string
}

export interface PersonalRowsCompleteness extends ScopedCacheCursor {
  readonly scopeFingerprint: string
}

/** Keep adapter-private scope metadata out of the feed cursor port. */
export function cursorTriple(cursor: Cursor | null): Cursor | null {
  return cursor === null ? null : { feedId: cursor.feedId, epoch: cursor.epoch, seq: cursor.seq }
}

/** A cursor is a triple; equal seq alone cannot certify another feed or epoch. */
export function sameCursor(a: Cursor | null, b: Cursor | null): boolean {
  return a !== null && b !== null && a.feedId === b.feedId && a.epoch === b.epoch && a.seq === b.seq
}

/** Optional metadata is fail-open to unknown completeness, never a boot migration. */
export function decodePersonalRowsCompleteAt(value: unknown): PersonalRowsCompleteness | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Partial<PersonalRowsCompleteness>
  if (
    typeof row.feedId !== 'string' ||
    typeof row.epoch !== 'string' ||
    typeof row.seq !== 'number' ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 0 ||
    typeof row.scopeFingerprint !== 'string' ||
    row.scopeFingerprint === ''
  ) {
    return null
  }
  return {
    feedId: row.feedId,
    epoch: row.epoch,
    seq: row.seq,
    scopeFingerprint: row.scopeFingerprint,
  }
}

/** A surviving key from an older installer cannot certify its newly installed slice. */
export function trustedPersonalRowsCompleteAt(
  cursor: ScopedCacheCursor | null,
  marker: PersonalRowsCompleteness | null,
): PersonalRowsCompleteness | null {
  if (
    marker === null ||
    typeof marker.scopeFingerprint !== 'string' ||
    marker.scopeFingerprint === '' ||
    !sameCursor(cursor, marker) ||
    cursor?.scopeFingerprint !== marker.scopeFingerprint
  )
    return null
  return marker
}

/** Adapter-local scope token, not a feed identity or an authorization decision. */
function mintScopeFingerprint(): string {
  const bytes = new Uint8Array(16)
  const source = (
    globalThis as {
      crypto?: { getRandomValues?: (into: Uint8Array) => Uint8Array }
    }
  ).crypto
  if (typeof source?.getRandomValues === 'function') source.getRandomValues(bytes)
  else {
    // Private mode and older mobile engines must not acquire a new boot refusal.
    // Downgrade safety rests on the old cursor rewrite dropping the field, not entropy.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function certifyPersonalRowsCompleteAt(
  cursor: Cursor,
  scopeFingerprint = mintScopeFingerprint(),
): PersonalRowsCompleteness {
  return { feedId: cursor.feedId, epoch: cursor.epoch, seq: cursor.seq, scopeFingerprint }
}

/** Shared port law, evaluated BEFORE any adapter stages data. */
export function nextPersonalRowsCompleteAt(
  previous: Cursor | null,
  mutation: CacheMutation,
): Cursor | null {
  const marker = mutation.personalRowsCompleteAt
  if (marker !== undefined && marker !== null) {
    if (!sameCursor(marker, mutation.cursor ?? null)) {
      throw new Error('personal row completeness requires the same batch cursor')
    }
    return marker
  }
  if (marker === null || mutation.cursor !== undefined || mutation.operations.length > 0)
    return null
  return previous
}

/** Evaluate the port law and bind a new claim to the cursor row in the same draft. */
export function nextCacheCompleteness(
  cursor: ScopedCacheCursor | null,
  marker: PersonalRowsCompleteness | null,
  mutation: CacheMutation,
): { cursor: ScopedCacheCursor | null; marker: PersonalRowsCompleteness | null } {
  const previous = trustedPersonalRowsCompleteAt(cursor, marker)
  const completeAt = nextPersonalRowsCompleteAt(previous, mutation)
  let nextMarker: PersonalRowsCompleteness | null = null
  if (completeAt !== null) {
    nextMarker =
      mutation.personalRowsCompleteAt === undefined
        ? previous
        : certifyPersonalRowsCompleteAt(completeAt, previous?.scopeFingerprint)
  }
  return {
    cursor: mutation.cursor === undefined ? cursor : (nextMarker ?? cursorTriple(mutation.cursor)),
    marker: nextMarker,
  }
}
