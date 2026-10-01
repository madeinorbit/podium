import { describe, expect, it } from 'vitest'
import { asIssueId, asUserId } from '../ids'
import {
  IssueUserState,
  IssueUserStateWire,
  issueUserStateRowId,
  issueUserStateToWire,
  parseIssueUserStateRowId,
} from './issue-state'

describe('issue user-state feed projection', () => {
  it('keeps the shared keyed shape and projects only the pin timestamp to a flag', () => {
    const row = IssueUserState.parse({
      userId: 'user:a',
      entityId: 'issue:a',
      readAt: 'read',
      tuckedAt: null,
      pinnedAt: 'pin',
    })
    expect(IssueUserStateWire.shape.userId).toBe(IssueUserState.shape.userId)
    expect(IssueUserStateWire.shape.entityId).toBe(IssueUserState.shape.entityId)
    expect(issueUserStateToWire(row)).toEqual({
      userId: 'user:a',
      entityId: 'issue:a',
      readAt: 'read',
      tuckedAt: null,
      pinned: true,
    })
    expect(issueUserStateToWire({ ...row, pinnedAt: null }).pinned).toBe(false)
  })

  it('round-trips hostile key parts without aliases and rejects another entity kind', () => {
    const userId = asUserId('user:a\\:b')
    const entityId = asIssueId('issue:a:b\\c')
    expect(parseIssueUserStateRowId(issueUserStateRowId(userId, entityId))).toEqual({
      userId,
      entityId,
    })
    expect(issueUserStateRowId(userId, entityId)).not.toBe(
      issueUserStateRowId(asUserId('user:a'), asIssueId('b:issue:a:b\\c')),
    )
    expect(() => parseIssueUserStateRowId('user:session:id')).toThrow()
    expect(() => parseIssueUserStateRowId('invalid')).toThrow()
  })
})
