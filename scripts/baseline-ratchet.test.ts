/**
 * The raise check's own tests.
 *
 * Written against LITERALS, not against the constants under test. The repo's
 * existing threshold tests are relative — `MIN_ID_FIELD_SITES + 10`,
 * `CLIENT_FILE_FLOOR.web - 1`, `DAEMON_COMPOSITION_ROOT_MAX_LINES + 1` — which
 * proves the check fires at its boundary and then floats with the constant, so
 * editing the constant leaves them green. That is the shape this module exists
 * to stop being the only guard, and it would be a poor joke to repeat it here.
 */
import { describe, expect, it } from 'vitest'
import {
  type BaselineAuthorisation,
  baseRevision,
  checkBaseline,
  checkBaselineAgainstBase,
  constantsIn,
  type GitRunner,
} from './baseline-ratchet'

const AUTH: BaselineAuthorisation = {
  key: 'seats',
  from: 41,
  to: 46,
  issue: 'POD-0000',
  reason: 'a reason long enough to clear the minimum, which is the point of the minimum',
}

const raise = (over: Partial<Parameters<typeof checkBaseline>[0]> = {}) =>
  checkBaseline({
    instrument: 'probe',
    current: { seats: 46 },
    base: { seats: 41 },
    directions: { seats: 'ceiling' },
    authorisations: [],
    enforced: ['seats'],
    how: 'a fixture',
    requireBase: false,
    ...over,
  })

/**
 * The mirror fixture — POD-3906. A floor's safe direction is UP, so every
 * expectation here is the reverse of the block above. Written against literals
 * for the same reason that block is: a fixture derived from the constant under
 * test floats with it.
 */
const FLOOR_AUTH: BaselineAuthorisation = {
  key: 'sites',
  from: 1800,
  to: 1200,
  issue: 'POD-0000',
  reason: 'a reason long enough to clear the minimum, which is the point of the minimum',
}

const floor = (over: Partial<Parameters<typeof checkBaseline>[0]> = {}) =>
  checkBaseline({
    instrument: 'probe',
    current: { sites: 1200 },
    base: { sites: 1800 },
    directions: { sites: 'floor' },
    authorisations: [],
    enforced: ['sites'],
    how: 'a fixture',
    requireBase: false,
    ...over,
  })

const checks = (fs: ReturnType<typeof checkBaseline>) => fs.map((f) => f.check)

describe('constantsIn', () => {
  it('reads an object-literal baseline by key', () => {
    expect(constantsIn('export const BASELINE = { firstAdminMemberId: 42 }', 'BASELINE')).toEqual({
      firstAdminMemberId: 42,
    })
  })

  it('reads a bare numeric export under the empty key', () => {
    expect(constantsIn('export const THRESHOLD = 600', 'THRESHOLD')).toEqual({ '': 600 })
  })

  it('sees through the type annotation and the `as const` the repo writes', () => {
    const src = `
      export const BASELINE: Readonly<Record<string, number>> = {
        /** a doc comment between the key and its value */
        firstAdminMemberId: 42,
        'quoted-key': 7,
      } as const
    `
    expect(constantsIn(src, 'BASELINE')).toEqual({ firstAdminMemberId: 42, 'quoted-key': 7 })
  })

  it('is not fooled by the symbol appearing in prose or in another declaration', () => {
    const src = `
      // BASELINE was 41 here once
      const notTheBaseline = { firstAdminMemberId: 999 }
      export const BASELINE = { firstAdminMemberId: 42 }
    `
    expect(constantsIn(src, 'BASELINE')).toEqual({ firstAdminMemberId: 42 })
  })

  it('returns nothing when the export is absent, rather than guessing', () => {
    expect(constantsIn('export const OTHER = { a: 1 }', 'BASELINE')).toEqual({})
  })
})

