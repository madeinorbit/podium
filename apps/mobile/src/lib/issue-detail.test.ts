import { describe, expect, it } from 'vitest'
import { shouldContinueEventDrain } from './issue-detail'

describe('shouldContinueEventDrain', () => {
  it('pages while the cursor advances on a full page', () => {
    expect(
      shouldContinueEventDrain({
        pageLength: 200,
        pageSize: 200,
        sinceBefore: 0,
        sinceAfter: 200,
        pages: 1,
      }),
    ).toBe(true)
  })

  it('stops when the server repeats the same page', () => {
    expect(
      shouldContinueEventDrain({
        pageLength: 200,
        pageSize: 200,
        sinceBefore: 200,
        sinceAfter: 200,
        pages: 2,
      }),
    ).toBe(false)
  })

  it('stops after the page cap even if the cursor is still moving', () => {
    expect(
      shouldContinueEventDrain({
        pageLength: 200,
        pageSize: 200,
        sinceBefore: 3800,
        sinceAfter: 4000,
        pages: 20,
      }),
    ).toBe(false)
  })
})
