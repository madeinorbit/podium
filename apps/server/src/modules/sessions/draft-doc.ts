/**
 * Versioned draft document — the conflict model for Draft Sync v2 (POD-859).
 *
 * One draft per session, editable from many replicas (chat views, mobile, and the
 * daemon-side native scraper). The server is the single sequencer: every accepted
 * edit gets a monotonic `rev`. Conflicts resolve last-writer-wins BY REV, and any
 * superseded non-empty text is preserved in a small `history` ring so a lost race
 * never destroys real typing.
 *
 * This module is PURE: it reads no clock and holds no state. The caller supplies
 * the edit's server-stamped time (`at`) and the current time for lease queries,
 * which keeps the arbitration deterministic and unit-testable.
 *
 * See docs/superpowers/specs/2026-07-17-draft-sync-v2-design.md §1, §3.
 */

/** ~1.5s soft edit lease (design §3). A replica that edited within this window of
 *  the doc's last edit is treated as the active editor. */
export const DEFAULT_LEASE_MS = 1500
/** How many superseded non-empty drafts the history ring keeps (design §1). */
export const DEFAULT_HISTORY_LIMIT = 5

export interface DraftDoc {
  sessionId: string
  /** The current composer text. Empty string = no draft. */
  text: string
  /** Server-assigned monotonic sequence per session. 0 = never edited (seed). */
  rev: number
  /** Who last wrote: a chat client id, `'native'` (daemon scrape), or `'seed'`. */
  origin: string
  /** ISO-8601 time of the last accepted edit; `''` for a never-edited doc. */
  editedAt: string
  /** Ring of superseded non-empty texts, oldest first, deduped, capped. */
  history: string[]
}

export interface DraftEdit {
  /** The rev the sender believed it was editing from. */
  baseRev: number
  text: string
  /** Server-resolved origin of this edit (client id / `'native'` / `'seed'`). */
  origin: string
  /** Server-stamped ISO-8601 time of this edit. */
  at: string
}

export type ApplyResult =
  /** Accepted. `changed` is false for a no-op (identical text) — skip broadcast. */
  | { status: 'applied'; doc: DraftDoc; changed: boolean }
  /** Stale baseRev from a non-lease-holder: the authoritative doc is returned
   *  unchanged so the sender can rebase. */
  | { status: 'rejected'; doc: DraftDoc }

/** A fresh, empty, never-edited draft. */
export function emptyDraftDoc(sessionId: string): DraftDoc {
  return { sessionId, text: '', rev: 0, origin: 'seed', editedAt: '', history: [] }
}

/**
 * The current soft-lease holder, or null if the lease has lapsed (or the doc was
 * never edited). Derived purely from the doc's last edit — no separate signal.
 */
export function leaseHolder(
  doc: DraftDoc,
  nowMs: number,
  leaseMs = DEFAULT_LEASE_MS,
): string | null {
  if (doc.rev === 0) return null
  const t = Date.parse(doc.editedAt)
  if (Number.isNaN(t)) return null
  return nowMs - t <= leaseMs ? doc.origin : null
}

function pushHistory(history: readonly string[], superseded: string, limit: number): string[] {
  if (!superseded) return [...history]
  const next = [...history.filter((h) => h !== superseded), superseded]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * Apply an edit to a draft doc under the LWW-by-rev + soft-lease model.
 *
 * - baseRev === rev (fresh): always accepted; any superseded non-empty text is
 *   pushed to history ("losers go to history").
 * - baseRev < rev (stale): accepted only if the sender still holds the soft lease
 *   (same origin, within the window) — this absorbs a replica's own coalescing
 *   lag. Otherwise rejected so the sender rebases onto the authoritative doc.
 * - Identical text is a no-op (changed=false); rev is not bumped.
 */
export function applyDraftEdit(
  doc: DraftDoc,
  edit: DraftEdit,
  opts: { leaseMs?: number; historyLimit?: number } = {},
): ApplyResult {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS
  const historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT

  if (edit.baseRev !== doc.rev) {
    const holder = leaseHolder(doc, Date.parse(edit.at), leaseMs)
    if (holder !== edit.origin) return { status: 'rejected', doc }
  }

  if (edit.text === doc.text) return { status: 'applied', doc, changed: false }

  const next: DraftDoc = {
    ...doc,
    text: edit.text,
    rev: doc.rev + 1,
    origin: edit.origin,
    editedAt: edit.at,
    history: pushHistory(doc.history, doc.text, historyLimit),
  }
  return { status: 'applied', doc: next, changed: true }
}
