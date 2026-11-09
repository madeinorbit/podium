import { asIssueId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { harness, sessionId, myIssue, mySession } from './test-support'

describe('navigation read command coalescing', () => {
  it('keeps the latest observed receipt when a visit ends during leading enqueue', async () => {
    const h = harness()
    const first = h.actions.markIssueRead('issue-1', '2026-10-29T12:00:00.000Z')
    const last = h.actions.markIssueRead('issue-1', '2026-10-29T12:00:01.000Z')
    await Promise.all([first, last])
    expect(h.queued).toEqual([
      myIssue('issue-1', { readAt: '2026-10-29T12:00:00.000Z' }),
      myIssue('issue-1', { readAt: '2026-10-29T12:00:01.000Z' }),
    ])
  })

  it.each([
    'issue',
    'session',
  ] as const)('manual %s unread cancels a receipt waiting on enqueue', async (kind) => {
    const h = harness()
    const read = kind === 'issue' ? h.actions.markIssueRead : h.actions.markSessionRead
    const unread = kind === 'issue' ? h.actions.markIssueUnread : h.actions.markSessionUnread
    const first = read(sessionId, '2026-10-29T12:00:00.000Z')
    const last = read(sessionId, '2026-10-29T12:00:01.000Z')
    await unread(sessionId)
    await Promise.all([first, last])
    const mine = kind === 'issue' ? myIssue : mySession
    expect(h.queued).toEqual([
      mine(sessionId, { readAt: '2026-10-29T12:00:00.000Z' }),
      mine(sessionId, { readAt: null }),
    ])
  })

  it('writes no read mark for a session that is only a start’s paint (POD-6622)', async () => {
    // The server has no row under the painted id, so the mark would be refused
    // ("Couldn't save session read status"); the paint already reads as read.
    let painted = true
    const h = harness({}, undefined, { launchPainted: (id) => painted && id === sessionId })
    await h.actions.markSessionRead(sessionId)
    await h.actions.markSessionRead(sessionId, '2026-11-08T09:06:00.000Z')
    expect(h.queued).toEqual([])
    // The row has landed: the same press marks it.
    painted = false
    await h.actions.markSessionRead(sessionId, '2026-11-08T09:07:00.000Z')
    expect(h.queued).toEqual([mySession(sessionId, { readAt: '2026-11-08T09:07:00.000Z' })])
  })

  it('shares the reaction and click read until its optimistic overlay is published', async () => {
    const h = harness()
    const issueId = asIssueId('issue-1')
    const first = h.actions.markIssueRead(issueId)
    const duplicate = h.actions.markIssueRead(issueId)
    const session = h.actions.markSessionRead(sessionId)
    const duplicateSession = h.actions.markSessionRead(sessionId)
    expect(duplicate).toBe(first)
    expect(duplicateSession).toBe(session)
    // A press without a cursor marks what this device has seen: now, or the
    // row's later activity (POD-6404).
    expect(h.queued).toEqual([
      myIssue(issueId, { readAt: expect.any(String) }),
      mySession(sessionId, { readAt: expect.any(String) }),
    ])
    await Promise.all([first, session])
    await h.actions.markIssueRead(issueId)
    expect(h.queued).toHaveLength(3)
  })
})
