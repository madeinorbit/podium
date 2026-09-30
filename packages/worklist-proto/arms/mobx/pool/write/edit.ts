/**
 * POD-4573 (Mc1) + POD-4574 (Mc2) — optimistic edits on the MobX pool's
 * in-memory objects.
 *
 * Linear's shape (audit §7): an edit is applied to the in-memory object AT
 * ONCE, recorded in a pending log with the values it replaced, and sent
 * through the kernel, which stays the transport. The server broadcast is the
 * receipt (even for the originating client); a rejection rewinds from the old
 * values the transaction kept.
 *
 * WHAT THIS MODULE DOES (L1c W1–W6, Mc1 slice; W7–W11, Mc2 slice):
 * - `edit(kind, id, patch)` validates via `commandFor` (throws before any
 *   state changes), refuses a row that is not in memory (W1.2, below),
 *   captures `prior` per patched field from the CURRENT display (which may be
 *   an older pending value, W1.3), mints `txId` (W2), then in ONE `runInAction` writes the
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
 * - `handleAccepted(txId)` records the receipt (W7). The entry leaves the log
 *   only when every field is confirmed by its echo or overtaken (W8): the
 *   receipt alone repaints nothing, and the echo that carries the pending
 *   value repaints nothing either (values equal, PITFALL). A second receipt
 *   for the same txId is a no-op (S4: `log.settle` returns null).
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
 * never a copy (the reads fence refuses a copy on first read and the copy
 * sweep fails on one held outside the wrapped tables). So this layer does NOT
 * write new row objects into the tables. It holds the pending display per row
 * in the overlay (`PendingOverlay`, `overlay.ts`: the newest pending value
 * per editable field, mirrored from the log), which the pool was constructed
 * with (POD-4743). The pool's one reader (`MobxPool.row`) lays it over every
 * row it serves: the server row unchanged when nothing is pending
 * (identity-preserving, so an idle layer adds no commit), else a transient
 * `{...server, ...pending}` (never stored, so the sweep never sees it; a
 * reader subscribes to the overlay entry and the server slot, never the
 * transient). Models, row views, visibility nodes, roll-ups and this
 * module's own prior capture all read there, so they agree at every
 * moment; nothing is patched at runtime. Title, stage and readAt are the only
 * fields ever overlaid, and the overlay value holds at most those three —
 * never a full row copy. The read cursor's pending value reaches the
 * visibility parts through `MobxPool.readCursor`.
 *
 * A ROW NOT IN MEMORY IS NOT EDITED (POD-4753). The pool's one reader
 * answers `LOADING` for a cold row and queues its load for the next window;
 * `edit` asks the same way and refuses with a `WriteContractError` while it
 * loads, so nothing blocks and nothing is read by id. Every edit surface
 * draws the row first, and a row not in memory draws as a loading
 * placeholder with no model to edit (`pool.issue(id)` is undefined), so the
 * UI never offers the edit; once the row lands the same edit applies as it
 * would have. Queueing it instead would paint on nothing and leave the log
 * without its prior (the server value, W4) while a receipt, rejection or echo
 * could already arrive.
 *
 * SCOPE. Mc1 was edit + pending log + rewind. Mc2 adds echo/settle (W7),
 * overtake after receipt (W8), supersede (W9), TTL expiry (W10), bootstrap
 * re-apply (W11), and the optimism-aware rebuild (`pendingDisplay`, used by
 * `arm.ts` to overlay pending onto the feed snapshot before deriving).
 */

import { asMutationId } from '@podium/model'
import { compareStructural, runInAction } from 'mobx'
import type { RowSource } from '../../../../shared/src/arm'
import {
  commandFor,
  ECHO_TTL_MS,
  editForPendingWrite,
  type EditPatch,
  type FieldValues,
  type PendingLog,
  type Rejection,
  type TxId,
  wallClockNow,
  type WritableKind,
  type WriteTransport,
  WriteContractError,
} from '../../../../shared/src/write-contract'
import type { SliceIssue } from '../../../../shared/src/slice-types'
import type { MobxPool } from '../pool'
import type { Schedule } from '../residency'
import { LOADING } from '../worklist/rollup'
import type { IssueOverlay, PendingOverlay } from './overlay'
import { createPendingLog } from './pending'

