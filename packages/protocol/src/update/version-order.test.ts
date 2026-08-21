import { describe, expect, it } from 'vitest'
import { compareVersions, isProvablyNewer } from './version-order'

/**
 * The ordering moved here from `apps/cli/src/podium-update.ts` (POD-2221) so the
 * daemon's schema gate and `podium update` share ONE answer. Its own suite came
 * with it, and it earns its place twice over: the CLI's suite is excluded from
 * the default unit lane, so before this file the parser deciding whether an
 * install swaps its own directory ran in no lane at all.
 */
describe('isProvablyNewer', () => {
  const cases: [candidate: string, current: string, newer: boolean, why: string][] = [
    ['0.1.1', '0.1.0', true, 'a later patch'],
    ['0.1.0', '0.1.0', false, 'the same version'],
    ['0.2.0', '0.10.0', false, 'numeric core components, not text'],
    ['0.1.4-edge.10', '0.1.4-edge.4', true, 'numeric prerelease identifiers count, not sort'],
    ['0.1.4-edge.4', '0.1.4-edge.10', false, 'and the other way round'],
    ['0.1.4-edge.4', '0.1.4-edge.4', false, 'the same prerelease'],
    ['0.1.4', '0.1.4-edge.4', true, 'the release outranks its own prereleases'],
    ['0.1.4-edge.4', '0.1.4', false, 'and a prerelease never overwrites the release'],
    ['0.1.5-edge.1', '0.1.4', true, 'a prerelease of a LATER version still wins'],
    ['0.1.4-edge.4', '0.1.3', true, 'edge moving forward across a patch'],
    ['0.1.4-edge', '0.1.4-edge.1', false, 'fewer identifiers rank lower'],
    ['0.1.4-edge.1', '0.1.4-edge', true, 'and more identifiers rank higher'],
    ['0.1.4-beta', '0.1.4-alpha', true, 'alphanumeric identifiers compare as text'],
    ['0.1.4-alpha.1', '0.1.4-alpha.beta', false, 'numeric ranks below alphanumeric'],
    ['0.1.4+abc1234', '0.1.4', false, 'build metadata takes no part in precedence'],
    ['0.1.5+abc1234', '0.1.4', true, 'and does not prevent a real comparison either'],
    // Publisher-minted development versions (POD-2502): appended prerelease
    // identifiers `.dev.<N>` with the commit as build metadata.
    [
      '0.1.0-edge.20.dev.5+656f49b',
      '0.1.0-edge.20',
      true,
      'a dest mint ranks above the edge cut it builds on',
    ],
    [
      '0.1.0-edge.20.dev.5+656f49b',
      '0.1.0-edge.21',
      false,
      'and below the next edge cut',
    ],
    [
      '0.1.0-edge.20.dev.10+aaa',
      '0.1.0-edge.20.dev.4+bbb',
      true,
      'dest counters compare numerically; build metadata is ignored',
    ],
    // FAIL CLOSED. Both callers read `false` as "cannot be proven ahead", never
    // as "is older": one leaves an install where it is, the other refuses a swap
    // it cannot prove survivable.
    ['0.1.4', 'dev', false, 'a source checkout has no place on this ordering'],
    ['dev+abc1234', '0.1.4', false, 'nor does the label it reports'],
    ['0.1.4', 'dev+abc1234', false, 'in either position'],
    ['', '0.1.4', false, 'an empty version'],
    ['0.1', '0.1.4', false, 'a two-component version is not a semver'],
    ['0.1.4.5', '0.1.4', false, 'nor is a four-component one'],
    ['latest', '0.1.4', false, 'nor a channel name'],
    ['0.1.4-', '0.1.4-edge', false, 'nor an empty prerelease'],
    ['0.1.4-edge..1', '0.1.4-edge.1', false, 'nor an empty identifier inside one'],
  ]

  for (const [candidate, current, newer, why] of cases) {
    it(`${newer ? 'ahead' : 'not provably ahead'}: ${candidate || '<empty>'} vs ${current} — ${why}`, () => {
      expect(isProvablyNewer(candidate, current)).toBe(newer)
    })
  }
})

describe('compareVersions', () => {
  const cases: [left: string, right: string, order: number | null, why: string][] = [
    ['0.1.4-edge.0', '0.1.4-edge.1', -1, 'zero itself is a valid numeric identifier'],
    ['0.1.4-edge.10', '0.1.4-edge.2', 1, 'multi-digit identifiers may start nonzero'],
    ['00.1.5', '0.1.4', null, 'a major component cannot have a leading zero'],
    ['0.01.5', '0.1.4', null, 'a minor component cannot have a leading zero'],
    ['0.1.05', '0.1.4', null, 'a patch component cannot have a leading zero'],
    ['0.1.4-edge.00', '0.1.4-edge.0', null, 'multiple zeroes are malformed'],
    ['0.1.4-edge.01', '0.1.4-edge.1', null, 'a leading zero is malformed on the left'],
    ['0.1.5', '0.1.4-edge.01', null, 'a leading zero is malformed on the right'],
  ]

  for (const [left, right, order, why] of cases) {
    it(`${left} vs ${right} — ${why}`, () => {
      expect(compareVersions(left, right)).toBe(order)
    })
  }

  it('distinguishes unorderable from equal, which is the whole reason it returns null', () => {
    // A caller that read `null` as `0` would call a `dev+<sha>` target the same
    // version as the release it is being asked to swap for.
    expect(compareVersions('0.1.4', '0.1.4')).toBe(0)
    expect(compareVersions('dev+abc1234', 'dev+abc1234')).toBeNull()
  })
})
