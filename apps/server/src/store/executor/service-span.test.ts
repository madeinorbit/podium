/**
 * THE TWO SHAPES THE DESIGN HAS TO SURVIVE [POD-3248].
 *
 * Nothing here is wired into production. These are FIXTURES: the two service
 * shapes that would break a scheduler design that only ever saw a repository
 * call, reproduced small enough to reason about and driven through the real
 * executor.
 *
 *   1. A SERVICE-SHAPED WRITE CLOSURE OVER NARROWED DEPS. Services do not hold
 *      the store; they hold lambdas built in `relay.ts`
 *      (`shippingCommitMany: (entries, write) => issues.shippingCommitMany(entries, write)`).
 *      So the unit of work cannot be threaded through a parameter without
 *      rewriting every narrowed port: the transaction has to reach the closure
 *      ambiently, and the closure runs INSIDE somebody else's span.
 *
 *   2. THE CROSS-SERVICE SPAN `issues.shippingCommitMany`
 *      (`modules/shipping/service.ts:2204-2215`). Shipping builds a `write`
 *      closure over its own repository and hands it to the ISSUES service,
 *      which fences the issue stages, mutates process-owned issue rows, runs
 *      the shipping closure, and publishes events — one atomic span across two
 *      services and two repositories, with the caller's write in the middle of
 *      it.
 *
 * The failure a naive design gives here is not a crash. It is a partial commit
 * with the in-memory issue rows already mutated: exactly what today's
 * mutate-then-restore-by-assignment produces once an await sits between the
 * mutation and the rollback.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { QueryClient } from './driver'
import { postCommit, type StoreExecutor } from './executor'
import { barrier, type Harness, openHarness, settle } from './harness'

const SCHEMA = `
  CREATE TABLE issues (
    id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    needs_human INTEGER NOT NULL,
    revision INTEGER NOT NULL
  );
  CREATE TABLE ship_edges (upper TEXT NOT NULL, lower TEXT NOT NULL);
`

interface IssueRow {
  readonly id: string
  readonly stage: string
  readonly needsHuman: boolean
  readonly revision: number
}

interface ShippingMutation {
  readonly expectedStage: string
  readonly needsHuman: boolean
  readonly nextStage?: string
}

// ---------------------------------------------------------------------------
// Repositories: bound to an executor, returning domain rows, never a handle.
// ---------------------------------------------------------------------------

class IssueRepository {
  constructor(private readonly executor: StoreExecutor<QueryClient>) {}

  async row(id: string): Promise<IssueRow | undefined> {
    const found = (await this.executor.drizzle.get(
      'SELECT id, stage, needs_human, revision FROM issues WHERE id = ?',
      id,
    )) as { id: string; stage: string; needs_human: number; revision: number } | undefined
    if (!found) return undefined
    return {
      id: found.id,
      stage: found.stage,
      needsHuman: found.needs_human === 1,
      revision: found.revision,
    }
  }

  async persist(row: IssueRow): Promise<void> {
    await this.executor.drizzle.run(
      'INSERT INTO issues (id, stage, needs_human, revision) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET stage = excluded.stage, ' +
        'needs_human = excluded.needs_human, revision = excluded.revision',
      row.id,
      row.stage,
      row.needsHuman ? 1 : 0,
      row.revision,
    )
  }
}

class ShipEdgeRepository {
  constructor(private readonly executor: StoreExecutor<QueryClient>) {}

  async record(upper: string, lower: string): Promise<void> {
    await this.executor.drizzle.run(
      'INSERT INTO ship_edges (upper, lower) VALUES (?, ?)',
      upper,
      lower,
    )
  }

  async count(): Promise<number> {
    const row = (await this.executor.drizzle.get('SELECT COUNT(*) AS n FROM ship_edges')) as {
      n: number
    }
    return row.n
  }
}

// ---------------------------------------------------------------------------
// The issues service: owns the span, the fence, and the process-owned rows.
// ---------------------------------------------------------------------------

class IssueService {
  /** The process-owned rows other services read without touching the store. */
  readonly installed = new Map<string, IssueRow>()
  readonly emitted: string[] = []

  constructor(
    private readonly executor: StoreExecutor<QueryClient>,
    private readonly repository: IssueRepository,
  ) {}

  /**
   * The cross-service span. `write` is the CALLER's closure over the caller's
   * own repository: it must run inside this transaction, and its failure must
   * take the issue rows down with it.
   */
  async shippingCommitMany<T>(
    entries: readonly { id: string; mutation: ShippingMutation }[],
    write: () => Promise<T>,
  ): Promise<{ issues: IssueRow[]; result: T }> {
    if (entries.length === 0) throw new Error('shipping batch requires an affected issue')
    return this.executor.transact(async () => {
      const rows: IssueRow[] = []
      for (const entry of entries) {
        const row = await this.repository.row(entry.id)
        if (!row) throw new Error(`issue ${entry.id} not found`)
        if (row.stage !== entry.mutation.expectedStage) {
          throw new Error(
            `issue ${row.id} shipping stage fence failed: expected ${entry.mutation.expectedStage}`,
          )
        }
        rows.push(row)
      }
      // DRAFTS, not mutation of the installed rows: with an await between here
      // and the commit, mutate-then-restore would leave another reader looking
      // at a stage that never committed.
      const drafts = rows.map((row, index) => {
        const mutation = (entries[index] as { mutation: ShippingMutation }).mutation
        return {
          id: row.id,
          stage: mutation.nextStage ?? row.stage,
          needsHuman: mutation.needsHuman,
          revision: row.revision + 1,
        }
      })
      for (const draft of drafts) await this.repository.persist(draft)

      const result = await write()

      postCommit().applyCommit(() => {
        for (const draft of drafts) this.installed.set(draft.id, draft)
      }, 'install-issue-rows')
      postCommit().effect(() => {
        for (const draft of drafts) this.emitted.push(`issue.updated:${draft.id}`)
      }, 'emit-issue-events')
      return { issues: drafts, result }
    })
  }
}

