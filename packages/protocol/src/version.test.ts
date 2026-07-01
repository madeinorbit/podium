import { describe, expect, it } from 'vitest'
import {
  isProtocolCompatible,
  MIN_SUPPORTED_VERSION,
  versionSupport,
  WIRE_VERSION,
} from './version'

describe('wire protocol version', () => {
  it('WIRE_VERSION is a positive integer', () => {
    expect(Number.isInteger(WIRE_VERSION)).toBe(true)
    expect(WIRE_VERSION).toBeGreaterThan(0)
  })
  it('same version is compatible', () => {
    expect(isProtocolCompatible(WIRE_VERSION, WIRE_VERSION)).toBe(true)
  })
  it('different versions are incompatible', () => {
    expect(isProtocolCompatible(1, 2)).toBe(false)
  })
  it('non-integers are incompatible', () => {
    expect(isProtocolCompatible(Number.NaN, 1)).toBe(false)
  })
})

describe('version support classification', () => {
  it('MIN_SUPPORTED_VERSION is a positive int ≤ WIRE_VERSION', () => {
    expect(Number.isInteger(MIN_SUPPORTED_VERSION)).toBe(true)
    expect(MIN_SUPPORTED_VERSION).toBeGreaterThan(0)
    expect(MIN_SUPPORTED_VERSION).toBeLessThanOrEqual(WIRE_VERSION)
  })
  it('versionSupport classifies old/new/ok', () => {
    expect(versionSupport(1, 2, 1)).toBe('ok') // in [1,2]
    expect(versionSupport(2, 2, 1)).toBe('ok')
    expect(versionSupport(0, 2, 1)).toBe('too-old')
    expect(versionSupport(3, 2, 1)).toBe('too-new')
    expect(versionSupport(Number.NaN, 2, 1)).toBe('too-old') // unparseable → treat as unsupported
  })
})
