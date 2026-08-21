import { describe, expect, it } from 'vitest'
import {
  commitShaFromDevVersion,
  type DevPublisherVersionState,
  effectiveMintBase,
  formatDevVersion,
  formatDevVersionShort,
  isDevChannelVersion,
  isPublisherDevVersion,
  mintDevVersion,
  parsePublisherDevVersion,
} from './dev-version'
import { compareVersions, isProvablyNewer } from './version-order'

describe('effectiveMintBase', () => {
  it('passes edge bases through', () => {
    expect(effectiveMintBase('0.1.1-edge.1')).toBe('0.1.1-edge.1')
  })

  it('bumps a bare stable release to the next patch lineage', () => {
    expect(effectiveMintBase('0.1.1')).toBe('0.1.2')
    expect(effectiveMintBase('0.1.0')).toBe('0.1.1')
  })
})

describe('formatDevVersion', () => {
  it('appends .dev.N onto an edge prerelease lineage and keeps the commit as build metadata', () => {
    expect(formatDevVersion('0.1.0-edge.20', 5, '656F49Bdead')).toBe('0.1.0-edge.20.dev.5+656f49b')
  })

  it('starts a -dev.N prerelease on a next-patch lineage base', () => {
    // Lineage is already the next patch (effectiveMintBase output), not the
    // stable cut itself — minting on 0.1.0-dev.N would sort below 0.1.0.
    expect(formatDevVersion('0.1.1', 1, 'abc1234')).toBe('0.1.1-dev.1+abc1234')
  })
})

describe('mintDevVersion', () => {
  it('seeds from the effective checkout lineage at counter 1', () => {
    expect(mintDevVersion(null, '0.1.0-edge.20', 'aaa1111')).toEqual({
      version: '0.1.0-edge.20.dev.1+aaa1111',
      state: { base: '0.1.0-edge.20', counter: 1 },
    })
  })

  it('seeds a stable checkout onto the next-patch lineage', () => {
    expect(mintDevVersion(null, '0.1.1', 'aaa1111')).toEqual({
      version: '0.1.2-dev.1+aaa1111',
      state: { base: '0.1.2', counter: 1 },
    })
  })

  it('bumps the counter on the same base', () => {
    const state: DevPublisherVersionState = { base: '0.1.0-edge.20', counter: 4 }
    expect(mintDevVersion(state, '0.1.0-edge.20', 'bbb2222')).toEqual({
      version: '0.1.0-edge.20.dev.5+bbb2222',
      state: { base: '0.1.0-edge.20', counter: 5 },
    })
  })

  it('adopts a newer checkout base and resets the counter (branch caught up with a cut)', () => {
    const state: DevPublisherVersionState = { base: '0.1.0-edge.20', counter: 99 }
    expect(mintDevVersion(state, '0.1.0-edge.21', 'ccc3333')).toEqual({
      version: '0.1.0-edge.21.dev.1+ccc3333',
      state: { base: '0.1.0-edge.21', counter: 1 },
    })
  })

  it('keeps the publisher base when the checkout is older (branch-vintage)', () => {
    const state: DevPublisherVersionState = { base: '0.1.0-edge.20', counter: 5 }
    expect(mintDevVersion(state, '0.1.0-edge.18', 'ddd4444')).toEqual({
      version: '0.1.0-edge.20.dev.6+ddd4444',
      state: { base: '0.1.0-edge.20', counter: 6 },
    })
  })

  it('survives the edge.N → stable X.Y.Z cut this repo actually ships', () => {
    let state: DevPublisherVersionState | null = null
    const first = mintDevVersion(state, '0.1.1-edge.1', 'aaaaaaa')
    state = first.state
    const second = mintDevVersion(state, '0.1.1-edge.1', 'bbbbbbb')
    state = second.state
    // package.json becomes the stable release of the same core.
    const afterStable = mintDevVersion(state, '0.1.1', 'ccccccc')
    expect(afterStable.version).toBe('0.1.2-dev.1+ccccccc')
    expect(isProvablyNewer(afterStable.version, second.version)).toBe(true)
    expect(isProvablyNewer(afterStable.version, '0.1.1')).toBe(true)
    expect(isProvablyNewer('0.1.2-edge.1', afterStable.version)).toBe(true)
  })
})

describe('publisher development version ordering', () => {
  const cases: [candidate: string, current: string, newer: boolean, why: string][] = [
    [
      '0.1.0-edge.20.dev.5+656f49b',
      '0.1.0-edge.20',
      true,
      'appended .dev.N ranks above the edge cut it builds on',
    ],
    ['0.1.0-edge.20.dev.5+656f49b', '0.1.0-edge.21', false, 'and below the next edge cut'],
    [
      '0.1.0-edge.20.dev.5+aaa',
      '0.1.0-edge.20.dev.4+bbb',
      true,
      'counters compare numerically; build metadata is ignored',
    ],
    [
      '0.1.0-edge.21.dev.1+aaa',
      '0.1.0-edge.20.dev.99+bbb',
      true,
      'a mint on a newer base outranks any counter on an older base',
    ],
    [
      '0.1.0-edge.20.dev.5+aaa',
      '0.1.0-edge.20.dev.5+bbb',
      false,
      'same mint identity — sha is build metadata only',
    ],
    [
      '0.1.2-dev.1+ccccccc',
      '0.1.1-edge.1.dev.2+bbbbbbb',
      true,
      'next-patch lineage after a stable cut clears the prior edge mint',
    ],
    [
      '0.1.2-dev.1+ccccccc',
      '0.1.1',
      true,
      'a mint sorts ABOVE the release it builds on (disposition 23)',
    ],
  ]

  for (const [candidate, current, newer, why] of cases) {
    it(`${newer ? 'ahead' : 'not ahead'}: ${candidate} vs ${current} — ${why}`, () => {
      expect(isProvablyNewer(candidate, current)).toBe(newer)
    })
  }
})