describe('checkBaseline', () => {
  it('passes an unchanged baseline', () => {
    expect(raise({ current: { seats: 41 } })).toEqual([])
  })

  it('passes a LOWERED ceiling with no ceremony at all', () => {
    expect(raise({ current: { seats: 12 } })).toEqual([])
  })

  it('fails a raise with no authorisation', () => {
    expect(checks(raise())).toEqual(['baseline-raised-without-authorisation'])
  })

  it('passes a raise whose authorisation names both numbers', () => {
    expect(raise({ authorisations: [AUTH] })).toEqual([])
  })

  it('fails a raise whose authorisation names the wrong previous value', () => {
    // The number an author cannot write from memory is the whole mechanism.
    expect(checks(raise({ authorisations: [{ ...AUTH, from: 45 }] }))).toEqual([
      'baseline-raised-without-authorisation',
    ])
    expect(raise({ authorisations: [{ ...AUTH, from: 45 }] })[0]?.detail).toContain(
      'says it rose from 45, but the base commit says 41',
    )
  })

  it('fails a raise authorised for a different destination', () => {
    expect(checks(raise({ authorisations: [{ ...AUTH, to: 50 }] }))).toEqual([
      'baseline-raised-without-authorisation',
    ])
  })

  it('fails a raise whose reason is a shrug, and says how short it was', () => {
    const found = raise({ authorisations: [{ ...AUTH, reason: 'later' }] })
    expect(checks(found)).toEqual(['baseline-raised-without-authorisation'])
    expect(found[0]?.detail).toContain('is 5 characters; 40 is the minimum')
  })

  it('fails a raise whose authorisation names no issue', () => {
    expect(checks(raise({ authorisations: [{ ...AUTH, issue: '  ' }] }))).toEqual([
      'baseline-raised-without-authorisation',
    ])
  })

  it('fails a key that vanished — a rename carries the value across', () => {
    expect(checks(raise({ current: { chairs: 41 } }))).toEqual(['baseline-key-disappeared'])
  })

  it('passes a rename recorded with both spellings and both numbers', () => {
    expect(
      raise({
        current: { chairs: 41 },
        authorisations: [{ ...AUTH, from: 41, to: 41, renamedTo: 'chairs' }],
      }),
    ).toEqual([])
  })

  it('fails a rename whose recorded destination value is not the one in the tree', () => {
    // And names the NUMBER, not the rename: once a retirement has landed, this
    // is the shape a later raise takes, and pointing the reader at the rename
    // would send them after the wrong thing.
    const found = raise({
      current: { chairs: 44 },
      authorisations: [{ ...AUTH, from: 41, to: 41, renamedTo: 'chairs' }],
    })
    expect(checks(found)).toEqual(['baseline-raised-without-authorisation'])
    expect(found[0]?.where).toBe('probe:chairs')
    expect(found[0]?.detail).toContain('records it at 41. This tree baselines it at 44')
  })

  it('fails a rename recorded with the right numbers but no argument', () => {
    const found = raise({
      current: { chairs: 41 },
      authorisations: [{ ...AUTH, from: 41, to: 41, renamedTo: 'chairs', reason: 'no' }],
    })
    expect(checks(found)).toEqual(['baseline-raised-without-authorisation'])
    expect(found[0]?.detail).toContain('incomplete record')
  })

  it('fails a baseline that is still there but no longer enforced', () => {
    expect(checks(raise({ current: { seats: 41 }, enforced: [] }))).toEqual([
      'baseline-enforcement-dropped',
    ])
  })

  it('says nothing about a key the base commit never had', () => {
    expect(raise({ base: {}, current: { seats: 46 } })).toEqual([])
  })

  describe('when history cannot be read', () => {
    it('is silent by default, so a shallow clone is not a wall', () => {
      expect(raise({ base: null })).toEqual([])
    })

    it('fails under --require-base, so CI cannot pass by not looking', () => {
      expect(checks(raise({ base: null, requireBase: true }))).toEqual([
        'baseline-base-unavailable',
      ])
    })
  })
})

