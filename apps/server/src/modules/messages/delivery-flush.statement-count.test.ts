/**
 * A coalesced delivery flush, through the real delivery service, runs a fixed
 * number of statements however many messages and targets are waiting
 * [POD-6174, server-data rule 8]. It used to read one page per target, the
 * issue report of each issue-addressed row and a wake cooldown per row.
 *
 * Since issue rows come from the database (POD-6158) the pass reads every
 * target issue once, together, before its attempts; that is the third
 * statement of the held case and the fourth of the wake case. The first is the
 * check of which triggered targets have mail at all (POD-6219).
 *
 * A pass reads the members of each issue it attempts once, not once per
 * queued row (POD-6229): pinned at the end by counting that read, and through
 * the real registry (whose member read is the issue's session projection)
 * once POD-6231 removes the pass's last per-row read.
 */
import { asIssueId, asSessionId, asThreadId, firstAdminMemberId, type IssueId, type SessionMeta } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import type { MessageRow, SessionStore } from '../../store'
import { OPERATOR } from '../../test-support/capabilities'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements, quietShipping } from '../../test-support/statement-count'
import { SuperagentService } from '../superagent'
import { type MailHarness, mailHarness } from './characterization-support'
import type { MessageDeliveryDeps } from './service'

const SENDER = asSessionId('sFrom')
/** Measured on the polaris VM (POD-6229), with one account read per row left. */
const PASS_STATEMENTS = 17

const row = (id: string, toId: IssueId, lifecycle: MessageRow['lifecycle'], createdAt: string): MessageRow => ({
  id,
  threadId: asThreadId(id),
  inReplyTo: null,
  fromKind: 'agent',
  fromSession: SENDER,
  fromIssue: null,
  toKind: 'issue',
  toId,
  kind: 'message',
  urgency: 'fyi',
  lifecycle,
  body: id,
  expiresAt: null,
  createdAt,
  deliveryStatus: 'stored',
  deliveredAt: null,
  deliveredTo: null,
  ackedBy: null,
  hop: 0,
  clampedFrom: null,
  remindedAt: null,
  expectsResponse: false,
})

interface Fixture {
  h: MailHarness
  issueIds: IssueId[]
}

/** `size` open issues with no session, one stored `lifecycle` message to each,
 *  every target queued for the next flush. */
async function heldMail(size: number, lifecycle: MessageRow['lifecycle']): Promise<Fixture> {
  const h = await mailHarness()
  const issueIds: IssueId[] = []
  for (let i = 0; i < size; i++) {
    const { id } = await h.createIssue({ title: `target ${i}` })
    issueIds.push(id)
    const at = new Date(Date.parse('2026-07-20T11:00:00.000Z') + i).toISOString()
    await h.store.messages.addMessage(row(`m-${i}`, id, lifecycle, at))
    // Woken a minute ago: the cooldown is hot, and only the durable row knows
    // it — this service's brake has never seen the key, as after a restart.
    if (lifecycle === 'wake') {
      await h.store.messages.recordWakeCooldown(`agent:${SENDER}|${id}`, '2026-07-20T11:59:00.000Z')
    }
  }
  await h.svc.onIssuesEligibilityChanged(issueIds)
  return { h, issueIds }
}

const flush = async ({ h }: Fixture) => {
  const queued = h.svc.deliveryStats().pendingTargetCount
  await h.svc.flushDeliveryTriggers()
  return { queued, pushes: h.pushes.length }
}

const teardown = async ({ h }: Fixture) => {
  h.svc.dispose()
  await h.store.close()
}

describe('delivery flush through the service: pinned statement counts at 5 and 200 targets', () => {
  it('held issue mail: one check, one read of every page', async () => {
    await expectConstantStatements<Fixture>(
      {
        name: 'flushDeliveryTriggers (held)',
        setup: async (size) => await heldMail(size, 'wait'),
        target: ({ h }) => h.store,
        run: flush,
        check: async (result, { h, issueIds }, size) => {
          expect(result).toEqual({ queued: size, pushes: 0 })
          // Still held: an issue with no session keeps its mail for the next one.
          expect((await h.svc.message('m-0'))?.deliveryStatus).toBe('stored')
          expect(issueIds).toHaveLength(size)
        },
        teardown,
      },
      3,
    )
  })

  it('wake mail inside a cold cooldown: one check, one read of the pages, one of the cooldowns', async () => {
    await expectConstantStatements<Fixture>(
      {
        name: 'flushDeliveryTriggers (wake, cooling down)',
        setup: async (size) => await heldMail(size, 'wake'),
        target: ({ h }) => h.store,
        run: flush,
        check: async (result, { h }, size) => {
          // Nothing woke and nothing spawned: every key is still cooling down.
          expect(result).toEqual({ queued: size, pushes: 0 })
          expect(h.wakeSpawns).toHaveLength(0)
          expect((await h.svc.message(`m-${size - 1}`))?.deliveryStatus).toBe('stored')
        },
        teardown,
      },
      4,
    )
  })
})

