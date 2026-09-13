/**
 * Replica hydration and Store snapshot publication.
 *
 * The sync kernel owns cursor arithmetic, healing, watermarks, evictions and
 * rescopes. This adapter deliberately knows none of those concepts: it reads the
 * principal-bound slice exposed through the client Replica contract and publishes
 * row snapshots. That boundary keeps the Store from becoming a second sync state
 * machine while still giving it hydrate-first, offline paint.
 *
 * A kernel bootstrap installation reports one changed-kind batch, so consumers
 * observe one fully rebuilt slice, never a mixture of the pre- and post-rescope
 * worlds. Ordinary collection writes remain synchronous, matching Store action
 * semantics. Cursor-only events (including watermarks) report no row batch and
 * therefore produce no Store publication.
 */

import { type IssueWire, joinIssueExecution, joinSessionMarks } from '@podium/model'
import type { Replica, ReplicaHydrateResult, ReplicaKind, ReplicaRows } from '../replica/contract'

/**
 * The owner-scoped private half, joined back onto the issue rows [B4, PDM-136].
 *
 * THE ENGINE IS THE SECOND JOIN SITE, and it is not optional. The kernel
 * replica now holds SHARED issue rows — the four private execution keys arrive
 * as their own owner-scoped kind — so every engine reader of `st.issues`
 * (`state.ts`'s worktree selection, `viewmodels/session-ownership.ts`,
 * `dock-panel.ts`, `slices/worklist/nav.ts`, and the ~30 surfaces behind them)
 * would see an owner's own `worktreePath` as absent. That is the regression B3
 * warned about: absence is not a free win, and it looks exactly like an issue
 * that was never started.
 *
 * Returns the SAME ARRAY when there is nothing to join, which is the common case
 * for a reader who owns nothing in view. `readChanged` compares by identity to
 * decide what the Store republishes, so allocating a new array unconditionally
 * would make every unrelated batch look like an issue change.
 */
/**
 * THE ENGINE'S OWN JOIN for this reader's session marks (PDM-424).
 *
 * `st.sessions` reaches every session surface through this binding — the sidebar
 * unread dots, `focus.ts`'s snooze ordering, the worklist row roll-up,
 * `use-mark-read-on-view`, the reactions auto-read — so joining only in the view
 * models would leave all of them rendering the broadcast's NEUTRAL marks. That
 * is a false green of exactly the shape neutral values invite: every session
 * unread for everybody, which is indistinguishable from a person who has opened
 * nothing. B4 learned this on its own sidecar and PDM-408 on the issue twin: the
 * engine path is the catch.
 *
 * An empty marks list is the ordinary state of a person who has opened nothing,
 * and the join then leaves every row as the producer sent it — already neutral.
 * It must NOT force neutral itself: the rows reaching here have already had this
 * client's optimistic overlay applied, and an unconditional overwrite would wipe
 * the `readAt` a person had just written by pressing "mark read". PDM-408
 * measured that on the issue twin, where the unread dot flicked straight back on
 * under the cursor.
 *
 * Returns the SAME ARRAY when there is nothing to join, for the reason
 * {@link joinExecutions} gives: `readChanged` compares by identity, so
 * allocating unconditionally would make every unrelated batch look like a
 * session change.
 */
function joinMarks(
  sessions: readonly ReplicaRows['sessions'][],
  marks: readonly ReplicaRows['sessionMarks'][],
): ReplicaRows['sessions'][] {
  if (marks.length === 0) return sessions as ReplicaRows['sessions'][]
  const bySession = new Map(marks.map((row) => [row.sessionId as string, row]))
  return sessions.map((session) => joinSessionMarks(session, bySession.get(session.sessionId)))
}

function joinExecutions(
  issues: readonly ReplicaRows['issues'][],
  executions: readonly ReplicaRows['issueExecutions'][],
): ReplicaRows['issues'][] {
  if (executions.length === 0) return issues as ReplicaRows['issues'][]
  const byIssue = new Map(executions.map((row) => [row.issueId as string, row]))
  return issues.map((issue) => joinIssueExecution(issue, byIssue.get(issue.id)) as IssueWire)
}

export const REPLICA_BINDING_KINDS = [
  'sessions',
  'sessionMarks',
  'issues',
  'issueProjections',
  'issueDeps',
  'issueExecutions',
  'repos',
  'issueEvents',
  'pendingInteractions',
  'shipOrders',
  'conversations',
  'automations',
  'automationRuns',
  'userLayouts',
] as const satisfies readonly ReplicaKind[]

export type ReplicaBindingSnapshot = {
  readonly [K in ReplicaKind]: ReplicaRows[K][]
}

export interface ReplicaPublication {
  readonly snapshot: ReplicaBindingSnapshot
  readonly changed: ReadonlySet<ReplicaKind>
  readonly reason: 'rows' | 'hydrated'
}

export interface ReplicaBindingSubscriber {
  publish(publication: ReplicaPublication): void
  /** Legacy wire-v1 compatibility only. The kernel feed never seeds the hub. */
  hydrated?(result: ReplicaHydrateResult): void
}

export interface ReplicaBinding {
  /** Synchronous durable read used to build the Store's very first snapshot. */
  snapshot(): ReplicaBindingSnapshot
  /** Arm row subscriptions and hydration. The returned teardown is idempotent. */
  start(subscriber: ReplicaBindingSubscriber): () => void
}

