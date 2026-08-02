import { describe, expect, it } from 'vitest'

import { isInitialConnectivityError } from './wiring'

describe('isInitialConnectivityError', () => {
  it('recognizes only the expected cold-offline socket failures', () => {
    expect(isInitialConnectivityError('WebSocket connection failed')).toBe(true)
    expect(isInitialConnectivityError('WebSocket connection closed before connecting')).toBe(true)
    expect(isInitialConnectivityError('feed protocol rejected')).toBe(false)
    expect(isInitialConnectivityError('Invalid WebSocket URL')).toBe(false)
  })
})
