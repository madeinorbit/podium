import { asIssueId, asSessionId, asThreadId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../../store'
import { openTestStore } from '../../../test-support/open-test-store'
import { seedMessage } from '../../../test-support/seed-message'
import { countStatements } from '../../../test-support/statement-count'
import { countContextAwarePendingMail } from './mail-pending'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:00:01.000Z'

function message(input: {
  id: string
  fromIssue: string | null
  fromSession: string | null
  deliveryStatus?: MessageRow['deliveryStatus']
}): MessageRow {
  return {
    id: asIssueId(input.id),
    threadId: asThreadId(input.id),
    inReplyTo: null,
    fromKind: 'agent',
    fromSession: input.fromSession ? asSessionId(input.fromSession) : null,
    fromIssue: input.fromIssue ? asIssueId(input.fromIssue) : null,
    toKind: 'issue',
    toId: 'iss_target',
    kind: 'message',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: input.id,
    expiresAt: null,
    createdAt: T0,
    deliveryStatus: input.deliveryStatus ?? 'stored',
    deliveredAt: null,
    deliveredTo: null,
    readAt: null,
    injectedAt: null,
    deadLetteredAt: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    factKey: null,
    factTarget: null,
    expectsResponse: false,
    delegationRef: null,
  }
}

describe('countContextAwarePendingMail', () => {
  it('uses one grouped messages read while preserving reader visibility', async () => {
    const store = await openTestStore(':memory:')
    try {
      const { messages } = store

      await seedMessage(
        store.messages,
        message({ id: 'msg-peer-1', fromIssue: 'iss_peer', fromSession: 'peer-session' }),
      )
      await seedMessage(
        store.messages,
        message({ id: 'msg-peer-2', fromIssue: 'iss_peer', fromSession: 'peer-session' }),
      )
      await seedMessage(
        store.messages,
        message({ id: 'msg-session', fromIssue: null, fromSession: 'peer-session-2' }),
      )
      await seedMessage(
        store.messages,
        message({ id: 'msg-own', fromIssue: 'iss_reader', fromSession: 'reader-session' }),
      )
      await seedMessage(
        store.messages,
        message({
          id: 'msg-seen',
          fromIssue: 'iss_peer',
          fromSession: 'peer-session',
          deliveryStatus: 'confirmed',
        }),
      )
      await store.messages.recordRead('msg-seen', asSessionId('reader-session'), T1)

      const baseline = await countStatements(store, async () => ({
        senders: await messages.listPendingSendersForSession(
          asIssueId('iss_target'),
          asSessionId('reader-session'),
        ),
        count: await messages.countPendingForSession(
          asIssueId('iss_target'),
          asSessionId('reader-session'),
        ),
      }))
      expect(baseline.result.count).toBe(3)
      expect(baseline.result.senders).toHaveLength(2)
      expect(baseline.statements).toBe(2)

      const { result, byQuery } = await countStatements(
        store,
        async () =>
          await countContextAwarePendingMail(
            { messages, issues: store.issues },
            asIssueId('iss_target'),
            (fromIssue) => `issue:${fromIssue}`,
            asSessionId('reader-session'),
          ),
      )
      const counts = [...byQuery]

      expect(result).toEqual({
        unread: 3,
        senders: ['session:peer-session-2', 'issue:iss_peer'],
      })

      // BOTH SPELLINGS [POD-3221 spec rule 32]. Drizzle emits lowercase keywords
      // and quoted identifiers, so the hand-written text this used to match no
      // longer occurs: `select "from_kind", …, count(*) from "messages"`, with no
      // `AS n`. Widened rather than replaced, because a caller that has not been
      // converted still emits the old form and a builder-only matcher would go
      // blind on it.
      const norm = (sql: string): string =>
        sql.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase()

      const groupedReads = counts.filter(([sql]) =>
        norm(sql).includes('from_kind, from_issue, from_session, count(*)'),
      )
      // Also the canary for this whole assertion: a probe that observed nothing
      // reports 0 here and fails loudly, rather than letting the negative check
      // below pass at 0 === 0 (rule 44).
      expect(groupedReads).toHaveLength(1)
      expect(groupedReads[0]?.[1]).toBe(1)

      const oldSeparateReads = counts.filter(([sql]) => {
        const q = norm(sql)
        // `startsWith` on the count arm, because the GROUPED read also contains
        // `count(*) from messages` and an `includes` would match it here.
        return (
          q.startsWith('select distinct from_kind, from_issue, from_session') ||
          q.startsWith('select count(*)')
        )
      })
      expect(oldSeparateReads).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('trusts a durable delivery stamp when the reader receipt is missing', async () => {
    const store = await openTestStore(':memory:')
    try {
      await seedMessage(store.messages, {
        ...message({
          id: 'msg-delivered-without-receipt',
          fromIssue: 'iss_peer',
          fromSession: 'peer-session',
          deliveryStatus: 'confirmed',
        }),
        deliveredAt: T1,
        deliveredTo: asSessionId('reader-session'),
      })

      expect(
        await countContextAwarePendingMail(
          store,
          asIssueId('iss_target'),
          (fromIssue) => `issue:${fromIssue}`,
          asSessionId('reader-session'),
        ),
      ).toEqual({ unread: 0, senders: [] })
      expect(
        await countContextAwarePendingMail(
          store,
          asIssueId('iss_target'),
          (fromIssue) => `issue:${fromIssue}`,
          asSessionId('other-session'),
        ),
      ).toEqual({ unread: 1, senders: ['issue:iss_peer'] })
    } finally {
      await store.close()
    }
  })
})
