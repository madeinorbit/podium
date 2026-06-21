import { describe, expect, it } from 'vitest'
import { isProtocolCompatible, WIRE_VERSION } from './version'

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
