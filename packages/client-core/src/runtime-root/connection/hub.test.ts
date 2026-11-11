import { describe, expect, it, vi } from 'vitest'

import type { PodiumClientApi } from '../../api'
import type { Replica } from '../../replica/kernel/facade'
import type { SocketHub, SocketHubOptions } from '../../socket-transport'
import { createEngineHub, isInitialConnectivityError } from './hub'

describe('isInitialConnectivityError', () => {
  it('recognizes only the expected cold-offline socket failures', () => {
    expect(isInitialConnectivityError('WebSocket connection failed')).toBe(true)
    expect(isInitialConnectivityError('WebSocket connection closed before connecting')).toBe(true)
    expect(isInitialConnectivityError('feed protocol rejected')).toBe(false)
    expect(isInitialConnectivityError('Invalid WebSocket URL')).toBe(false)
  })
})

it('leaves metadata reads to the HTTP feed when no feed was supplied', () => {
  const query = vi.fn()
  const createHub = vi.fn((_options: SocketHubOptions) => ({}) as SocketHub)
  createEngineHub({
    wsClientUrl: 'wss://example.test/ws/client',
    api: { sync: { changesSince: { query } } } as unknown as PodiumClientApi,
    replica: { getCursor: () => 0 } as Replica,
    onFatalError: vi.fn(),
    createHub,
  })
  expect(createHub.mock.calls[0]?.[0].feed).toBeUndefined()
  expect(query).not.toHaveBeenCalled()
})
