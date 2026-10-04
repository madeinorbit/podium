import { describe, expect, it, vi } from 'vitest'
import { shallowEqual } from './store'

describe('shallowEqual', () => {
  it('matches identical and shallow-equal objects', () => {
    const arr = [1, 2]
    expect(shallowEqual({ a: 1, b: arr }, { a: 1, b: arr })).toBe(true)
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(shallowEqual({ a: [1] }, { a: [1] })).toBe(false) // deep values differ by identity
    expect(shallowEqual(null, {})).toBe(false)
    expect(shallowEqual(1, 1)).toBe(true)
  })
})

