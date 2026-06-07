import { describe, expect, it } from 'vitest'
import { ctrlByte, ctrlSequence, keySequence } from './keys'

describe('key sequences', () => {
  it('maps named keys to terminal byte sequences', () => {
    expect(keySequence('Escape')).toBe('\x1b')
    expect(keySequence('Tab')).toBe('\t')
    expect(keySequence('ShiftTab')).toBe('\x1b[Z')
    expect(keySequence('Enter')).toBe('\r')
    expect(keySequence('Backspace')).toBe('\x7f')
    expect(keySequence('ArrowUp')).toBe('\x1b[A')
    expect(keySequence('ArrowDown')).toBe('\x1b[B')
    expect(keySequence('ArrowRight')).toBe('\x1b[C')
    expect(keySequence('ArrowLeft')).toBe('\x1b[D')
  })

  it('maps Ctrl+letter to control codes', () => {
    expect(ctrlSequence('c')).toBe('\x03')
    expect(ctrlSequence('C')).toBe('\x03')
    expect(ctrlSequence('d')).toBe('\x04')
    expect(ctrlSequence('l')).toBe('\x0c')
    expect(ctrlSequence('a')).toBe('\x01')
  })

  it('throws on a non-letter ctrl target', () => {
    expect(() => ctrlSequence('1')).toThrow()
  })

  it('ctrlByte maps letters and ignores everything else', () => {
    expect(ctrlByte('c')).toBe('\x03')
    expect(ctrlByte('A')).toBe('\x01')
    expect(ctrlByte('e')).toBe('\x05')
    // Non-letters, escape sequences, and multi-char chunks pass through (null).
    expect(ctrlByte('1')).toBeNull()
    expect(ctrlByte('/')).toBeNull()
    expect(ctrlByte('\x1b')).toBeNull()
    expect(ctrlByte('')).toBeNull()
    expect(ctrlByte('ab')).toBeNull()
  })
})
