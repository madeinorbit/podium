/**
 * POD-7431: before/after flight deck reads on the POD-7414 §4 populations.
 * Run on an agent VM:
 * bun --conditions=@podium/source scripts/server-data-bench/deck-scope.ts
 *
 * One generated, disposable SQLite store per scale holds the report's workspace
 * (7,884 live unarchived issues, 6,992 sessions, 4,914 observation checkpoints
 * of about 11 KiB) around one realistic mission: two phases of tasks, direct
 * tasks, provenance grafts with children, a departed discovery, proposals,
 * internal and external blockers, seats with resume twins outside the deck and
 * open asks. The ×2 scale doubles everything but the mission.
 *
 * Both arms run the real command reader, read scope, repositories and durable
 * session records; the projection is `SessionRecords.resolve` → `subjectMeta`.
 * The before arm is `readDeck` as it was at d994f65a2e
 * (`deck-scope-before.ts`), fed every session's facts. The after arm is the
 * current deck. Five alternating pairs per scale after one warm-up each; setup
 * is excluded. Both arms must produce the same deck, byte for byte.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asIssueId,
  asSessionId,
  firstAdminMemberId,
  type IssueId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { userCommandPrincipal } from '../../apps/server/src/command-principal'
import { IssueCommandCtx } from '../../apps/server/src/modules/issues/command-ctx'
import { assigneeNames } from '../../apps/server/src/modules/issues/service/assignee-filter'
import { IssueStore } from '../../apps/server/src/modules/issues/service/core'
import { IssueReportsModule } from '../../apps/server/src/modules/issues/service/reads'
import type { IssueDeps } from '../../apps/server/src/modules/issues/service/types'
import { SessionFactsReader } from '../../apps/server/src/modules/sessions/facts'
import { SessionRecords, subjectMeta } from '../../apps/server/src/modules/sessions/records'
import type { Session } from '../../apps/server/src/modules/sessions/session'
import type { IssueRow, SessionRow, SessionStore } from '../../apps/server/src/store'
import { withReadScope } from '../../apps/server/src/store/executor/read-scope'
import {
  probeStatements,
  type StatementProbeHolder,
} from '../../apps/server/src/store/executor/statement-probe'
import { issueRowFixture } from '../../apps/server/src/test-support/issue-row'
import { TEST_MACHINE_ID } from '../../apps/server/src/test-support/machine-id'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'
import { readDeckBefore } from './deck-scope-before'

const AT = '2026-11-23T00:00:00.000Z'
const ISSUES = 7884
const DRAFTS = 35
const SESSIONS = 6992
const CHECKPOINTS = 4914
const OPEN_ASKS = 60
const PAIRS = 5
/** `DECK_SCOPE_SMOKE=1` checks the script at 2% of the sizes, once. */
const SMOKE = process.env.DECK_SCOPE_SMOKE === '1'
const SCALES = process.env.DECK_SCOPE_SCALES
  ? process.env.DECK_SCOPE_SCALES.split(',').map(Number)
  : SMOKE
    ? [0.02]
    : [1, 2]
const sized = (n: number, scale: number) => Math.round(n * scale)
const ROOT = asIssueId('iss_m_root')

