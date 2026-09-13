import type { EntityRecord } from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import { createKernelReplica, createSideCache } from '../replica/kernel'
import type { KernelCacheRead } from '../replica/kernel'
import { memoryStorage } from '../replica/replica'
import { createReplicaBinding, type ReplicaPublication } from './replica-binding'

/**
 * **THE OWNER'S REASSEMBLY, THROUGH THE ACTUAL CONSUMER** [PDM-448, for PDM-415].
 *
 * PDM-415's server-side witness calls `joinIssueExecution` directly over real
 * serving output. That is the production JOIN FUNCTION, but not the production
 * consumer that calls it, and the reviewer was right to separate the two. The
 * consumer is `createReplicaBinding`'s `joinExecutions`, and it cannot be reached
 * from an `apps/server` test at all: the `declared-deps` boundary rule refuses
 * `apps/server` depending on `@podium/client-core` (stated in
 * `apps/server/src/modules/interactions/synthesis.ts:204`). So the coverage lives
 * here, beside the consumer.
 *
 * WHAT THIS IS AND IS NOT. This is CONSUMER-SEAM evidence: real replica, real
 * binding, rows delivered through `applySnapshot` — the actual ingestion seam,
 * not a manufactured cache mutation. It is NOT end-to-end: no server produces
 * these rows here. The end-to-end claim would need a package depending on both
 * sides, and nothing in this repair creates one. Said plainly so the pair of
 * witnesses is not read as one.
 */

const issueRow = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, stage: 'backlog', ...extra }) as never

const executionRow = (issueId: string, extra: Record<string, unknown> = {}) =>
  ({ issueId, ...extra }) as never

const PRIVATE = {
  worktreePath: '/wt/owner',
  machineId: 'm_owner',
  coordinatorSessionId: 'ses_coordinator',
  startedBySession: 'ses_started',
}

/**
 * A kernel replica + binding over a cache, driven the way PRODUCTION drives it:
 * the kernel installs into the cache and then emits an event. That event is the
 * real notification seam, not a poke at the binding — `replica-binding.test.ts`
 * uses the same one, and driving `applySnapshot` on a legacy replica instead
 * reads only the snapshot captured at construction (my first attempt did exactly
 * that and could not see an update at all).
 */
function bound(issues: [string, Record<string, unknown>][], executions: [string, Record<string, unknown>][]) {
  const cache = new BindingCache()
  for (const [id, extra] of issues) cache.put('issue', id, issueRow(id, extra))
  for (const [id, extra] of executions) cache.put('issueExecution', id, executionRow(id, extra))
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  return { cache, replica, binding: createReplicaBinding({ replica }) }
}

const joined = (snapshot: { issues: readonly unknown[] }, id: string) =>
  snapshot.issues.find((row) => (row as { id: string }).id === id) as Record<string, unknown> | undefined

