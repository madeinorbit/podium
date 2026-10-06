/**
 * POD-4825 (item 1) — the arm that owns optimism, as the instruments run it.
 * The work check (`work-per-change.test.tsx`), the census
 * (`arms/mobx/pool/tracking-counts.test.ts`) and the web pages
 * (`harness/web/entries/mobx-write.ts`, `mobx-pending.ts`) run it twice:
 *
 * - `idle`: nothing pending (it must cost what the bare pool costs, or say
 *   what it adds);
 * - `pending`: {@link PENDING_TITLE_EDITS} title edits queued in the kernel
 *   outbox before the arm is built, exactly as a reload with a queued outbox,
 *   and never answered, so none settles or expires: they stay pending for
 *   every step.
 *
 * POD-5432: for the MobX pool that arm is the product's own path: the pool on
 * the `owned` feed with the runtime's transaction log, its pending edits real
 * outbox records against a server that holds them (the helpers at the end of
 * this file). It replaced the pool-side `PendingOverlay` and its edit log. The
 * silent transport below remains for the hand-rolled arm's own write layer,
 * which runs on the `overlaid` feed.
 *
 * The edits are TITLES of open, non-draft rows in the list's first window
 * that no scenario targets, taken from the window's end: a title is drawn on
 * the row and moves nothing else (no order, no visibility), so the oracle's
 * snapshot with those titles laid over it ({@link withPendingTitles}) is the
 * list the arm must show, derived without asking the arm.
 */