export interface ReplicaBindingInit {
  readonly replica: Replica
}

export function createReplicaBinding(init: ReplicaBindingInit): ReplicaBinding {
  const { replica } = init
  let current = readSnapshot(replica)
  let generation = 0

  return {
    snapshot: () => current,

    start(subscriber): () => void {
      const mine = ++generation
      let stopped = false
      const pending = new Set<ReplicaKind>()
      const offs: Array<() => void> = []

      const flush = (reason: ReplicaPublication['reason']): void => {
        if (stopped || generation !== mine || pending.size === 0) return
        const changed = new Set(pending)
        // A sidecar change IS an issue change to every consumer [B4, PDM-136].
        // `readChanged` re-derives the joined rows, but a subscriber keyed on
        // 'issues' would never look at them: the Store republishes what the
        // changed SET names, and naming only 'issueExecutions' would deliver the
        // owner's worktree path into a snapshot nobody re-read.
        if (changed.has('issueExecutions')) changed.add('issues')
        pending.clear()
        current = readChanged(replica, current, changed)
        subscriber.publish({ snapshot: current, changed, reason })
      }

      const publishRows = (kinds: ReadonlySet<ReplicaKind>): void => {
        for (const kind of kinds) pending.add(kind)
        flush('rows')
      }

      // Subscribe first, then re-read every kind. A write in the construction →
      // start gap is either caught by the listener or by this synchronous read.
      if (replica.subscribeRowBatch !== undefined) {
        offs.push(replica.subscribeRowBatch((changed) => publishRows(changed)))
      } else {
        for (const kind of REPLICA_BINDING_KINDS) {
          offs.push(replica.subscribeRows(kind, () => publishRows(new Set([kind]))))
        }
      }
      for (const kind of REPLICA_BINDING_KINDS) pending.add(kind)
      flush('rows')

      // Hydration belongs here, not in engine.ts. Re-read through rows() after it
      // resolves: the returned result is also handed to the v1 hub adapter, but
      // rows() is the one read model both legacy and kernel facades expose.
      void replica.hydrate().then((result) => {
        if (stopped || generation !== mine) return
        subscriber.hydrated?.(result)
        for (const kind of REPLICA_BINDING_KINDS) pending.add(kind)
        flush('hydrated')
      })

      return () => {
        if (stopped) return
        stopped = true
        if (generation === mine) generation += 1
        pending.clear()
        for (const off of offs.splice(0)) {
          try {
            off()
          } catch {
            // Teardown is best-effort, matching the engine lifecycle contract.
          }
        }
      }
    },
  }
}

function readSnapshot(replica: Replica): ReplicaBindingSnapshot {
  return {
    sessions: joinMarks(replica.rows('sessions'), replica.rows('sessionMarks')),
    sessionMarks: replica.rows('sessionMarks'),
    issues: joinExecutions(replica.rows('issues'), replica.rows('issueExecutions')),
    issueProjections: replica.rows('issueProjections'),
    issueDeps: replica.rows('issueDeps'),
    issueExecutions: replica.rows('issueExecutions'),
    repos: replica.rows('repos'),
    issueEvents: replica.rows('issueEvents'),
    pendingInteractions: replica.rows('pendingInteractions'),
    shipOrders: replica.rows('shipOrders'),
    conversations: replica.rows('conversations'),
    automations: replica.rows('automations'),
    automationRuns: replica.rows('automationRuns'),
    userLayouts: replica.rows('userLayouts'),
  }
}

function readChanged(
  replica: Replica,
  previous: ReplicaBindingSnapshot,
  changed: ReadonlySet<ReplicaKind>,
): ReplicaBindingSnapshot {
  const next = { ...previous } as { [K in ReplicaKind]: ReplicaRows[K][] }
  for (const kind of changed) {
    // The indexed access is the same K on both sides; the mapped object retains
    // the correlation that TypeScript loses while iterating a union of keys.
    ;(next as Record<ReplicaKind, unknown>)[kind] = replica.rows(kind)
  }
  // `issues` DEPENDS ON `issueExecutions` [B4, PDM-136], so a batch that changed
  // only the sidecar must still re-derive the joined issue rows — otherwise an
  // owner's worktree path appears on the first frame that happens to touch an
  // issue and never on the frame that actually delivered it. This is the one
  // cross-kind dependency in this adapter and it is the reason the join lives
  // here rather than in each reader.
  if (changed.has('issues') || changed.has('issueExecutions')) {
    next.issues = joinExecutions(replica.rows('issues'), replica.rows('issueExecutions'))
  }
  // `sessions` DEPENDS ON `sessionMarks` the same way [PDM-424]. A batch that
  // changed only the sidecar must still re-derive the joined session rows —
  // otherwise a read mark appears on the first frame that happens to touch a
  // session and never on the frame that actually delivered it. And a batch that
  // changed only the SESSION must re-join too, because a shared session row
  // arriving second carries the broadcast's neutral marks and would otherwise
  // overwrite a mark this client already holds.
  if (changed.has('sessions') || changed.has('sessionMarks')) {
    next.sessions = joinMarks(replica.rows('sessions'), replica.rows('sessionMarks'))
  }
  return next
}
