import { describe, expect, it } from 'vitest'
import { finishPeekClose, nextPeekPhase, PEEK_CLOSED } from './issue-peek-phase'

describe('peek drawer phases', () => {
  it('opens from closed', () => {
    expect(nextPeekPhase(PEEK_CLOSED, 'a')).toEqual({ kind: 'open', issueId: 'a' })
  })

  it('same id while open is a no-op (stable reference)', () => {
    const open = nextPeekPhase(PEEK_CLOSED, 'a')
    expect(nextPeekPhase(open, 'a')).toBe(open)
  })

  it('a new id replaces the open peek without closing', () => {
    const open = nextPeekPhase(PEEK_CLOSED, 'a')
    expect(nextPeekPhase(open, 'b')).toEqual({ kind: 'open', issueId: 'b' })
  })

  it('clearing the id starts the exit, keeping the issue mounted', () => {
    const open = nextPeekPhase(PEEK_CLOSED, 'a')
    expect(nextPeekPhase(open, null)).toEqual({ kind: 'closing', issueId: 'a' })
  })

  it('reopening mid-close snaps back to open', () => {
    const closing = nextPeekPhase(nextPeekPhase(PEEK_CLOSED, 'a'), null)
    expect(nextPeekPhase(closing, 'b')).toEqual({ kind: 'open', issueId: 'b' })
  })

  it('clearing while closing or closed changes nothing', () => {
    const closing = nextPeekPhase(nextPeekPhase(PEEK_CLOSED, 'a'), null)
    expect(nextPeekPhase(closing, null)).toBe(closing)
    expect(nextPeekPhase(PEEK_CLOSED, null)).toBe(PEEK_CLOSED)
  })

  it('finishPeekClose only completes a closing phase', () => {
    const closing = nextPeekPhase(nextPeekPhase(PEEK_CLOSED, 'a'), null)
    expect(finishPeekClose(closing)).toEqual(PEEK_CLOSED)
    const open = nextPeekPhase(PEEK_CLOSED, 'a')
    expect(finishPeekClose(open)).toBe(open)
    expect(finishPeekClose(PEEK_CLOSED)).toBe(PEEK_CLOSED)
  })
})
