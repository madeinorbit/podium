/**
 * POD-4586 (Hc1) + POD-4587 (Hc2) — optimistic edits on the hand-rolled
 * pool's in-memory objects.
 *
 * Linear's shape (audit §7): an edit is applied to the in-memory object AT
 * ONCE, recorded in a pending log with the values it replaced, and sent
 * through the kernel, which stays the transport. The server broadcast is the
 * receipt (even for the originating client); a rejection rewinds from the old
 * values the transaction kept.
 *
 * WHAT THIS MODULE DOES (L1c W1–W6, Hc1 slice; W7–W11, Hc2 slice):
 * - `edit(kind, id, patch)` validates via `commandFor` (throws before any
 *   state changes), materialises a cold row first (W1.2), captures `prior`
 *   per patched field from the CURRENT display (which may be an older pending
 *   value, W1.3) and `priorIdentity` (the server row object, W6), mints `txId`
 *   (W2), appends `{txId, prior, priorIdentity}` to the pending log and paints
 *   in ONE pool commit (`pool.commitOverlay`, W1.5), and fires
 *   `transport.send(txId, command)` without awaiting it (W1.6). A title rename
 *   commits one row.
 * - `reject(rejection)` (L3b) rewinds in ONE pool commit via the log (W5):
 *   the field falls back to the next-older pending value or the last server
 *   value the log saw, then fires `onRejected` listeners. The tables never
 *   held a copy, so the server row object is already the pre-edit one: the
 *   log's `restoreIdentity` is that same object, and no reinstatement writes.
 * - Feed rows arriving while an edit is pending are fed to `log.remote`
 *   (W8): pending fields keep the local value while the server value becomes
 *   the rewind target (W5). Non-pending fields are already in the tables via
 *   `pool.apply`, so the log's passthrough for them is ignored and no patch
 *   is ever applied twice (W12: the feed must carry server truth, `truth`
 *   mode; with the ledger overlay in the feed a remote on a pending field
 *   would be invisible and a rejection would rewind twice).
 * - `handleAccepted(txId)` records the receipt (W7). The entry leaves the log
 *   only when every field is confirmed by its echo or overtaken (W8): the
 *   receipt alone repaints nothing, and the echo that carries the pending
 *   value repaints nothing either (values equal, PITFALL). A second receipt
 *   for the same txId is a no-op (`log.settle` returns null).
 * - `handleSuperseded(txId)` removes a collapsed mark-read without repaint
 *   (W9: its successor carries the value).
 * - `expire()` drops receipted edits whose echo never arrived after the TTL
 *   (W10); unreceipted edits never expire.
 * - `bootstrap()` re-applies the kernel outbox's pending entries on creation
 *   (W11): queued then awaiting-truth, in queue order, painted under their own
 *   mutation ids without re-sending, receipted ones settled at once, then each
 *   affected row's current server values passed through `log.remote` so an
 *   echo that landed before the reload settles there.
 *
 * WHERE OPTIMISM LIVES. The pool's tables hold the BORROWED server rows,
 * never a copy and never edited (the reads fence refuses a copy on first read
 * and borrowed proxies refuse `set`). So this layer does NOT write new row
 * objects into the tables. It holds the pending display per row in a plain
 * map (`overlays`: the newest pending value per editable field, mirrored from
 * the log) and overlays it at the row-reader boundary: `pool.inputs.issue`
 * and `pool.visibleInputs.issueRow` (every part — row views, standing,
 * roll-up facts, placements — reads through one of those two doors). Each
 * wrapper tracks its overlay entry in a `DepIndex`, so a pending change
 * dirties exactly the cells that read that row, whatever they derived. With
 * no pending edit the server object is returned unchanged
 * (identity-preserving, idle layer invisible); with one a transient
 * `{...server, ...pending}` is returned (never stored, so the sweep never
 * sees it). The overlay holds at most title/stage/readAt — never a full row
 * copy.
 *
 * SCOPE. Hc1 was edit + pending log + rewind. Hc2 adds echo/settle (W7),
 * overtake after receipt (W8), supersede (W9), TTL expiry (W10), bootstrap
 * re-apply (W11), and the optimism-aware rebuild (`pendingDisplay`, used by
 * `arm.ts` to overlay pending onto the feed snapshot before deriving).
 */

import { asMutationId } from '@podium/model'
import type { RowSource } from '../../../../shared/src/arm'
import {
  commandFor,
  editForPendingWrite,
  type EditPatch,
  type FieldValues,
  type PendingLog,
  type Rejection,
  type TxId,
  type WritableKind,
  type WriteTransport,
  WriteContractError,
} from '@podium/client-graph/shared/write-contract'
import type { SliceIssue } from '@podium/client-graph/shared/slice-types'
import type { HandPool } from '../pool'
import { createPendingLog } from './pending'

