import { describe, expect, it } from 'vitest'
import { formatControlCosts } from './loop-attribution'

describe('formatControlCosts', () => {
  it('orders control types by synchronous wall cost and reports count and heap pressure', () => {
    const costs = new Map([
      ['resize', { count: 20, wallMs: 12.4, heapBytes: 512 * 1024 }],
      ['reattach', { count: 2, wallMs: 140.6, heapBytes: 8 * 1024 * 1024 }],
    ])

    expect(formatControlCosts(costs)).toBe('reattach:2/141ms/+8.0MB,resize:20/12ms/+0.5MB')
  })
})
