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
 * COMPARISON SURFACE. The gate compares `SliceSnapshot`s. The expected
 * snapshot is the WHOLE display computed from server truth plus the
 * reference log (coordinator ruling, option b): the store's rows with the
 * pending display overlaid per row, run through the shared slice oracle
 * (`snapshotFromStore`). Membership, order, groups, decay windows and
 * roll-ups then follow the spec rules over the overlaid rows — whether a
 * pending readAt reopens a window is decided by the slice rule itself,
 * never by the kernel, the arm, or a test exception. The kernel is never
 * an input here; it stays a counted legacy finding in the gate
 * (`kernelDiffers`).
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
import type { ScenarioEngine } from '../scenarios'
import { snapshotFromStore } from '../../../harness/src/oracle/index'
import type { PodiumClientApi } from '@podium/client-core/api'
import type { Store } from '@podium/client-core/engine'
import type { Replica } from '@podium/client-core/replica'
import { baseOf, subscribeReceipts } from '../receipts'
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

/** One server value, shortened for the consumed-event lists. */
function short(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  const text = String(value)
  return text.length > 28 ? `${text.slice(0, 28)}…` : text
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
  /** Titles the log held per row, kept after they leave (chained-hold
   *  detection in `expectedSnapshot`; cleared when the row goes pending
   *  again is unnecessary — a pending row takes the display branch instead). */
  private readonly seenTitles = new Map<string, Set<string>>()
  /** Ordered stream events consumed per row (ruling: a skew reads directly
   *  from the result file, so every row ever touched keeps its list). */
  readonly eventsByRow = new Map<string, string[]>()
  /** Every row ever touched (never pruned; result rows report these). */
  readonly touchedRows = new Set<string>()

  private record(id: string, what: string): void {
    this.touchedRows.add(id)
    const list = this.eventsByRow.get(id)
    if (list === undefined) this.eventsByRow.set(id, [what])
    else list.push(what)
  }

  /** The ordered event lists for every touched row (per-seed result rows). */
  consumedEvents(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const id of this.touchedRows) out[id] = this.eventsByRow.get(id) ?? []
    return out
  }

  /**
   * Consume the SAME ordered delivery stream as the arm (coordinator ruling,
   * option 1): feed row deliveries as remotes, kernel outcomes as receipts,
   * in delivery order, at the same moment the arm's own subscriptions see
   * them. Install at arm creation, before the step's apply starts, and drop
   * on dispose (a reload re-creates over the new feed). W8's overtake reads
   * `ackBase`, the value seen at receipt, so sharing the observation order
   * is what keeps the two logs' resolutions identical; a later pipe (the old
   * onStep sync) is a different sequence and resolves opposite.
   */
  watch(ctx: ScenarioEngine, source: RowSource): () => void {
    const offRows = source.subscribe((event) => {
      for (const row of event.rows) {
        if (row.kind !== 'issue' || row.value === undefined) continue
        const values = editableOf(row.value as unknown as Record<string, unknown>)
        this.log.remote('issue', row.id, { ...values })
        this.record(row.id, `remote t=${short(values.title)} s=${short(values.stage)} r=${short(values.readAt)}`)
      }
    })
    const offReceipts = subscribeReceipts(ctx.engine, (event) => {
      const tx8 = String(event.txId).slice(0, 8)
      const id = event.id ?? tx8
      if (event.type === 'accepted') {
        this.log.settle({ txId: event.txId })
        this.record(id, `accepted ${tx8}`)
      } else if (event.type === 'rejected') {
        this.log.reject({ txId: event.txId, error: { message: 'refused', parked: false } })
        this.record(id, `rejected ${tx8}`)
      } else {
        this.log.supersede({ txId: event.txId })
        this.record(id, `superseded ${tx8}`)
      }
    })
    return () => {
      offRows()
      offReceipts()
    }
  }

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
    const patchRecord = patch as { title?: string; stage?: string; readAt?: string }
    const shownPatch = [
      patchRecord.title !== undefined ? `t=${short(patchRecord.title)}` : null,
      (patch as { stage?: string }).stage !== undefined ? `s=${short((patch as { stage?: string }).stage)}` : null,
      (patch as { readAt?: string }).readAt !== undefined ? `r=${short((patch as { readAt?: string }).readAt)}` : null,
    ]
      .filter((part) => part !== null)
      .join(' ')
    this.record(id, `edit ${shownPatch}`)
    if (patchRecord.title !== undefined) {
      let seen = this.seenTitles.get(id)
      if (!seen) {
        seen = new Set()
        this.seenTitles.set(id, seen)
      }
      seen.add(patchRecord.title)
    }
  }

  /**
   * One-shot state sync, used only by `refresh` below: pass the current
   * server values of every pending row through the log so pre-reload echoes
   * confirm through them (W11). Rows whose server values did not move since
   * the last sync are skipped, so an untracked sync never bumps the rewind
   * clock (W6). Never on the per-step path: remotes arrive through `watch`,
   * in delivery order with the arm.
   */
  syncPending(source: RowSource): void {
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
      this.record(mapped.id, `refresh${entry.acked ? ' acked' : ''}`)
      const patchRecord = mapped.patch as { title?: string }
      if (patchRecord.title !== undefined) {
        let seen = this.seenTitles.get(mapped.id)
        if (!seen) {
          seen = new Set()
          this.seenTitles.set(mapped.id, seen)
        }
        seen.add(patchRecord.title)
      }
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

  /** Whether the log currently holds a pending title for the row. */
  private hasPendingTitle(id: string): boolean {
    return this.log
      .pendingFor('issue', id)
      .some((e) => (e.patch as { title?: string }).title !== undefined)
  }

  /**
   * The WHOLE expected snapshot (coordinator ruling, option b): the shared
   * slice oracle over the store's rows with the reference log's pending
   * display overlaid per row. The overlay goes three levels deep, because
   * that is where the derivation reads: the legacy rows (the models'
   * supplement), the normalized projections (whose whole-row spelling,
   * including the durable server title, is spread over the supplement), and
   * a stub replica serving the same overlaid issue rows (the views derive
   * from replica rows). Every other kind delegates to the live replica, and
   * the store's remaining collections stay intact, so an empty log
   * reproduces `oracleSnapshot` exactly. Membership, order, groups, decay
   * windows and roll-ups then follow the spec rules over the overlaid rows
   * — whether a pending readAt reopens a window is decided by the slice
   * rule itself, never by the kernel, the arm, or a test exception. Where
   * the log is empty but the store still shows a title the log once held (a
   * chained overlay the kernel retired past a newer server value), the
   * feed's server truth is expected instead — with no condition on the arm,
   * so an arm that copies the kernel's hold fails here. The kernel is never
   * otherwise an input; it stays a counted legacy finding in the gate.
   * Unselected baseline at the store's clock, like `oracleSnapshot`.
   */
  expectedSnapshot(store: Store<PodiumClientApi>, source: RowSource): SliceSnapshot {
    const feed = this.serverRows(source)
    const storeIssues = (store.issues ?? []) as readonly Record<string, unknown>[]
    // The pending display per row with pending edits (fresh objects), plus
    // the chained-hold repair against feed truth where the log is empty.
    const displayById = new Map<string, { title: string; stage: string; readAt: string | null }>()
    for (const row of storeIssues) {
      const id = row['id'] as string
      if (this.log.pendingFor('issue', id).length > 0) {
        const server = feed.get(id) ?? editableOf(row)
        displayById.set(id, displayOf(this.log, id, server))
      }
    }
    const issues = storeIssues.map((row) => {
      const id = row['id'] as string
      const display = displayById.get(id)
      if (display !== undefined) return { ...row, ...display }
      const titles = this.seenTitles.get(id)
      const serverTitle = feed.get(id)?.title
      if (
        titles !== undefined &&
        !this.hasPendingTitle(id) &&
        typeof row['title'] === 'string' &&
        titles.has(row['title'] as string) &&
        serverTitle !== undefined &&
        row['title'] !== serverTitle
      ) {
        return { ...row, title: serverTitle }
      }
      return row
    })
    // The normalized projections carry the durable title/stage the model
    // merge spreads over the supplement: overlay the pending display onto
    // the fields each projection row actually carries, and repair a chained
    // hold the same way as legacy rows below (the store's projections can
    // carry the kernel's paint as well as its truth).
    const storeProjections = (store.issueProjections ?? []) as readonly Record<string, unknown>[]
    const projections = storeProjections.map((row) => {
      const id = row['id'] as string
      const display = displayById.get(id)
      if (display !== undefined) {
        const overlaid: Record<string, unknown> = { ...row }
        for (const [field, value] of Object.entries(display)) {
          if (field in overlaid) overlaid[field] = value
        }
        return overlaid
      }
      const titles = this.seenTitles.get(id)
      const serverTitle = feed.get(id)?.title
      if (
        titles !== undefined &&
        !this.hasPendingTitle(id) &&
        typeof row['title'] === 'string' &&
        titles.has(row['title'] as string) &&
        serverTitle !== undefined &&
        row['title'] !== serverTitle
      ) {
        return { ...row, title: serverTitle }
      }
      return row
    })
    // The stub replica serves the overlaid issue rows and projections;
    // everything else reads the live replica. Fresh per call, so no
    // view-model memo can survive across overlaid generations (a caller with
    // no previous generation gets wholly new views, the correct answer).
    const live = store.replica as Replica | undefined | null
    const liveRows = (kind: string): readonly unknown[] | undefined =>
      (
        live?.rows as ((k: string) => readonly unknown[] | undefined) | undefined
      )?.call(live, kind)
    const stub = {
      rows: (kind: string) => {
        if (kind === 'issues') return issues
        if (kind === 'issueProjections') return projections
        return [...(liveRows(kind) ?? [])]
      },
      subscribeRows: () => () => {},
      batch: <T>(fn: () => T): T => fn(),
      persistent: true,
    } as unknown as Replica
    const overlaid = { ...store, replica: stub, issues, issueProjections: projections }
    return snapshotFromStore(overlaid as never, {
      selectedIssueId: null,
      coarseNow: (store as unknown as { coarseNow: number }).coarseNow,
    } as never)
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
 * Feed one settled step's INTENT into the oracle (shared with Hc2): a
 * generated edit appends under its kernel id, as does every mark-read a
 * supersede step presses through the arm (the runner drives one arm edit
 * per handle and claims one kernel id per handle; without these appends the
 * oracle never learns entries the arm holds); a reload rebuilds the log
 * from the outbox. Outcomes (receipts) and row writes (remotes, echoes)
 * arrive through `watch`, in delivery order with the arm — never through a
 * later onStep sample, which is a different sequence. A skipped change feeds
 * nothing.
 */
export function feedStep(oracle: WriteOracle, step: StepResult, run: GenRun): void {
  const change = step.change
  const detail = step.detail ?? {}
  const source = run.feed().source
  if (change.kind === 'edit' && step.skipped === undefined) {
    const kernelId = detail['mutationId']
    if (typeof kernelId === 'string') {
      // Wall-clock stamp like the runner's hook and the kernel's own
      // (POD-4574): the unread rollup branches on stamp recency, so a
      // corpus-clock stamp days away flips visibility against both. Never
      // compared directly (SliceSnapshot drops readAt).
      const patch: EditPatch<'issue'> =
        'title' in change.patch
          ? { title: change.patch.title }
          : 'stage' in change.patch
            ? { stage: change.patch.stage }
            : { readAt: new Date(Date.now()).toISOString() }
      oracle.editApplied(source, kernelId as TxId, change.id, patch)
    }
  } else if (change.kind === 'supersede' && step.skipped === undefined) {
    // One arm mark-read per handle above; one kernel id per handle claimed.
    // Stamps agree with the arm's within milliseconds (same tolerance as
    // generated mark-reads; never compared directly).
    const ids = detail['mutationIds']
    if (Array.isArray(ids)) {
      for (const kernelId of ids) {
        if (typeof kernelId !== 'string') continue
        oracle.editApplied(source, kernelId as TxId, change.id, {
          readAt: new Date(Date.now()).toISOString(),
        })
      }
    }
  } else if (change.kind === 'refresh' && step.skipped === undefined) {
    oracle.refresh(outboxPendingOf(run), source)
  }
}
