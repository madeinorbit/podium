import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  AGENT_RELAY_ENDPOINT,
  describePortConflict,
  HOOK_INGEST_ENDPOINT,
  isAddressInUse,
  listenLoopback,
  listenStableLoopbackPort,
} from './loopback-listen'

describe('listenLoopback', () => {
  it('resolves with the bound port', async () => {
    const server = createServer(() => {})
    try {
      const port = await listenLoopback(server, 0)
      expect(port).toBeGreaterThan(0)
      expect((server.address() as { port: number }).port).toBe(port)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('rejects on a taken port instead of hanging', async () => {
    const held = createServer(() => {})
    const port = await listenLoopback(held, 0)
    const second = createServer(() => {})
    try {
      await expect(listenLoopback(second, port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      await new Promise<void>((r) => held.close(() => r()))
    }
  })

  /**
   * The failure this guard exists for: Bun's native server throws out of
   * `listen` rather than emitting `error`. Unguarded, that escapes the promise
   * executor as an uncaught exception — logged as "surviving" by the process
   * safety net — and the promise NEVER settles, so the daemon hangs at boot
   * with no error anyone can act on.
   */
  it('turns a synchronous throw from listen into a rejection', async () => {
    const throwing = {
      on: () => {},
      off: () => {},
      listen: () => {
        throw Object.assign(new Error('Failed to start server. Is port 45777 in use?'), {
          code: 'EADDRINUSE',
        })
      },
    } as unknown as Server
    await expect(listenLoopback(throwing, 45_777)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})

describe('listenStableLoopbackPort', () => {
  it('reports no conflict when the preferred port is free', async () => {
    const server = createServer(() => {})
    try {
      const bound = await listenStableLoopbackPort(server, 0)
      expect(bound.port).toBeGreaterThan(0)
      expect(bound.conflict).toBeUndefined()
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('binds an ephemeral port and reports the conflict when the preferred one is taken', async () => {
    const held = createServer(() => {})
    const preferredPort = await listenLoopback(held, 0)
    const server = createServer(() => {})
    try {
      const bound = await listenStableLoopbackPort(server, preferredPort)
      expect(bound.port).not.toBe(preferredPort)
      expect(bound.conflict?.preferredPort).toBe(preferredPort)
      expect(bound.conflict?.boundPort).toBe(bound.port)
      expect(bound.conflict?.detail).toContain(String(preferredPort))
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      await new Promise<void>((r) => held.close(() => r()))
    }
  })

  // An explicit `0` is a caller asking for an ephemeral port outright; there is
  // no stable port to have lost, so a failure there is the caller's own.
  it('never invents a fallback for a caller that asked for port 0', async () => {
    const throwing = {
      on: () => {},
      off: () => {},
      listen: () => {
        throw Object.assign(new Error('nope'), { code: 'EADDRINUSE' })
      },
    } as unknown as Server
    await expect(listenStableLoopbackPort(throwing, 0)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    })
  })

  it('does not swallow a failure that is not a port collision', async () => {
    const throwing = {
      on: () => {},
      off: () => {},
      listen: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    } as unknown as Server
    await expect(listenStableLoopbackPort(throwing, 45_777)).rejects.toMatchObject({
      code: 'EACCES',
    })
  })
})

describe('isAddressInUse', () => {
  it('recognizes the errno and nothing else', () => {
    expect(isAddressInUse(Object.assign(new Error('listen'), { code: 'EADDRINUSE' }))).toBe(true)
    expect(isAddressInUse(Object.assign(new Error('listen'), { code: 'EACCES' }))).toBe(false)
    expect(isAddressInUse(new Error('EADDRINUSE'))).toBe(false)
    expect(isAddressInUse(null)).toBe(false)
    expect(isAddressInUse('EADDRINUSE')).toBe(false)
  })
})

describe('describePortConflict', () => {
  const conflict = { preferredPort: 45_777, boundPort: 51_234, detail: 'port 45777 in use' }

  it('names the port, the fallback, the cost, and both ways to pin it', () => {
    const diagnostic = describePortConflict(HOOK_INGEST_ENDPOINT, conflict, 'default')
    expect(diagnostic.code).toBe('hook-ingest-port-conflict')
    expect(diagnostic.title).toContain('45777')
    expect(diagnostic.body).toContain('127.0.0.1:45777')
    expect(diagnostic.body).toContain('127.0.0.1:51234')
    expect(diagnostic.body).toContain('PODIUM_HOOK_PORT')
    expect(diagnostic.body).toContain('hookPort')
    expect(diagnostic.body).toContain("Instance: 'default'")
    // The description is what a person reads first; it must not be jargon about
    // an integration version, which is what the server used to say for every code.
    expect(diagnostic.description).toContain('hook ingest')
    expect(diagnostic.description).not.toContain('45777')
  })

  it('distinguishes the relay from the ingest', () => {
    const diagnostic = describePortConflict(AGENT_RELAY_ENDPOINT, conflict, 'blue')
    expect(diagnostic.code).toBe('agent-relay-port-conflict')
    expect(diagnostic.body).toContain('PODIUM_AGENT_RELAY_PORT')
    expect(diagnostic.body).toContain("Instance: 'blue'")
  })
})
