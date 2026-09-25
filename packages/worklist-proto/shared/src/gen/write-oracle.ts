/**
 * POD-4574 (Mc2, coordinator ruling F4) — the oracle for a writable arm:
 * server truth plus the shared reference log.
 *
 * A phase-c arm owns its optimism, so the kernel's optimistic paint (the
 * overlaid oracle) is the wrong expectation wherever the two disagree: the
 * kernel retires an applied overlay as soon as the server row moved past its
 * enqueue baseline (`optimism.ts` `mutationApplied`, finding 2), while the
 * reference contract holds the pending value until the echo confirms it or a
 * post-receipt third value overtakes it (write contract W7/W8). After
 * edit → remote → accept the kernel shows the remote value and the contract
 * shows the pending one; both converge again at the echo. Those kernel-fold
 * differences are a finding, not a gate failure — so this oracle derives the
 * expectation from the contract instead: the feed's server rows with the
 * reference log's pending display overlaid.
 *
 * COMPARISON SURFACE. The gate compares `SliceSnapshot`s, which carry exactly
 * one editable field: `title` (`stage` and `readAt` never reach a row). The
 * log still tracks all three (stacked priors and echo confirmation need
 * them), but the patch touches titles only. Pending edits never move
 * visibility, order or groups, so those come from the kernel oracle
 * untouched.
 *
 * INDEPENDENCE. This log is fed from the RUN (generated intents, kernel
 * outcomes, feed rows under kernel ids), never from the arm: an arm that
 * mis-tracks its own log diverges from it. The arm's log is keyed by arm
 * txIds, this one by kernel mutation ids; both see the same events.
 *
 * LIFECYCLE. The log mirrors the arm's: entries linger across evict/reAdd
 * (neither side hears removals), rejects rewind to the last server value
 * seen, and a reload rebuilds from the outbox (`refresh`). Removals are
 * patched only onto rows the kernel snapshot still holds.
 *
 * OWNERSHIP. Shared gate code (round three, POD-4545): the MobX gate uses it
 * now, the hand arm's Hc2 later.
 */

import type { RowSource } from '../arm'
import type { SliceSnapshot } from '../slice-types'
import { baseOf } from '../receipts'
import {
  createPendingLog,
  editForPendingWrite,
  type EditPatch,
  type OutboxPendingWrite,
  type PendingLog,
  type TxId,
} from '../write-contract'
import type { GenRun, StepResult } from './run'

/** The editable fields of one server issue row, as the feed spells them. */
export interface ServerEditable {
  readonly title: string
  readonly stage: string
  readonly readAt: string | null
}

function editableOf(value: Record<string, unknown>): ServerEditable {
  return {
    title: value['title'] as string,
    stage: value['stage'] as string,
    readAt: (value['readAt'] ?? null) as string | null,
  }
}

/** The pending display for one row: the newest pending value per field. */
function displayOf(
  log: PendingLog,
  id: string,
  server: ServerEditable,
): { title: string; stage: string; readAt: string | null } {
  const display = { title: server.title, stage: server.stage, readAt: server.readAt }
  for (const edit of log.pendingFor('issue', id)) {
    const patch = edit.patch as Partial<ServerEditable>
    if (patch.title !== undefined) display.title = patch.title
    if (patch.stage !== undefined) display.stage = patch.stage
    if (patch.readAt !== undefined) display.readAt = patch.readAt as string | null
  }
  return display
}

export class WriteOracle {
  log: PendingLog = createPendingLog()
  /** Last server values synced per pending row (a repeat sync is a no-op). */
  private readonly synced = new Map<string, ServerEditable>()
  /** Every row ever appended (pruned when its log empties; the log itself
   *  has no whole-log enumeration). */
  private readonly rows = new Set<string>()
  /** Server arrivals already consumed (deduped re-sends below). */
  private arrivalsSeen = 0

  private serverRows(source: RowSource): Map<string, ServerEditable> {
    const out = new Map<string, ServerEditable>()
    for (const record of source.snapshot('issue')) {
      if (record.value === undefined) continue
      out.set(record.id, editableOf(record.value as unknown as Record<string, unknown>))
    }
    return out
  }

