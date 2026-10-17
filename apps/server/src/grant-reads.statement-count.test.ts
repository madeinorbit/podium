/**
 * A CHANGE READS ITS GRANTS ONCE [POD-6217, server-data rule 8].
 *
 * One write is one operation, and its passes ask about the same session under
 * two rules: the access check and the projection pass read the grants of the
 * session's issue (or of the session when it has none), and the publication's
 * visibility pass (`feed-visibility.ts` `prepareOver`) reads the session's own
 * grants, and the issue's for an issue row. Through the per-operation loader
 * (POD-6189) a repeat of the same key is free, but a different key was a
 * statement of its own, and so was each resource kind: on the server-data bench
 * (POD-6140 result §4) grant reads were 8,062 statements/min, about 3.9 per
 * write. Now the passes ask for the keys the later passes need, and one read
 * covers every kind (`GrantsRepository.loadForResourcesOfKinds`).
 *
 * Grant reads per operation, for a running session on an issue, before -> now:
 * - `sessions.rename` over tRPC: 3 -> 2 (the caller's machine grants, which
 *   the machine-use snapshot reads directly, and the issue's and the session's
 *   grants in one read at the access check);
 * - `issues.update` over tRPC: 2 -> 1 (the issue's and its session's grants,
 *   one read per kind in the visibility pass, now one);
 * - an `agentObservation` daemon frame: 2 -> 1 (the projection pass reads the
 *   session's own grants with the issue's).
 * Each at 5 and 200 other sessions on the server.
 */
import { asUserId, firstAdminMemberId, type IssueId, type SessionId } from '@podium/model'
import type { AgentObservation } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import type { SessionStore } from './store'
import { OPERATOR } from './test-support/capabilities'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import {
  expectConstantStatements,
  type PinnedCounts,
  quietShipping,
  type StatementPin,
  type StatementTally,
} from './test-support/statement-count'

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  issueId: IssueId
  /** Running, on the issue. */
  sessionId: SessionId
  call: ReturnType<typeof appRouter.createCaller>
}

const reader = asUserId('reader')

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** One running session on a shared issue, among `size` running sessions with none. */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {}, { repos: ['/repo'] })
  await quietShipping(reg)
  const owner = firstAdminMemberId()
  const issue = await reg.issues.crud.create({ repoPath: '/repo', title: 'Shared issue', startNow: false })
  const start = async (cwd: string, issueId?: IssueId): Promise<SessionId> => {
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd,
      ...(issueId ? { issueId } : {}),
    })
    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'codex',
      cwd,
      agentKind: 'codex',
      geometry: { cols: 80, rows: 24 },
    } as never)
    return sessionId
  }
  const sessionId = await start('/repo/w', issue.id)
  for (let i = 0; i < size; i++) await start(`/other/w${i}`)
  // Edges on both resources, so each read returns a row.
  for (const [resourceKind, resourceId] of [['issue', issue.id], ['session', sessionId]] as const) {
    await store.grants.upsert({
      resourceKind,
      resourceId,
      grantee: reader,
      verb: 'read',
      owner,
      visibility: 'personal',
      createdAt: '2026-10-17T00:00:00.000Z',
      actorKind: 'user',
      actorId: owner,
      onBehalfOf: null,
    })
  }
  const repos = new RepoRegistry(reg, reg.sessionStore)
  const superagent = await SuperagentService.create(reg.modules, repos, reg.sessionStore)
  const call = appRouter.createCaller({
    registry: reg,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(owner, 'admin'),
  })
  await settle(reg)
  return { store, reg, issueId: issue.id, sessionId, call }
}

const grantReads = (tally: StatementTally): number =>
  [...tally.byQuery].reduce((n, [key, count]) => (/^select\b.*\bfrom "grants"/i.test(key) ? n + count : n), 0)

const expectGrantReads = (counts: PinnedCounts, reads: number): void => {
  expect(grantReads(counts.small), 'grant reads at the small size').toBe(reads)
  expect(grantReads(counts.large), 'grant reads at the large size').toBe(reads)
}

const pin = (
  name: string,
  run: (f: Fixture) => Promise<unknown>,
  check: (f: Fixture) => Promise<void>,
): StatementPin<Fixture> => ({
  name,
  setup: fixture,
  target: (f) => f.store,
  run: async (f) => {
    await run(f)
    await settle(f.reg)
  },
  check: async (_result, f) => await check(f),
  teardown: async (f) => {
    await f.reg.dispose()
    await f.store.close()
  },
})

const at = '2026-10-17T12:00:10.000Z'
const observation = (sessionId: SessionId): AgentObservation => ({
  podiumSessionId: sessionId,
  provider: 'codex',
  providerSessionId: null,
  bindingVersion: 1,
  providerTurnId: null,
  providerPromptId: null,
  observerGeneration: 1,
  providerCursor: { segmentId: 'rollout-1', components: { file: 10 } },
  providerAt: at,
  receivedAt: at,
  sourceEventKind: 'rollout_fold',
  transitionKind: 'snapshot',
  provenance: 'bootstrap',
  inputOrigin: 'provider',
  turnEpoch: 0,
  priorPhase: 'unknown',
  nextPhase: 'idle',
  transitionId: 'snapshot-10',
  state: { phase: 'idle', since: at, workingMsTotal: 0, nativeSubagentCount: 0 },
})

describe('grant reads per change, a running session on an issue: pinned at 5 and 200', () => {
  it('sessions.rename reads the machine grants and both of the session\'s grant sets once', async () => {
    const counts = await expectConstantStatements(
      pin(
        'sessions.rename (on an issue)',
        async (f) => await f.call.sessions.rename({ sessionId: f.sessionId, name: 'Renamed' }),
        async (f) => expect((await f.store.sessions.loadSession(f.sessionId))?.name).toBe('Renamed'),
      ),
      RENAME,
    )
    expectGrantReads(counts, 2)
  })

  it('issues.update reads the issue\'s and its session\'s grants in one statement', async () => {
    const counts = await expectConstantStatements(
      pin(
        'issues.update',
        async (f) => await f.call.issues.update({ id: f.issueId, patch: { priority: 1 } }),
        async (f) => expect((await f.store.issues.getIssue(f.issueId))?.priority).toBe(1),
      ),
      ISSUE_UPDATE,
    )
    expectGrantReads(counts, 1)
  })

  it('an agentObservation frame reads the issue\'s and the session\'s grants in one statement', async () => {
    const counts = await expectConstantStatements(
      pin(
        'agentObservation (on an issue)',
        async (f) =>
          await f.reg.gateway.routeDaemonFrame(f.reg.sessionStore.hostMachineId, {
            type: 'agentObservation',
            observation: observation(f.sessionId),
          } as never),
        async (f) => expect(f.reg.modules.sessions.sessions.get(f.sessionId)?.agentState?.phase).toBe('idle'),
      ),
      OBSERVATION,
    )
    expectGrantReads(counts, 1)
  })
})

// Measured on the polaris VM (see the header for the grant reads in each).
// POD-6219: the session write's delivery trigger counted the session's and its
// issue's pending mail (two statements); the flush now asks for both in one: -1.
const RENAME = 12
const ISSUE_UPDATE = 29
const OBSERVATION = 12