describe('a floor, where the escape is LOWERING it', () => {
  // POD-3906. Half the repository's committed numbers are floors — a coverage
  // floor, a file-count floor, a scanned-files floor — and for those the
  // direction `checkBaseline` guards is the safe one. The ratchet's own recorded
  // history is the demonstration: the single authorisation in the repository
  // records 46 -> 42 -> 38, three movements, all downward, none of them a raise.

  it('fails a lowering with no authorisation', () => {
    expect(checks(floor())).toEqual(['baseline-lowered-without-authorisation'])
  })

  it('passes a RAISED floor with no ceremony at all', () => {
    // The exact mirror of the ceiling's lowering: moving a floor up tightens it.
    expect(floor({ current: { sites: 2400 } })).toEqual([])
  })

  it('passes an unchanged floor', () => {
    expect(floor({ current: { sites: 1800 } })).toEqual([])
  })

  it('passes a lowering whose authorisation names both numbers', () => {
    expect(floor({ authorisations: [FLOOR_AUTH] })).toEqual([])
  })

  it('fails a lowering whose authorisation names the wrong previous value', () => {
    const found = floor({ authorisations: [{ ...FLOOR_AUTH, from: 1700 }] })
    expect(checks(found)).toEqual(['baseline-lowered-without-authorisation'])
    expect(found[0]?.detail).toContain('says it fell from 1700, but the base commit says 1800')
  })

  it('fails a lowering whose reason is a shrug, and says how short it was', () => {
    const found = floor({ authorisations: [{ ...FLOOR_AUTH, reason: 'later' }] })
    expect(checks(found)).toEqual(['baseline-lowered-without-authorisation'])
    expect(found[0]?.detail).toContain('is 5 characters; 40 is the minimum')
  })

  it('says which way the gate looks, and by how much', () => {
    // A reader who sees `1800 -> 1200` without the word `floor` cannot tell
    // whether the number moving down is the problem or the fix.
    expect(floor()[0]?.detail).toContain('floor 1800 -> 1200 (-600)')
  })

  it('names a stale retirement record by the direction the floor looks', () => {
    // The rare path, and the one a reviewer reads last: once a retirement has
    // landed, a later movement of the RENAMED key surfaces here rather than in
    // the comparison above, and calling a collapse a `raise` would send the
    // reader looking for the opposite defect.
    const found = floor({
      current: { scanned: 1200 },
      directions: { sites: 'floor', scanned: 'floor' },
      authorisations: [{ ...FLOOR_AUTH, from: 1800, to: 1500, renamedTo: 'scanned' }],
    })
    expect(checks(found)).toEqual(['baseline-lowered-without-authorisation'])
    expect(found[0]?.where).toBe('probe:scanned')
  })

  it('still catches a floor that vanished, which a rename is', () => {
    expect(checks(floor({ current: { scanned: 1800 } }))).toEqual(['baseline-key-disappeared'])
  })

  it('still catches a floor that is there but no longer enforced', () => {
    expect(checks(floor({ current: { sites: 1800 }, enforced: [] }))).toEqual([
      'baseline-enforcement-dropped',
    ])
  })
})

describe('the direction itself', () => {
  // A default direction would reintroduce the hole one level up: add a floor,
  // forget to declare it, and it silently gets ceiling semantics — so lowering
  // it to zero is unguarded, which is the exact escape this issue closes.

  it('refuses to guess for an enforced key that declares none', () => {
    expect(checks(floor({ directions: {} }))).toEqual(['baseline-direction-undeclared'])
  })

  it('refuses to guess even when the number did not move', () => {
    // The direction is a property of the CHECK, not of a movement: a key with
    // no declared direction is unguarded the moment someone does move it.
    expect(checks(floor({ current: { sites: 1800 }, directions: {} }))).toEqual([
      'baseline-direction-undeclared',
    ])
  })

  it("does not confuse one key's direction for another's", () => {
    expect(checks(floor({ directions: { seats: 'floor' } }))).toEqual([
      'baseline-direction-undeclared',
    ])
  })

  it('reports the undeclared key by name', () => {
    expect(floor({ directions: {} })[0]?.where).toBe('probe:sites')
  })
})

