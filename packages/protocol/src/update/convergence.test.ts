import { describe, expect, it } from 'vitest'
import { planConvergence } from './convergence'

const feed = {
  delivery: 'feed',
  platforms: {
    'linux-x86_64': { url: 'https://x.test/a-x64.tgz', digest: 'd1', signature: 's1' },
    'linux-aarch64': { url: 'https://x.test/a-arm.tgz', digest: 'd2', signature: 's2' },
  },
} as const
const bundle = {
  delivery: 'bundle',
  platforms: {
    'linux-x86_64': { url: 'https://hub.test/a-x64.tgz', digest: 'd3', signature: 's3' },
  },
} as const
const git = {
  delivery: 'git',
  repo: '/repo/podium',
  sha: 'abc1234',
} as const
const target = (version: string, artifact: unknown = feed) =>
  ({ version, critical: false, artifacts: { headless: artifact } }) as never
const targetWithAlternatives = (alternatives: readonly unknown[]) =>
  ({
    version: 'dev+abc1234',
    critical: false,
    artifacts: { headless: bundle, headlessAlternatives: alternatives },
  }) as never

const HOST = 'linux-x86_64'
const ALL_CAPS = ['update.delivery.feed', 'update.delivery.bundle', 'update.delivery.git']

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
      caps: ['update.delivery.git'],
      platform: HOST,
    })
    expect(p).toEqual({ action: 'cannot', reason: 'unsupported-delivery' })
  })

  it('selects a git alternative for a source daemon', () => {
    const p = planConvergence({
      current: 'dev+old',
      target: targetWithAlternatives([git]),
      caps: ['update.delivery.git'],
      platform: HOST,
    })
    expect(p).toEqual({ action: 'converge', delivery: 'git', artifact: git })
  })

  it('keeps the primary bundle for an installed daemon', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: targetWithAlternatives([git]),
      caps: ['update.delivery.feed', 'update.delivery.bundle'],
      platform: HOST,
    })
    expect(p).toEqual({ action: 'converge', delivery: 'bundle', asset: bundle.platforms[HOST] })
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
      caps: ['update.delivery.feed', 'update.delivery.bundle'],
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

  it('supports bundle delivery with its selected platform asset', () => {
    const p = planConvergence({
      current: '0.4.1',
      target: target('0.4.2', bundle),
      caps: ALL_CAPS,
      platform: HOST,
    })
    expect(p).toMatchObject({
      action: 'converge',
      delivery: 'bundle',
      asset: bundle.platforms[HOST],
    })
  })

  it('is already-current BEFORE checking delivery', () => {
    const p = planConvergence({
      current: '0.4.2',
      target: target('0.4.2'),
      caps: ['update.delivery.git'],
      platform: HOST,
    })
    expect(p).toEqual({ action: 'already-current' })
  })
})