const OVERLAY_FIELDS: readonly (keyof IssueOverlay)[] = ['title', 'stage', 'readAt']

const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
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
  /**
   * A receipt arrived (W7): record it. The entry leaves only when every field
   * is confirmed by its echo or overtaken (W8) — the receipt alone repaints
   * nothing. Unknown or already-settled txIds are no-ops (S4).
   */
  handleAccepted(txId: TxId): void
  /** The outbox collapsed a still-queued mark-read (W9): no repaint. */
  handleSuperseded(txId: TxId): void
  /**
   * Drop receipted edits whose echo never arrived after the TTL (W10) and
   * repaint their rows to server truth. Unreceipted edits never expire. The
   * api owns a timer for this: while at least one receipted edit is pending
   * it is armed for the earliest receipt time + the TTL, and firing only
   * calls `expire()` (which re-arms while receipted edits remain).
   */
  expire(): void
  /**
   * Re-apply the kernel outbox's pending entries on creation (W11): queued
   * then awaiting-truth, in queue order, painted under their own mutation ids
   * without re-sending, receipted ones settled at once, then each affected
   * row's current server values passed through `log.remote` so an echo that
   * landed before the reload settles there. Server rows come from the FEED
   * source — the same rows the reference oracle's reload rebuild reads — so
   * priors, ack bases and synthesis values agree exactly however the pool
   * tables lag the feed at creation. Unknown rows and non-slice entries are
   * skipped. Idempotent: re-running it settles nothing new.
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
  /** Drop every pending display (the pool shows server truth) and the listeners. */
  dispose(): void
}

/**
 * The write api over `pool`, mirroring its log into `overlay`: the seam the
 * pool was constructed with (`new MobxPool(..., overlay)`), refused otherwise,
 * since an overlay the pool does not read would paint nothing.
 *
 * `schedule`/`now` drive the W10 expiry timer (the pool residency `Schedule`
 * shape); the default log is built with the same `now`, so the timer's
 * receipt times agree with the log's TTL clock.
 */