/** The mission: its rows, and the sessions sitting on them. */
function missionRows(owner: UserId): { issues: IssueRow[]; sessions: SessionRow[] } {
  const issues: IssueRow[] = []
  const sessions: SessionRow[] = []
  let seq = 0
  const add = (name: string, patch: Partial<IssueRow> = {}) => {
    const row = issue(owner, ++seq, `m_${name}`, patch)
    issues.push(row)
    return row.id
  }
  const seat = (name: string, issueId: IssueId, patch: Partial<SessionRow> = {}) => {
    sessions.push(session(owner, `m-${name}`, { issueId, ...patch }))
    return asSessionId(`m-${name}`)
  }
  add('root', { type: 'phase' })
  seat('coord', ROOT, { status: 'live', resumeKind: 'codex', resumeValue: 'm-coord' })
  for (const phase of [1, 2]) {
    const phaseId = add(`phase${phase}`, { type: 'phase', parentId: ROOT })
    seat(`lead${phase}`, phaseId, { status: 'live' })
    for (let t = 1; t <= 12; t++) {
      const task = add(`p${phase}t${t}`, {
        parentId: phaseId,
        ...(t % 4 === 0 ? { stage: 'done', closedAt: AT } : {}),
      })
      seat(`p${phase}t${t}`, task, {
        status: t % 3 === 0 ? 'live' : 'hibernated',
        resumeKind: 'codex',
        resumeValue: `m-p${phase}t${t}`,
      })
    }
  }
  for (let t = 1; t <= 6; t++) {
    const task = add(`direct${t}`, { parentId: ROOT })
    const author = seat(`direct${t}`, task)
    if (t > 3) continue
    // Provenance: what this task's session started, with children of its own.
    const graft = add(`graft${t}`, { startedBySession: author })
    add(`graft${t}a`, { parentId: graft })
    add(`graft${t}b`, { parentId: graft })
    add(`proposal${t}`, { startedBySession: author, stage: 'proposed' })
    add(`departed${t}`, { startedBySession: author, stage: 'in_progress' })
  }
  for (let x = 1; x <= 5; x++) add(`external${x}`)
  return { issues, sessions }
}

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
      parentId: null,
      draft: false,
      stage: 'backlog',
      type: 'task',
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
    id: asSessionId(name),
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

async function checkpoint(store: SessionStore, id: SessionId): Promise<void> {
  const lease = await store.observationCheckpoints.advanceGeneration(id, 'codex', null)
  await store.observationCheckpoints.save({
    schemaVersion: 1,
    podiumSessionId: id,
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
    // Roughly 11 KiB of valid checkpoint JSON, the report's payload order of
    // magnitude, as in deck-authorization.ts.
    lastTransitionId: `synthetic-${'x'.repeat(10600)}`,
  })
}

