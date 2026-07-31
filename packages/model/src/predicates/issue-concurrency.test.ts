import { describe, expect, it } from 'vitest'
import { checkExpectedRevision } from './issue-concurrency'

describe('checkExpectedRevision (ADR 1 exp-rev / ADR 2 D3 token / ADR 3 D13)', () => {
  it('allows a write whose precondition matches current truth', () => {
    expect(checkExpectedRevision(4, 4)).toEqual({ kind: 'ok' })
  })

  it('allows a write that states no precondition', () => {
    // Not "the check failed open": expectedRevision is optional across the Issues
    // seed, and omitting it MEANS last-write-wins. The distinction matters — the
    // `unverifiable` case below is what a genuinely uncheckable precondition
    // looks like, and it is a refusal.
    expect(checkExpectedRevision(undefined, 4)).toEqual({ kind: 'ok' })
    expect(checkExpectedRevision(undefined, undefined)).toEqual({ kind: 'ok' })
  })

  it('refuses a stale write and reports the revision to rebase onto', () => {
    // The caller read revision 3; someone else has since written (now 5). The
    // CURRENT revision rides along so a client can re-read and retry rather than
    // guess — ADR 3 D13.3's "a reason the UI can render".
    expect(checkExpectedRevision(3, 5)).toEqual({ kind: 'stale', expected: 3, actual: 5 })
  })

  it('refuses a write it CANNOT check rather than waving it through', () => {
    // The gate must refuse what it does not understand. A caller asked for a
    // precondition against an entity carrying no revision (hub-mirrored, or
    // written before ADR 2 D3); applying anyway would silently downgrade the
    // write to last-write-wins while the caller believes it was guarded.
    expect(checkExpectedRevision(3, undefined)).toEqual({ kind: 'unverifiable', expected: 3 })
  })

  it('refuses a precondition ahead of truth, not just behind it', () => {
    // A revision the authority has never issued is not "close enough to current"
    // — it is a caller out of sync with the authority in the other direction
    // (a replayed client, a bad rebase). Equality is the rule, not ordering.
    expect(checkExpectedRevision(9, 5)).toEqual({ kind: 'stale', expected: 9, actual: 5 })
  })
})