describe('baseRevision', () => {
  const git = (table: Record<string, string | null>): GitRunner => {
    return (args) => {
      const key = args.join(' ')
      const value = table[key]
      return value === undefined || value === null
        ? { ok: false, stdout: '' }
        : { ok: true, stdout: value }
    }
  }

  it('prefers the merge base with origin/main', () => {
    const r = baseRevision(
      git({
        'rev-parse --verify HEAD': 'aaa',
        'rev-parse --verify origin/main^{commit}': 'ooo',
        'merge-base HEAD origin/main': 'mmm',
      }),
      {},
    )
    expect(r).toEqual({ commit: 'mmm', how: 'merge-base HEAD origin/main' })
  })

  it('falls back to local main when there is no remote', () => {
    const r = baseRevision(
      git({
        'rev-parse --verify HEAD': 'aaa',
        'rev-parse --verify main^{commit}': 'lll',
        'merge-base HEAD main': 'mmm',
      }),
      {},
    )
    expect(r.commit).toBe('mmm')
    expect(r.how).toBe('merge-base HEAD main')
  })

  it('uses the previous commit when HEAD IS the merge base', () => {
    // On main itself the merge base is HEAD, and comparing a file with itself
    // is a check that can never say no.
    const r = baseRevision(
      git({
        'rev-parse --verify HEAD': 'aaa',
        'rev-parse --verify origin/main^{commit}': 'aaa',
        'merge-base HEAD origin/main': 'aaa',
        'rev-parse --verify HEAD^{commit}^': 'prev',
      }),
      {},
    )
    expect(r.commit).toBe('prev')
    expect(r.how).toContain('HEAD^')
  })

  it('honours PODIUM_RATCHET_BASE over everything', () => {
    const r = baseRevision(git({ 'rev-parse --verify deadbeef^{commit}': 'deadbeef' }), {
      PODIUM_RATCHET_BASE: 'deadbeef',
    })
    expect(r).toEqual({ commit: 'deadbeef', how: 'PODIUM_RATCHET_BASE=deadbeef' })
  })

  it('reports a shallow clone by name instead of passing quietly', () => {
    const r = baseRevision(git({ 'rev-parse --verify HEAD': 'aaa' }), {})
    expect(r.commit).toBeNull()
    expect(r.how).toContain('no integration branch present')
  })
})

describe('checkBaselineAgainstBase', () => {
  const gitWith =
    (baseSource: string | null): GitRunner =>
    (args) => {
      const key = args.join(' ')
      if (key === 'rev-parse --verify HEAD') return { ok: true, stdout: 'headsha0000' }
      if (key === 'rev-parse --verify origin/main^{commit}')
        return { ok: true, stdout: 'mainsha0000' }
      if (key === 'merge-base HEAD origin/main') return { ok: true, stdout: 'basesha0000' }
      if (key.startsWith('show basesha0000:'))
        return baseSource === null ? { ok: false, stdout: '' } : { ok: true, stdout: baseSource }
      return { ok: false, stdout: '' }
    }

  const run = (baseSource: string | null, current: Record<string, number>, requireBase = false) =>
    checkBaselineAgainstBase({
      instrument: 'probe',
      relativePath: 'scripts/probe.ts',
      exportName: 'BASELINE',
      current,
      directions: { seats: 'ceiling' },
      authorisations: [],
      enforced: ['seats'],
      requireBase,
      git: gitWith(baseSource),
      env: {},
    })

  it('parses the baseline out of the base commit and catches a raise', () => {
    const out = run('export const BASELINE = { seats: 41 }', { seats: 46 })
    expect(out.base).toEqual({ seats: 41 })
    expect(checks(out.findings)).toEqual(['baseline-raised-without-authorisation'])
    expect(out.how).toBe('merge-base HEAD origin/main (basesha00)')
  })

  it('is quiet when the tree matches history', () => {
    expect(run('export const BASELINE = { seats: 41 }', { seats: 41 }).findings).toEqual([])
  })

  it('distinguishes "the file was not there" from "it had no baseline"', () => {
    expect(run(null, { seats: 46 }).how).toContain('did not exist there')
    expect(run('export const OTHER = 1', { seats: 46 }).how).toContain('no `BASELINE` there')
  })

  it('a file absent on the base commit is unreadable history, and --require-base fails it', () => {
    expect(checks(run(null, { seats: 46 }, true).findings)).toEqual(['baseline-base-unavailable'])
  })
})
