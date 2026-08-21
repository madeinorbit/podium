import { describe, expect, it } from 'vitest'
import { captureServerBuildVersion } from '../../server/src/build-version'
import { buildReport, captureDaemonBootBuild, deliveryCaps } from './build-report'

describe('buildReport', () => {
  it('reports the baked version for an installed build', () => {
    const r = buildReport({ PODIUM_APP_VERSION: '0.4.2' }, '/home/u/.local/share/podium')
    expect(r.appVersion).toBe('0.4.2')
    expect(r.installKind).toBe('installed')
  })

  it('falls back to the baked process version when the installed runtime env omits it', () => {
    const originalVersion = process.env.PODIUM_APP_VERSION
    process.env.PODIUM_APP_VERSION = '0.4.2'
    try {
      const r = buildReport({}, '/home/u/.local/share/podium')
      expect(r).toMatchObject({ appVersion: '0.4.2', installKind: 'installed' })
    } finally {
      if (originalVersion === undefined) delete process.env.PODIUM_APP_VERSION
      else process.env.PODIUM_APP_VERSION = originalVersion
    }
  })

  it('reports a source run when there is no install dir', () => {
    const r = buildReport({ PODIUM_APP_VERSION: '0.4.2' }, undefined)
    expect(r.installKind).toBe('source')
  })

  it('reports the checkout identity for a source run with no baked version', () => {
    expect(buildReport({}, undefined, 'dev+abc1234').appVersion).toBe('dev+abc1234')
  })

  it('keeps an explicit development version authoritative', () => {
    expect(
      buildReport({ PODIUM_APP_VERSION: 'dev+explicit' }, undefined, 'dev+abc1234').appVersion,
    ).toBe('dev+explicit')
  })

  it('keeps the installed path and baked version authoritative at daemon boot', () => {
    const boot = captureDaemonBootBuild(
      { PODIUM_HOME: '/opt/podium', PODIUM_APP_VERSION: '0.4.2' },
      '/usr/bin/bun',
    )
    expect(boot.installDir).toBe('/opt/podium')
    expect(boot.build).toMatchObject({ appVersion: '0.4.2', installKind: 'installed' })
  })

  it('recognises the detached-install executable without PODIUM_HOME', () => {
    const boot = captureDaemonBootBuild(
      { PODIUM_APP_VERSION: '0.4.2' },
      '/home/u/.local/share/podium/podium-cli',
    )
    expect(boot.installDir).toBe('/home/u/.local/share/podium')
    expect(boot.build).toMatchObject({ appVersion: '0.4.2', installKind: 'installed' })
    expect(deliveryCaps(boot.build)).toEqual(['update.delivery.feed', 'shipping.train.v2'])
  })

  it('matches the server source identity for the same checkout', () => {
    const originalVersion = process.env.PODIUM_APP_VERSION
    delete process.env.PODIUM_APP_VERSION
    try {
      const daemonBuild = captureDaemonBootBuild({}, process.execPath).build
      const serverVersion = captureServerBuildVersion({})

      expect(daemonBuild.installKind).toBe('source')
      expect(daemonBuild.appVersion).toMatch(/^dev\+[0-9a-f]{7}$/)
      expect(daemonBuild.appVersion).toBe(serverVersion)
    } finally {
      if (originalVersion === undefined) delete process.env.PODIUM_APP_VERSION
      else process.env.PODIUM_APP_VERSION = originalVersion
    }
  })

  it('always carries this build wire schema digest', () => {
    expect(buildReport({}, undefined).wireSchemaDigest).toBeTypeOf('string')
  })
})

/**
 * A DESKTOP-SUPERVISED DAEMON IS THE SHELL'S, NOT THE FLEET'S (POD-2099).
 *
 * Three shapes, because the two platforms disagree about what a supervised
 * daemon looks like and neither disagreement may decide the outcome:
 * - macOS all-in-one runs the sidecar IN PLACE inside `Podium.app` and looks
 *   `installed` (feed+bundle caps — a grant would rename dirs in the signature);
 * - Linux copies the sidecar to `~/.podium/bin`, where it looks like a plain
 *   run and nothing about the path says "desktop";
 * - a standalone installed daemon on the same machine is an ordinary fleet
 *   machine and must keep its caps.
 */
describe('desktop-supervised build report', () => {
  const supervisedEnv = { PODIUM_APP_VERSION: '0.4.2', PODIUM_DESKTOP_SUPERVISED: '1' }

  it('flags the macOS all-in-one sidecar running in place inside the .app', () => {
    const r = buildReport(supervisedEnv, '/Applications/Podium.app/Contents/Resources/podium')
    expect(r).toMatchObject({ installKind: 'installed', supervised: true })
    expect(deliveryCaps(r)).toEqual([])
  })

  it('flags the Linux sidecar copied out of the bundle, which looks like a plain run', () => {
    const r = buildReport(supervisedEnv, undefined)
    expect(r).toMatchObject({ installKind: 'source', supervised: true })
    expect(deliveryCaps(r)).toEqual([])
  })

  it('leaves a standalone installed daemon on the same machine untouched', () => {
    const r = buildReport({ PODIUM_APP_VERSION: '0.4.2' }, '/home/u/.local/share/podium')
    expect(r.supervised).toBeUndefined()
    expect(deliveryCaps(r)).toEqual(['update.delivery.feed', 'shipping.train.v2'])
  })

  it('reads only the exact flag, never a truthy-looking value', () => {
    expect(buildReport({ PODIUM_DESKTOP_SUPERVISED: '0' }, undefined).supervised).toBeUndefined()
    expect(buildReport({ PODIUM_DESKTOP_SUPERVISED: 'true' }, undefined).supervised).toBeUndefined()
  })

  it('carries the flag through the one build captured at daemon boot', () => {
    const boot = captureDaemonBootBuild(
      { PODIUM_HOME: '/opt/podium', PODIUM_APP_VERSION: '0.4.2', PODIUM_DESKTOP_SUPERVISED: '1' },
      '/usr/bin/bun',
    )
    expect(boot.build.supervised).toBe(true)
  })
})

describe('deliveryCaps', () => {
  it('offers the one surviving delivery kind for an installed build', () => {
    expect(deliveryCaps({ installKind: 'installed' })).toEqual([
      'update.delivery.feed',
      'shipping.train.v2',
    ])
  })

  /**
   * A SOURCE RUN OFFERS NO DELIVERY AT ALL (spec §1, disposition 5).
   *
   * It used to offer `update.delivery.git` — "move my checkout to that sha" —
   * and that kind is retired: exactly one machine runs from source, the
   * publisher, and it is not a fleet consumer. Reporting `feed` instead would
   * be worse than reporting nothing: it has no install directory, so it would
   * download and verify a quarter of a gigabyte and then throw at the swap.
   *
   * It keeps the shipping-train capability, which is not about delivery.
   */
  it('offers no delivery for a source run, which has nowhere to install one', () => {
    expect(deliveryCaps({ installKind: 'source' })).toEqual(['shipping.train.v2'])
  })

  it('offers nothing at all when a desktop shell owns the bytes', () => {
    expect(deliveryCaps({ installKind: 'installed', supervised: true })).toEqual([])
    expect(deliveryCaps({ installKind: 'source', supervised: true })).toEqual([])
  })
})
