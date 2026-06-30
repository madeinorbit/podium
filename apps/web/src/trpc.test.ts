import { afterEach, describe, expect, it } from 'vitest'
import { makeTrpc, serverConfig } from './trpc'

const loc = (over: Partial<Location>): Location =>
  ({
    protocol: 'http:',
    host: 'localhost:5173',
    origin: 'http://localhost:5173',
    search: '',
    ...over,
  }) as Location

describe('serverConfig backend resolution', () => {
  afterEach(() => {
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = undefined
  })

  it('prefers the injected global over location', () => {
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = 'ws://remote:18787'
    const cfg = serverConfig(loc({}))
    expect(cfg.wsClientUrl).toBe('ws://remote:18787/client')
    expect(cfg.httpOrigin).toBe('http://remote:18787')
    expect(cfg.override).toBe(true)
  })
  it('falls back to ?server= when no global', () => {
    const cfg = serverConfig(loc({ search: '?server=wss://q:443' }))
    expect(cfg.wsClientUrl).toBe('wss://q:443/client')
    expect(cfg.httpOrigin).toBe('https://q:443')
    expect(cfg.override).toBe(true)
  })
  it('falls back to same-origin from location', () => {
    const cfg = serverConfig(loc({ protocol: 'https:', host: 'h:1', origin: 'https://h:1' }))
    expect(cfg.wsClientUrl).toBe('wss://h:1/client')
    expect(cfg.httpOrigin).toBe('https://h:1')
    expect(cfg.override).toBe(false)
  })
  it('normalizes an injected https:// server to wss:// (Machines-tab URL)', () => {
    // The Machines tab + `npx @podium/daemon --server …` hand out an https:// origin; the
    // desktop injects it verbatim. It must resolve, not fall back to same-origin (the freeze).
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ =
      'https://podium-host.example.com:55555'
    const cfg = serverConfig(loc({}))
    expect(cfg.wsClientUrl).toBe('wss://podium-host.example.com:55555/client')
    expect(cfg.httpOrigin).toBe('https://podium-host.example.com:55555')
    expect(cfg.override).toBe(true)
  })
  it('normalizes an injected http:// server to ws://', () => {
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = 'http://host:18787'
    const cfg = serverConfig(loc({}))
    expect(cfg.wsClientUrl).toBe('ws://host:18787/client')
    expect(cfg.httpOrigin).toBe('http://host:18787')
    expect(cfg.override).toBe(true)
  })
  it('ignores a malformed injected global and falls through', () => {
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = 'not-a-url'
    const cfg = serverConfig(loc({}))
    expect(cfg.override).toBe(false)
  })
})

describe('makeTrpc credential', () => {
  afterEach(() => {
    delete (globalThis as { __PODIUM_ISSUE_TOKEN__?: string }).__PODIUM_ISSUE_TOKEN__
  })
  it('constructs a client with and without an injected token', () => {
    expect(makeTrpc('http://localhost:1')).toBeDefined()
    ;(globalThis as { __PODIUM_ISSUE_TOKEN__?: string }).__PODIUM_ISSUE_TOKEN__ = 'T'
    expect(makeTrpc('http://localhost:1')).toBeDefined()
  })
})
