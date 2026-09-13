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
  baseRevision,
  checkRaise,
  checkRaiseAgainstBase,
  constantsIn,
  type GitRunner,
  type RaiseAuthorisation,
} from './baseline-ratchet'

const AUTH: RaiseAuthorisation = {
  key: 'seats',
  from: 41,
  to: 46,
  issue: 'POD-0000',
  reason: 'a reason long enough to clear the minimum, which is the point of the minimum',
}

const raise = (over: Partial<Parameters<typeof checkRaise>[0]> = {}) =>
  checkRaise({
    instrument: 'probe',
    current: { seats: 46 },
    base: { seats: 41 },
    authorisations: [],
    enforced: ['seats'],
    how: 'a fixture',
    requireBase: false,
    ...over,
  })

const checks = (fs: ReturnType<typeof checkRaise>) => fs.map((f) => f.check)

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

describe('checkRaise', () => {
  it('passes an unchanged baseline', () => {
    expect(raise({ current: { seats: 41 } })).toEqual([])
  })

  it('passes a LOWERED baseline with no ceremony at all', () => {
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

describe('checkRaiseAgainstBase', () => {
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
    checkRaiseAgainstBase({
      instrument: 'probe',
      relativePath: 'scripts/probe.ts',
      exportName: 'BASELINE',
      current,
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