describe('the owner reassembles the private half through the real binding [PDM-448]', () => {
  it('joins the sidecar onto the shared row, and leaves an unrelated issue alone', async () => {
    // THE UNRELATED-ROW CONTROL. A binding that spread every sidecar over every
    // issue, or that rebuilt the whole list, would pass a single-issue assertion
    // and fail this one.
    const { binding } = bound(
      [['iss_owned', {}], ['iss_other', {}]],
      [['iss_owned', PRIVATE]],
    )
    const snapshot = binding.snapshot()

    const owned = joined(snapshot, 'iss_owned')
    expect.soft(owned?.worktreePath).toBe(PRIVATE.worktreePath)
    expect.soft(owned?.machineId).toBe(PRIVATE.machineId)
    expect.soft(owned?.coordinatorSessionId).toBe(PRIVATE.coordinatorSessionId)
    expect.soft(owned?.startedBySession).toBe(PRIVATE.startedBySession)
    // The shared half is untouched by the join.
    expect.soft(owned?.title).toBe('iss_owned')

    const other = joined(snapshot, 'iss_other')
    expect.soft(other).toBeDefined()
    for (const key of Object.keys(PRIVATE)) {
      expect.soft(Object.hasOwn(other ?? {}, key)).toBe(false)
    }
  })

  it('an UPDATE to the sidecar moves the joined values', async () => {
    const { cache, replica, binding } = bound(
      [['iss_owned', {}], ['iss_other', {}]],
      [['iss_owned', PRIVATE]],
    )
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0

    // The kernel has already swapped the cache when the event fires — the same
    // ordering `replica-binding.test.ts` documents.
    const moved = executionRow('iss_owned', { ...PRIVATE, worktreePath: '/wt/moved' })
    cache.put('issueExecution', 'iss_owned', moved)
    replica.onKernelEvent({
      type: 'upserted',
      record: { entity: 'issueExecution', entityId: 'iss_owned', value: moved, provenance: { seq: 1 } },
    } as never)

    // THE PUBLICATION IS MANDATORY, NOT CONDITIONAL [PDM-448]. The first version
    // of this test read `publications.at(-1)?.snapshot ?? binding.snapshot()` and
    // guarded its changed-set assertion with `if (publications.length > 0)` — so a
    // binding that published NOTHING passed the whole test. A subscriber only
    // re-reads what a publication NAMES, so "no publication" is the defect, not a
    // permitted alternative, and both the fallback and the guard are gone.
    expect(publications.length).toBeGreaterThan(0)
    const latest = publications.at(-1)!.snapshot
    const owned = joined(latest, 'iss_owned')
    expect.soft(owned?.worktreePath).toBe('/wt/moved')
    // A stale join would still read the original — this is the assertion that
    // separates "re-derived" from "computed once at construction".
    expect.soft(owned?.worktreePath).not.toBe(PRIVATE.worktreePath)
    // The other private keys are unchanged, so the update moved one field rather
    // than replacing the joined object with a partial one.
    expect.soft(owned?.machineId).toBe(PRIVATE.machineId)

    // A SIDECAR CHANGE IS AN ISSUE CHANGE to a subscriber keyed on 'issues'. If
    // the publication named only 'issueExecutions', a Store republishing what the
    // changed set names would never re-read the joined rows.
    expect.soft([...publications.at(-1)!.changed]).toContain('issues')

    // UNRELATED-ROW CONTROL on the update path: the bystander must not have
    // acquired the moved value, or the join is spreading rather than keying.
    expect.soft(Object.hasOwn(joined(latest, 'iss_other') ?? {}, 'worktreePath')).toBe(false)
    stop()
  })

  it('REMOVING the sidecar takes the private keys off the joined row', async () => {
    // The stranding question, asked at the consumer: if the sidecar goes away,
    // does the owner's row keep serving the old private values?
    // TWO issues, each with its OWN sidecar — the unrelated-row control this case
    // was missing [PDM-448]. Removing one sidecar must leave the other's values
    // intact; a single-issue fixture cannot tell a targeted eviction from one that
    // drops every sidecar.
    const OTHER_PRIVATE = { ...PRIVATE, worktreePath: '/wt/other', machineId: 'm_other' }
    const { cache, replica, binding } = bound(
      [['iss_owned', {}], ['iss_other', {}]],
      [['iss_owned', PRIVATE], ['iss_other', OTHER_PRIVATE]],
    )
    const publications: ReplicaPublication[] = []
    const stop = binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0
    // NON-VACUITY: BOTH were there before the removal.
    expect.soft(joined(binding.snapshot(), 'iss_owned')?.worktreePath).toBe(PRIVATE.worktreePath)
    expect.soft(joined(binding.snapshot(), 'iss_other')?.worktreePath).toBe(OTHER_PRIVATE.worktreePath)

    // Eviction, through the kernel's own event rather than a rebuilt list.
    cache.drop('issueExecution', 'iss_owned')
    replica.onKernelEvent({ type: 'evicted', entity: 'issueExecution', entityId: 'iss_owned' })

    expect(publications.length).toBeGreaterThan(0)
    const afterRemoval = publications.at(-1)!.snapshot
    const owned = joined(afterRemoval, 'iss_owned')
    expect.soft(owned).toBeDefined()
    expect.soft(owned?.title).toBe('iss_owned') // the shared half survives
    for (const key of Object.keys(PRIVATE)) {
      expect.soft(Object.hasOwn(owned ?? {}, key)).toBe(false)
    }
    // THE CONTROL: the unrelated issue keeps its OWN sidecar values, so the
    // eviction was targeted rather than a blanket drop.
    const survivor = joined(afterRemoval, 'iss_other')
    expect.soft(survivor?.worktreePath).toBe(OTHER_PRIVATE.worktreePath)
    expect.soft(survivor?.machineId).toBe(OTHER_PRIVATE.machineId)
    stop()
  })

  it('an issue with no sidecar at all is a complete, renderable row', async () => {
    // The NON-OWNER's normal state after the PDM-415 mask: shared row, no
    // sidecar. It must not be an error and must not acquire the keys.
    const { binding } = bound([['iss_shared', {}]], [])
    const row = joined(binding.snapshot(), 'iss_shared')
    expect.soft(row?.title).toBe('iss_shared')
    for (const key of Object.keys(PRIVATE)) {
      expect.soft(Object.hasOwn(row ?? {}, key)).toBe(false)
    }
  })
})

class BindingCache implements KernelCacheRead {
  records: EntityRecord[] = []
  cursor: { seq: number } | null = null
  readCursor(): { seq: number } | null {
    return this.cursor
  }
  readEntities(): readonly EntityRecord[] {
    return this.records
  }
  read(entity: string, entityId: string): EntityRecord | undefined {
    return this.records.find((record) => record.entity === entity && record.entityId === entityId)
  }
  durability(): 'durable' {
    return 'durable'
  }
  put(entity: string, entityId: string, value: unknown): void {
    this.records = [
      ...this.records.filter((record) => record.entity !== entity || record.entityId !== entityId),
      { entity, entityId, value, provenance: { seq: this.cursor?.seq ?? 0 } },
    ]
  }
  drop(entity: string, entityId: string): void {
    this.records = this.records.filter(
      (record) => record.entity !== entity || record.entityId !== entityId,
    )
  }
}