  /** The oracle's current display for one row (pending over server). */
  private display(source: RowSource, id: string): { title: string; stage: string; readAt: string | null } | null {
    const server = this.serverRows(source).get(id)
    if (server === undefined) return null
    return displayOf(this.log, id, server)
  }

  /**
   * A generated edit was applied under `kernelId`: append under that id with
   * `prior` from the oracle's current display (older pending or server,
   * W1.3). Skipped when the row is gone (the runner skips the change too).
   */
  editApplied(
    source: RowSource,
    kernelId: TxId,
    id: string,
    patch: EditPatch<'issue'>,
  ): void {
    const shown = this.display(source, id)
    if (shown === null) return
    const prior: Record<string, unknown> = {}
    for (const field of Object.keys(patch as Record<string, unknown>)) {
      prior[field] = (shown as unknown as Record<string, unknown>)[field] ?? null
    }
    this.log.append({ txId: kernelId, kind: 'issue', id, patch, prior })
    this.rows.add(id)
  }

  accept(kernelId: TxId): void {
    this.log.settle({ txId: kernelId })
  }

  reject(kernelId: TxId): void {
    this.log.reject({ txId: kernelId, error: { message: 'refused', parked: false } })
  }

  supersede(kernelId: TxId): void {
    this.log.supersede({ txId: kernelId })
  }

  /**
   * Observe the server's answers the runner never turns into changes: a
   * re-sent call the server already applied (or refused) is answered at once,
   * deduped by mutation id — for the arm that outcome arrives as a receipt
   * (or rejection) through its transport, so the oracle records it here from
   * the scripted server's arrival log. Unknown ids are no-ops either way.
   */
  consumeServerAnswers(run: GenRun): void {
    const arrivals = run.server.arrivals.slice(this.arrivalsSeen)
    this.arrivalsSeen = run.server.arrivals.length
    for (const arrival of arrivals) {
      if (!arrival.deduped) continue
      const txId = arrival.mutationId as TxId
      if (run.server.applied.has(arrival.mutationId)) this.log.settle({ txId })
      else if (run.server.refused.has(arrival.mutationId)) {
        this.log.reject({ txId, error: { message: 'refused', parked: false } })
      }
    }
  }
  syncPending(source: RowSource): void {
    // Pass the current server values of every pending row through the log
    // (echo/remote/stale coverage, W7/W8). Rows whose server values did not
    // move since the last sync are skipped, so an untracked sync never bumps
    // the rewind clock (W6).
    const server = this.serverRows(source)
    for (const id of this.pendingIds()) {
      const values = server.get(id)
      if (values === undefined) continue
      const last = this.synced.get(id)
      if (
        last !== undefined &&
        last.title === values.title &&
        last.stage === values.stage &&
        last.readAt === values.readAt
      ) {
        continue
      }
      this.log.remote('issue', id, { ...values })
      this.synced.set(id, values)
    }
  }

  /**
   * Rebuild from the outbox after a reload (kernel ids, queue order):
   * the in-memory log is gone, so it starts empty and re-appends what the
   * queue still holds — entries the kernel retired (moved-past, TTL) stay
   * dropped on both sides. Receipted ones settle at once, then pre-reload
   * echoes confirm through the current server values (W11). Unknown rows
   * and non-slice entries are skipped.
   */
  refresh(outboxPending: readonly OutboxPendingWrite[], source: RowSource): void {
    this.log = createPendingLog()
    this.rows.clear()
    this.synced.clear()
    const server = this.serverRows(source)
    for (const entry of outboxPending) {
      const mapped = editForPendingWrite(entry)
      if (mapped === null || mapped.kind !== 'issue') continue
      const shown = server.get(mapped.id)
      if (shown === undefined) continue
      const current = displayOf(this.log, mapped.id, shown)
      const prior: Record<string, unknown> = {}
      for (const field of Object.keys(mapped.patch as Record<string, unknown>)) {
        prior[field] = (current as unknown as Record<string, unknown>)[field] ?? null
      }
      try {
        this.log.append(
          { txId: entry.txId, kind: mapped.kind, id: mapped.id, patch: mapped.patch, prior },
          entry.base ? { base: entry.base } : undefined,
        )
      } catch {
        continue
      }
      if (entry.acked) this.log.settle({ txId: entry.txId })
      this.rows.add(mapped.id)
      this.synced.delete(mapped.id)
    }
    this.syncPending(source)
  }

