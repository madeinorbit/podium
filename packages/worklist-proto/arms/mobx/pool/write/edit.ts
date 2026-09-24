/**
 * POD-4573 (Mc1) — optimistic edits on the MobX pool's in-memory objects.
 *
 * Linear's shape (audit §7): an edit is applied to the in-memory object AT
 * ONCE, recorded in a pending log with the values it replaced, and sent
 * through the kernel, which stays the transport. The server broadcast is the
 * receipt (even for the originating client); a rejection rewinds from the old
 * values the transaction kept.
 *
 * WHAT THIS MODULE DOES (L1c W1–W6, Mc1 slice):
 * - `edit(kind, id, patch)` validates via `commandFor` (throws before any
 *   state changes), materialises a cold row first (W1.2), captures `prior`
 *   per patched field from the CURRENT display (which may be an older pending
 *   value, W1.3), mints `txId` (W2), then in ONE `runInAction` writes the
 *   patch onto the overlay and appends `{txId, prior}` to the pending log
 *   (W1.5), and fires `transport.send(txId, command)` without awaiting it
 *   (W1.6). A title rename commits one row.
 * - `reject(rejection)` (L3b) rewinds in ONE `runInAction` via the log (W5):
 *   the field falls back to the next-older pending value or the last server
 *   value the log saw, then fires `onRejected` listeners. A MobX arm mutates
 *   in place, so it omits `priorIdentity` and there is no identity restore
 *   (W6).
 * - Feed rows arriving while an edit is pending are fed to `log.remote`
 *   (W8): pending fields keep the local value while the server value becomes
 *   the rewind target (W5). Non-pending fields are already in the tables via
 *   `pool.apply`; the log's passthrough for them is ignored so the same patch
 *   is never applied twice (W12: the feed must carry server truth, `truth`
 *   mode; with the ledger overlay in the feed a remote on a pending field
 *   would be invisible and a rejection would rewind twice).
 *
 * WHERE OPTIMISM LIVES. The pool's tables hold the BORROWED server rows,
 * never a copy (the reads fence refuses a copy on first read and the copy
 * sweep fails on one held outside the wrapped tables). So this layer does NOT
 * write new row objects into the tables. It holds the pending display per row
 * in an observable map (`overlays`: the newest pending value per editable
 * field, mirrored from the log) and overlays it at the row-reader boundary:
 * `pool.inputs.issue`, `pool.visibleInputs.issueRow` / `progressFacts` /
 * `loadedIssue`. Each wrapper reads its overlay entry (tracked) and returns
 * the server row unchanged when there is none (identity-preserving, so an
 * idle layer adds no commit) or a transient `{...server, ...pending}` when
 * there is one (never stored, so the sweep never sees it; the derivation
 * subscribes to the overlay entry and the server slot, never the transient).
 * Title, stage and readAt are the only fields ever overlaid, and the overlay
 * value holds at most those three — never a full row copy.
 *
 * SCOPE. Mc1 is edit + pending log + rewind. Echo/settle (W7), overtake (W8
 * after receipt), supersede (W9), TTL expiry (W10) and bootstrap re-apply
 * (W11) are Mc2 (c2). `handleRemote` here only keeps the rewind target fresh;
 * it never settles. `handleReceipt` answers `accepted` by recording the
 * receipt on the log (so a later Mc2 echo can settle) without repainting when
 * nothing changed — Mc1 tests drive rejection only.
 */

import { asMutationId } from '@podium/model'
import { observable, runInAction } from 'mobx'
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
import type { MobxPool } from '../pool'
import { createPendingLog } from './pending'

/** The editable fields of an issue row, as the overlay holds them. */
type IssueOverlay = { title?: string; stage?: string; readAt?: string | null }

const OVERLAY_FIELDS: readonly (keyof IssueOverlay)[] = ['title', 'stage', 'readAt']

function overlayKey(kind: WritableKind, id: string): string {
  return `${kind}:${id}`
}

