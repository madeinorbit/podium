/**
 * The census's own tests — POD-3906.
 *
 * Written against literals wherever a literal will do, for the reason
 * `baseline-ratchet.test.ts` gives: a fixture derived from the constant under
 * test floats with it. The three tests that read the REAL tree are the point of
 * the file and say so.
 */
import { describe, expect, it } from 'vitest'
import {
  baselineShapedConstants,
  COMMITTED_BASELINES,
  checkRegistry,
  NOT_A_COMMITTED_BASELINE,
  qualify,
} from './audit-committed-floors'
import { constantsInFile } from './baseline-ratchet'

const registry = (over: Partial<Parameters<typeof checkRegistry>[0]> = {}) =>
  checkRegistry({
    found: ['scripts/probe.ts:MIN_THINGS'],
    registered: [],
    excluded: [],
    ...over,
  })

const checks = (fs: ReturnType<typeof checkRegistry>) => fs.map((f) => f.check)

describe('qualify', () => {
  it('spells a bare constant under its own export name, not the empty key', () => {
    expect(qualify({ '': 1800 }, 'MIN_ID_FIELD_SITES')).toEqual({ MIN_ID_FIELD_SITES: 1800 })
  })

  it('keeps an object literal addressable member by member', () => {
    expect(qualify({ web: 400, mobile: 30 }, 'CLIENT_FILE_FLOOR')).toEqual({
      'CLIENT_FILE_FLOOR.web': 400,
      'CLIENT_FILE_FLOOR.mobile': 30,
    })
  })

  it('is empty when the export was not found, rather than inventing a key', () => {
    expect(qualify({}, 'ABSENT')).toEqual({})
  })
})

describe('checkRegistry', () => {
  it('fails a baseline-shaped constant that is neither registered nor excluded', () => {
    expect(checks(registry())).toEqual(['committed-baseline-unregistered'])
  })

  it('passes one that is registered', () => {
    expect(registry({ registered: ['scripts/probe.ts:MIN_THINGS'] })).toEqual([])
  })

  it('passes one that is excluded with a reason', () => {
    expect(registry({ excluded: ['scripts/probe.ts:MIN_THINGS'] })).toEqual([])
  })

  it('fails an exclusion for a constant that no longer exists', () => {
    // Without this the escape hatch rots into a list of names nobody can check,
    // and a genuinely new floor can be hidden by reusing a dead entry's name.
    expect(checks(registry({ found: [], excluded: ['scripts/probe.ts:GONE'] }))).toEqual([
      'committed-baseline-exclusion-stale',
    ])
  })

  it('fails a registration for a constant that no longer exists', () => {
    expect(checks(registry({ found: [], registered: ['scripts/probe.ts:GONE'] }))).toEqual([
      'committed-baseline-registration-stale',
    ])
  })

  it('names the constant, not just the file', () => {
    expect(registry()[0]?.where).toBe('scripts/probe.ts:MIN_THINGS')
  })
})

describe('the census against the real tree', () => {
  it('resolves every registered baseline to a number that is actually there', () => {
    // A registration pointing at a renamed or deleted export would otherwise
    // sit in the list looking like coverage while guarding nothing.
    for (const b of COMMITTED_BASELINES) {
      const found = qualify(constantsInFile(b.relativePath, b.exportName), b.exportName)
      expect({
        where: `${b.relativePath}:${b.exportName}`,
        keys: Object.keys(found).sort(),
      }).toEqual({
        where: `${b.relativePath}:${b.exportName}`,
        keys: Object.keys(b.directions).sort(),
      })
    }
  })

  it('declares a direction for every key it enforces', () => {
    for (const b of COMMITTED_BASELINES)
      for (const [key, d] of Object.entries(b.directions))
        expect({ key, d }).toEqual({ key, d: d === 'floor' ? 'floor' : 'ceiling' })
  })

  it('leaves no baseline-shaped constant in scripts/ unaccounted for', () => {
    // THE LIVE GATE, and the reason this file is not just another hand-kept
    // list: a new floor added anywhere under scripts/ fails here until somebody
    // says which way it may not move, or says in writing why it is not a gate.
    expect(
      checkRegistry({
        found: baselineShapedConstants(),
        registered: COMMITTED_BASELINES.flatMap((b) => `${b.relativePath}:${b.exportName}`),
        excluded: NOT_A_COMMITTED_BASELINE.map((e) => e.where),
      }),
    ).toEqual([])
  })

  it('gives every exclusion a reason long enough to be one', () => {
    for (const e of NOT_A_COMMITTED_BASELINE)
      expect({ where: e.where, long: e.why.trim().length >= 40 }).toEqual({
        where: e.where,
        long: true,
      })
  })
})