async function seed(store: SessionStore, scale: number) {
  const owner = await firstAdminMemberId(store)
  await store.repos.addRepo('/repo', TEST_MACHINE_ID, undefined, 'POD')
  const mission = missionRows(owner)
  const issues = sized(ISSUES, scale)
  const sessions = sized(SESSIONS, scale)
  const unrelatedIssues = issues - mission.issues.length
  const unrelatedSessions = sessions - mission.sessions.length
  const other = (n: number) => asIssueId(`iss_u_${n}`)
  await store.transact(async () => {
    for (const row of mission.issues) await store.issues.upsertIssue(fixtureWriteScope(), row)
    for (let n = 1; n <= unrelatedIssues; n++) {
      await store.issues.upsertIssue(
        fixtureWriteScope(),
        issue(owner, 1000 + n, `u_${n}`, {
          // Other missions: every tenth issue a root, the rest its children.
          parentId: n % 10 === 1 ? null : other(n - ((n - 1) % 10)),
          draft: n > unrelatedIssues - sized(DRAFTS, scale),
          // Every 25th was started by an unrelated session.
          ...(n % 25 === 0 ? { startedBySession: asSessionId(`u-${n % unrelatedSessions}`) } : {}),
        }),
      )
    }
    for (const row of mission.sessions) await store.sessions.upsertSession(fixtureWriteScope(), row)
    // Twins of three mission seats, parked on other missions.
    for (const t of [1, 2, 3]) {
      await store.sessions.upsertSession(
        fixtureWriteScope(),
        session(owner, `twin-${t}`, {
          issueId: other(10 * t + 1),
          resumeKind: 'codex',
          resumeValue: `m-p1t${t}`,
          lastActiveAt: '2026-11-22T00:00:00.000Z',
        }),
      )
    }
    for (let n = 0; n < unrelatedSessions - 3; n++) {
      await store.sessions.upsertSession(
        fixtureWriteScope(),
        session(owner, `u-${n}`, {
          issueId: other(1 + (n % unrelatedIssues)),
          status: n % 7 === 0 ? 'live' : 'hibernated',
          ...(n % 2 === 0 ? { resumeKind: 'codex', resumeValue: `u-${n}` } : {}),
        }),
      )
    }
  })
  const missionSessions = [
    ...mission.sessions.map((s) => s.id),
    ...[1, 2, 3].map((t) => asSessionId(`twin-${t}`)),
  ]
  for (const id of missionSessions) await checkpoint(store, id)
  for (let n = 0; n < sized(CHECKPOINTS, scale) - missionSessions.length; n++)
    await checkpoint(store, asSessionId(`u-${n}`))
  // Edges: the mission's chain, its external blockers and discoveries, and
  // the other missions' own.
  await store.issues.addIssueDep(asIssueId('iss_m_p1t1'), asIssueId('iss_m_p1t2'))
  await store.issues.addIssueDep(asIssueId('iss_m_p1t2'), asIssueId('iss_m_p2t1'))
  for (let x = 1; x <= 5; x++)
    await store.issues.addIssueDep(asIssueId(`iss_m_p2t${x}`), asIssueId(`iss_m_external${x}`))
  for (let t = 1; t <= 3; t++)
    await store.issues.addIssueDep(asIssueId(`iss_m_departed${t}`), ROOT, 'discovered-from')
  for (let n = 2; n <= unrelatedIssues; n += 3)
    await store.issues.addIssueDep(other(n), other(n - 1))
  for (const [n, id] of [
    ...Array.from(
      { length: sized(OPEN_ASKS, scale) },
      (_, n) => [n, asSessionId(`u-${n * 11}`)] as const,
    ),
    [-1, asSessionId('m-p1t3')] as const,
    [-2, asSessionId('m-coord')] as const,
  ]) {
    await store.interactions.insert({
      id: `ask-${n}`,
      sessionId: id,
      kind: 'permission',
      payload: {},
      source: 'protocol',
      answerable: 'structured',
      fingerprint: `ask-${n}`,
      askedAt: AT,
    })
  }
  return { owner, issues, sessions, missionIssues: mission.issues.length }
}

interface Sample {
  wallMs: number
  sqlMs: number
  statements: number
  rows: number
  issueRows: number
  sessionRows: number
  depRows: number
  checkpointRows: number
  checkpointStatements: number
  /** SQL milliseconds per statement text, this run. */
  bySql: Map<string, number>
}