/** The editable fields of an issue row, as the overlay holds them. */
type IssueOverlay = { title?: string; stage?: string; readAt?: string | null }

const OVERLAY_FIELDS: readonly (keyof IssueOverlay)[] = ['title', 'stage', 'readAt']

function overlayKey(kind: WritableKind, id: string): string {
  return `${kind}:${id}`
}

function isIssueRow(value: unknown): value is SliceIssue {
  return typeof value === 'object' && value !== null
}

/** The newest pending value per field for (kind, id), oldest edit first. */
function displayOf(log: PendingLog, kind: WritableKind, id: string): IssueOverlay | undefined {
  if (kind !== 'issue') return undefined
  const out: IssueOverlay = {}
  let found = false
  for (const edit of log.pendingFor(kind, id)) {
    const patch = edit.patch as IssueOverlay
    for (const field of OVERLAY_FIELDS) {
      const value = patch[field]
      if (value !== undefined) {
        ;(out as Record<string, unknown>)[field] = value
        found = true
      }
    }
  }
  return found ? out : undefined
}

export interface HandWriteApi {
  /** L1c W1: apply the patch at once, remember it, send the command. */
  edit<K extends WritableKind>(kind: K, id: string, patch: EditPatch<K>): TxId
  /** L3b rejection: rewind to the log's target, then surface the error. */
  reject(rejection: Rejection): void
  /** A server row arrived: keep local on pending fields, track truth (W5/W8). */
  handleRemote<K extends WritableKind>(kind: K, id: string, values: FieldValues<K>): void
  /**
   * A receipt arrived (W7): record it. The entry leaves only when every field
   * is confirmed by its echo or overtaken (W8) — the receipt alone repaints
   * nothing. Unknown or already-settled txIds are no-ops.
   */
  handleAccepted(txId: TxId): void
  /** The outbox collapsed a still-queued mark-read (W9): no repaint. */
  handleSuperseded(txId: TxId): void
  /**
   * Drop receipted edits whose echo never arrived after the TTL (W10) and
   * repaint their rows to server truth. Unreceipted edits never expire.
   * No timer drives this yet: expiry is covered at the log level (L1c) and
   * stays out of the gate, whose oracle holds entries the same way.
   */
  expire(): void
  /**
   * Re-apply the kernel outbox's pending entries on creation (W11): queued
   * then awaiting-truth, in queue order, painted under their own mutation ids
   * without re-sending; receipted ones settled at once; then each affected
   * row's current server values passed through `log.remote` so a pre-reload
   * echo settles there. Server rows come from the FEED source, not the pool
   * tables, so reload priors and ackBases agree exactly with what the
   * optimism-aware rebuild derives from. Cold rows are materialised first
   * (W1.2 parity: the pre-reload edit made them resident, so the pre-reload
   * live showed them). Unknown rows and non-slice entries are skipped.
   * Idempotent: re-running it settles nothing new.
   */
  bootstrap(source: RowSource): { applied: number; skipped: number }
  /**
   * The pending display for (kind, id): the newest pending value per editable
   * field, or undefined when nothing is pending. The optimism-aware rebuild
   * overlays it onto the feed's server rows before deriving.
   */
  pendingDisplay<K extends WritableKind>(kind: K, id: string): FieldValues<K> | undefined
  /** Surfaces each rejection AFTER its rewind (W5). */
  onRejected(
    listener: (rejection: Rejection & { readonly kind: WritableKind; readonly id: string }) => void,
  ): () => void
  /** The pending log (tests: size, pendingFor). */
  readonly log: PendingLog
  /** Detach the row-reader overlays (tests). */
  dispose(): void
}

