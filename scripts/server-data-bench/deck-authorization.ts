/**
 * POD-7430: before/after deck authorization on the POD-7414 §4 populations.
 * Run on an agent VM:
 * bun --conditions=@podium/source scripts/server-data-bench/deck-authorization.ts
 *
 * Both arms use the real command reader, read scope, repositories and durable
 * session-fact hydration. The before arm removes only the loaded-row policy,
 * restoring the old `mayRead -> has -> loadIssue` loop. Five alternating pairs
 * share one generated, disposable SQLite store; setup and warm-up are excluded.
 * The mission has five children and no seats; all sessions are unrelated history.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { userCommandPrincipal } from '../../apps/server/src/command-principal'
import { IssueCommandCtx } from '../../apps/server/src/modules/issues/command-ctx'
import { IssueStore } from '../../apps/server/src/modules/issues/service/core'
import { IssueReportsModule } from '../../apps/server/src/modules/issues/service/reads'
import type { IssueDeps } from '../../apps/server/src/modules/issues/service/types'
import { SessionFactsReader } from '../../apps/server/src/modules/sessions/facts'
import { SessionRecords } from '../../apps/server/src/modules/sessions/records'
import type { Session } from '../../apps/server/src/modules/sessions/session'
import type { SessionStore } from '../../apps/server/src/store'
import { withReadScope } from '../../apps/server/src/store/executor/read-scope'
import { probeStatements } from '../../apps/server/src/store/executor/statement-probe'
import { issueRowFixture } from '../../apps/server/src/test-support/issue-row'
import { TEST_MACHINE_ID } from '../../apps/server/src/test-support/machine-id'
import { openTestStore } from '../../apps/server/src/test-support/open-test-store'

const AT = '2026-11-23T00:00:00.000Z'
const SESSIONS = 6992
const CHECKPOINTS = 4914
const DRAFTS = 35
const PAIRS = 5
const ROOT = asIssueId('iss_deck_1')

async function seed(store: SessionStore, issues: number) {
  const owner = await firstAdminMemberId(store)
  await store.repos.addRepo('/repo', TEST_MACHINE_ID, undefined, 'POD')
  await store.transact(async () => {
    for (let seq = 1; seq <= issues; seq++) {
      await store.issues.upsertIssue(fixtureWriteScope(), {
        ...issueRowFixture({
          id: `iss_deck_${seq}`,
          seq,
          title: `Issue ${seq}`,
          description: '',
          ownerUserId: owner,
          createdByActor: owner,
          createdByOnBehalfOf: owner,
          parentId: seq >= 2 && seq <= 6 ? ROOT : null,
          draft: seq > issues - DRAFTS,
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
      })
    }
    for (let i = 0; i < SESSIONS; i++) {
      const id = asSessionId(`deck-history-${String(i).padStart(5, '0')}`)
      await store.sessions.upsertSession(fixtureWriteScope(), {
        id,
        ownerUserId: owner,
        agentKind: 'codex',
        cwd: '/repo',
        title: `Historical session ${i}`,
        name: null,
        originKind: 'spawn',
        conversationId: null,
        resumeKind: null,
        resumeValue: null,
        status: 'hibernated',
        exitCode: null,
        durableLabel: `podium-${id}`,
        createdAt: AT,
        lastActiveAt: AT,
        lastOutputAt: null,
        lastInputAt: null,
        lastResumedAt: null,
        archived: false,
        workState: null,
        machineId: TEST_MACHINE_ID,
        headless: false,
        issueId: asIssueId('iss_deck_7'),
        stoppedAt: null,
      })
      if (i >= CHECKPOINTS) continue
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
        // Roughly 11 KiB of valid checkpoint JSON, matching the report's
        // payload order of magnitude without retaining private source data.
        lastTransitionId: `synthetic-${'x'.repeat(10600)}`,
      })
    }
  })
  return owner
}

interface Sample {
  wallMs: number
  sqlMs: number
  statements: number
  issueStatements: number
  issueRows: number
  checkpointStatements: number
  checkpointRows: number
}

for (const issues of [7879, 7884]) {
  const directory = await mkdtemp(join(tmpdir(), 'podium-deck-auth-'))
  const store = await openTestStore(join(directory, 'bench.db'), TEST_MACHINE_ID)
  try {
    const owner = await seed(store, issues)
    const resident = new Map<SessionId, Session>()
    const facts = new SessionFactsReader(
      resident,
      new SessionRecords({ store, sessions: resident }),
    )
    const reports = new IssueReportsModule(
      new IssueStore({
        store,
        readSessionFacts: async () => {
          const rows = await facts.readAll()
          assert.equal(rows.length, SESSIONS)
          return rows
        },
        sessionsById: async (ids: readonly SessionId[]) => {
          assert.equal(ids.length, 0, 'benchmark mission must have no seats')
          return []
        },
      } as unknown as IssueDeps),
    )
    const principal = userCommandPrincipal(owner, 'member')
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
        issueStatements: 0,
        issueRows: 0,
        checkpointStatements: 0,
        checkpointRows: 0,
      }
      const detach = probeStatements(store, (statement) => {
        sample.statements++
        sample.sqlMs += statement.durationMs / statement.batchSize
        if (statement.sql.includes('from "issues"')) {
          sample.issueStatements++
          sample.issueRows += statement.rows
        }
        if (statement.sql.includes('from "session_observation_checkpoints"')) {
          sample.checkpointStatements++
          sample.checkpointRows += statement.rows
        }
      })
      const start = performance.now()
      try {
        const deck = await withReadScope(async () => {
          const reader = ctx.issueReader()
          return await reports.deck(
            ROOT,
            arm === 'before' ? { viewer: reader.viewer, mayRead: reader.mayRead } : reader,
          )
        })
        sample.wallMs = performance.now() - start
        assert.equal(deck.root.children.length, 5)
        assert.equal(deck.counts.total, 5)
        const serialized = JSON.stringify(deck)
        expected ??= serialized
        assert.equal(serialized, expected, `${arm}: deck changed`)
        // Both arms read the root live and the candidate listing. The old
        // policy additionally loads every non-draft candidate by ID, including
        // the root: a live read deliberately does not prime the row loader.
        assert.equal(sample.issueStatements, arm === 'before' ? issues - DRAFTS + 2 : 2)
        assert.equal(sample.issueRows, arm === 'before' ? 2 * issues - DRAFTS + 1 : issues + 1)
        assert.equal(sample.checkpointStatements, Math.ceil(SESSIONS / 500))
        assert.equal(sample.checkpointRows, CHECKPOINTS)
        return sample
      } finally {
        detach()
      }
    }
    await run('before')
    await run('after')
    const samples: Record<'before' | 'after', Sample[]> = { before: [], after: [] }
    for (let pair = 0; pair < PAIRS; pair++) {
      const arms = pair % 2 ? (['after', 'before'] as const) : (['before', 'after'] as const)
      for (const arm of arms) samples[arm].push(await run(arm))
    }
    const summarize = (arm: 'before' | 'after') => {
      const values = samples[arm]
      const times = values.map((sample) => sample.wallMs).sort((a, b) => a - b)
      return {
        medianMs: times[Math.floor(times.length / 2)],
        minMs: times[0],
        maxMs: times.at(-1),
        samples: values,
      }
    }
    console.log(
      JSON.stringify({
        issues,
        drafts: DRAFTS,
        sessions: SESSIONS,
        checkpoints: CHECKPOINTS,
        engine: 'sqlite',
        bun: Bun.version,
        identicalDecks: true,
        before: summarize('before'),
        after: summarize('after'),
      }),
    )
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
