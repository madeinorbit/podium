import type { IssueProjection, IssueWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { issueCursorReadAt } from './issue-view-models'

describe('issueCursorReadAt', () => {
  const legacy = { readAt: '2026-08-13T09:00:00.000Z' } as Pick<IssueWire, 'readAt'>

  it('uses an explicit projection cursor, including a mark-unread null', () => {
    expect(
      issueCursorReadAt(
        { readAt: '2026-08-13T10:00:00.000Z' } as unknown as IssueProjection,
        legacy,
      ),
    ).toBe('2026-08-13T10:00:00.000Z')
    expect(issueCursorReadAt({ readAt: null } as unknown as IssueProjection, legacy)).toBeNull()
  })

  it('falls back to the persist echo when the projection omits readAt', () => {
    const projection = { id: 'iss_1' } as IssueProjection
    expect(Object.hasOwn(projection, 'readAt')).toBe(false)
    expect(issueCursorReadAt(projection, legacy)).toBe(legacy.readAt)
    expect(issueCursorReadAt(projection, { readAt: null })).toBeNull()
    expect(issueCursorReadAt(projection, undefined)).toBeNull()
  })
})