export function createMobxWriteApi(
  pool: MobxPool,
  overlay: PendingOverlay,
  transport: WriteTransport,
  opts: { log?: PendingLog; schedule?: Schedule; now?: () => number } = {},
): MobxWriteApi {
  if (pool.writes !== overlay) {
    throw new WriteContractError('the pool was not constructed with this write overlay')
  }
  // W10 is a wall-clock liveness bound (the kernel's AWAITING_TRUTH_TTL_MS and
  // the reference log's default clock are wall-clock too): it fires a timer,
  // never a displayed value, so no derivation reads it.
  const now = opts.now ?? wallClockNow
  const log = opts.log ?? createPendingLog({ now })
  const schedule: Schedule = opts.schedule ?? realSchedule
  const listeners = new Set<
    (rejection: Rejection & { readonly kind: WritableKind; readonly id: string }) => void
  >()

  /**
   * W10: receipt times of the entries still in the log. The log holds `ackedAt`
   * internally but never exposes it, so the api records what it settled: a
   * txId enters here when its receipt arrives while the entry stays pending,
   * and leaves with every txId a log call reports in `left`.
   */
  const receiptedAt = new Map<TxId, number>()
  let cancelTimer: (() => void) | null = null
  /** Arm for the earliest receipt + the TTL; clear when nothing receipted remains. */
  const rearm = (): void => {
    cancelTimer?.()
    cancelTimer = null
    if (receiptedAt.size === 0) return
    let earliest = Number.POSITIVE_INFINITY
    for (const at of receiptedAt.values()) if (at < earliest) earliest = at
    cancelTimer = schedule(
      () => {
        cancelTimer = null
        api.expire()
      },
      Math.max(0, earliest + ECHO_TTL_MS - now()),
    )
  }
  const forgetLeft = (left: readonly TxId[]): void => {
    for (const txId of left) receiptedAt.delete(txId)
  }

  const refreshOverlay = (kind: WritableKind, id: string): void => {
    if (kind !== 'issue') return
    const display = displayOf(log, kind, id)
    if (display === undefined) {
      // A dropped display re-runs whatever read it (every row in memory holds
      // its filing reaction).
      overlay.delete(id)
      return
    }
    // Skip an equal write (W4): a remote on a pending field recomputes the
    // same display, which must not notify (no commit) — structural equality
    // downstream would stop it anyway, but skipping avoids the derivation.
    const current = overlay.pending(kind, id)
    if (current !== undefined && compareStructural(current, display)) return
    overlay.set(id, display)
    // An edited row belongs in memory: the one reader's first access queues a
    // cold one for the next load window, and once it lands its filing
    // reaction follows the pending display like any row's.
    pool.row('issue', id)
  }

  /**
   * The CURRENT display of the issue an edit applies to (older pending or
   * server, W1.3): the pool's one reader, so a prior is exactly what every
   * reader showed. A row not in memory is refused, its load queued (W1.2).
   */
  const shownInMemory = (kind: WritableKind, id: string): SliceIssue => {
    if (kind !== 'issue') throw new WriteContractError(`no editable fields on ${String(kind)}`)
    const shown = pool.row('issue', id)
    if (shown === LOADING) {
      throw new WriteContractError(`issue ${id} is loading: edit it once it is in memory`)
    }
    if (shown === undefined) throw new WriteContractError(`unknown issue ${id}`)
    return shown as SliceIssue
  }

  const api: MobxWriteApi = {
    log,

    edit(kind, id, patch) {
      // Validates before any state changes (W1.1); reads no pool state.
      const command = commandFor(kind, id, patch)
      const txId = asMutationId(crypto.randomUUID())
      // One action (W1.5): capture prior from the current display (older
      // pending or server, W1.3), append, and paint. Reading the borrowed
      // rows here matches the pool's own ingest, which reads its tables
      // inside its action.
      runInAction(() => {
        const shown = shownInMemory(kind, id)
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
      let left: readonly TxId[] = []
      runInAction(() => {
        const result = log.reject(rejection) as {
          kind: WritableKind
          id: string
          left: readonly TxId[]
        } | null
        outcome = result
        if (result !== null) {
          left = result.left
          refreshOverlay(result.kind, result.id)
        }
      })
      forgetLeft(left)
      rearm()
      if (outcome === null) return
      const row = outcome as { kind: WritableKind; id: string }
      const enriched = { ...rejection, kind: row.kind, id: row.id }
      for (const listener of [...listeners]) listener(enriched)
    },

    handleRemote(kind, id, values) {
      runInAction(() => {
        const outcome = log.remote(kind, id, values)
        // An echo (or overtake) can settle a receipted edit here: the timer
        // must follow, or it would fire for an entry already gone.
        forgetLeft(outcome.left)
        // Pending fields keep the local value (no overlay change); a settle
        // or overtake (Mc2) would change the display — refresh anyway so this
        // path never double-paints the tables' own update.
        refreshOverlay(kind, id)
      })
      rearm()
    },

    handleAccepted(txId) {
      runInAction(() => {
        const outcome = log.settle({ txId })
        if (outcome === null) return
        forgetLeft(outcome.left)
        if (!outcome.left.includes(txId)) receiptedAt.set(txId, now())
        // The receipt alone confirms nothing: the entry stays until its echo
        // (or an overtake) resolves every field, so this refresh is a no-op
        // unless the echo already arrived (echo-before-receipt). A second
        // receipt returns null above: no repaint, ever (S4).
        refreshOverlay(outcome.kind, outcome.id)
      })
      rearm()
    },

    handleSuperseded(txId) {
      runInAction(() => {
        const outcome = log.supersede({ txId })
        if (outcome === null) return
        forgetLeft(outcome.left)
        // No repaint: the successor is newer and carries the value (W9). The
        // refresh only drops tracking that ended.
        refreshOverlay(outcome.kind, outcome.id)
      })
      rearm()
    },

    expire() {
      runInAction(() => {
        for (const outcome of log.expire()) {
          forgetLeft(outcome.left)
          refreshOverlay(outcome.kind, outcome.id)
        }
      })
      rearm()
    },

    bootstrap(source: RowSource) {
      const entries = transport.pending()
      const feedRows = new Map<string, SliceIssue>()
      for (const record of source.snapshot('issue')) {
        if (record.value !== undefined) feedRows.set(record.id, record.value as SliceIssue)
      }
      let applied = 0
      let skipped = 0
      const settled: TxId[] = []
      const left: TxId[] = []
      runInAction(() => {
        const touched: { kind: WritableKind; id: string }[] = []
        for (const entry of entries) {
          const mapped = editForPendingWrite(entry)
          if (mapped === null || mapped.kind !== 'issue') {
            skipped += 1
            continue
          }
          // The display every reader shows (W1.3): the feed's server row with
          // the entries already re-applied laid over it, as the pool's reader
          // lays the overlay. Read from the feed, never the pool: the row
          // may not be in memory, and its load is only asked for below.
          const server = feedRows.get(mapped.id)
          const shown =
            server === undefined ? undefined : { ...server, ...displayOf(log, 'issue', mapped.id) }
          if (shown === undefined) {
            skipped += 1
            continue
          }
          const prior: Record<string, unknown> = {}
          for (const field of Object.keys(mapped.patch as Record<string, unknown>)) {
            prior[field] = (shown as unknown as Record<string, unknown>)[field] ?? null
          }
          try {
            log.append(
              { txId: entry.txId, kind: mapped.kind, id: mapped.id, patch: mapped.patch, prior } as never,
              entry.base ? { base: entry.base } : undefined,
            )
          } catch {
            // A reused txId (bootstrap twice): the entry is already pending.
            skipped += 1
            continue
          }
          if (entry.acked) {
            const outcome = log.settle({ txId: entry.txId })
            if (outcome !== null) {
              left.push(...outcome.left)
              if (!outcome.left.includes(entry.txId)) settled.push(entry.txId)
              refreshOverlay(outcome.kind, outcome.id)
            }
          }
          refreshOverlay(mapped.kind, mapped.id)
          touched.push({ kind: mapped.kind, id: mapped.id })
          applied += 1
        }
        // An echo that landed before the reload settles its receipted edit
        // here (S5): the server row is already the echo.
        const seen = new Set<string>()
        for (const { kind, id } of touched) {
          const key = `${kind}:${id}`
          if (seen.has(key)) continue
          seen.add(key)
          if (log.pendingFor(kind, id).length === 0) continue
          const server = feedRows.get(id)
          if (server === undefined) continue
          const outcome = log.remote(kind, id, {
            title: (server as SliceIssue).title,
            stage: (server as SliceIssue).stage,
            readAt: ((server as SliceIssue).readAt ?? null) as never,
          } as never)
          left.push(...outcome.left)
          refreshOverlay(kind, id)
        }
      })
      // Receipts restored from the outbox arm the timer like live ones; an
      // echo that landed before the reload settles above and leaves no timer.
      const at = now()
      for (const txId of settled) if (!left.includes(txId)) receiptedAt.set(txId, at)
      forgetLeft(left)
      rearm()
      // The arm never re-sends: the kernel replays its own queue under the
      // same mutation ids, and receipts arrive under the same txIds.
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
      cancelTimer?.()
      cancelTimer = null
      receiptedAt.clear()
      overlay.leave()
      runInAction(() => overlay.clear())
      listeners.clear()
    },
  }
  // A model's setter (`issue.title = x`) is this api's `edit`: one transaction.
  overlay.join(api.edit)
  return api
}