describe('onWakeUnavailable', () => {
  it('flags only the rows handed to that session', async () => {
    const h = await mailHarness()
    try {
      const issue = asIssueId((await h.createIssue({ title: 'target' })).id)
      const woken = asSessionId('sWoken')
      await h.store.messages.addMessage({ ...row('handed', issue, 'wake', '2026-07-20T11:00:00.000Z'), deliveredTo: woken })
      await h.store.messages.addMessage({
        ...row('elsewhere', issue, 'wake', '2026-07-20T11:00:01.000Z'),
        deliveredTo: asSessionId('sOther'),
      })
      await h.store.messages.addMessage(row('unhanded', issue, 'wake', '2026-07-20T11:00:02.000Z'))
      expect((await h.store.messages.pendingDeliveredToPage(woken)).map((m) => m.id)).toEqual(['handed'])
      await h.svc.onWakeUnavailable(woken, 'machine offline')
      const flagged = (await h.events(['message.needs_attention'])).map((e) => (e.payload as { messageId?: string }).messageId)
      expect(flagged).toEqual(['handed'])
    } finally {
      h.svc.dispose()
      await h.store.close()
    }
  })
})

interface ChangedSessions {
  h: MailHarness
  sessions: SessionMeta[]
}

/** `size` live sessions under one issue's worktree, half attached to the issue
 *  and half only in a folder under it, and one message to the first. */
async function changedSessions(size: number): Promise<ChangedSessions> {
  const h = await mailHarness()
  const { id } = await h.createIssue({ title: 'workspace' })
  await h.setWorktree(id, '/repo/.worktrees/workspace')
  const sessions = h.put(
    ...Array.from({ length: size }, (_, i) => ({
      sessionId: asSessionId(`s${i}`),
      phase: 'idle' as const,
      ...(i % 2 === 0 ? { issueId: id, cwd: '/repo/.worktrees/workspace' } : { cwd: `/repo/.worktrees/workspace/pkg${i}` }),
    })),
  )
  await h.store.messages.addMessage({
    ...row('m-session', id, 'wait', '2026-07-20T11:00:00.000Z'),
    toKind: 'session',
    toId: sessions[0]!.sessionId,
  })
  return { h, sessions }
}

describe('session changes: pinned statement counts at 5 and 200 sessions [POD-6219]', () => {
  // What the relay's change-log handler does for a batch of session upserts:
  // one eligibility change per session, then the coalesced flush. Each change
  // used to count its session's and its issue's pending mail and look up the
  // issue of an unattached session's folder (2.5 statements a change here).
  // Now: the folder read, the check of which targets have mail and the page
  // read of the one that has, then the delivery's own three (the earliest admin,
  // one statement for its row since POD-6218, the dispatch stamp and its event).
  it('a burst of changes: one folder read, one check and one page read, then the one delivery', async () => {
    await expectConstantStatements<ChangedSessions>(
      {
        name: 'onSessionEligibilityChanged x size + flushDeliveryTriggers',
        setup: changedSessions,
        target: ({ h }) => h.store,
        run: async ({ h, sessions }) => {
          for (const session of sessions) await h.svc.onSessionEligibilityChanged(session.sessionId, session)
          await h.svc.flushDeliveryTriggers()
          return h.pushes.map((push) => push.sessionId)
        },
        // The change reached the one message: it went to s0.
        check: (pushes) => expect(pushes).toEqual(['s0']),
        teardown: async ({ h }) => {
          h.svc.dispose()
          await h.store.close()
        },
      },
      6,
    )
  })
})

interface HeldIssueMail {
  store: SessionStore
  reg: SessionRegistry
  issueId: IssueId
  superagent: SuperagentService
  call: ReturnType<typeof appRouter.createCaller>
}

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * A running shell on one issue and `size` messages sent to the issue. A shell
 * takes no mail, so the issue holds every one of them, and each pass over the
 * issue attempts them all.
 */
async function heldIssueMail(size: number): Promise<HeldIssueMail> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {}, { repos: ['/repo'] })
  await quietShipping(reg)
  const issue = await reg.issues.crud.create({ repoPath: '/repo', title: 'Mail', startNow: false })
  await reg.issues.crud.update(issue.id, { worktreePath: '/repo/.worktrees/mail' })
  const cwd = '/repo/.worktrees/mail'
  const { sessionId } = await reg.modules.sessions.createSession({ agentKind: 'shell', cwd, issueId: issue.id })
  await reg.gateway.routeDaemonFrame(store.hostMachineId, {
    type: 'bind',
    sessionId,
    cmd: 'sh',
    cwd,
    agentKind: 'shell',
    geometry: { cols: 80, rows: 24 },
  } as never)
  const repos = new RepoRegistry(reg, reg.sessionStore)
  const superagent = await SuperagentService.create(reg.modules, repos, reg.sessionStore)
  const call = appRouter.createCaller({
    registry: reg,
    repos,
    superagent,
    capability: OPERATOR,
    principal: userCommandPrincipal(firstAdminMemberId(), 'admin'),
  })
  for (let i = 0; i < size; i++) await call.messages.send({ to: issue.id, body: `held ${i}` })
  await settle(reg)
  return { store, reg, issueId: issue.id, superagent, call }
}