export function createHandWriteApi(
  pool: HandPool,
  transport: WriteTransport,
  opts: { log?: PendingLog } = {},
): HandWriteApi {
  const log = opts.log ?? createPendingLog()
  const listeners = new Set<
    (rejection: Rejection & { readonly kind: WritableKind; readonly id: string }) => void
  >()

  const refreshOverlay = (kind: WritableKind, id: string): boolean => {
    if (kind !== 'issue') return false
    const display = displayOf(log, kind, id)
    const current = pool.pending(kind, id) as IssueOverlay | undefined
    if (display === undefined) {
      if (current === undefined) return false
      pool.setPendingOverlay(kind, id, undefined)
      return true
    }
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(display)) return false
    pool.setPendingOverlay(kind, id, display)
    return true
  }

  /**
   * POD-4706 — keep the pool's replace pin in line with the pending log: a
   * row with a pending edit stays resident across a `replace`, so its
   * pending display never loses its server row.
   */
  const repin = (kind: WritableKind, id: string): void => {
    if (kind !== 'issue') return
    if (log.pendingFor(kind, id).length === 0) pool.writePins.delete(id)
    else pool.writePins.add(id)
  }

  /** The server row with the pending display overlaid (transient, never stored). */
  const withOverlay = (id: string, row: SliceIssue | undefined): SliceIssue | undefined => {
    if (row === undefined) return undefined
    const overlay = pool.pending('issue', id) as IssueOverlay | undefined
    if (overlay === undefined) return row
    return { ...row, ...overlay }
  }

  // Pending edits fold in inside the one reader (`HandPool.row`, POD-4743):
  // no reader is wrapped here. With no pending edit the server object is
  // returned unchanged, so identity-based commit counting holds and an idle
  // layer is invisible.

  const commitFor = (kind: WritableKind, id: string): void => {
    // POD-4707: the pending display moves rows only derivations read. File
    // and admit the touched row's closure first (idempotent): a row without
    // filing or member cells would never follow its pending verdict.
    if (kind === 'issue') pool.ensureIssues([id])
    pool.commitOverlay(() => {
      pool.graph.invalidateKey(pool.pendingReaders, overlayKey(kind, id))
      // The row's table readers too: cells created before the layer attached
      // tracked the table slot, never the overlay key, so an overlay-only
      // commit would wake nothing (a pending edit could never flip
      // visibility). Re-running them re-subscribes them going forward; row
      // isolation holds — one row's readers, like a row delta.
      pool.graph.invalidateKey(pool.rowReaders[kind], id)
    })
  }

  /** Make a cold issue resident before editing it (W1.2), else throw. */
  const ensureResident = (kind: WritableKind, id: string): SliceIssue => {
    if (kind !== 'issue') throw new WriteContractError(`no editable fields on ${String(kind)}`)
    const residency = pool.residency
    if (residency !== null && !pool.tables.issue.has(id)) {
      if (residency.isCold('issue', id)) {
        residency.request('issue', id)
        pool.hydrate()
      }
    }
    const server = pool.tables.issue.get(id) as SliceIssue | undefined
    if (server === undefined || !isIssueRow(server)) {
      throw new WriteContractError(`unknown issue ${id}`)
    }
    return server
  }

  /** The CURRENT display for the patched fields (older pending or server, W1.3). */
  const currentDisplay = (id: string, server: SliceIssue): SliceIssue => withOverlay(id, server) ?? server

  const api: HandWriteApi = {
    log,

    edit(kind, id, patch) {
      // Validates before any state changes (W1.1); reads no pool state.
      const command = commandFor(kind, id, patch)
      const txId = asMutationId(crypto.randomUUID())
      // Materialise, capture prior from the current display (older pending or
      // server, W1.3) with the server row as priorIdentity (W6), append, and
      // paint in ONE pool commit (W1.5). Reading the borrowed rows here
      // matches the pool's own ingest, which reads its fenced tables.
      const server = ensureResident(kind, id)
      const shown = currentDisplay(id, server)
      const prior: Record<string, unknown> = {}
      for (const field of Object.keys(patch as Record<string, unknown>)) {
        prior[field] = (shown as unknown as Record<string, unknown>)[field] ?? null
      }
      log.append({ txId, kind, id, patch, prior, priorIdentity: server } as never, undefined)
      refreshOverlay(kind, id)
      repin(kind, id)
      commitFor(kind, id)
      // Fire-and-forget (W1.6): the paint does not wait for the queue.
      transport.send(txId, command)
      return txId
    },

    reject(rejection) {
      const outcome = log.reject(rejection) as { kind: WritableKind; id: string } | null
      if (outcome === null) return
      refreshOverlay(outcome.kind, outcome.id)
      repin(outcome.kind, outcome.id)
      commitFor(outcome.kind, outcome.id)
      const enriched = { ...rejection, kind: outcome.kind, id: outcome.id }
      for (const listener of [...listeners]) listener(enriched)
    },

    handleRemote(kind, id, values) {
      log.remote(kind, id, values)
      repin(kind, id)
      // Pending fields keep the local value (no overlay change); a settle
      // or overtake would change the display — refresh anyway so this path
      // never double-paints the tables' own update.
      if (refreshOverlay(kind, id)) commitFor(kind, id)
    },

    handleAccepted(txId) {
      const outcome = log.settle({ txId })
      if (outcome === null) return
      repin(outcome.kind, outcome.id)
      // The receipt alone confirms nothing: the entry stays until its echo
      // (or an overtake) resolves every field, so this refresh is a no-op
      // unless the echo already arrived (echo-before-receipt). A second
      // receipt returns null above: no repaint, ever.
      if (refreshOverlay(outcome.kind, outcome.id)) commitFor(outcome.kind, outcome.id)
    },

    handleSuperseded(txId) {
      const outcome = log.supersede({ txId })
      if (outcome === null) return
      repin(outcome.kind, outcome.id)
      // No repaint: the successor is newer and carries the value (W9). The
      // refresh only drops tracking that ended.
      if (refreshOverlay(outcome.kind, outcome.id)) commitFor(outcome.kind, outcome.id)
    },

    expire() {
      for (const outcome of log.expire()) {
        repin(outcome.kind, outcome.id)
        if (refreshOverlay(outcome.kind, outcome.id)) commitFor(outcome.kind, outcome.id)
      }
    },

    bootstrap(source: RowSource) {
      const entries = transport.pending()
      const feedRows = new Map<string, SliceIssue>()
      for (const record of source.snapshot('issue')) {
        if (record.value !== undefined) feedRows.set(record.id, record.value as SliceIssue)
      }
      let applied = 0
      let skipped = 0
      const touched: { kind: WritableKind; id: string }[] = []
      for (const entry of entries) {
        const mapped = editForPendingWrite(entry)
        if (mapped === null || mapped.kind !== 'issue') {
          skipped += 1
          continue
        }
        const server = feedRows.get(mapped.id)
        if (server === undefined) {
          skipped += 1
          continue
        }
        // W11 parity with W1.2: the pre-reload edit materialised this row, so
        // the pre-reload live showed it. Re-materialise cold rows here, or the
        // live pool hides a row the optimism-aware rebuild (feed rows plus the
        // re-applied pending display) shows — a live-vs-rebuild divergence on
        // the first step after every reload with a pending cold-row edit.
        try {
          ensureResident(mapped.kind, mapped.id)
        } catch {
          skipped += 1
          continue
        }
        const shown = currentDisplay(mapped.id, server)
        const prior: Record<string, unknown> = {}
        for (const field of Object.keys(mapped.patch as Record<string, unknown>)) {
          prior[field] = (shown as unknown as Record<string, unknown>)[field] ?? null
        }
        try {
          log.append(
            {
              txId: entry.txId,
              kind: mapped.kind,
              id: mapped.id,
              patch: mapped.patch,
              prior,
              priorIdentity: server,
            } as never,
            entry.base ? { base: entry.base } : undefined,
          )
        } catch {
          // A reused txId (bootstrap twice): the entry is already pending.
          skipped += 1
          continue
        }
        if (entry.acked) {
          const outcome = log.settle({ txId: entry.txId })
          if (outcome !== null) refreshOverlay(outcome.kind, outcome.id)
        }
        if (refreshOverlay(mapped.kind, mapped.id)) commitFor(mapped.kind, mapped.id)
        touched.push({ kind: mapped.kind, id: mapped.id })
        applied += 1
      }
      // An echo that landed before the reload settles its receipted edit
      // here: the server row is already the echo.
      const seen = new Set<string>()
      for (const { kind, id } of touched) {
        const key = overlayKey(kind, id)
        if (seen.has(key)) continue
        seen.add(key)
        if (log.pendingFor(kind, id).length === 0) continue
        const server = feedRows.get(id)
        if (server === undefined) continue
        log.remote(kind, id, {
          title: (server as SliceIssue).title,
          stage: (server as SliceIssue).stage,
          readAt: ((server as SliceIssue).readAt ?? null) as never,
        } as never)
        if (refreshOverlay(kind, id)) commitFor(kind, id)
      }
      // The arm never re-sends: the kernel replays its own queue under the
      // same mutation ids, and receipts arrive under the same txIds.
      for (const { kind, id } of touched) repin(kind, id)
      return { applied, skipped }
    },

    pendingDisplay(kind, id) {
      const display = displayOf(log, kind, id)
      return display === undefined ? undefined : ({ ...display } as FieldValues<typeof kind>)
    },

    onRejected(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      listeners.clear()
      for (const id of [...pool.writePins]) pool.setPendingOverlay('issue', id, undefined)
      pool.pendingReaders.clear()
      pool.writePins.clear()
    },
  }
  return api
}