  /** Rows with pending edits (prunes rows whose log emptied). */
  pendingIds(): string[] {
    const out: string[] = []
    for (const id of this.rows) {
      if (this.log.pendingFor('issue', id).length > 0) out.push(id)
      else {
        this.rows.delete(id)
        this.synced.delete(id)
      }
    }
    return out
  }

  /**
   * The expected display: server truth plus the shared reference log, for
   * every row the server holds, whatever the kernel or the arm shows (F4).
   * Each row keeps the kernel snapshot's shape and every field the gate does
   * not edit; its title is the reference display (newest pending title, else
   * the server value). A row with nothing pending shows the server value —
   * which is also what retires a kernel stale-hold (a chained overlay past a
   * newer server value) back to truth without any condition on the arm. Rows
   * the server no longer holds keep the kernel's row.
   */
  patchSnapshot(oracle: SliceSnapshot, source: RowSource): SliceSnapshot {
    const server = this.serverRows(source)
    const rowsById = { ...oracle.rowsById }
    for (const [id, values] of server) {
      const row = rowsById[id]
      if (row === undefined) continue
      const display = displayOf(this.log, id, values)
      if (display.title !== row.title) rowsById[id] = { ...row, title: display.title }
    }
    return { ...oracle, rowsById }
  }
}

/** This engine's outbox entries as bootstrap inputs (kernel ids, queue order). */
function outboxPendingOf(run: GenRun): OutboxPendingWrite[] {
  const out: OutboxPendingWrite[] = []
  const push = (entry: Parameters<typeof baseOf>[0], acked: boolean): void => {
    const base = baseOf(entry)
    out.push({
      txId: entry.mutationId as TxId,
      kind: entry.kind,
      input: entry.input,
      queuedAt: entry.queuedAt,
      acked,
      ...(base === undefined ? {} : { base }),
    })
  }
  for (const entry of run.ctx.engine.outbox.pending()) push(entry, false)
  for (const entry of run.ctx.engine.outbox.awaiting()) push(entry, true)
  return out
}

/**
 * Feed one settled step into the oracle (shared with Hc2). Edit intent and
 * outcomes come from the step (kernel ids, as the runner records them);
 * echoes, remotes and row writes arrive through the per-step pending sync,
 * which reads the feed's current server rows. A skipped change feeds nothing
 * except the sync (which is a no-op without movement).
 */
export function feedStep(oracle: WriteOracle, step: StepResult, run: GenRun): void {
  const change = step.change
  const detail = step.detail ?? {}
  const source = run.feed().source
  if (change.kind === 'edit' && step.skipped === undefined) {
    const kernelId = detail['mutationId']
    if (typeof kernelId === 'string') {
      const patch: EditPatch<'issue'> =
        'title' in change.patch
          ? { title: change.patch.title }
          : 'stage' in change.patch
            ? { stage: change.patch.stage }
            : { readAt: run.ctx.stamp() }
      oracle.editApplied(source, kernelId as TxId, change.id, patch)
    }
  } else if (change.kind === 'accept' && step.skipped === undefined) {
    const record = run.edits.get(change.handle)
    if (record) oracle.accept(record.mutationId as TxId)
  } else if (change.kind === 'reject' && step.skipped === undefined) {
    const record = run.edits.get(change.handle)
    if (record) oracle.reject(record.mutationId as TxId)
  } else if (change.kind === 'supersede' && step.skipped === undefined) {
    const ids = detail['mutationIds']
    if (detail['collapsed'] === true && Array.isArray(ids) && typeof ids[0] === 'string') {
      oracle.supersede(ids[0] as TxId)
    }
  } else if (change.kind === 'refresh' && step.skipped === undefined) {
    oracle.refresh(outboxPendingOf(run), source)
    return
  }
  oracle.consumeServerAnswers(run)
  oracle.syncPending(source)
}
