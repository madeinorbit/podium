import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonMessage, SessionOpenUrlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserOpenManager, deriveCallbackTarget } from './browser-open'
import { browserOpenEnv } from './control/session'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('browser-open callback capability', () => {
  it('derives only an explicit loopback redirect target', () => {
    const auth = new URL(
      'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    )
    expect(deriveCallbackTarget(auth)).toEqual({
      host: 'localhost',
      port: 1455,
      path: '/auth/callback',
    })
    expect(
      deriveCallbackTarget(new URL('https://auth.example/?next=http://localhost:9999/admin')),
    ).toBeUndefined()
  })

  it('executes a matching pasted callback and completes the request', async () => {
    const sent: DaemonMessage[] = []
    const execute = vi.fn(async () => 200)
    const manager = createBrowserOpenManager((message) => sent.push(message), {
      now: () => 1_000,
      ttlMs: 5_000,
      execute,
    })
    expect(
      manager.capture(
        's1',
        'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
      ),
    ).toEqual({ ok: true })
    const request = sent[0] as SessionOpenUrlMessage
    expect(request.callbackTarget).toEqual({
      host: 'localhost',
      port: 1455,
      path: '/auth/callback',
    })

    await manager.callback({
      type: 'sessionOpenUrlCallback',
      sessionId: 's1',
      requestId: request.requestId,
      url: 'http://localhost:1455/auth/callback?code=secret&state=x',
    })

    expect(execute).toHaveBeenCalledWith(
      new URL('http://localhost:1455/auth/callback?code=secret&state=x'),
    )
    expect(sent.at(-1)).toMatchObject({
      type: 'sessionOpenUrlResult',
      status: 'completed',
      httpStatus: 200,
    })
    expect(manager.pendingCount()).toBe(0)
  })

  it('rejects arbitrary loopback ports and paths without making a request', async () => {
    const sent: DaemonMessage[] = []
    const execute = vi.fn(async () => 200)
    const manager = createBrowserOpenManager((message) => sent.push(message), { execute })
    manager.capture(
      's1',
      'https://auth.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8085%2Foauth2callback',
    )
    const request = sent[0] as SessionOpenUrlMessage

    await manager.callback({
      type: 'sessionOpenUrlCallback',
      sessionId: 's1',
      requestId: request.requestId,
      url: 'http://localhost:22/oauth2callback?code=x',
    })
    await manager.callback({
      type: 'sessionOpenUrlCallback',
      sessionId: 's1',
      requestId: request.requestId,
      url: 'http://localhost:8085/admin?code=x',
    })

    expect(execute).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ type: 'sessionOpenUrlResult', status: 'failed' })
    expect(manager.pendingCount()).toBe(1)
  })

  it('replays pending requests after transport reconnect and drops expired ones', () => {
    let now = 100
    const sent: DaemonMessage[] = []
    const manager = createBrowserOpenManager((message) => sent.push(message), {
      now: () => now,
      ttlMs: 50,
    })
    manager.capture('s1', 'https://auth.example/login')
    manager.replay()
    expect(sent.filter((message) => message.type === 'sessionOpenUrl')).toHaveLength(2)
    now = 151
    manager.replay()
    expect(manager.pendingCount()).toBe(0)
  })
})

describe('browser command shims', () => {
  it('materializes executable shims and prepends their directory to PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-browser-shims-'))
    dirs.push(dir)
    const env = browserOpenEnv(dir, '/usr/bin')
    const shimDir = join(dir, 'browser-shims')

    expect(env).toEqual({
      BROWSER: join(shimDir, 'podium-browser-open'),
      PATH: `${shimDir}:/usr/bin`,
    })
    for (const name of ['podium-browser-open', 'xdg-open', 'open', 'sensible-browser']) {
      const path = join(shimDir, name)
      expect(statSync(path).mode & 0o700).toBe(0o700)
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is a literal shell expansion.
      expect(readFileSync(path, 'utf8')).toContain('${PODIUM_AGENT_RELAY%/}/open')
    }
  })
})
