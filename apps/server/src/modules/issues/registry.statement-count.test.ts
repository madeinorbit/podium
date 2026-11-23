import { asIssueId, asSessionId, asUserId, firstAdminMemberId, type IssueDeck } from '@podium/model'
/**
 * Issue reports and listings run a fixed number of statements, whatever the
 * number of issues [POD-6149, server-data rule 8].
 *
 * No WorldIndex is bound, so grants come from the database — the state the
 * world-index removal (POD-6155) leaves behind.
 *
 * Since POD-6191 a listing is one SQL statement that filters, applies the
 * reader's visibility and orders; the joins a report needs are read for the
 * listed rows only: labels, both dependency directions, live children,
 * comment counts, the broadcast viewer's markers (after the viewer itself,
 * two `users` reads once per operation) and the closure of the rows'
 * blockers when there are any. Before, every listing read the whole label,
 * dependency and comment tables and one grant set per row from the issue map's
 * rows; `doctor` reads only its listing and the dependencies now.
 */
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it, vi } from 'vitest'
import type { CommandPrincipal } from '../../command-principal'
import type { IssueRow, SessionStore } from '../../store'
import { probeStatements, type StatementProbeHolder } from '../../store/executor/statement-probe'
import { OPERATOR } from '../../test-support/capabilities'
import { TEST_MACHINE_ID } from '../../test-support/machine-id'
import { openTestStore } from '../../test-support/open-test-store'
import {
  countStatements,
  expectArmed,
  expectConstantStatements,
  type StatementPin,
} from '../../test-support/statement-count'
import { IssueCommandCtx } from './command-ctx'
import { issueRegistry } from './registry'
import { IssueStore } from './service/core'
import { IssueReportsModule } from './service/reads'
import type { IssueDeps } from './service/types'

const reader = asUserId('reader')
const other = asUserId('other')

function row(seq: number, patch: Partial<IssueRow> = {}): IssueRow {
  return {
    id: asIssueId(`iss_${seq}`),
    repoPath: '/repo',
    seq,
    title: `Issue ${seq}`,
    description: '',
    ownerUserId: reader,
    visibility: 'personal',
    createdByActor: firstAdminMemberId(),
    createdByOnBehalfOf: null,
    stage: 'backlog',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'codex',
    defaultModel: 'auto',
    defaultEffort: 'auto',
    linearId: null,
    linearIdentifier: null,
    linearUrl: null,
    activityNotes: null,
    notesUpdatedAt: null,
    suggestedStage: null,
    suggestedReason: null,
    blockedBy: [],
    dependencyNote: null,
    prUrl: null,
    priority: 2,
    type: 'task',
    assignee: null,
    parentId: null,
    acceptance: null,
    dueAt: null,
    deferUntil: null,
    closedReason: null,
    closedAt: null,
    supersededBy: null,
    duplicateOf: null,
    estimateMin: null,
    needsHuman: false,
    humanQuestion: null,
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    archived: false,
    ...patch,
  }
}

interface Fixture {
  store: SessionStore
  reports: IssueReportsModule
  issueRowsRead: number
}

/**
 * `size` children under one phase. Every third child belongs to someone else and
 * is shared with the reader; every fifth belongs to someone else and is not.
 * Every other child is closed, and each open child depends on the next open
 * one, so ready and blocked both have rows.
 */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:', TEST_MACHINE_ID)
  await store.repos.addRepo('/repo', TEST_MACHINE_ID, undefined, 'POD')
  const rows = [
    row(1, { type: 'phase' }),
    ...Array.from({ length: size }, (_, i) =>
      row(i + 2, {
        parentId: asIssueId('iss_1'),
        ownerUserId: i % 3 === 0 || i % 5 === 0 ? other : reader,
        ...(i % 2 === 1 ? { stage: 'done', closedAt: '2026-10-03T00:00:00.000Z' } : {}),
      }),
    ),
  ]
  await store.transact(async () => {
    for (const issue of rows) await store.issues.upsertIssue(fixtureWriteScope(), issue)
    // Open children are the even seqs; each depends on the next open one.
    for (let seq = 2; seq + 2 <= size + 1; seq += 2) {
      await store.issues.addIssueDep(asIssueId(`iss_${seq}`), asIssueId(`iss_${seq + 2}`))
    }
    for (let i = 0; i < size; i++) {
      if (i % 3 !== 0) continue
      await store.grants.upsert({
        resourceKind: 'issue',
        resourceId: `iss_${i + 2}`,
        grantee: reader,
        verb: 'read',
        owner: other,
        visibility: 'private',
        createdAt: '2026-10-02T00:00:00.000Z',
        actorKind: 'user',
        actorId: other,
        onBehalfOf: null,
      })
    }
  })
  const issues = new IssueStore({
    store,
    runningSessionFacts: () => [],
    readSessionFacts: async () => [],
    readSessionSeatFacts: async () => [],
    readSessionFactsById: async () => undefined,
    readSessionFactsByIssue: async () => [],
    sessionsById: async () => [],
  } as unknown as IssueDeps)
  return { store, reports: new IssueReportsModule(issues), issueRowsRead: 0 }
}

