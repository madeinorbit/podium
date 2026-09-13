import { InMemoryReplicaStore, Replica } from '@podium/sync/replica'
import { describe, expect, it } from 'vitest'
import type { FeedServerFrame } from '../socket-transport'
import { FeedAuthorityClient } from '../replica/feed/authority-client'
import { PushedBootstrapSource } from '../replica/feed/bootstrap-source'
import { FeedSink } from '../replica/feed/sink'
import { createKernelReplica, createSideCache } from '../replica/kernel'
import type { KernelCacheRead } from '../replica/kernel'
import { memoryStorage } from '../replica/replica'
import { createReplicaBinding, type ReplicaPublication } from './replica-binding'

/**
 * **THE OWNER'S REASSEMBLY, THROUGH THE REAL INGESTION PATH** [PDM-448, for PDM-415].
 *
 * PDM-415's server-side witness calls `joinIssueExecution` directly over real
 * serving output. That is the production join FUNCTION but not the production
 * consumer, and it cannot be driven from `apps/server` at all: the `declared-deps`
 * boundary refuses `apps/server` depending on `@podium/client-core`
 * (`modules/interactions/synthesis.ts:204`). So the coverage lives here.
 *
 * WHAT THIS EXERCISES, AS OF THIS COMMIT. Rows arrive as WIRE FRAMES and go in at
 * `FeedSink.frame()` — the real consumer entry point. A `feedBootstrap` is OFFERED
 * to a real `PushedBootstrapSource`, walked by a real `@podium/sync` `Replica`, and
 * installed inside that walk's transaction; subsequent `feedDelta` frames are
 * applied on top. The kernel facade receives the replica's events and
 * `createReplicaBinding` reads the joined rows. Nothing is hand-placed in a cache.
 *
 * TWO FACTS THAT MAKE A CORRECT FIXTURE LOOK BROKEN, learned by getting them wrong:
 * a COLD replica CANNOT apply deltas — with no cursor it must be served a world
 * first (the ADR 2 D7 ladder), and pushing deltas at it yields silently absent rows.
 * And a bootstrap is NOT applied by `sink.frame()`: its arm calls
 * `bootstraps.offer(...)`, so the install is ASYNCHRONOUS and must be awaited with
 * `replica.settled()`. An earlier version of this file placed rows with `cache.put`
 * for exactly these reasons and could not catch a frame-TRANSLATION defect; this one
 * can, and the unrepaired witness below names what it reports when translation is
 * wrong.
 *
 * STILL NOT END-TO-END: the frames are CONSTRUCTED here rather than produced by a
 * running server, because no package depends on both sides and this repair creates
 * none. Said plainly so this and the server-side witness are not summed into a claim
 * neither makes.
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

/** Wire frames, in the shapes the server actually sends. */
type Change = { entity: string; entityId: string; op: 'upsert' | 'remove'; value?: unknown }

const bootstrapFrame = (changes: Change[], seq: number): FeedServerFrame =>
  ({
    type: 'feedBootstrap',
    feedId: 'feed_1',
    epoch: 'epoch_1',
    fromSeq: 0,
    seq,
    minAvailableSeq: 0,
    changes: changes.map((c, i) => ({ ...c, seq: i + 1 })),
    last: true,
  }) as FeedServerFrame

const deltaFrame = (changes: Change[], fromSeq: number): FeedServerFrame =>
  ({
    type: 'feedDelta',
    feedId: 'feed_1',
    epoch: 'epoch_1',
    fromSeq,
    seq: fromSeq + changes.length,
    minAvailableSeq: 0,
    changes: changes.map((c, i) => ({ ...c, seq: fromSeq + i + 1 })),
  }) as FeedServerFrame

interface Harness {
  readonly binding: ReturnType<typeof createReplicaBinding>
  readonly replica: Replica
  /** Apply a delta frame the way the socket does, and wait for it to land. */
  push(changes: Change[]): Promise<void>
}

/**
 * The real ingestion path, assembled in the order the shipped composition roots
 * use: the facade first, because the kernel Replica needs its `onKernelEvent`.
 * A PROPER BOOTSTRAP runs before anything else, which is the ordering the ladder
 * requires and the reviewer specified.
 */
