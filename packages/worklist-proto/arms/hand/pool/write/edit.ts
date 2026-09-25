/**
 * POD-4586 (Hc1) — optimistic edits on the hand-rolled pool's in-memory objects.
 *
 * Linear's shape (audit §7): an edit is applied to the in-memory object AT
 * ONCE, recorded in a pending log with the values it replaced, and sent
 * through the kernel, which stays the transport. The server broadcast is the
 * receipt (even for the originating client); a rejection rewinds from the old
 * values the transaction kept.
 *
 * WHAT THIS MODULE DOES (L1c W1–W6, Hc1 slice):
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
 * SCOPE. Hc1 is edit + pending log + rewind. Echo/settle (W7), overtake (W8
 * after receipt), supersede (W9), TTL expiry (W10) and bootstrap re-apply
 * (W11) are Hc2 (c2). `handleRemote` here only keeps the rewind target fresh;
 * it never settles. `handleAccepted` records the receipt on the log (so a
 * later Hc2 echo can settle) without repainting when nothing changed — Hc1
 * tests drive rejection only.
 */

import { asMutationId } from '@podium/model'
import {
  commandFor,
  type EditPatch,
  type FieldValues,
  type PendingLog,
  type Rejection,
  type TxId,
  type WritableKind,
  type WriteTransport,
  WriteContractError,
} from '../../../../shared/src/write-contract'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import { DepIndex } from '../cells'
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
  /** A receipt arrived: record it; Hc1 never settles without an echo (Hc2). */
  handleAccepted(txId: TxId): void
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
  const overlays = new Map<string, IssueOverlay>()
  const pendingReaders = new DepIndex<string>('write.pending')
  const listeners = new Set<
    (rejection: Rejection & { readonly kind: WritableKind; readonly id: string }) => void
  >()

  const refreshOverlay = (kind: WritableKind, id: string): boolean => {
    if (kind !== 'issue') return false
    const key = overlayKey(kind, id)
    const display = displayOf(log, kind, id)
    if (display === undefined) {
      if (!overlays.has(key)) return false
      overlays.delete(key)
      return true
    }
    const current = overlays.get(key)
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(display)) return false
    overlays.set(key, display)
    return true
  }

  const overlayOf = (id: string): IssueOverlay | undefined => {
    pool.graph.track(pendingReaders, overlayKey('issue', id))
    return overlays.get(overlayKey('issue', id))
  }

  /** The server row with the pending display overlaid (transient, never stored). */
  const withOverlay = (id: string, row: SliceIssue | undefined): SliceIssue | undefined => {
    if (row === undefined) return undefined
    const overlay = overlayOf(id)
    if (overlay === undefined) return row
    return { ...row, ...overlay }
  }

  // Overlay at the row-reader boundary. Each wrapper tracks its overlay entry
  // and delegates to the server reader it replaced. With no pending edit the
  // server object is returned unchanged, so identity-based commit counting
  // holds and an idle layer is invisible.
  const inputs = pool.inputs as { issue: (id: string) => SliceIssue | undefined }
  const originalIssue = inputs.issue.bind(pool.inputs)
  inputs.issue = (id: string) => withOverlay(id, originalIssue(id))

  const visible = pool.visibleInputs as {
    issueRow(id: string): SliceIssue | undefined
  }
  const originalIssueRow = visible.issueRow.bind(pool.visibleInputs)
  visible.issueRow = (id: string) => withOverlay(id, originalIssueRow(id))

  const commitFor = (kind: WritableKind, id: string): void => {
    pool.commitOverlay(() => {
      pool.graph.invalidateKey(pendingReaders, overlayKey(kind, id))
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
    const server = originalIssue(id) ?? originalIssueRow(id)
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
      commitFor(kind, id)
      // Fire-and-forget (W1.6): the paint does not wait for the queue.
      transport.send(txId, command)
      return txId
    },

    reject(rejection) {
      const outcome = log.reject(rejection) as { kind: WritableKind; id: string } | null
      if (outcome === null) return
      refreshOverlay(outcome.kind, outcome.id)
      commitFor(outcome.kind, outcome.id)
      const enriched = { ...rejection, kind: outcome.kind, id: outcome.id }
      for (const listener of [...listeners]) listener(enriched)
    },

    handleRemote(kind, id, values) {
      log.remote(kind, id, values)
      // Pending fields keep the local value (no overlay change); a settle
      // or overtake (Hc2) would change the display — refresh anyway so this
      // path never double-paints the tables' own update.
      if (refreshOverlay(kind, id)) commitFor(kind, id)
    },

    handleAccepted(txId) {
      const outcome = log.settle({ txId })
      if (outcome === null) return
      if (refreshOverlay(outcome.kind, outcome.id)) commitFor(outcome.kind, outcome.id)
    },

    onRejected(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    dispose() {
      inputs.issue = originalIssue
      visible.issueRow = originalIssueRow
      listeners.clear()
      overlays.clear()
      pendingReaders.clear()
    },
  }
  return api
}