/** Children the reader may see: every one. Every member reads every task
 *  (design §2.2, §4.1; POD-6288 6d0dc46741), so the other member's unshared
 *  children are listed too and the legacy grants decide nothing. */
const readableChildren = (size: number) => size

const call = async (
  f: Fixture,
  name: keyof typeof issueRegistry.defs,
  input: unknown,
  principal: CommandPrincipal | null = {
    kind: 'user',
    user: reader,
    capability: OPERATOR,
  },
) => {
  const ctx = new IssueCommandCtx(
    { issues: { reports: f.reports } } as never,
    { capability: OPERATOR, ...(principal ? { principal } : {}) },
    name,
  )
  const handler = issueRegistry.defs[name].handler as (
    ctx: unknown,
    input: unknown,
  ) => Promise<unknown>
  return await handler(ctx, input)
}

const pin = (
  name: string,
  run: (f: Fixture) => Promise<unknown>,
  check: (result: unknown, size: number) => void,
): StatementPin<Fixture> => ({
  name,
  setup: fixture,
  target: (f) => f.store,
  run,
  check: (result, _f, size) => check(result, size),
  teardown: async (f) => await f.store.close(),
})

const lengthOf = (value: unknown) => (value as unknown[]).length

const deckPin: StatementPin<Fixture> = {
  name: 'issues.deck',
  setup: fixture,
  target: (f) => f.store,
  run: (f) => call(f, 'deck', { id: 'iss_1' }),
  count: async (f, run) => {
    f.issueRowsRead = 0
    const detach = probeStatements(f.store as unknown as StatementProbeHolder, (statement) => {
      if (statement.sql.includes('from "issues"')) f.issueRowsRead += statement.rows
    })
    try {
      return await countStatements(f.store, run)
    } finally {
      detach()
    }
  },
  check: (result, f, size) => {
    const deck = result as IssueDeck
    expect(deck.root.children).toHaveLength(size)
    expect(deck.counts.total).toBe(size)
    expect(deck.root.children.some((child) => child.blockers.length > 0)).toBe(true)
    // Root, its children (the mission's rows only, POD-7431), and distinct
    // blocker targets. Authorization fetches no rows of its own, even for the
    // other member's unshared issues.
    expect(f.issueRowsRead).toBe(1 + size + Math.floor((size - 1) / 2))
  },
  teardown: async (f) => await f.store.close(),
}