const releaseHeld = async (f: HeldIssueMail) => {
  f.superagent.dispose()
  await f.reg.dispose()
  await f.store.close()
}

const stillHeld = async (f: HeldIssueMail, size: number) => {
  const held = await f.store.messages.listQueuedPage({ limit: 1000 })
  expect(held.filter((m) => m.toKind === 'issue' && m.toId === f.issueId)).toHaveLength(size)
}

describe('a pass over held issue mail: pinned statement counts at 5 and 150 held messages [POD-6229]', () => {
  // Each held row read the issue's members on its own (four statements) and
  // its sender's machine ownership for an apply check that reads none of it
  // (two more). Both are gone; the send that triggers such a pass is pinned in
  // mail-send.statement-count.test.ts. The pass alone still reads its sender's
  // account once a row: the apply-time re-authorization asks for the sender's
  // role, and the account memo is per read scope, which each attempt opens
  // anew. 17 statements at 5 held rows, 162 at 150. Unskip at its constant
  // when POD-6231 reads the account once per operation. Both sizes fit one
  // delivery page (200 rows): a full page asks for the next.
  it.skip('the pass itself: the members of the issue and the sender read once (POD-6231)', async () => {
    await expectConstantStatements<HeldIssueMail>(
      {
        name: 'onIssueEligibilityChanged + flushDeliveryTriggers (held issue mail)',
        sizes: [5, 150],
        setup: heldIssueMail,
        target: (f) => f.store,
        run: async (f) => {
          await f.reg.modules.messages.onIssueEligibilityChanged(f.issueId)
          await f.reg.modules.messages.flushDeliveryTriggers()
        },
        check: async (_result, f, size) => await stillHeld(f, size),
        teardown: releaseHeld,
      },
      PASS_STATEMENTS,
    )
  })
})

/** The member read the delivery service was given, to count its calls. */
const memberReads = (h: MailHarness) =>
  vi.spyOn((h.svc as unknown as { deps: MessageDeliveryDeps }).deps.sessions, 'listSessionsForIssue')

describe("a pass's member lists [POD-6229]", () => {
  it('reads the members of an issue once for all of its held rows', async () => {
    const h = await mailHarness()
    try {
      const { id } = await h.createIssue({ title: 'held' })
      h.put({ sessionId: asSessionId('shell'), issueId: id, agentKind: 'shell' })
      for (let i = 0; i < 20; i++) {
        await h.store.messages.addMessage(row(`m-${i}`, id, 'wait', new Date(Date.parse('2026-07-20T11:00:00.000Z') + i).toISOString()))
      }
      const reads = memberReads(h)
      await h.svc.onIssueEligibilityChanged(id)
      await h.svc.flushDeliveryTriggers()
      expect(reads).toHaveBeenCalledTimes(1)
      expect(h.pushes).toHaveLength(0)
      // Only the pass shares: a second one reads afresh.
      await h.svc.onIssueEligibilityChanged(id)
      await h.svc.flushDeliveryTriggers()
      expect(reads).toHaveBeenCalledTimes(2)
    } finally {
      h.svc.dispose()
      await h.store.close()
    }
  })

  it('reads them again after a row woke a member, so the next row sees it running', async () => {
    const h = await mailHarness()
    try {
      const { id } = await h.createIssue({ title: 'parked' })
      const [parked] = h.put({ sessionId: asSessionId('s1'), issueId: id, status: 'hibernated' })
      // The resume a wake starts: the session runs from here on, a new row
      // in every later read, as the projection returns.
      const deps = (h.svc as unknown as { deps: MessageDeliveryDeps }).deps.sessions
      const queueText = deps.queueText.bind(deps)
      vi.spyOn(deps, 'queueText').mockImplementation(async (input) => {
        const at = h.sessions.findIndex((s) => s.sessionId === input.sessionId)
        if (at >= 0 && h.sessions[at]!.status === 'hibernated') h.sessions[at] = { ...h.sessions[at]!, status: 'live' }
        return await queueText(input)
      })
      await h.store.messages.addMessage(row('wake', id, 'wake', '2026-07-20T11:00:00.000Z'))
      await h.store.messages.addMessage(row('after', id, 'wait', '2026-07-20T11:00:01.000Z'))
      const reads = memberReads(h)
      await h.svc.onIssueEligibilityChanged(id)
      await h.svc.flushDeliveryTriggers()
      // The wait row went to the running session; with the list read before
      // the wake it would have been held for a session still parked.
      expect(h.pushes.map((push) => [(push as { sourceMessageId?: string }).sourceMessageId, push.sessionId])).toEqual([
        ['wake', parked!.sessionId],
        ['after', parked!.sessionId],
      ])
      expect(reads).toHaveBeenCalledTimes(2)
    } finally {
      h.svc.dispose()
      await h.store.close()
    }
  })
})
