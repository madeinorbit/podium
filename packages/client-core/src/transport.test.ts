import { describe, expect, it } from 'vitest'
import {
  parseServerOrigin,
  resolveServerConfig,
  workspaceRequestInit,
  workspaceSocketUrl,
} from './transport'

describe('shared transport endpoint parsing', () => {
  it('accepts ws and http origins and normalizes to ws/http endpoint pairs', () => {
    expect(parseServerOrigin('ws://host.test:1234')).toMatchObject({
      wsClientUrl: expect.stringContaining('ws://host.test:1234/client?v='),
      httpOrigin: 'http://host.test:1234',
    })
    expect(parseServerOrigin('https://host.test')).toMatchObject({
      wsClientUrl: expect.stringContaining('wss://host.test/client?v='),
      httpOrigin: 'https://host.test',
    })
  })

  it('derives same-origin endpoints when no override exists', () => {
    const config = resolveServerConfig({
      protocol: 'https:',
      host: 'podium.test',
      origin: 'https://podium.test',
      search: '',
    })
    expect(config).toMatchObject({
      httpOrigin: 'https://podium.test',
      wsClientUrl: expect.stringContaining('wss://podium.test/client?v='),
      override: false,
    })
  })

  it('honors a server query override', () => {
    const config = resolveServerConfig({
      protocol: 'https:',
      host: 'podium.test',
      origin: 'https://podium.test',
      search: '?server=http://127.0.0.1:18787',
    })
    expect(config).toMatchObject({
      httpOrigin: 'http://127.0.0.1:18787',
      wsClientUrl: expect.stringContaining('ws://127.0.0.1:18787/client?v='),
      override: true,
    })
  })
  it('routes the selected workspace on HTTP and WebSocket transports without dropping queries', () => {
    const config = resolveServerConfig({
      protocol: 'https:',
      host: 'podium.test',
      origin: 'https://podium.test',
      pathname: '/mobile',
      search: '?workspace=ws_blue',
    })
    expect(config).toMatchObject({ workspaceId: 'ws_blue' })
    expect(new URL(config.wsClientUrl).searchParams.get('workspace')).toBe('ws_blue')
    const request = workspaceRequestInit(
      'https://podium.test/trpc?input=%7B%7D',
      { headers: { 'x-test': 'keep' } },
      { workspaceId: 'ws_blue' },
    )
    const headers = new Headers(request?.headers)
    expect(headers.get('podium-workspace-id')).toBe('ws_blue')
    expect(headers.get('x-test')).toBe('keep')
    expect(
      workspaceSocketUrl('wss://podium.test/client?v=2&input=feed', { workspaceId: 'ws_blue' }),
    ).toContain('workspace=ws_blue')
    expect(
      workspaceSocketUrl('wss://podium.test/client?v=2&input=feed', { workspaceId: 'ws_blue' }),
    ).toContain('input=feed')
  })
})