async function ingest(world: Change[]): Promise<Harness> {
  const store = new InMemoryReplicaStore()
  const facade = createKernelReplica({
    cache: store.cache as unknown as KernelCacheRead,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  let sink: FeedSink
  let seq = world.length
  const bootstraps = new PushedBootstrapSource({
    requestFreshWorld: () => sink.frame(bootstrapFrame(world, world.length)),
  })
  const replica = new Replica({
    store: store.cache,
    authority: new FeedAuthorityClient({
      // Never expected to fire: the ladder is driven by the pushed world here.
      // Throwing rather than returning an empty reply means a heal we did not
      // intend shows up as a failure instead of as silently missing rows.
      fetchChangesSince: async () => {
        throw new Error('unexpected heal: this fixture drives the pushed-world path only')
      },
      bootstraps,
    }),
    onEvent: (event: unknown) => facade.onKernelEvent(event as never),
    batchEvents: (emitAll: () => void) => facade.batch(emitAll),
  } as never)
  sink = new FeedSink({ replica, bootstraps } as never)

  // THE PROPER BOOTSTRAP: connect, let the replica ask for a world, push it, and
  // AWAIT THE WALK. Without the await the install has not happened and every row
  // reads absent — which is what the earlier attempt hit.
  sink.connected(true)
  bootstraps.expectWorld()
  sink.frame(bootstrapFrame(world, world.length))
  await replica.settled()

  return {
    binding: createReplicaBinding({ replica: facade }),
    replica,
    push: async (changes) => {
      sink.frame(deltaFrame(changes, seq))
      seq += changes.length
      await replica.settled()
    },
  }
}

/** A world of issues and their sidecars, delivered as a bootstrap. */
const worldOf = (
  issues: [string, Record<string, unknown>][],
  executions: [string, Record<string, unknown>][],
): Change[] => [
  ...issues.map(([id, extra]) => ({ entity: 'issue', entityId: id, op: 'upsert' as const, value: issueRow(id, extra) })),
  ...executions.map(([id, extra]) => ({
    entity: 'issueExecution',
    entityId: id,
    op: 'upsert' as const,
    value: executionRow(id, extra),
  })),
]

const joined = (snapshot: { issues: readonly unknown[] }, id: string) =>
  snapshot.issues.find((row) => (row as { id: string }).id === id) as Record<string, unknown> | undefined

describe('the owner reassembles the private half through the real ingestion path [PDM-448]', () => {
  it('a bootstrap delivers the sidecar joined onto its own issue, and no other', async () => {
    const { binding } = await ingest(
      worldOf([['iss_owned', {}], ['iss_other', {}]], [['iss_owned', PRIVATE]]),
    )
    const snapshot = binding.snapshot()

    const owned = joined(snapshot, 'iss_owned')
    expect.soft(owned?.worktreePath).toBe(PRIVATE.worktreePath)
    expect.soft(owned?.machineId).toBe(PRIVATE.machineId)
    expect.soft(owned?.coordinatorSessionId).toBe(PRIVATE.coordinatorSessionId)
    expect.soft(owned?.startedBySession).toBe(PRIVATE.startedBySession)
    expect.soft(owned?.title).toBe('iss_owned')

    // UNRELATED-ROW CONTROL: a join that spread every sidecar over every issue,
    // or rebuilt the whole list, would pass the assertions above and fail here.
    const other = joined(snapshot, 'iss_other')
    expect.soft(other).toBeDefined()
    for (const key of Object.keys(PRIVATE)) {
      expect.soft(Object.hasOwn(other ?? {}, key)).toBe(false)
    }
  })

  it('an UPDATE delta moves the joined values, and publishes the change as an issue change', async () => {
    const h = await ingest(worldOf([['iss_owned', {}], ['iss_other', {}]], [['iss_owned', PRIVATE]]))
    const publications: ReplicaPublication[] = []
    const stop = h.binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0

    await h.push([
      {
        entity: 'issueExecution',
        entityId: 'iss_owned',
        op: 'upsert',
        value: executionRow('iss_owned', { ...PRIVATE, worktreePath: '/wt/moved' }),
      },
    ])

    // THE PUBLICATION IS MANDATORY, NOT CONDITIONAL [PDM-448]. An earlier version
    // read `publications.at(-1)?.snapshot ?? binding.snapshot()` and guarded its
    // changed-set assertion with `if (publications.length > 0)`, so a binding that
    // published NOTHING passed the whole test. A subscriber re-reads exactly what a
    // publication NAMES; no publication is the defect, not an alternative.
    expect(publications.length).toBeGreaterThan(0)
    const latest = publications.at(-1)!.snapshot

    const owned = joined(latest, 'iss_owned')
    expect.soft(owned?.worktreePath).toBe('/wt/moved')
    // A join computed once at construction would still read the original.
    expect.soft(owned?.worktreePath).not.toBe(PRIVATE.worktreePath)
    // One field moved rather than the joined object being replaced by a partial.
    expect.soft(owned?.machineId).toBe(PRIVATE.machineId)

    // A SIDECAR CHANGE IS AN ISSUE CHANGE to a subscriber keyed on 'issues'.
    expect.soft([...publications.at(-1)!.changed]).toContain('issues')
    // UNRELATED-ROW CONTROL on the update path too.
    expect.soft(Object.hasOwn(joined(latest, 'iss_other') ?? {}, 'worktreePath')).toBe(false)
    stop()
  })

  it('an EVICTION delta takes the private keys off its own row and leaves the other intact', async () => {
    // TWO issues, each with its OWN sidecar: a single-issue fixture cannot tell a
    // targeted eviction from one that drops every sidecar.
    const OTHER_PRIVATE = { ...PRIVATE, worktreePath: '/wt/other', machineId: 'm_other' }
    const h = await ingest(
      worldOf(
        [['iss_owned', {}], ['iss_other', {}]],
        [['iss_owned', PRIVATE], ['iss_other', OTHER_PRIVATE]],
      ),
    )
    const publications: ReplicaPublication[] = []
    const stop = h.binding.start({ publish: (publication) => publications.push(publication) })
    await Promise.resolve()
    publications.length = 0

    // NON-VACUITY: both were joined before the eviction.
    expect.soft(joined(h.binding.snapshot(), 'iss_owned')?.worktreePath).toBe(PRIVATE.worktreePath)
    expect.soft(joined(h.binding.snapshot(), 'iss_other')?.worktreePath).toBe(OTHER_PRIVATE.worktreePath)

    await h.push([{ entity: 'issueExecution', entityId: 'iss_owned', op: 'remove' }])

    expect(publications.length).toBeGreaterThan(0)
    const after = publications.at(-1)!.snapshot

    const owned = joined(after, 'iss_owned')
    expect.soft(owned?.title).toBe('iss_owned') // the shared half survives
    for (const key of Object.keys(PRIVATE)) {
      expect.soft(Object.hasOwn(owned ?? {}, key)).toBe(false)
    }
    // THE CONTROL: the unrelated issue keeps its own sidecar values.
    const survivor = joined(after, 'iss_other')
    expect.soft(survivor?.worktreePath).toBe(OTHER_PRIVATE.worktreePath)
    expect.soft(survivor?.machineId).toBe(OTHER_PRIVATE.machineId)
    stop()
  })

  it('an issue with no sidecar at all is a complete, renderable row', async () => {
    // The NON-OWNER's normal state after the PDM-415 mask: shared row, no sidecar.
    // It must not be an error and must not acquire the keys.
    const { binding } = await ingest(worldOf([['iss_shared', {}]], []))
    const row = joined(binding.snapshot(), 'iss_shared')
    expect.soft(row?.title).toBe('iss_shared')
    for (const key of Object.keys(PRIVATE)) {
      expect.soft(Object.hasOwn(row ?? {}, key)).toBe(false)
    }
  })

  /**
   * **THE UNREPAIRED WITNESS** [PDM-448].
   *
   * ITS OWN `it()` ON PURPOSE, and this is the point of it. Every assertion above
   * lives downstream of a bootstrap; if ingestion is broken they do not FAIL so
   * much as find nothing, and a soft assertion that never runs after an early
   * throw is an ABSENCE — which never appears in a failing-name diff. This case
   * asserts the ingestion PREMISE and nothing else, so a broken frame path
   * reports as this named test failing rather than as four tests quietly
   * measuring an empty world.
   *
   * WHAT IT REPORTS IF FRAME TRANSLATION IS WRONG, taken from the rendered output
   * rather than restated: `AssertionError: expected +0 to be 2` (vitest prints the
   * zero as `+0`). The world arrived and carried no rows. That is the sentence to
   * look for.
   *
   * MEASURED, both directions, because a witness that reddens on everything
   * distinguishes nothing:
   *   - translation loses the bootstrap rows -> ALL FIVE cases fail and THIS ONE
   *     names the cause with the line above.
   *   - `joinExecutions` disabled, ingestion intact -> the three join cases fail
   *     and THIS ONE STAYS GREEN, along with the no-sidecar case.
   * So a red here means the frames did not land; a red above it with this one
   * green means they landed and the join is wrong. That separation is why it has
   * its own `it()` rather than a guard at the top of another.
   */
  it('INGESTION PREMISE: the bootstrap actually delivered a world', async () => {
    const { binding } = await ingest(worldOf([['iss_a', {}], ['iss_b', {}]], [['iss_a', PRIVATE]]))
    const snapshot = binding.snapshot()
    expect(snapshot.issues.length).toBe(2)
    expect(snapshot.issueExecutions.length).toBe(1)
  })
})
