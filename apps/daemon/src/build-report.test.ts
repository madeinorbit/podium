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

describe('deliveryCaps', () => {
  it('offers feed and bundle for an installed build', () => {
    expect(deliveryCaps('installed')).toEqual(['update.delivery.feed', 'update.delivery.bundle'])
  })

  it('offers only git for a source run, which cannot swap a bundle', () => {
    expect(deliveryCaps('source')).toEqual(['update.delivery.git'])
  })
})
