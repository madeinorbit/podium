/**
 * A flight deck reads its own mission, whatever else the workspace holds
 * [POD-7431, POD-7414 §4, server-data rules 5 and 8].
 *
 * The deck used to list every live issue and read every session's facts, the
 * observation checkpoint included, before choosing its seats. These tests run
 * the deck over a real store and real session records: one mission (a phase,
 * tasks, a provenance graft with its own child, a departed discovery, a
 * proposal, an internal and an external blocker, resume twins, a headless and
 * a deleted session, an open ask) beside a growing pile of unrelated issues,
 * sessions, checkpoints, provenance and edges. The statements, the rows they
 * fetch and the checkpoints hydrated stay the same as the pile grows.
 */
import {
  asIssueId,
  asSessionId,
  firstAdminMemberId,
  type IssueDeck,
  type IssueDeckNode,
  type IssueId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { afterEach, describe, expect, it } from 'vitest'
import type { IssueRow, SessionRow, SessionStore } from '../../../store'
import { withReadScope } from '../../../store/executor/read-scope'
import { probeStatements, type StatementProbeHolder } from '../../../store/executor/statement-probe'
import { issueRowFixture } from '../../../test-support/issue-row'
import { TEST_MACHINE_ID } from '../../../test-support/machine-id'
import { openTestStore } from '../../../test-support/open-test-store'
import {
  countStatements,
  expectConstantStatements,
  measureAtSizes,
  type StatementPin,
} from '../../../test-support/statement-count'
import { SessionRecords, subjectFacts, subjectMeta } from '../../sessions/records'
import type { Session } from '../../sessions/session'
import { IssueStore } from './core'
import { IssueReportsModule } from './reads'
import type { IssueDeps } from './types'

const AT = '2026-11-23T00:00:00.000Z'
const id = (name: string) => asIssueId(`iss_${name}`)
const sid = (name: string) => asSessionId(name)
const ROOT = id('root')

interface Fixture {
  store: SessionStore
  reports: IssueReportsModule
  hidden: Set<SessionId>
  rows: { total: number; checkpoints: number; issues: number; sessions: number }
}

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

function issue(owner: UserId, seq: number, name: string, patch: Partial<IssueRow> = {}) {
  return {
    ...issueRowFixture({
      id: `iss_${name}`,
      seq,
      title: `Issue ${name}`,
      description: '',
      ownerUserId: owner,
      createdByActor: owner,
      createdByOnBehalfOf: owner,
      stage: 'backlog',
      type: 'task',
      parentId: null,
      draft: false,
      worktreePath: null,
      branch: null,
      needsHuman: false,
      humanQuestion: null,
      dueAt: null,
      machineId: TEST_MACHINE_ID,
    }),
    repoId: undefined,
    revision: undefined,
    ...patch,
  } as IssueRow
}

function session(owner: UserId, name: string, patch: Partial<SessionRow>): SessionRow {
  return {
    id: sid(name),
    ownerUserId: owner,
    agentKind: 'codex',
    cwd: '/repo',
    title: `Session ${name}`,
    name: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: 'hibernated',
    exitCode: null,
    durableLabel: `podium-${name}`,
    createdAt: AT,
    lastActiveAt: AT,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    archived: false,
    workState: null,
    machineId: TEST_MACHINE_ID,
    headless: false,
    issueId: null,
    stoppedAt: null,
    ...patch,
  }
}

async function checkpoint(store: SessionStore, sessionId: SessionId): Promise<void> {
  const lease = await store.observationCheckpoints.advanceGeneration(sessionId, 'codex', null)
  await store.observationCheckpoints.save({
    schemaVersion: 1,
    podiumSessionId: sessionId,
    provider: 'codex',
    providerSessionId: null,
    bindingVersion: lease.bindingVersion,
    lifecycleObservationGeneration: lease.observationGeneration,
    providerCursor: null,
    bootstrapCursor: null,
    lastAcceptedLiveCursor: null,
    turnEpoch: 0,
    providerTurnId: null,
    providerPromptId: null,
    turnState: { phase: 'idle', since: AT, nativeSubagentCount: 0 },
    terminalFence: null,
    providerAt: AT,
    acceptedAt: AT,
    lastLiveReceiptAt: null,
    lastTransitionId: null,
  })
}

/** The mission, plus `unrelated` issues, sessions and edges of other missions. */
async function fixture(
  unrelated: number,
  /** Plant: answer the seat facts from every session's record, as the deck did. */
  wholeTable = false,
): Promise<Fixture> {
  const store = await openTestStore(':memory:', TEST_MACHINE_ID)
  stores.push(store)
  const owner = await firstAdminMemberId(store)
  await store.repos.addRepo('/repo', TEST_MACHINE_ID, undefined, 'POD')
  const root = issue(owner, 1, 'root', { type: 'phase' })
  const mission: IssueRow[] = [
    root,
    issue(owner, 2, 'phase', { type: 'phase', parentId: ROOT }),
    issue(owner, 3, 't1', { parentId: id('phase') }),
    issue(owner, 4, 't2', { parentId: id('phase') }),
    issue(owner, 5, 't3', { parentId: ROOT }),
    // Provenance: started by the session on t3, with its own child.
    issue(owner, 6, 'graft', { startedBySession: sid('author') }),
    issue(owner, 7, 'graft-child', { parentId: id('graft') }),
    // A discovery that left: started, discovered from the root, under way.
    issue(owner, 8, 'departed', { startedBySession: sid('author'), stage: 'in_progress' }),
    issue(owner, 9, 'proposal', { startedBySession: sid('author'), stage: 'proposed' }),
    issue(owner, 10, 'external', { title: 'External blocker' }),
    issue(owner, 11, 'archived-child', { parentId: ROOT, archived: true }),
    issue(owner, 12, 'draft-child', { parentId: ROOT, draft: true }),
  ]
  const sessions: SessionRow[] = [
    session(owner, 'coord', {
      issueId: ROOT,
      status: 'live',
      resumeKind: 'codex',
      resumeValue: 'c-coord',
    }),
    session(owner, 'worker', {
      issueId: id('t1'),
      status: 'live',
      resumeKind: 'codex',
      resumeValue: 'c-worker',
    }),
    session(owner, 'author', { issueId: id('t3') }),
    // Parked twins of one conversation: the newer one sits outside the deck.
    session(owner, 'twin-old', {
      issueId: id('t2'),
      resumeKind: 'codex',
      resumeValue: 'c-shared',
      lastActiveAt: '2026-11-22T00:00:00.000Z',
    }),
    session(owner, 'twin-new', {
      issueId: id('unrelated-1'),
      resumeKind: 'codex',
      resumeValue: 'c-shared',
    }),
    session(owner, 'headless', {
      issueId: id('t1'),
      headless: true,
      resumeKind: 'codex',
      resumeValue: 'c-worker',
    }),
    session(owner, 'gone', { issueId: id('t1'), status: 'live' }),
  ]
  await store.transact(async () => {
    for (const row of mission) await store.issues.upsertIssue(fixtureWriteScope(), row)
    for (let n = 1; n <= unrelated; n++) {
      await store.issues.upsertIssue(
        fixtureWriteScope(),
        issue(owner, 100 + 3 * n, `unrelated-${n}`),
      )
      await store.issues.upsertIssue(
        fixtureWriteScope(),
        issue(owner, 101 + 3 * n, `unrelated-child-${n}`, { parentId: id(`unrelated-${n}`) }),
      )
      await store.issues.upsertIssue(
        fixtureWriteScope(),
        issue(owner, 102 + 3 * n, `unrelated-started-${n}`, {
          startedBySession: sid(`history-${n}`),
          stage: n % 2 ? 'proposed' : 'in_progress',
        }),
      )
    }
    for (const row of sessions) await store.sessions.upsertSession(fixtureWriteScope(), row)
    await store.issues.upsertIssue(fixtureWriteScope(), {
      ...root,
      coordinatorSessionId: sid('coord'),
    })
    for (let n = 1; n <= unrelated; n++) {
      await store.sessions.upsertSession(
        fixtureWriteScope(),
        session(owner, `history-${n}`, {
          issueId: id(`unrelated-${n}`),
          resumeKind: 'codex',
          resumeValue: `c-history-${n}`,
          status: n % 3 ? 'hibernated' : 'live',
        }),
      )
    }
  })
  await store.sessions.softDeleteSessions(fixtureWriteScope(), [sid('gone')], AT, 'standalone')
  for (const name of ['coord', 'worker', 'author', 'twin-old', 'twin-new'])
    await checkpoint(store, sid(name))
  for (let n = 1; n <= unrelated; n++) await checkpoint(store, sid(`history-${n}`))
  await store.issues.addIssueDep(id('t1'), id('t2'))
  await store.issues.addIssueDep(id('t2'), id('external'))
  await store.issues.addIssueDep(id('departed'), ROOT, 'discovered-from')
  for (let n = 2; n <= unrelated; n++) {
    await store.issues.addIssueDep(id(`unrelated-${n}`), id(`unrelated-${n - 1}`))
    await store.issues.addIssueDep(
      id(`unrelated-started-${n}`),
      id(`unrelated-${n}`),
      'discovered-from',
    )
  }
  await store.interactions.insert({
    id: 'ask',
    sessionId: sid('worker'),
    kind: 'permission',
    payload: {},
    source: 'protocol',
    answerable: 'structured',
    fingerprint: 'ask',
    askedAt: AT,
  })
  for (let n = 1; n <= unrelated; n++) {
    await store.interactions.insert({
      id: `history-ask-${n}`,
      sessionId: sid(`history-${n}`),
      kind: 'permission',
      payload: {},
      source: 'protocol',
      answerable: 'structured',
      fingerprint: `history-ask-${n}`,
      askedAt: AT,
    })
  }

  // The production read path below the issue service: the durable records
  // answer the seat facts and the projection, nothing is resident.
  const resident = new Map<SessionId, Session>()
  const records = new SessionRecords({ store, sessions: resident })
  const hidden = new Set<SessionId>()
  const reports = new IssueReportsModule(
    new IssueStore({
      store,
      readSessionSeatFacts: async (query: Parameters<SessionRecords['seatFacts']>[0]) => {
        const wanted = await records.seatFacts(query)
        if (!wholeTable) return wanted
        const ids = new Set(wanted.map((s) => s.sessionId))
        return (await records.all('plant')).map(subjectFacts).filter((s) => ids.has(s.sessionId))
      },
      readSessionFacts: async () => {
        throw new Error('a deck reads no whole session table')
      },
      sessionsById: async (ids: readonly SessionId[]) =>
        [...(await records.resolve(ids)).values()]
          .filter((s) => !hidden.has(s.sessionId))
          .map(subjectMeta),
    } as unknown as IssueDeps),
  )
  return {
    store,
    reports,
    hidden,
    rows: { total: 0, checkpoints: 0, issues: 0, sessions: 0 },
  }
}

const deck = async (f: Fixture): Promise<IssueDeck> =>
  await withReadScope(async () => await f.reports.deck(ROOT))

const node = (root: IssueDeckNode, issueId: IssueId): IssueDeckNode | undefined =>
  root.id === issueId
    ? root
    : root.children.map((child) => node(child, issueId)).find((found) => found !== undefined)

const shape = (n: IssueDeckNode): unknown => ({
  id: n.id,
  seats: n.sessions.map((s) => `${s.sessionId}:${s.seat}:${s.word}`),
  blockers: n.blockers.map((b) => `${b.id}${b.external ? ':external' : ''}`),
  children: n.children.map(shape),
})

function expectMission(result: IssueDeck): void {
  expect(shape(result.root)).toEqual({
    id: ROOT,
    seats: ['coord:coordinator:idle'],
    blockers: [],
    children: [
      {
        id: id('phase'),
        seats: [],
        blockers: [],
        children: [
          {
            id: id('t1'),
            seats: ['worker:helper:needs-you'],
            blockers: [id('t2')],
            children: [],
          },
          // twin-old's newer twin wins the collapse, and it is not on this deck.
          { id: id('t2'), seats: [], blockers: [`${id('external')}:external`], children: [] },
        ],
      },
      {
        id: id('t3'),
        seats: ['author:helper:idle'],
        blockers: [],
        children: [
          {
            id: id('graft'),
            seats: [],
            blockers: [],
            children: [{ id: id('graft-child'), seats: [], blockers: [], children: [] }],
          },
        ],
      },
    ],
  })
  expect(result.proposals.map((p) => [p.id, p.placement, p.proposedBy?.sessionId])).toEqual([
    [id('proposal'), 'own-issue', sid('author')],
  ])
  expect(JSON.stringify(result)).not.toMatch(
    /departed|archived-child|draft-child|unrelated|history|gone/,
  )
}

const scopePin: StatementPin<Fixture> = {
  name: 'issues.deck over a growing workspace',
  setup: fixture,
  target: (f) => f.store,
  run: (f) => deck(f),
  count: async (f, run) => {
    f.rows = { total: 0, checkpoints: 0, issues: 0, sessions: 0 }
    const detach = probeStatements(f.store as unknown as StatementProbeHolder, (statement) => {
      f.rows.total += statement.rows
      if (statement.sql.includes('from "session_observation_checkpoints"'))
        f.rows.checkpoints += statement.rows
      if (statement.sql.includes('from "issues"')) f.rows.issues += statement.rows
      if (statement.sql.includes('from "sessions"')) f.rows.sessions += statement.rows
    })
    try {
      return await countStatements(f.store, run)
    } finally {
      detach()
    }
  },
  check: (result, f) => {
    rowsBySize.push({ ...f.rows })
    expectMission(result as IssueDeck)
    // The projected candidates only: the seats, the author and both twins.
    expect(f.rows.checkpoints).toBe(5)
  },
}
const rowsBySize: Fixture['rows'][] = []

describe('the flight deck reads only its mission', () => {
  it('runs the same statements and fetches the same rows as unrelated history grows', async () => {
    rowsBySize.length = 0
    await expectConstantStatements(scopePin, 23)
    expect(rowsBySize).toHaveLength(2)
    expect(rowsBySize[1]).toEqual(rowsBySize[0])
  })

  it('fails the row pin when the seats are chosen from every session', async () => {
    rowsBySize.length = 0
    await measureAtSizes({
      ...scopePin,
      setup: (size) => fixture(size, true),
      check: (_result, f) => void rowsBySize.push({ ...f.rows }),
    })
    const [small, large] = rowsBySize
    expect(large?.sessions).toBeGreaterThan(small?.sessions ?? Number.POSITIVE_INFINITY)
    expect(large?.checkpoints).toBeGreaterThan(small?.checkpoints ?? Number.POSITIVE_INFINITY)
  })

  it('lets neither a private author graft provenance nor a private twin hide a seat', async () => {
    const f = await fixture(3)
    expectMission(await deck(f))
    f.hidden.add(sid('twin-new'))
    const twin = await deck(f)
    expect(node(twin.root, id('t2'))?.sessions.map((s) => s.sessionId)).toEqual([sid('twin-old')])
    f.hidden.clear()
    f.hidden.add(sid('author'))
    const privateAuthor = await deck(f)
    expect(node(privateAuthor.root, id('t3'))?.children).toEqual([])
    expect(node(privateAuthor.root, id('t3'))?.sessions).toEqual([])
    expect(privateAuthor.proposals).toEqual([])
    expect(JSON.stringify(privateAuthor)).not.toContain('graft')
  })
})
