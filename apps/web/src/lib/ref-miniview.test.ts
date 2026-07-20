import { describe, expect, it } from 'vitest'
import {
  collectRefPrefixes,
  miniviewReducer,
  type RefIssueLike,
  type RefSessionLike,
  resolveRef,
  sessionWorkingIssueRef,
} from './ref-miniview'

const issues: RefIssueLike[] = [
  { id: 'iss_1', prefix: 'POD', seq: 13, displayRef: 'POD-13', title: 'Nice ids' },
  { id: 'iss_2', prefix: 'POD', seq: 27, displayRef: 'POD-27', title: 'Other' },
  { id: 'iss_3', prefix: 'WEB', seq: 4, displayRef: 'WEB-4', title: 'Web thing' },
]

const sessions: RefSessionLike[] = [
  { sessionId: 's1', displayRef: 'POD-13-A', cwd: '/repo', issueId: 'iss_1', name: 'agent a' },
  { sessionId: 's2', displayRef: 'POD-DRAFT-3', cwd: '/repo', name: 'draft agent' },
]

describe('resolveRef', () => {
  it('resolves an issue token by prefix + seq', () => {
    const r = resolveRef('POD-13', issues, sessions)
    expect(r?.kind).toBe('issue')
    expect(r?.kind === 'issue' && r.issue.id).toBe('iss_1')
  })

  it('resolves against the right prefix, not just seq', () => {
    const r = resolveRef('WEB-4', issues, sessions)
    expect(r?.kind === 'issue' && r.issue.id).toBe('iss_3')
  })

  it('resolves an issue-born session by displayRef', () => {
    const r = resolveRef('POD-13-A', issues, sessions)
    expect(r?.kind).toBe('session')
    expect(r?.kind === 'session' && r.session.sessionId).toBe('s1')
  })

  it('resolves a draft session by displayRef', () => {
    const r = resolveRef('POD-DRAFT-3', issues, sessions)
    expect(r?.kind === 'session' && r.session.sessionId).toBe('s2')
  })

  it('returns null for an unparseable token', () => {
    expect(resolveRef('not-a-ref', issues, sessions)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(resolveRef('POD-999', issues, sessions)).toBeNull()
    expect(resolveRef('POD-13-Z', issues, sessions)).toBeNull()
  })

  it('tolerates surrounding whitespace', () => {
    expect(resolveRef('  POD-13  ', issues, sessions)?.kind).toBe('issue')
  })
})

describe('miniviewReducer', () => {
  it('opens to a ref, carrying the click anchor', () => {
    expect(miniviewReducer(null, { type: 'open', ref: 'POD-13', anchor: { x: 40, y: 90 } })).toEqual(
      { ref: 'POD-13', anchor: { x: 40, y: 90 }, seq: 1 },
    )
  })

  it('opening again replaces the previous ref (single instance) and bumps seq', () => {
    const s = miniviewReducer({ ref: 'POD-13', seq: 1 }, { type: 'open', ref: 'POD-27' })
    expect(s).toEqual({ ref: 'POD-27', anchor: undefined, seq: 2 })
  })

  it('re-opening the same ref still bumps seq (position re-seeds per click)', () => {
    const s = miniviewReducer(
      { ref: 'POD-13', anchor: { x: 1, y: 2 }, seq: 3 },
      { type: 'open', ref: 'POD-13', anchor: { x: 300, y: 400 } },
    )
    expect(s).toEqual({ ref: 'POD-13', anchor: { x: 300, y: 400 }, seq: 4 })
  })

  it('closes', () => {
    expect(miniviewReducer({ ref: 'POD-13', seq: 1 }, { type: 'close' })).toBeNull()
  })
})

describe('collectRefPrefixes', () => {
  it('derives the unique set of prefixes', () => {
    expect(collectRefPrefixes(issues)).toEqual(new Set(['POD', 'WEB']))
  })

  it('skips rows without a prefix (undefined or null)', () => {
    expect(collectRefPrefixes([{ prefix: 'POD' }, {}, { prefix: null }])).toEqual(new Set(['POD']))
  })

  it('unions repo rows with issue rows — a repo with zero issues still counts', () => {
    const repoRows = [{ prefix: 'CLI' }, { prefix: null }]
    expect(collectRefPrefixes(repoRows, issues)).toEqual(new Set(['CLI', 'POD', 'WEB']))
  })

  it('is empty for no rows', () => {
    expect(collectRefPrefixes([]).size).toBe(0)
  })
})

describe('sessionWorkingIssueRef', () => {
  it('returns the current issue ref when the session re-homed off its birth issue', () => {
    const s = { displayRef: 'POD-13-A', issueId: 'iss_2' } // now working POD-27
    expect(sessionWorkingIssueRef(s, issues)).toBe('POD-27')
  })

  it('returns null when the current issue IS the birth issue', () => {
    const s = { displayRef: 'POD-13-A', issueId: 'iss_1' }
    expect(sessionWorkingIssueRef(s, issues)).toBeNull()
  })

  it('returns the current issue ref for a draft-born session', () => {
    const s = { displayRef: 'POD-DRAFT-3', issueId: 'iss_3' }
    expect(sessionWorkingIssueRef(s, issues)).toBe('WEB-4')
  })

  it('returns null without a current issue, an unknown issue, or a ref-less issue', () => {
    expect(sessionWorkingIssueRef({ displayRef: 'POD-13-A' }, issues)).toBeNull()
    expect(sessionWorkingIssueRef({ displayRef: 'POD-13-A', issueId: 'nope' }, issues)).toBeNull()
    expect(
      sessionWorkingIssueRef({ displayRef: 'POD-13-A', issueId: 'iss_9' }, [
        { id: 'iss_9', seq: 9, title: 'legacy, no displayRef' },
      ]),
    ).toBeNull()
  })
})
