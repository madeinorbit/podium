import { describe, expect, it } from 'vitest'
import {
  ID_PREFIXES,
  type IdPrefix,
  isBrandedId,
  mintBrandedId,
  parseBrandedId,
  splitBrandedId,
} from './branded-ksuid'
import { KSUID_LENGTH, ksuid } from './ksuid'

/**
 * WHY THIS FILE EXISTS: the prefix is the half that makes an id say what it is,
 * so the two things it has to actually do are pinned here — refuse an id from
 * the WRONG table (a `mem_` where an `inv_` belongs is the confusion a shared
 * 27-character body invites), and keep the creation order `ksuid.ts` provides
 * after a prefix is glued on the front.
 */

describe('minting', () => {
  it('is the prefix followed by a KSUID', () => {
    const id = mintBrandedId('mem_')
    expect(id.startsWith('mem_')).toBe(true)
    expect(id).toHaveLength('mem_'.length + KSUID_LENGTH)
    expect(id).toMatch(/^mem_[0-9A-Za-z]{27}$/)
  })

  it('mints at an instant the caller names, so the id carries that time', () => {
    expect(parseBrandedId('mem_', mintBrandedId('mem_', 1_600_000_000_000)).at).toBe(
      1_600_000_000_000,
    )
  })

  it('refuses a prefix that is not two to four lowercase letters and an underscore', () => {
    // §9.1's rule, enforced at the mint so a typo cannot reach a column. The
    // `IdPrefix` type already refuses a literal with no underscore, which is why
    // these go through a cast: the runtime check is what holds for a prefix that
    // arrives as data — from a config, or from a caller in another package.
    const mint = (prefix: string) => () => mintBrandedId(prefix as IdPrefix)
    expect(mint('mem')).toThrow(/not a valid id prefix/)
    expect(mint('m_')).toThrow(/not a valid id prefix/)
    expect(mint('member_')).toThrow(/not a valid id prefix/)
    expect(mint('Mem_')).toThrow(/not a valid id prefix/)
    expect(mint('me-_')).toThrow(/not a valid id prefix/)
  })
})

describe('splitting an id of unknown kind', () => {
  it('names the prefix of an id nobody told it about', () => {
    // The support-ticket case: an id in a log says which table it came from
    // without the reader having to know every prefix this build mints.
    const id = `zzz_${ksuid()}`
    expect(splitBrandedId(id)).toEqual({ prefix: 'zzz_', ksuid: id.slice(4) })
  })

  it('refuses a bare KSUID, which belongs to no table', () => {
    expect(splitBrandedId(ksuid())).toBeNull()
  })

  it('refuses a well-formed prefix on a body that is not a KSUID', () => {
    expect(splitBrandedId(`mem_${ksuid().slice(1)}`)).toBeNull()
    expect(splitBrandedId('mem_')).toBeNull()
    expect(splitBrandedId(`mem_${'z'.repeat(KSUID_LENGTH)}`)).toBeNull()
  })

  it('refuses a KSUID behind a prefix that breaks the shape rule', () => {
    expect(splitBrandedId(`member_${ksuid()}`)).toBeNull()
    expect(splitBrandedId(`MEM_${ksuid()}`)).toBeNull()
  })
})

describe('parsing against an expected prefix', () => {
  it('returns the prefix, the body and the minting instant', () => {
    const id = mintBrandedId('inv_', 1_700_000_000_500)
    expect(parseBrandedId('inv_', id)).toEqual({
      prefix: 'inv_',
      ksuid: id.slice(4),
      at: 1_700_000_000_000,
    })
  })

  it('refuses an id from another table, and says which it got', () => {
    // The assertion A4 depends on: completing an invite must not accept a member
    // id. Both are 27 base62 characters, so only the prefix can tell them apart.
    const member = mintBrandedId('mem_')
    expect(() => parseBrandedId('inv_', member)).toThrow(/expected inv_.*got mem_/)
  })

  it('refuses a bare KSUID', () => {
    expect(() => parseBrandedId('mem_', ksuid())).toThrow(/expected mem_/)
  })

  it('answers the same question without throwing', () => {
    const member = mintBrandedId('mem_')
    expect(isBrandedId('mem_', member)).toBe(true)
    expect(isBrandedId('inv_', member)).toBe(false)
    expect(isBrandedId('mem_', ksuid())).toBe(false)
  })
})

describe('the prefix does not break creation order', () => {
  it('sorts ids of one kind by creation', () => {
    const week = 7 * 86_400_000
    const minted = Array.from({ length: 200 }, (_, i) =>
      mintBrandedId('mem_', 1_600_000_000_000 + i * week),
    )
    expect([...minted].sort()).toEqual(minted)
  })

  it('sorts by KIND first, which is what a constant prefix per table is for', () => {
    // Not a defect to route around: rows from one table share one prefix, so
    // within a table the order is the clock's, and an index on the column keeps
    // one table's ids contiguous. Cross-table ordering is not a thing to want.
    const invite = mintBrandedId('inv_', 1_900_000_000_000)
    const member = mintBrandedId('mem_', 1_600_000_000_000)
    expect(invite < member).toBe(true)
  })
})

describe('the prefix registry', () => {
  it('holds the SQLite-side prefixes §9.1 assigns this repo', () => {
    expect(ID_PREFIXES).toEqual({ member: 'mem_', invite: 'inv_' })
  })

  it('gives every model a distinct prefix that obeys the shape rule', () => {
    // Parsing is keyed by prefix, so two models sharing one would make an id
    // from either parse as both.
    const prefixes = Object.values(ID_PREFIXES)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    for (const prefix of prefixes) expect(() => mintBrandedId(prefix)).not.toThrow()
  })
})
