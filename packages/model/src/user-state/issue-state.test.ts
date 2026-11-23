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
  it('keeps the shared keyed shape and carries no pin', () => {
    const row = IssueUserState.parse({
      userId: 'user:a',
      entityId: 'issue:a',
      readAt: 'read',
      tuckedAt: null,
    })
    expect(IssueUserStateWire.shape.userId).toBe(IssueUserState.shape.userId)
    expect(IssueUserStateWire.shape.entityId).toBe(IssueUserState.shape.entityId)
    expect(issueUserStateToWire(row)).toEqual({
      userId: 'user:a',
      entityId: 'issue:a',
      readAt: 'read',
      tuckedAt: null,
    })
    // An issue pin is a `pin` record (POD-6692): this row and its wire carry none.
    expect(issueUserStateToWire(row)).not.toHaveProperty('pinned')
    expect(IssueUserStateWire.shape).not.toHaveProperty('pinned')
    expect(IssueUserStateWire.shape).not.toHaveProperty('pinnedAt')
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
