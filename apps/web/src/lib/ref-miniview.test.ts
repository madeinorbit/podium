import { describe, expect, it } from 'vitest'
import {
  knownPrefixesFromIssues,
  miniviewReducer,
  type RefIssueLike,
  type RefSessionLike,
  resolveRef,
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
  it('opens to a ref', () => {
    expect(miniviewReducer(null, { type: 'open', ref: 'POD-13' })).toEqual({ ref: 'POD-13' })
  })

  it('opening again replaces the previous ref (single instance)', () => {
    const s = miniviewReducer({ ref: 'POD-13' }, { type: 'open', ref: 'POD-27' })
    expect(s).toEqual({ ref: 'POD-27' })
  })

  it('closes', () => {
    expect(miniviewReducer({ ref: 'POD-13' }, { type: 'close' })).toBeNull()
  })
})

describe('knownPrefixesFromIssues', () => {
  it('derives the unique set of prefixes', () => {
    expect(knownPrefixesFromIssues(issues)).toEqual(new Set(['POD', 'WEB']))
  })

  it('skips issues without a prefix', () => {
    expect(knownPrefixesFromIssues([{ prefix: 'POD' }, {}, { prefix: undefined }])).toEqual(
      new Set(['POD']),
    )
  })

  it('is empty for no issues', () => {
    expect(knownPrefixesFromIssues([]).size).toBe(0)
  })
})
