import type { SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  activityAfterRead,
  issueOwnContentUnread,
  latestActivityAt,
  sessionUnreadEmphasized,
  subtreeUnread,
} from './unread'

const READ = '2026-07-06T11:00:00.000Z'
const BEFORE = '2026-07-06T10:00:00.000Z'
const AFTER = '2026-07-06T12:00:00.000Z'

describe('subtreeUnread', () => {
  it('a never-read issue is unread even with quiet descendants', () => {
    expect(
      subtreeUnread({
        readAt: null,
        updatedAt: BEFORE,
        descendantUpdatedAts: [BEFORE],
        sessions: [{ lastActiveAt: BEFORE }],
      }),
    ).toBe(true)
  })

  it('covers current subtree activity when readAt is later', () => {
    expect(
      subtreeUnread({
        readAt: READ,
        updatedAt: BEFORE,
        descendantUpdatedAts: [BEFORE],
        sessions: [{ lastActiveAt: BEFORE }],
      }),
    ).toBe(false)
  })

  it('a child session after the parent readAt re-unreads the rollup', () => {
    expect(
      subtreeUnread({
        readAt: READ,
        updatedAt: BEFORE,
        sessions: [{ lastActiveAt: BEFORE }, { lastActiveAt: AFTER }],
      }),
    ).toBe(true)
  })

  it('a child issue edit after the parent readAt re-unreads the rollup', () => {
    expect(
      subtreeUnread({
        readAt: READ,
        updatedAt: BEFORE,
        descendantUpdatedAts: [AFTER],
        sessions: [{ lastActiveAt: BEFORE }],
      }),
    ).toBe(true)
  })
})

describe('issueOwnContentUnread', () => {
  it('ignores sessions — expanded strips leave those to the session rows', () => {
    expect(issueOwnContentUnread({ readAt: READ, updatedAt: BEFORE })).toBe(false)
    expect(issueOwnContentUnread({ readAt: READ, updatedAt: AFTER })).toBe(true)
    expect(issueOwnContentUnread({ readAt: null, updatedAt: BEFORE })).toBe(true)
  })
})

describe('sessionUnreadEmphasized', () => {
  const sess = (over: Partial<SessionMeta>): SessionMeta =>
    ({
      unread: true,
      agentState: { phase: 'idle', since: BEFORE, nativeSubagentCount: 0 },
      ...over,
    }) as SessionMeta

  it('hides the mark while a session is working', () => {
    expect(sessionUnreadEmphasized(sess({}))).toBe(true)
    expect(
      sessionUnreadEmphasized(
        sess({
          agentState: { phase: 'working', since: AFTER, nativeSubagentCount: 0 },
        }),
      ),
    ).toBe(false)
    expect(sessionUnreadEmphasized(sess({ unread: false }))).toBe(false)
  })
})

describe('latestActivityAt / activityAfterRead', () => {
  it('picks the newest stamp', () => {
    expect(latestActivityAt(BEFORE, [{ lastActiveAt: AFTER }, { lastActiveAt: READ }])).toBe(AFTER)
  })

  it('treats equal stamps as read', () => {
    expect(activityAfterRead(READ, READ)).toBe(false)
    expect(activityAfterRead(READ, AFTER)).toBe(true)
  })
})