describe('mint sequences stay monotonic across branches', () => {
  it('every mint is provably newer than the previous, for any branch hop sequence', () => {
    // Simulated checkouts: main advances, then a vintage branch, then main again.
    const checkouts: { base: string; sha: string }[] = [
      { base: '0.1.0-edge.18', sha: '1111111' },
      { base: '0.1.0-edge.18', sha: '2222222' },
      { base: '0.1.0-edge.20', sha: '3333333' }, // main cut
      { base: '0.1.0-edge.19', sha: '4444444' }, // older branch
      { base: '0.1.0-edge.17', sha: '5555555' }, // even older
      { base: '0.1.0-edge.20', sha: '6666666' }, // back on the cut
      { base: '0.1.0-edge.21', sha: '7777777' }, // next cut
    ]

    let state: DevPublisherVersionState | null = null
    const minted: string[] = []
    for (const step of checkouts) {
      const result = mintDevVersion(state, step.base, step.sha)
      state = result.state
      minted.push(result.version)
    }

    for (let i = 1; i < minted.length; i++) {
      expect(
        isProvablyNewer(minted[i] as string, minted[i - 1] as string),
        `${minted[i]} should be newer than ${minted[i - 1]}`,
      ).toBe(true)
    }

    // Each mint on base B.dev.N stays below the next edge cut of B.
    expect(isProvablyNewer('0.1.0-edge.21', minted[2] as string)).toBe(true) // after edge.20.dev.1
    expect(isProvablyNewer('0.1.0-edge.22', minted[6] as string)).toBe(true) // after edge.21.dev.1
    expect(compareVersions(minted[5] as string, '0.1.0-edge.21')).toBe(-1)
  })

  it('stays monotonic across the edge → stable → next-edge cadence this repo ships', () => {
    const checkouts: { base: string; sha: string }[] = [
      { base: '0.1.1-edge.1', sha: 'aaaaaaa' },
      { base: '0.1.1-edge.1', sha: 'bbbbbbb' },
      { base: '0.1.1', sha: 'ccccccc' }, // stable cut of the same core
      { base: '0.1.1', sha: 'ddddddd' },
      { base: '0.1.0-edge.20', sha: 'eeeeeee' }, // vintage branch
      { base: '0.1.2-edge.1', sha: 'fffffff' }, // next edge after the bump lineage
    ]

    let state: DevPublisherVersionState | null = null
    const minted: string[] = []
    for (const step of checkouts) {
      const result = mintDevVersion(state, step.base, step.sha)
      state = result.state
      minted.push(result.version)
    }

    for (let i = 1; i < minted.length; i++) {
      expect(
        isProvablyNewer(minted[i] as string, minted[i - 1] as string),
        `${minted[i]} should be newer than ${minted[i - 1]}`,
      ).toBe(true)
    }

    // The first post-stable mint clears the release it builds on.
    expect(isProvablyNewer(minted[2] as string, '0.1.1')).toBe(true)
    // And stays below the next edge cut of its lineage.
    expect(isProvablyNewer('0.1.2-edge.1', minted[2] as string)).toBe(true)
  })

  it('an older-base checkout still mints newer-than-fleet after the publisher has advanced', () => {
    let state: DevPublisherVersionState | null = null
    const onMain = mintDevVersion(state, '0.1.0-edge.20', 'aaaaaaa')
    state = onMain.state
    // Fleet is now on the first mint. A vintage branch must still clear it.
    const onVintage = mintDevVersion(state, '0.1.0-edge.12', 'bbbbbbb')
    expect(isProvablyNewer(onVintage.version, onMain.version)).toBe(true)
    expect(onVintage.version).toBe('0.1.0-edge.20.dev.2+bbbbbbb')
  })
})

describe('parse / short form / predicates', () => {
  it('parses both edge-base and next-patch lineage mints', () => {
    expect(parsePublisherDevVersion('0.1.0-edge.20.dev.5+656f49b')).toEqual({
      base: '0.1.0-edge.20',
      counter: 5,
      sha: '656f49b',
      version: '0.1.0-edge.20.dev.5+656f49b',
    })
    expect(parsePublisherDevVersion('0.1.2-dev.3+abc1234')).toEqual({
      base: '0.1.2',
      counter: 3,
      sha: 'abc1234',
      version: '0.1.2-dev.3+abc1234',
    })
    expect(parsePublisherDevVersion('dev+656f49b')).toBeNull()
    expect(parsePublisherDevVersion('0.1.0-edge.20')).toBeNull()
  })

  it('renders the operator short form and leaves other versions alone', () => {
    expect(formatDevVersionShort('0.1.0-edge.20.dev.5+656f49b')).toBe('dev.5 (656f49b)')
    expect(formatDevVersionShort('0.1.0-edge.20')).toBe('0.1.0-edge.20')
    expect(formatDevVersionShort('dev+656f49b')).toBe('dev+656f49b')
  })

  it('classifies channel versions and extracts the commit', () => {
    expect(isPublisherDevVersion('0.1.0-edge.20.dev.5+656f49b')).toBe(true)
    expect(isPublisherDevVersion('dev+656f49b')).toBe(false)
    expect(isDevChannelVersion('0.1.0-edge.20.dev.5+656f49b')).toBe(true)
    expect(isDevChannelVersion('dev+656f49b')).toBe(true)
    expect(isDevChannelVersion('0.1.0-edge.20')).toBe(false)
    expect(commitShaFromDevVersion('0.1.0-edge.20.dev.5+656f49b')).toBe('656f49b')
    expect(commitShaFromDevVersion('dev+656f49b')).toBe('656f49b')
  })
})
