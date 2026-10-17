/**
 * A steward poll reads only the subscriptions that can match its events
 * [POD-6208, server-data rules 5 and 8]. Subscriptions are never cleaned up,
 * so rows of finished sessions and closed issues pile up; the poll used to read
 * every enabled one and check each in memory, with an issue lookup per
 * relationship row. Here the same poll runs over 5 and over 200 subscriptions
 * that cannot match it, and both the statements it runs and the subscription
 * rows it reads stay the same.
 */

import { asSessionId, type SessionMeta } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { type StewardDeps, StewardService } from './steward'
import type { SessionStore, Subscription } from './store'
import { probeStatements } from './store/executor/statement-probe'
import { openTestStore } from './test-support/open-test-store'
import { sessionReadPorts } from './test-support/session-facts'
import { expectConstantStatements, type StatementPin } from './test-support/statement-count'

interface Fixture {
  store: SessionStore
  steward: StewardService
  sendNotice: ReturnType<typeof vi.fn>
}

const subscription = (over: Partial<Subscription>): Subscription => ({
  id: 'sub',
  subscriberKind: 'issue',
  subscriberId: 'iss_p',
  event: 'issue.closed',
  sourceKind: 'relationship',
  sourceRef: 'my-children',
  deliverNudge: true,
  deliverNotify: false,
  origin: 'custom',
  enabled: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  ...over,
})

/** One subscription that can never match the poll, of each kind in turn: an
 *  explicit session or issue source the poll does not name, and relationship
 *  sources whose subscriber (an issue, or a session) is no ancestor of it. */
const stale = (i: number): Subscription => {
  const id = `sub_stale_${String(i).padStart(4, '0')}`
  const createdAt = `2026-07-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`
  switch (i % 4) {
    case 0:
      return subscription({
        id,
        createdAt,
        event: 'session.finished',
        sourceKind: 'session',
        sourceRef: `ses_old_${i}`,
        subscriberId: `iss_old_${i}`,
      })
    case 1:
      return subscription({ id, createdAt, sourceKind: 'issue', sourceRef: `iss_old_${i}` })
    case 2:
      return subscription({ id, createdAt, subscriberId: `iss_old_${i}` })
    default:
      return subscription({
        id,
        createdAt,
        subscriberKind: 'session',
        subscriberId: `ses_old_${i}`,
        sourceRef: 'my-subtree',
      })
  }
}

async function setup(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  await store.repos.addRepo('/r', store.hostMachineId)
  await store.events.setStewardState('cursor', '0')
  const sessions: SessionMeta[] = []
  const settings = normalizeSettings({
    steward: { enabled: true },
    gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
    sessionDefaults: { agent: 'claude-code' },
  })
  let clockMs = Date.parse('2026-07-02T00:00:00.000Z')
  const now = () => new Date(clockMs++).toISOString()
  const issueDeps: IssueDeps = {
    store,
    ...sessionReadPorts(() => sessions),
    getSettings: async () => settings,
    spawnSession: vi.fn(async () => ({ sessionId: asSessionId('s1'), machine: 'machine-under-test' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing(),
    now,
  }
  const issues = await IssueService.create(issueDeps)
  const sendNotice = vi.fn()
  const deps: StewardDeps = {
    store: store.events,
    facts: store.notificationFacts,
    messages: store.messages,
    issues,
    runningSessionFacts: () => sessionReadPorts(() => sessions).runningSessionFacts(),
    readSessionFactsByIds: async (ids) =>
      await sessionReadPorts(() => sessions).readSessionFactsByIds(ids),
    sessionById: async (sessionId) => sessions.find((s) => s.sessionId === sessionId),
    sendNotice,
    getSettings: async () => settings,
    now,
  }
  const epic = await issues.crud.create({ repoPath: '/r', title: 'Epic', startNow: false })
  await issues.crud.update(epic.id, { worktreePath: '/r/.worktrees/epic' })
  const child = await issues.crud.create({
    repoPath: '/r',
    title: 'Child',
    parentId: epic.id,
    startNow: false,
  })
  sessions.push({
    sessionId: asSessionId('psess'),
    agentKind: 'claude-code',
    cwd: '/r/.worktrees/epic',
    status: 'live',
    issueId: epic.id,
  } as never)
  // The one subscription the poll matches: the epic watches its children close.
  await store.events.addSubscription(subscription({ id: 'sub_match', subscriberId: epic.id }))
  for (let i = 0; i < size; i++) await store.events.addSubscription(stale(i))
  const steward = new StewardService(deps)
  // Consume the set-up events, so the measured poll holds only the close.
  await steward.tick()
  await issues.crud.close(child.id)
  sendNotice.mockClear()
  return { store, steward, sendNotice }
}

const pin: StatementPin<Fixture> = {
  name: 'steward poll with stored subscriptions',
  setup,
  target: (f) => f.store,
  run: async (f) => await f.steward.tick(),
  check: (_result, f) => {
    const texts = f.sendNotice.mock.calls.map((call) => String(call[1]))
    expect(texts.filter((text) => text.startsWith('Subscription: issue.closed'))).toHaveLength(1)
  },
  teardown: async (f) => await f.store.close(),
}

/** The subscription rows one poll reads, at a given number of stale rows. */
async function subscriptionRowsRead(size: number): Promise<number> {
  const f = await setup(size)
  let rows = 0
  const detach = probeStatements(f.store as never, (observation) => {
    if (/from "subscriptions"/i.test(observation.sql)) rows += observation.rows
  })
  try {
    await f.steward.tick()
  } finally {
    detach()
    await f.store.close()
  }
  return rows
}

describe('steward subscription matching (POD-6208)', () => {
  it('runs a fixed number of statements, however many subscriptions cannot match', async () => {
    await expectConstantStatements(pin, 62)
  })

  it('reads the same subscription rows, however many cannot match', async () => {
    const [small, large] = [await subscriptionRowsRead(5), await subscriptionRowsRead(200)]
    expect(large, `subscription rows read: ${small} at 5 stale rows, ${large} at 200`).toBe(small)
  })
})