// ---------------------------------------------------------------------------
// The shipping service: narrowed deps only, exactly as `relay.ts` builds them.
// ---------------------------------------------------------------------------

interface ShippingDeps {
  readonly repository: { record(upper: string, lower: string): Promise<void> }
  readonly issues: {
    shippingCommitMany<T>(
      entries: readonly { id: string; mutation: ShippingMutation }[],
      write: () => Promise<T>,
    ): Promise<{ issues: IssueRow[]; result: T }>
  }
  readonly ledger: { commit<T>(op: { write: () => Promise<T> }): Promise<{ result: T }> }
}

class ShippingService {
  constructor(private readonly deps: ShippingDeps) {}

  async recordDiscoveredEdges(
    discovered: readonly { upper: string; lower: string }[],
    affected: readonly string[],
  ): Promise<number> {
    const write = async (): Promise<number> => {
      for (const edge of discovered) await this.deps.repository.record(edge.upper, edge.lower)
      return discovered.length
    }
    if (affected.length === 0) {
      const { result } = await this.deps.ledger.commit({ write })
      return result
    }
    const { result } = await this.deps.issues.shippingCommitMany(
      affected.map((id) => ({
        id,
        mutation: { expectedStage: 'shipping', needsHuman: true, nextStage: 'shipping' },
      })),
      write,
    )
    return result
  }
}

// ---------------------------------------------------------------------------

let harness: Harness | undefined

interface Fixture {
  h: Harness
  issues: IssueService
  shipping: ShippingService
  edges: ShipEdgeRepository
}

async function fixture(): Promise<Fixture> {
  const h = openHarness({ schema: SCHEMA })
  harness = h
  const issueRepository = new IssueRepository(h.executor)
  const edges = new ShipEdgeRepository(h.executor)
  const issues = new IssueService(h.executor, issueRepository)
  // The narrowing `relay.ts` does: lambdas, not the service, not the store.
  const shipping = new ShippingService({
    repository: { record: (upper, lower) => edges.record(upper, lower) },
    issues: { shippingCommitMany: (entries, write) => issues.shippingCommitMany(entries, write) },
    // The ledger opens its own span, as the real one does: the branch matters
    // because it is the SAME closure, run under a different owner's unit of work.
    ledger: {
      commit: ({ write }) => h.executor.transact(async () => ({ result: await write() })),
    },
  })
  for (const id of ['i1', 'i2']) {
    await issueRepository.persist({ id, stage: 'shipping', needsHuman: false, revision: 1 })
    issues.installed.set(id, { id, stage: 'shipping', needsHuman: false, revision: 1 })
  }
  h.log.clear()
  return { h, issues, shipping, edges }
}