function isIssueOverlay(value: unknown): value is IssueOverlay {
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

export interface MobxWriteApi {
  /** L1c W1: apply the patch at once, remember it, send the command. */
  edit<K extends WritableKind>(kind: K, id: string, patch: EditPatch<K>): TxId
  /** L3b rejection: rewind to the log's target, then surface the error. */
  reject(rejection: Rejection): void
  /** A server row arrived: keep local on pending fields, track truth (W5/W8). */
  handleRemote<K extends WritableKind>(kind: K, id: string, values: FieldValues<K>): void
  /** A receipt arrived: record it; Mc1 never settles without an echo (Mc2). */
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

export function createMobxWriteApi(
  pool: MobxPool,
  transport: WriteTransport,
  opts: { log?: PendingLog } = {},
): MobxWriteApi {
  const log = opts.log ?? createPendingLog()
  const overlays = observable.map<string, IssueOverlay>(undefined, {
    deep: false,
    name: 'write.overlays',
  })
  const listeners = new Set<
    (rejection: Rejection & { readonly kind: WritableKind; readonly id: string }) => void
  >()

  const refreshOverlay = (kind: WritableKind, id: string): void => {
    if (kind !== 'issue') return
    const key = overlayKey(kind, id)
    const display = displayOf(log, kind, id)
    if (display === undefined) {
      if (overlays.has(key)) overlays.delete(key)
      return
    }
    // Skip an equal write (W4): a remote on a pending field recomputes the
    // same display, which must not notify (no commit) — structural equality
    // downstream would stop it anyway, but skipping avoids the derivation.
    const current = overlays.get(key)
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(display)) return
    overlays.set(key, display)
  }

  const overlayOf = (id: string): IssueOverlay | undefined => overlays.get(overlayKey('issue', id))

  /** The server row with the pending display overlaid (transient, never stored). */
  const withOverlay = (id: string, row: SliceIssue | undefined): SliceIssue | undefined => {
    if (row === undefined) return undefined
    const overlay = overlayOf(id)
    if (overlay === undefined) return row
    return { ...row, ...overlay }
  }

  // Overlay at the row-reader boundary. Each wrapper reads its overlay entry
  // (tracked) and delegates to the server reader it replaced. With no pending
  // edit the server object is returned unchanged, so identity-based commit
  // counting holds and an idle layer is invisible.
  const inputs = pool.inputs as { issue: (id: string) => SliceIssue | undefined }
  const originalIssue = inputs.issue.bind(pool.inputs)
  inputs.issue = (id: string) => withOverlay(id, originalIssue(id))

  const visible = pool.visibleInputs as {
    issueRow(id: string): SliceIssue | undefined
    progressFacts(id: string): { stage: string; closedReason?: string | null } | undefined
    loadedIssue(id: string): SliceIssue | symbol | undefined
  }
  const originalIssueRow = visible.issueRow.bind(pool.visibleInputs)
  visible.issueRow = (id: string) => withOverlay(id, originalIssueRow(id))

  const originalProgressFacts = visible.progressFacts.bind(pool.visibleInputs)
  visible.progressFacts = (id: string) => {
    const facts = originalProgressFacts(id)
    if (facts === undefined) return undefined
    const overlay = overlayOf(id)
    if (overlay === undefined) return facts
    const next: Record<string, unknown> = { ...facts }
    if (overlay.stage !== undefined) next['stage'] = overlay.stage
    return next as { stage: string; closedReason?: string | null }
  }

  const originalLoadedIssue = visible.loadedIssue.bind(pool.visibleInputs)
  visible.loadedIssue = (id: string) => {
    const loaded = originalLoadedIssue(id)
    if (!isIssueOverlay(loaded) || typeof loaded === 'symbol') return loaded
    return withOverlay(id, loaded as SliceIssue)
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
    if (server === undefined) throw new WriteContractError(`unknown issue ${id}`)
    return server
  }

  /** The CURRENT display for the patched fields (older pending or server, W1.3). */
  const currentDisplay = (id: string, server: SliceIssue): SliceIssue => withOverlay(id, server) ?? server

  const api: MobxWriteApi = {
    log,

    edit(kind, id, patch) {
      // Validates before any state changes (W1.1); reads no pool state.
      const command = commandFor(kind, id, patch)
      const txId = asMutationId(crypto.randomUUID())
      // One action (W1.5): materialise, capture prior from the current
      // display (older pending or server, W1.3), append, and paint. Reading
      // the borrowed rows here matches the pool's own ingest, which reads its
      // fenced tables inside its action.
      runInAction(() => {
        const server = ensureResident(kind, id)
        const shown = currentDisplay(id, server)
        const prior: Record<string, unknown> = {}
        for (const field of Object.keys(patch as Record<string, unknown>)) {
          prior[field] = (shown as unknown as Record<string, unknown>)[field] ?? null
        }
        log.append({ txId, kind, id, patch, prior } as never, undefined)
        refreshOverlay(kind, id)
      })
      // Fire-and-forget (W1.6): the paint does not wait for the queue.
      transport.send(txId, command)
      return txId
    },

    reject(rejection) {
      let outcome: { kind: WritableKind; id: string } | null = null
      runInAction(() => {
        outcome = log.reject(rejection) as { kind: WritableKind; id: string } | null
        if (outcome !== null) refreshOverlay(outcome.kind, outcome.id)
      })
      if (outcome === null) return
      const row = outcome as { kind: WritableKind; id: string }
      const enriched = { ...rejection, kind: row.kind, id: row.id }
      for (const listener of [...listeners]) listener(enriched)
    },

    handleRemote(kind, id, values) {
      runInAction(() => {
        log.remote(kind, id, values)
        // Pending fields keep the local value (no overlay change); a settle
        // or overtake (Mc2) would change the display — refresh anyway so this
        // path never double-paints the tables' own update.
        refreshOverlay(kind, id)
      })
    },

    handleAccepted(txId) {
      runInAction(() => {
        const outcome = log.settle({ txId })
        if (outcome === null) return
        refreshOverlay(outcome.kind, outcome.id)
      })
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
      visible.progressFacts = originalProgressFacts
      visible.loadedIssue = originalLoadedIssue
      listeners.clear()
    },
  }
  return api
}
