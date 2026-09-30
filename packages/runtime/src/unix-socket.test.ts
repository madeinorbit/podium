import { describe, expect, it } from 'vitest'
import {
  CLIENT_TERMINAL_LABEL_TOKEN_MAX,
  instanceRuntimeSocketRoot,
  longestDurableLabelFor,
  SUN_PATH_MAX,
  unixSocketPathBytes,
  unixSocketPathFits,
} from './unix-socket.js'

/**
 * POD-2853: a socket path over `sun_path` is a byte count against a kernel
 * constant, so these are arithmetic tests that name the number.
 */
describe('the shared Unix socket path budget', () => {
  it('accepts the last byte below the ceiling and refuses the ceiling', () => {
    const lastAccepted = 'x'.repeat(SUN_PATH_MAX - 1)
    const firstRefused = 'x'.repeat(SUN_PATH_MAX)

    expect(unixSocketPathBytes(lastAccepted)).toBe(107)
    expect(unixSocketPathBytes(firstRefused)).toBe(108)
    expect(unixSocketPathFits(lastAccepted)).toBe(true)
    expect(unixSocketPathFits(firstRefused)).toBe(false)
  })

  it('counts UTF-8 bytes, not characters', () => {
    expect(unixSocketPathBytes('é')).toBe(2)
  })

  it('keeps a full named instance in its private runtime socket root', () => {
    const instanceId = 'i'.repeat(32)
    const root = instanceRuntimeSocketRoot(
      instanceId,
      { XDG_RUNTIME_DIR: '/run/user/1001' },
      { uid: 1001 },
    )
    const socket = `${root}/abcdefabcdef-123456789012.sock`

    expect(root).toBe(`/run/user/1001/podium-${instanceId}`)
    expect(unixSocketPathFits(socket)).toBe(true)
  })

  it('names the /tmp fallback by uid and instance', () => {
    // uid 4242 has no /run/user entry on a test host, so the fallback is taken.
    expect(instanceRuntimeSocketRoot('blue', {}, { uid: 4242 })).toBe('/tmp/podium-4242-blue')
  })
})

describe('the longest durable label', () => {
  it('is the CLIENT TERMINAL label below 8 characters of instance id (POD-2777)', () => {
    const clientTerminal = `podium-${'t'.repeat(CLIENT_TERMINAL_LABEL_TOKEN_MAX)}-attach-${'0'.repeat(36)}`
    expect(longestDurableLabelFor('blue')).toBe(clientTerminal)
    expect(longestDurableLabelFor('abcdefg')).toBe(clientTerminal)
    expect(longestDurableLabelFor('abcdefghijk')).toBe(`podium-abcdefghijk-${'0'.repeat(36)}`)
  })
})
