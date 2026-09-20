import type { IssueReferenceSource } from '@podium/client-core/viewmodels'
import { describe, expect, it } from 'vitest'
import { issueReferenceLookup, issueReferenceSignature } from '@/lib/issue-chip-liveness'
import { createIssueChipRefsSelector } from './issue-chip-refs'

function issue(overrides: Partial<IssueReferenceSource> = {}): IssueReferenceSource {
  return {
    id: 'issue-13' as IssueReferenceSource['id'],
    seq: 13,
    prefix: 'POD',
    displayRef: 'POD-13',
    title: 'Stable chips',
    stage: 'in_progress',
    archived: false,
    ...overrides,
  }
}

/** A corpus on the scale of the warm profile (~4,900 issues). */
function corpus(size: number): IssueReferenceSource[] {
  return Array.from({ length: size }, (_, index) =>
    issue({
      id: `issue-${index}` as IssueReferenceSource['id'],
      seq: index,
      displayRef: `POD-${index}`,
      title: `Issue ${index}`,
    }),
  )
}

/** A value-identical rebuild, the way a replica publication replaces the array. */
function rebuild(issues: readonly IssueReferenceSource[]): IssueReferenceSource[] {
  return issues.map((row) => ({ ...row }))
}

describe('issue chip refs selector', () => {
  it('computes one signature and one lookup across two renders on the same array', () => {
    const selector = createIssueChipRefsSelector()
    const issues = [issue()]

    const first = selector.select(issues)
    const second = selector.select(issues)

    expect(selector.stats.signatureBuilds).toBe(1)
    expect(selector.stats.lookupBuilds).toBe(1)
    expect(second).toBe(first)
  })

  it('does no signature or lookup work when a publication replaces the array without changing values', () => {
    const selector = createIssueChipRefsSelector()
    selector.select([issue()])

    const refs = selector.select(rebuild([issue()]))

    expect(selector.stats.signatureBuilds).toBe(1)
    expect(selector.stats.lookupBuilds).toBe(1)
    expect(refs.refs.get('POD-13')?.stage).toBe('in_progress')
  })

  it('a second identical corpus-scale pass does no signature or lookup work', () => {
    const selector = createIssueChipRefsSelector()
    const issues = corpus(4900)
    selector.select(issues)

    selector.select(rebuild(issues))

    expect(selector.stats.materialScans).toBe(2)
    expect(selector.stats.signatureBuilds).toBe(1)
    expect(selector.stats.lookupBuilds).toBe(1)
  })

  it('rebuilds when a visible field changes, and the new lookup answers with it', () => {
    const selector = createIssueChipRefsSelector()
    const before = selector.select([issue()])
    const after = selector.select([issue({ stage: 'done', title: 'Renamed' })])

    expect(selector.stats.signatureBuilds).toBe(2)
    expect(selector.stats.lookupBuilds).toBe(2)
    expect(after.signature).not.toBe(before.signature)
    expect(after.refs).not.toBe(before.refs)
    expect(after.refs.get('POD-13')?.stage).toBe('done')
    expect(after.refs.get('POD-13')?.title).toBe('Renamed')
  })

  it('a same-array render costs the identity fast path, with no material scan', () => {
    // The replica hands out immutable snapshots: same array identity means
    // nothing changed, exactly the assumption host-session-aggregates and
    // repository-usage make. This is the brief's "costs a map lookup" render.
    const selector = createIssueChipRefsSelector()
    const issues = [issue()]
    const first = selector.select(issues)

    const second = selector.select(issues)

    expect(second).toBe(first)
    expect(selector.stats.materialScans).toBe(1)
    expect(selector.stats.signatureBuilds).toBe(1)
    expect(selector.stats.lookupBuilds).toBe(1)
  })

  it('legacy arm: recomputing the signature per render builds every time, over identical results', () => {
    // The pre-fix call-site behavior: issueReferenceSignature(issues) plus
    // issueReferenceLookup(issues) on every render, with no memo between them.
    const issues = [issue()]
    let legacySignatureBuilds = 0
    let legacyLookupBuilds = 0
    const legacyRender = () => {
      legacySignatureBuilds += 1
      const signature = issueReferenceSignature(issues)
      legacyLookupBuilds += 1
      const refs = issueReferenceLookup(issues)
      return { signature, refs }
    }

    legacyRender()
    const legacy = legacyRender()

    // The legacy arm FAILS the memo assertion: two renders, two full builds.
    expect(legacySignatureBuilds).toBe(2)
    expect(legacyLookupBuilds).toBe(2)

    // Control dimension, asserted equal in both arms so the win cannot come
    // from doing less work: the memoized selection answers identically.
    const selector = createIssueChipRefsSelector()
    const memoized = selector.select(issues)
    selector.select(issues)
    expect(selector.stats.signatureBuilds).toBe(1)
    expect(selector.stats.lookupBuilds).toBe(1)
    expect(memoized.signature).toBe(legacy.signature)
    expect([...memoized.refs.entries()]).toEqual([...legacy.refs.entries()])
  })
})