const results: unknown[] = []
for (const scale of SCALES) {
  const directory = await mkdtemp(join(tmpdir(), 'podium-deck-scope-'))
  const store = await openTestStore(join(directory, 'bench.db'), TEST_MACHINE_ID)
  try {
    const seeded = await seed(store, scale)
    const resident = new Map<SessionId, Session>()
    const records = new SessionRecords({ store, sessions: resident })
    const facts = new SessionFactsReader(resident, records)
    const issueStore = new IssueStore({
      store,
      readSessionFacts: async () => await facts.readAll(),
      readSessionSeatFacts: async (query: Parameters<SessionRecords['seatFacts']>[0]) =>
        await records.seatFacts(query),
      sessionsById: async (ids: readonly SessionId[]) =>
        [...(await records.resolve(ids)).values()].map(subjectMeta),
    } as unknown as IssueDeps)
    const reports = new IssueReportsModule(issueStore)
    const principal = userCommandPrincipal(seeded.owner, 'member')
    const ctx = new IssueCommandCtx(
      { issues: { reports } } as never,
      { principal, capability: principal.capability },
      'deck',
    )
    let expected: string | undefined
    const run = async (arm: 'before' | 'after'): Promise<Sample> => {
      const sample: Sample = {
        wallMs: 0,
        sqlMs: 0,
        statements: 0,
        rows: 0,
        issueRows: 0,
        sessionRows: 0,
        depRows: 0,
        checkpointRows: 0,
        checkpointStatements: 0,
        bySql: new Map(),
      }
      const detach = probeStatements(store as unknown as StatementProbeHolder, (statement) => {
        sample.statements++
        sample.rows += statement.rows
        sample.sqlMs += statement.durationMs / statement.batchSize
        const text = statement.sql.replace(/select .*? from /s, "select … from ").slice(0, 400)
        sample.bySql.set(text, (sample.bySql.get(text) ?? 0) + statement.durationMs / statement.batchSize)
        if (statement.sql.includes('from "issues"')) sample.issueRows += statement.rows
        if (statement.sql.includes('from "sessions"')) sample.sessionRows += statement.rows
        if (statement.sql.includes('from "issue_deps"')) sample.depRows += statement.rows
        if (statement.sql.includes('from "session_observation_checkpoints"')) {
          sample.checkpointStatements++
          sample.checkpointRows += statement.rows
        }
      })
      const start = performance.now()
      try {
        const deck = await withReadScope(async () => {
          const reader = ctx.issueReader()
          if (arm === 'after') return await reports.deck(ROOT, reader)
          return await readDeckBefore(
            issueStore,
            ROOT,
            reader.mayReadRow ?? ((row) => reader.mayRead(row.id)),
            async (row) => await reports.niceRef(row),
            reader.viewer() ?? undefined,
            { names: async (ids) => await assigneeNames(store.users, ids) },
          )
        })
        sample.wallMs = performance.now() - start
        const serialized = JSON.stringify(deck)
        expected ??= serialized
        assert.equal(serialized, expected, `${arm}: deck changed`)
        return sample
      } finally {
        detach()
      }
    }
    const first = await run('before')
    await run('after')
    // The mission really is there: 24 phase tasks and 6 direct tasks, 3
    // grafts of 3 issues, 3 proposals; seats on the deck; blockers.
    const deck = JSON.parse(expected ?? 'null') as {
      counts: { total: number }
      proposals: unknown[]
    }
    assert.equal(deck.proposals.length, 3)
    assert.ok(deck.counts.total >= 30, `mission tasks: ${deck.counts.total}`)
    assert.ok(
      first.checkpointRows >= sized(CHECKPOINTS, scale),
      'before arm hydrates every checkpoint',
    )
    const samples: Record<'before' | 'after', Sample[]> = { before: [], after: [] }
    for (let pair = 0; pair < (SMOKE ? 1 : PAIRS); pair++) {
      const arms = pair % 2 ? (['after', 'before'] as const) : (['before', 'after'] as const)
      for (const arm of arms) samples[arm].push(await run(arm))
    }
    const summarize = (arm: 'before' | 'after') => {
      const values = samples[arm]
      const times = values.map((sample) => sample.wallMs).sort((a, b) => a - b)
      const sql = values.map((sample) => sample.sqlMs).sort((a, b) => a - b)
      const last = values.at(-1) ?? first
      return {
        medianMs: times[Math.floor(times.length / 2)],
        minMs: times[0],
        maxMs: times.at(-1),
        medianSqlMs: sql[Math.floor(sql.length / 2)],
        statements: last.statements,
        rows: last.rows,
        issueRows: last.issueRows,
        sessionRows: last.sessionRows,
        depRows: last.depRows,
        checkpointRows: last.checkpointRows,
        checkpointStatements: last.checkpointStatements,
        samples: values.map((sample) => Math.round(sample.wallMs * 10) / 10),
        slowestSql: [...last.bySql]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([sql, ms]) => ({ ms: Math.round(ms * 100) / 100, sql })),
      }
    }
    const result = {
      scale,
      issues: seeded.issues,
      drafts: sized(DRAFTS, scale),
      sessions: seeded.sessions,
      checkpoints: sized(CHECKPOINTS, scale),
      missionIssues: seeded.missionIssues,
      engine: 'sqlite',
      bun: Bun.version,
      identicalDecks: true,
      before: summarize('before'),
      after: summarize('after'),
    }
    results.push(result)
    console.log(JSON.stringify(result))
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
