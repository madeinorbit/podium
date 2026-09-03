import { asIssueId, asSessionId, asThreadId } from '@podium/model'
import type { SqlDatabase, SqlParam } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../../../store'
import { createBunStoreExecutor } from '../../../store/executor'
import { MessagesRepository } from '../../../store/messages'
import { openTestStore } from '../../../test-support/open-test-store'
import { countContextAwarePendingMail } from './mail-pending'

function counting(db: SqlDatabase, counts: Map<string, number>): SqlDatabase {
  const bump = (sql: string): void => {
    counts.set(sql, (counts.get(sql) ?? 0) + 1)
  }
  return {
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        run: (...params: SqlParam[]) => {
          bump(sql)
          return statement.run(...params)
        },
        get: (...params: SqlParam[]) => {
          bump(sql)
          return statement.get(...params)
        },
        all: (...params: SqlParam[]) => {
          bump(sql)
          return statement.all(...params)
        },
      }
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  }
}

function message(input: {
  id: string
  fromIssue: string | null
  fromSession: string | null
  status?: MessageRow['status']
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
    createdAt: 't0',
    status: input.status ?? 'queued',
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
  it('uses one grouped messages read while preserving reader visibility', () => {
    const store = openTestStore(':memory:')
    try {
      const db = (store as unknown as { db: SqlDatabase }).db
      const counts = new Map<string, number>()
      const messages = new MessagesRepository(
        createBunStoreExecutor({ database: counting(db, counts) }),
      )

      store.messages.addMessage(
        message({ id: 'msg-peer-1', fromIssue: 'iss_peer', fromSession: 'peer-session' }),
      )
      store.messages.addMessage(
        message({ id: 'msg-peer-2', fromIssue: 'iss_peer', fromSession: 'peer-session' }),
      )
      store.messages.addMessage(
        message({ id: 'msg-session', fromIssue: null, fromSession: 'peer-session-2' }),
      )
      store.messages.addMessage(
        message({ id: 'msg-own', fromIssue: 'iss_reader', fromSession: 'reader-session' }),
      )
      store.messages.addMessage(
        message({
          id: 'msg-seen',
          fromIssue: 'iss_peer',
          fromSession: 'peer-session',
          status: 'delivered',
        }),
      )
      store.messages.recordRead('msg-seen', asSessionId('reader-session'), 't1')
      counts.clear()

      const baselineSenders = messages.listPendingSendersForSession(
        asIssueId('iss_target'),
        asSessionId('reader-session'),
      )
      const baselineCount = messages.countPendingForSession(
        asIssueId('iss_target'),
        asSessionId('reader-session'),
      )
      expect(baselineCount).toBe(3)
      expect(baselineSenders).toHaveLength(2)
      expect([...counts].reduce((total, [, count]) => total + count, 0)).toBe(2)
      counts.clear()

      const result = countContextAwarePendingMail(
        { messages, issues: store.issues },
        asIssueId('iss_target'),
        (fromIssue) => `issue:${fromIssue}`,
        asSessionId('reader-session'),
      )

      expect(result).toEqual({
        unread: 3,
        senders: ['session:peer-session-2', 'issue:iss_peer'],
      })

      const groupedReads = [...counts].filter(([sql]) =>
        sql.includes('SELECT from_kind, from_issue, from_session, COUNT(*) AS n'),
      )
      expect(groupedReads).toHaveLength(1)
      expect(groupedReads[0]?.[1]).toBe(1)

      const oldSeparateReads = [...counts].filter(
        ([sql]) =>
          sql.includes('SELECT DISTINCT from_kind, from_issue, from_session') ||
          sql.includes('SELECT COUNT(*) AS n FROM messages'),
      )
      expect(oldSeparateReads).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('trusts a durable delivery stamp when the reader receipt is missing', () => {
    const store = openTestStore(':memory:')
    try {
      store.messages.addMessage({
        ...message({
          id: 'msg-delivered-without-receipt',
          fromIssue: 'iss_peer',
          fromSession: 'peer-session',
          status: 'delivered',
        }),
        deliveredAt: 't1',
        deliveredTo: asSessionId('reader-session'),
      })

      expect(
        countContextAwarePendingMail(
          store,
          asIssueId('iss_target'),
          (fromIssue) => `issue:${fromIssue}`,
          asSessionId('reader-session'),
        ),
      ).toEqual({ unread: 0, senders: [] })
      expect(
        countContextAwarePendingMail(
          store,
          asIssueId('iss_target'),
          (fromIssue) => `issue:${fromIssue}`,
          asSessionId('other-session'),
        ),
      ).toEqual({ unread: 1, senders: ['issue:iss_peer'] })
    } finally {
      store.close()
    }
  })
})