// POD-6218: the earliest admin is one statement (the row), not the id and then
// the row: list, ready, blocked, graph and get each -1.
// POD-6341, measured on the polaris VM over c2f8c0c3a6 and its fixes: tasks
// are shared (POD-6288 6d0dc46741), so no listing reads issue grants any more,
// and POD-6296 (3839188bcb, after the comparison's tip a0a1ebc335) names
// assignees on a shared instance with `users` reads (#83795ded): list 9 (one
// users read, no grant read), ready 8 -> 7 at a0a1ebc335 and 9 with POD-6296's
// two users reads (its shared-instance default and the names), blocked 9 -> 8,
// graph 11 -> 9 (no grant read and no users read), tree 8 -> 7 (no grant reads,
// one users read). graph and tree were never counted at a0a1ebc335: their row
// checks failed first, because the listings now return every task.
// Panel report DTOs read each normalized table once per batch.
describe('issue listings: pinned statement counts at 5 and 200 issues', () => {
  it('deck: authorizes loaded rows without a query per issue or blocker', async () => {
    // Root, two subtree levels, dependencies, blocker targets, and names; no
    // session is projected, so no asks are read (POD-7431).
    await expectConstantStatements(deckPin, 6)
  })

  // The deck asks a level's rows together, so even the old per-ID policy now
  // batches through the row loader (POD-7431). A live read per row still grows.
  it('deck pin detects an authorization read per loaded row', async () => {
    await expectArmed(deckPin, 6, () => {
      const issueReader = IssueCommandCtx.prototype.issueReader
      const spy = vi.spyOn(IssueCommandCtx.prototype, 'issueReader').mockImplementation(function (
        this: IssueCommandCtx,
      ) {
        const reader = issueReader.call(this)
        const issues = (this.reports as unknown as IssueReportsModule).store.deps.store.issues
        return {
          viewer: reader.viewer,
          mayRead: reader.mayRead,
          mayReadRow: async (row: IssueRow) => (await issues.getIssueLive(row.id)) !== null,
        }
      })
      return () => spy.mockRestore()
    })
  })

  it('deck admits an agent acting for a human and rejects callers without one', async () => {
    const f = await fixture(5)
    try {
      expect(
        await call(
          f,
          'deck',
          { id: 'iss_1' },
          {
            kind: 'agent',
            agentSessionId: asSessionId('agent'),
            onBehalfOf: reader,
            capability: OPERATOR,
            chain: [],
          },
        ),
      ).toMatchObject({ counts: { total: 5 } })
      const denied = await countStatements(f.store, async () => {
        await expect(
          call(f, 'deck', { id: 'iss_1' }, { kind: 'system', job: 'test' }),
        ).rejects.toThrow('issue reads require a human principal')
        await expect(call(f, 'deck', { id: 'iss_1' }, null)).rejects.toThrow(
          'issue reads require a human principal',
        )
      })
      expect(denied.statements).toBe(0)
      await expect(call(f, 'deck', { id: 'iss_absent' })).rejects.toThrow()
    } finally {
      await f.store.close()
    }
  })

  it('list: labels, deps, comment counts and one grant read (was 9 at 5 issues, 204 at 200)', async () => {
    await expectConstantStatements(
      pin(
        'issues.list',
        (f) => call(f, 'list', {}),
        (rows, size) => expect(lengthOf(rows)).toBe(readableChildren(size) + 1),
      ),
      14,
    )
  })

  it('ready', async () => {
    await expectConstantStatements(
      pin(
        'issues.ready',
        (f) => call(f, 'ready', {}),
        (rows) => expect(lengthOf(rows)).toBeGreaterThan(0),
      ),
      14,
    )
  })

  it('blocked (was 5 at 5 issues, 102 at 200)', async () => {
    await expectConstantStatements(
      pin(
        'issues.blocked',
        (f) => call(f, 'blocked', {}),
        (rows) => expect(lengthOf(rows)).toBeGreaterThan(0),
      ),
      13,
    )
  })

  it('graph (was 9 at 5 issues, 204 at 200)', async () => {
    await expectConstantStatements(
      pin(
        'issues.graph',
        (f) => call(f, 'graph', {}),
        (graph, size) =>
          expect((graph as { nodes: unknown[] }).nodes).toHaveLength(readableChildren(size) + 1),
      ),
      10,
    )
  })

  it('tree: deps, the root grant read and one for its children (was 10 at 5 issues, 289 at 200)', async () => {
    await expectConstantStatements(
      pin(
        'issues.tree',
        (f) => call(f, 'tree', { id: 'iss_1', maxNodes: 1000 }),
        (tree, size) =>
          expect((tree as { root: { children: unknown[] } }).root.children).toHaveLength(
            readableChildren(size),
          ),
      ),
      7,
    )
  })

  it('doctor: its own dep read plus lint and stale (was 23 at 5 issues, 581 at 200)', async () => {
    await expectConstantStatements(
      pin(
        'issues.doctor',
        (f) => call(f, 'doctor', {}),
        (report) => expect(report).toMatchObject({ cycles: [] }),
      ),
      3,
    )
  })

  it('one issue report (unbatched report())', async () => {
    await expectConstantStatements(
      pin(
        'issues.get',
        (f) => f.reports.get('iss_2'),
        (report) => expect(report).toMatchObject({ seq: 2 }),
      ),
      14,
    )
  })
})
