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
import { asIssueId, asUserId, firstAdminMemberId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IssueRow, SessionStore } from '../../store'
import { applyAfterCommit, spanOpen } from '../../store/executor/executor'
import { OPERATOR } from '../../test-support/capabilities'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements, type StatementPin } from '../../test-support/statement-count'
import { IssueCommandCtx } from './command-ctx'
import { issueRegistry } from './registry'
import { IssueStore } from './service/core'
import { IssueReportsModule } from './service/reads'
import { type IssueMapParityMode, setIssueMapParityMode } from './service/map-parity'
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
}

/**
 * `size` children under one phase. Every third child belongs to someone else and
 * is shared with the reader; every fifth belongs to someone else and is not.
 * Every other child is closed, and each open child depends on the next open
 * one, so ready and blocked both have rows.
 */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/repo', store.hostMachineId, undefined, 'POD')
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
    for (const issue of rows) await store.issues.upsertIssue(issue)
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
  const issues = await new IssueStore({
    store,
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
    sessionFacts: () => [],
    runningSessionFacts: () => [],
    readSessionFacts: async () => [],
    readSessionFactsById: async () => undefined,
    readSessionFactsByIssue: async () => [],
    sessionsById: async () => [],
  } as unknown as IssueDeps).init()
  return { store, reports: new IssueReportsModule(issues) }
}

/** Children the reader may see: owned, or shared (every third). */
const readableChildren = (size: number) =>
  Array.from({ length: size }, (_, i) => i).filter((i) => i % 3 === 0 || i % 5 !== 0).length

const call = async (f: Fixture, name: keyof typeof issueRegistry.defs, input: unknown) => {
  const ctx = new IssueCommandCtx(
    { issues: { reports: f.reports } } as never,
    { capability: OPERATOR, principal: { kind: 'user', user: reader, capability: OPERATOR } },
    name,
  )
  const handler = issueRegistry.defs[name].handler as (ctx: unknown, input: unknown) => Promise<unknown>
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

describe('issue listings: pinned statement counts at 5 and 200 issues', () => {
  // The pins count what production runs. The old/new comparison asks the
  // issue map's code beside every listing in development builds and tests
  // (POD-6158), and its legacy side has statements of its own.
  let parity: IssueMapParityMode
  beforeAll(() => {
    parity = setIssueMapParityMode('off')
  })
  afterAll(() => {
    setIssueMapParityMode(parity)
  })

  it('list: labels, deps, comment counts and one grant read (was 9 at 5 issues, 204 at 200)', async () => {
    await expectConstantStatements(
      pin('issues.list', (f) => call(f, 'list', {}), (rows, size) =>
        expect(lengthOf(rows)).toBe(readableChildren(size) + 1),
      ),
      10,
    )
  })

  it('ready', async () => {
    await expectConstantStatements(
      pin('issues.ready', (f) => call(f, 'ready', {}), (rows) => expect(lengthOf(rows)).toBeGreaterThan(0)),
      9,
    )
  })

  it('blocked (was 5 at 5 issues, 102 at 200)', async () => {
    await expectConstantStatements(
      pin('issues.blocked', (f) => call(f, 'blocked', {}), (rows) => expect(lengthOf(rows)).toBeGreaterThan(0)),
      10,
    )
  })

  it('graph (was 9 at 5 issues, 204 at 200)', async () => {
    await expectConstantStatements(
      pin('issues.graph', (f) => call(f, 'graph', {}), (graph, size) =>
        expect((graph as { nodes: unknown[] }).nodes).toHaveLength(readableChildren(size) + 1),
      ),
      12,
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
      8,
    )
  })

  it('doctor: its own dep read plus lint and stale (was 23 at 5 issues, 581 at 200)', async () => {
    await expectConstantStatements(
      pin('issues.doctor', (f) => call(f, 'doctor', {}), (report) =>
        expect(report).toMatchObject({ cycles: [] }),
      ),
      3,
    )
  })

  it('one issue report (unbatched report())', async () => {
    await expectConstantStatements(
      pin('issues.get', (f) => f.reports.get('iss_2'), (report) => expect(report).toMatchObject({ seq: 2 })),
      10,
    )
  })
})
