import { describe, expect, it } from 'vitest'
import { ctrlSequence, keySequence } from './keys'

describe('key sequences', () => {
  it('maps named keys to terminal byte sequences', () => {
    expect(keySequence('Escape')).toBe('\x1b')
    expect(keySequence('Tab')).toBe('\t')
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
})
