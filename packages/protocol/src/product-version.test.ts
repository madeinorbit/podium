import { describe, expect, it } from 'vitest'
import {
  DEV_SERVER_VERSION,
  formatSourceVersion,
  isForensicBundleIdentity,
  productVersionFromStamp,
  resolveProductVersion,
} from './product-version'

describe('resolveProductVersion', () => {
  it('uses the packaged channel version when one is declared', () => {
    expect(resolveProductVersion('0.4.2', '47a01e3')).toBe('0.4.2')
    expect(resolveProductVersion(' 0.4.2 ', undefined)).toBe('0.4.2')
  })

  it('names a source host as dest+short SHA', () => {
    expect(resolveProductVersion(undefined, '47A01E3deadbeef')).toBe('dev+47a01e3')
    expect(formatSourceVersion('47a01e3')).toBe('dev+47a01e3')
  })

  it('falls back to dest when there is no checkout SHA', () => {
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

  it('reconstructs dest+sha from a stamp that stored the chunk hash as appVersion', () => {
    expect(
      productVersionFromStamp({ appVersion: 'bundle+DHMkD0wf', sourceSha: '47a01e3' }),
    ).toBe('dev+47a01e3')
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
