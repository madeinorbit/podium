import { describe, expect, it } from 'vitest'
import { buildReport, deliveryCaps } from './build-report'

describe('buildReport', () => {
  it('reports the baked version for an installed build', () => {
    const r = buildReport({ PODIUM_APP_VERSION: '0.4.2' }, '/home/u/.local/share/podium')
    expect(r.appVersion).toBe('0.4.2')
    expect(r.installKind).toBe('installed')
  })

  it('reports a source run when there is no install dir', () => {
    const r = buildReport({ PODIUM_APP_VERSION: '0.4.2' }, undefined)
    expect(r.installKind).toBe('source')
  })

  it('reports dev when no version was baked in', () => {
    expect(buildReport({}, undefined).appVersion).toBe('dev')
  })

  it('always carries this build wire schema digest', () => {
    expect(buildReport({}, undefined).wireSchemaDigest).toBeTypeOf('string')
  })
})

describe('deliveryCaps', () => {
  it('offers feed and bundle for an installed build', () => {
    expect(deliveryCaps('installed')).toEqual([
      'update.delivery.feed',
      'update.delivery.bundle',
    ])
  })

  it('offers only git for a source run, which cannot swap a bundle', () => {
    expect(deliveryCaps('source')).toEqual(['update.delivery.git'])
  })
})
