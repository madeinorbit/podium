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
 */
import { asIssueId, asSessionId, asThreadId, type IssueId, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../store'
import { expectConstantStatements } from '../../test-support/statement-count'
import { type MailHarness, mailHarness } from './characterization-support'

const SENDER = asSessionId('sFrom')

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
