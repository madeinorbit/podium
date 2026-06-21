import { afterEach, describe, expect, it } from 'vitest'
import { serverConfig } from './trpc'

const loc = (over: Partial<Location>): Location =>
  ({ protocol: 'http:', host: 'localhost:5173', origin: 'http://localhost:5173', search: '', ...over }) as Location

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
  it('ignores a malformed injected global and falls through', () => {
    ;(globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ = 'not-a-url'
    const cfg = serverConfig(loc({}))
    expect(cfg.override).toBe(false)
  })
})