import type { SliceIssue, SliceOrder, SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import type { PoolTransactions } from '@podium/client-graph/write/transactions'
import { asIssueId } from '@podium/model'
import type { EngineOptions, ScenarioEngine, ScenarioServer } from '../../shared/src/scenarios'
import type { RowRecord } from '../../shared/src/stats'
import type { OutboxPendingWrite, TxId, WriteTransport } from '../../shared/src/write-contract'

export const WRITE_VARIANTS = ['idle', 'pending'] as const
export type WriteVariant = (typeof WRITE_VARIANTS)[number]

/** Pending title edits in the `pending` variant. */
export const PENDING_TITLE_EDITS = 3

/** The pending title an edit shows for a row whose server title is `title`. */
export const pendingTitleOf = (title: string): string => `${title} (pending edit)`

/**
 * A transport whose outbox holds `queued` and never answers: sends are kept
 * (the instruments never make one; a test may assert none), no receipt and no
 * rejection ever arrives.
 */
export function silentTransport(
  queued: readonly OutboxPendingWrite[] = [],
): WriteTransport & { readonly sent: { txId: TxId; command: unknown }[] } {
  const sent: { txId: TxId; command: unknown }[] = []
  return {
    sent,
    send(txId, command) {
      sent.push({ txId, command })
    },
    subscribe() {
      return () => {}
    },
    pending() {
      return queued
    },
  }
}

/**
 * The rows the `pending` variant edits: the last `count` rows of the list's
 * first `window` rows (pinned, then each group's open lane) that `eligible`
 * accepts. Throws when fewer qualify: an instrument never runs with fewer
 * pending edits than it says.
 */
export function pendingTitleTargets(
  order: SliceOrder,
  eligible: (id: string) => boolean,
  window: number,
  count: number = PENDING_TITLE_EDITS,
): string[] {
  const ids = [...order.pinnedIds, ...order.groups.flatMap((group) => group.rowIds)]
    .slice(0, window)
    .filter(eligible)
  if (ids.length < count) {
    throw new Error(
      `[writable] ${ids.length} eligible row(s) in the first ${window}: need ${count} for the pending edits`,
    )
  }
  return ids.slice(ids.length - count)
}

/**
 * The kernel outbox entries of one title edit per row (`issueUpdate`, queued,
 * not receipted), and the title each row shows while it is pending.
 */
export function queuedTitleEdits(
  ids: readonly string[],
  serverTitle: (id: string) => string,
  queuedAt: number,
): { queued: OutboxPendingWrite[]; titles: ReadonlyMap<string, string> } {
  const titles = new Map<string, string>()
  const queued = ids.map((id, index): OutboxPendingWrite => {
    const title = pendingTitleOf(serverTitle(id))
    titles.set(id, title)
    return {
      txId: `pod-4825-pending-${index}` as TxId,
      kind: 'issueUpdate',
      input: { id, patch: { title } },
      queuedAt,
      acked: false,
    }
  })
  return { queued, titles }
}

/**
 * The `pending` variant's edits over one feed: the rows (`pendingTitleTargets`:
 * open, not a draft, not `excluded`) read from the feed's issue rows, and
 * their queued outbox entries.
 */
export function pendingTitleEditsOn(
  issues: readonly RowRecord[],
  order: SliceOrder,
  excluded: (id: string) => boolean,
  window: number,
  queuedAt: number,
): { queued: OutboxPendingWrite[]; titles: ReadonlyMap<string, string> } {
  const rows = new Map<string, SliceIssue>()
  for (const record of issues) {
    if (record.kind === 'issue' && record.value !== undefined)
      rows.set(record.id, record.value as SliceIssue)
  }
  const ids = pendingTitleTargets(
    order,
    (id) => !excluded(id) && rows.has(id) && rows.get(id)?.isDraftVessel !== true,
    window,
  )
  return queuedTitleEdits(ids, (id) => rows.get(id)?.title ?? '', queuedAt)
}

/** The oracle's snapshot with the pending titles laid over their rows. Throws for a row the list does not hold. */
export function withPendingTitles(
  snapshot: SliceSnapshot,
  titles: ReadonlyMap<string, string>,
): SliceSnapshot {
  if (titles.size === 0) return snapshot
  const rowsById = { ...snapshot.rowsById }
  for (const [id, title] of titles) {
    const row = rowsById[id]
    if (row === undefined) throw new Error(`[writable] pending row ${id} is not in the list`)
    rowsById[id] = { ...row, title }
  }
  return { order: snapshot.order, rowsById }
}

/** Every row id a scenario target names (a string, or a list of them). */
export function targetIds(targets: object): Set<string> {
  const out = new Set<string>()
  for (const value of Object.values(targets)) {
    if (typeof value === 'string') out.add(value)
    else if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') out.add(id)
  }
  return out
}

/**
 * The window the node instruments pick pending rows from: the scale pages'
 * first window (`FIRST_WINDOW_ROWS`, `harness/web/entrylib.ts`), so a pending
 * row is one a page draws.
 */
export const PENDING_WINDOW_ROWS = 96

/**
 * POD-5432 — the MobX arm owns its optimism the way the product does: on the
 * `owned` feed (`openFenceFeeds(ctx, 'owned')`), its pool takes the runtime's
 * transaction log (`write/transactions.ts`) and the runtime's actions route
 * through it. Its pending edits are real outbox records, so the log rebuilds
 * them when the feeds open, exactly as a reload with a queued outbox does.
 *
 * They must stay pending for every step, so the engine runs the kernel outbox
 * (per-issue partitions: a held edit holds only its own issue, never a
 * scenario's write) against a server that answers an update of a held issue
 * with a transient failure (503: retried with backoff, never definitive) and
 * every other one as applied, as the default server does. Not a request that
 * never answers: the kernel's drain pass awaits every partition's send, so a
 * hung send would stall every other issue's writes too.
 */
export function holdingServer(): {
  readonly server: ScenarioServer
  hold(ids: Iterable<string>): void
} {
  const held = new Set<string>()
  return {
    server: {
      issueUpdate: (input) =>
        held.has(input.id)
          ? Promise.reject(
              Object.assign(new Error('held by the harness'), {
                data: { code: 'SERVICE_UNAVAILABLE', httpStatus: 503 },
              }),
            )
          : Promise.resolve({}),
    },
    hold(ids) {
      for (const id of ids) held.add(id)
    },
  }
}

/** The engine a pool-owned arm's run boots: the kernel outbox and `server`. */
export function ownedEngineOptions(server: ScenarioServer): EngineOptions {
  return { outbox: 'kernel', server }
}

/**
 * Queue one title edit per row in the engine's own outbox, through the
 * ledger's enqueue (never routed: no pool exists yet), and wait until each is
 * durable. The `server` must hold these rows first (`holdingServer`).
 */
export async function queuePendingTitles(
  engine: Pick<ScenarioEngine['engine'], 'outbox'>,
  titles: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [id, title] of titles) {
    await engine.outbox.enqueue('issueUpdate', { id: asIssueId(id), patch: { title } })
  }
}

/** The rows of `titles` the feeds' transaction log still holds pending. */
export function stillPending(
  feeds: { readonly transactions?: PoolTransactions },
  titles: ReadonlyMap<string, string>,
): string[] {
  const rows = feeds.transactions?.pending.byRow('issueProjections')
  return [...titles.keys()].filter((id) => rows?.has(id) === true)
}
