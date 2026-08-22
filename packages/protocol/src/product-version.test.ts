import { describe, expect, it } from 'vitest'
import {
  buildsDiffer,
  DEV_SERVER_VERSION,
  formatSourceVersion,
  isForensicBundleIdentity,
  productVersionFromStamp,
  resolveProductVersion,
  sourceDigestFromVersion,
} from './product-version'

describe('resolveProductVersion', () => {
  it('uses the packaged channel version when one is declared', () => {
    expect(resolveProductVersion('0.4.2', '47a01e3')).toBe('0.4.2')
    expect(resolveProductVersion(' 0.4.2 ', undefined)).toBe('0.4.2')
  })

  it('names a source host as dev+short SHA', () => {
    expect(resolveProductVersion(undefined, '47A01E3deadbeef')).toBe('dev+47a01e3')
    expect(formatSourceVersion('47a01e3')).toBe('dev+47a01e3')
  })

  it('falls back to dev when there is no checkout SHA', () => {
    expect(resolveProductVersion(undefined, undefined)).toBe('dev')
    expect(resolveProductVersion(undefined, 'HEAD')).toBe('dev')
  })
})

describe('productVersionFromStamp', () => {
  it('reads the product string a current stamp already wrote', () => {
    expect(productVersionFromStamp({ appVersion: '0.4.2', sourceSha: '47a01e3' })).toBe('0.4.2')
    expect(productVersionFromStamp({ appVersion: 'dev+47a01e3', sourceSha: '47a01e3' })).toBe(
      'dev+47a01e3',
    )
  })

  it('reconstructs dev+sha from a stamp that stored the chunk hash as appVersion', () => {
    expect(productVersionFromStamp({ appVersion: 'bundle+DHMkD0wf', sourceSha: '47a01e3' })).toBe(
      'dev+47a01e3',
    )
    expect(productVersionFromStamp({ appVersion: DEV_SERVER_VERSION, sourceSha: '47a01e3' })).toBe(
      'dev+47a01e3',
    )
  })

  it('does not invent a source identity when the stamp has neither a product string nor a source SHA', () => {
    expect(productVersionFromStamp({ appVersion: 'bundle+DHMkD0wf' })).toBe('bundle+DHMkD0wf')
    expect(productVersionFromStamp({})).toBe('dev')
  })
})

describe('isForensicBundleIdentity', () => {
  it('recognises the identities that must not replace the product version', () => {
    expect(isForensicBundleIdentity('bundle+DHMkD0wf')).toBe(true)
    expect(isForensicBundleIdentity(DEV_SERVER_VERSION)).toBe(true)
    expect(isForensicBundleIdentity('dev+47a01e3')).toBe(false)
    expect(isForensicBundleIdentity('0.4.2')).toBe(false)
  })
})

describe('build identity', () => {
  it('extracts source digests without depending on the product label', () => {
    expect(sourceDigestFromVersion('dev+a5f041c')).toBe('a5f041c')
    expect(sourceDigestFromVersion('0.1.1-dev.1+a5f041c')).toBe('a5f041c')
    expect(sourceDigestFromVersion('0.1.1-edge.1')).toBeUndefined()
  })

  it('prefers equal digests over unequal display labels', () => {
    expect(
      buildsDiffer(
        { version: 'dev+a5f041c', digest: 'a5f041c' },
        { version: '0.1.1-dev.1+a5f041c', digest: 'a5f041c' },
      ),
    ).toBe(false)
  })

  it('still reports a genuinely older build', () => {
    expect(
      buildsDiffer(
        { version: 'dev+b4c9e12', digest: 'b4c9e12' },
        { version: '0.1.1-dev.1+a5f041c', digest: 'a5f041c' },
      ),
    ).toBe(true)
  })

  it('falls back to exact labels for legacy reports without digests', () => {
    expect(buildsDiffer({ version: '0.4.1' }, { version: '0.4.2' })).toBe(true)
    expect(buildsDiffer({ version: '0.4.2' }, { version: '0.4.2' })).toBe(false)
    expect(buildsDiffer({}, { version: '0.4.2' })).toBe(false)
  })
})
