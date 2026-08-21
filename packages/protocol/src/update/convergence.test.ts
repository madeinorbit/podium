import { describe, expect, it } from 'vitest'
import { planConvergence } from './convergence'

const feed = {
  delivery: 'feed',
  platforms: {
    'linux-x86_64': { url: 'https://x.test/a-x64.tgz', digest: 'd1', signature: 's1' },
    'linux-aarch64': { url: 'https://x.test/a-arm.tgz', digest: 'd2', signature: 's2' },
  },
} as const
/** A second FEED artifact, offered as an alternative to the primary one. */
const altFeed = {
  delivery: 'feed',
  platforms: {
    'linux-x86_64': { url: 'https://hub.test/a-x64.tgz', digest: 'd3', signature: 's3' },
  },
} as const
/** The retired kinds. A daemon may still be OFFERED one by an old server. */
const bundle = { delivery: 'bundle', platforms: {} } as const
const git = { delivery: 'git', repo: '/repo/podium', sha: 'abc1234' } as const
const target = (version: string, artifact: unknown = feed) =>
  ({ version, critical: false, artifacts: { headless: artifact } }) as never
const targetWithAlternatives = (alternatives: readonly unknown[]) =>
  ({
    version: 'dev+abc1234',
    critical: false,
    artifacts: { headless: altFeed, headlessAlternatives: alternatives },
  }) as never

const HOST = 'linux-x86_64'
const ALL_CAPS = ['update.delivery.feed']

describe('planConvergence', () => {
  it('is already-current on an exact match', () => {
    expect(
      planConvergence({
        current: '0.4.2',
        target: target('0.4.2'),
        caps: ALL_CAPS,
        platform: HOST,
      }),
    ).toEqual({ action: 'already-current' })
  })

  it('re-delivers an exact match when an explicit repair was granted', () => {
    expect(
      planConvergence({
        current: '0.4.2',
        target: target('0.4.2'),
        caps: ALL_CAPS,
        platform: HOST,
        repair: true,
      }),
    ).toMatchObject({ action: 'converge', delivery: 'feed' })
  })

  it('converges upward', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: target('0.4.2'),
      caps: ALL_CAPS,
      platform: HOST,
    })
    expect(p).toMatchObject({ action: 'converge', delivery: 'feed' })
  })

  it('converges DOWNWARD, because the server is authority and rollback must work', () => {
    const p = planConvergence({
      current: '0.4.2',
      target: target('0.4.1'),
      caps: ALL_CAPS,
      platform: HOST,
    })
    expect(p.action).toBe('converge')
  })

  it('converges between two development identities, which have no ordering', () => {
    const p = planConvergence({
      current: 'dev+aaaaaaa',
      target: target('dev+bbbbbbb'),
      caps: ALL_CAPS,
      platform: HOST,
    })
    expect(p.action).toBe('converge')
  })

  it('refuses when the daemon cannot accept the offered delivery method', () => {
    const p = planConvergence({
      current: 'dev',
      target: target('0.4.2'),
      caps: ['podium.shipping-train'],
      platform: HOST,
    })
    expect(p).toEqual({ action: 'cannot', reason: 'unsupported-delivery' })
  })

  /**
   * A RETIRED KIND IS AN OFFER NOBODY CAN TAKE (spec §1, disposition 5).
   *
   * These two arms used to select `git` for a source daemon and `bundle` for an
   * installed one. Both kinds are gone, and what has to hold in their place is
   * that a target still offering one gets `unsupported-delivery` — never a plan
   * naming a delivery this build has no code for.
   *
   * An old SERVER can still publish one, which is why this is a refusal in the
   * planner and not merely a type that no longer compiles.
   */
  it.each([bundle, git])('refuses a retired delivery kind rather than planning it', (retired) => {
    expect(
      planConvergence({
        current: '0.4.1',
        target: target('0.4.2', retired),
        caps: ALL_CAPS,
        platform: HOST,
      }),
    ).toEqual({ action: 'cannot', reason: 'unsupported-delivery' })
  })

  it('falls through a retired alternative to a feed one it can actually take', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: targetWithAlternatives([git]),
      caps: ALL_CAPS,
      platform: HOST,
    })
    expect(p).toEqual({ action: 'converge', delivery: 'feed', asset: altFeed.platforms[HOST] })
  })

  it('still refuses when no offered alternative matches the daemon capabilities', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: targetWithAlternatives([feed]),
      caps: ['update.delivery.unknown'],
      platform: HOST,
    })
    expect(p).toEqual({ action: 'cannot', reason: 'unsupported-delivery' })
  })

  it('refuses the platform when supported deliveries offer no matching bytes', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: targetWithAlternatives([feed]),
      caps: ALL_CAPS,
      platform: 'darwin-aarch64',
    })
    expect(p).toEqual({ action: 'cannot', reason: 'unsupported-platform' })
  })

  it('refuses when the target names no headless artifact at all', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: { version: '0.4.2', critical: false, artifacts: {} } as never,
      caps: ALL_CAPS,
      platform: HOST,
    })
    expect(p).toEqual({ action: 'cannot', reason: 'no-artifact' })
  })

  it('refuses when the target has no bytes for THIS platform', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: target('0.4.2'),
      caps: ALL_CAPS,
      platform: 'darwin-aarch64',
    })
    expect(p).toEqual({ action: 'cannot', reason: 'unsupported-platform' })
  })

  it('selects the asset for the running platform, never another one', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: target('0.4.2'),
      caps: ALL_CAPS,
      platform: 'linux-aarch64',
    })
    expect(p).toMatchObject({ action: 'converge', asset: { url: 'https://x.test/a-arm.tgz' } })
  })

  it('is already-current BEFORE checking delivery', () => {
    const p = planConvergence({
      current: '0.4.2',
      target: target('0.4.2'),
      caps: ['podium.shipping-train'],
      platform: HOST,
    })
    expect(p).toEqual({ action: 'already-current' })
  })
})