afterEach(async () => {
  const current = harness
  harness = undefined
  await current?.close()
})

/**
 * The transaction boundaries since the last `clear`, with the session tag
 * stripped — after asserting there is only ONE session, which is the claim
 * "one transaction" actually makes. The tag itself is a counter over every
 * session the driver has opened, including the fixture's own setup writes, so
 * pinning its value would pin the fixture rather than the behaviour.
 */
function boundaries(h: Harness): string[] {
  const tagged = h.log.boundaries()
  expect(new Set(tagged.map((entry) => entry.split(':')[0])).size).toBeLessThanOrEqual(1)
  return tagged.map((entry) => entry.slice(entry.indexOf(':') + 1))
}

describe('the cross-service span', () => {
  it('commits both services’ writes in one transaction and publishes after it', async () => {
    const { h, issues, shipping, edges } = await fixture()

    const written = await shipping.recordDiscoveredEdges([{ upper: 'a', lower: 'b' }], ['i1', 'i2'])

    expect(written).toBe(1)
    expect(await edges.count()).toBe(1)
    expect(boundaries(h)).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    expect(issues.installed.get('i1')?.revision).toBe(2)
    await h.executor.effectsSettled()
    expect(issues.emitted).toEqual(['issue.updated:i1', 'issue.updated:i2'])
  })

  it('takes the issue rows down with the caller’s closure when it fails', async () => {
    const { h, issues, edges } = await fixture()
    const before = issues.installed.get('i1')

    await expect(
      issues.shippingCommitMany(
        [{ id: 'i1', mutation: { expectedStage: 'shipping', needsHuman: true } }],
        async () => {
          await settle(2)
          throw new Error('shipping repository failed')
        },
      ),
    ).rejects.toThrow('shipping repository failed')

    expect(boundaries(h)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
    expect(await edges.count()).toBe(0)
    // Nothing was installed and nothing was mutated: the shared row is the very
    // object it was before.
    expect(issues.installed.get('i1')).toBe(before)
    expect(issues.emitted).toEqual([])
  })

  it('fences the stage before anything is written', async () => {
    const { h, issues } = await fixture()
    let closureRan = false
    await expect(
      issues.shippingCommitMany(
        [{ id: 'i1', mutation: { expectedStage: 'review', needsHuman: true } }],
        async () => {
          closureRan = true
          return 1
        },
      ),
    ).rejects.toThrow(/stage fence failed/)
    expect(closureRan).toBe(false)
    expect(issues.installed.get('i1')?.revision).toBe(1)
    expect(boundaries(h)).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
  })

  it('does not let a concurrent reader see the span’s uncommitted stage', async () => {
    // The narrowed-deps case that matters: another service reads an issue
    // through the ROOT executor while the span is open. It must queue behind
    // the write, not read the staged row.
    const { h, issues } = await fixture()
    const reader = new IssueRepository(h.executor)
    const parked = barrier()
    const observed: (string | undefined)[] = []

    const span = issues.shippingCommitMany(
      [{ id: 'i1', mutation: { expectedStage: 'shipping', needsHuman: true, nextStage: 'done' } }],
      async () => {
        await parked.wait()
        return 'ok'
      },
    )
    const read = h.executor.read(async () => {
      observed.push((await reader.row('i1'))?.stage)
    })

    await parked.reached()
    await settle()
    expect(observed, 'the read must be queued behind the open span').toEqual([])

    parked.release()
    await Promise.all([span, read])
    expect(observed).toEqual(['done'])
  })

  it('uses the ledger branch when no issue is affected, still in one transaction', async () => {
    const { h, shipping, edges } = await fixture()
    const written = await shipping.recordDiscoveredEdges([{ upper: 'a', lower: 'b' }], [])
    expect(written).toBe(1)
    expect(await edges.count()).toBe(1)
    expect(boundaries(h)).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
  })
})
