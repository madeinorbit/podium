import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
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
        asSessionId('s1'),
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
      sessionId: asSessionId('s1'),
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
      asSessionId('s1'),
      'https://auth.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8085%2Foauth2callback',
    )
    const request = sent[0] as SessionOpenUrlMessage

    await manager.callback({
      type: 'sessionOpenUrlCallback',
      sessionId: asSessionId('s1'),
      requestId: request.requestId,
      url: 'http://localhost:22/oauth2callback?code=x',
    })
    await manager.callback({
      type: 'sessionOpenUrlCallback',
      sessionId: asSessionId('s1'),
      requestId: request.requestId,
      url: 'http://localhost:8085/admin?code=x',
    })

    expect(execute).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ type: 'sessionOpenUrlResult', status: 'failed' })
    expect(manager.pendingCount()).toBe(1)
  })

  it('stamps intent from the generic heuristic when no adapter verdict exists', () => {
    const sent: DaemonMessage[] = []
    const manager = createBrowserOpenManager((message) => sent.push(message))
    manager.capture(
      asSessionId('s1'),
      'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    )
    manager.capture(asSessionId('s1'), 'https://claude.ai/code/artifact/abc?via=auto_preview')
    const [login, link] = sent as SessionOpenUrlMessage[]
    expect(login?.intent).toBe('login')
    expect(link?.intent).toBe('link')
    expect(link?.callbackTarget).toBeUndefined()
  })

  it('prioritizes the adapter verdict and withholds the callback capability on links', () => {
    const sent: DaemonMessage[] = []
    const classify = vi.fn((_sessionId: SessionId, url: URL) =>
      url.hostname === 'known.example'
        ? ({ intent: url.pathname.startsWith('/oauth/') ? 'login' : 'link' } as const)
        : undefined,
    )
    const manager = createBrowserOpenManager((message) => sent.push(message), { classify })
    // Adapter says link: even a loopback redirect_uri must not mint a target.
    manager.capture(
      asSessionId('s1'),
      'https://known.example/share?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    )
    // Adapter says login without a loopback redirect: pending login, no target.
    manager.capture(asSessionId('s1'), 'https://known.example/oauth/device')
    // Unknown host: generic fallback still applies.
    manager.capture(asSessionId('s1'), 'https://other.example/page')
    const [link, login, fallback] = sent as SessionOpenUrlMessage[]
    expect(link).toMatchObject({ intent: 'link' })
    expect(link?.callbackTarget).toBeUndefined()
    expect(login).toMatchObject({ intent: 'login' })
    expect(login?.callbackTarget).toBeUndefined()
    expect(fallback).toMatchObject({ intent: 'link' })
    expect(classify).toHaveBeenCalledTimes(3)
  })

  it('replays pending requests after transport reconnect and drops expired ones', () => {
    let now = 100
    const sent: DaemonMessage[] = []
    const manager = createBrowserOpenManager((message) => sent.push(message), {
      now: () => now,
      ttlMs: 50,
    })
    manager.capture(asSessionId('s1'), 'https://auth.example/login')
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
      expect(readFileSync(path, 'utf8')).toContain('${relay%/}/open')
    }
  })

  // POD-1375: a human's shell no longer carries PODIUM_AGENT_RELAY, and the shim is on
  // its PATH. Opening a URL is transport, not delegate authority — so the shim reads
  // PODIUM_SESSION_RELAY (bound for every kind) and only falls back to the agent name
  // for sessions spawned before the split. Without this, `open`/`xdg-open` in a shell
  // would start exiting 2 with "missing relay" — silently, from the human's point of view.
  for (const [label, relayVar] of [
    ['session relay (shells included)', 'PODIUM_SESSION_RELAY'],
    ['legacy agent relay (pre-split session)', 'PODIUM_AGENT_RELAY'],
  ] as const) {
    it(`posts the URL to the daemon using the ${label}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'podium-browser-shims-'))
      dirs.push(dir)
      const received: { path?: string; body?: string } = {}
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          received.path = req.url
          received.body = Buffer.concat(chunks).toString('utf8')
          res.writeHead(200).end()
        })
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const port = (server.address() as AddressInfo).port

      try {
        const env = browserOpenEnv(dir, '/usr/bin')
        // spawn, NOT spawnSync: the server above lives on THIS event loop, so a
        // synchronous wait would block the accept curl is waiting for — deadlock.
        const child = spawn(join(dir, 'browser-shims', 'xdg-open'), ['https://example.test/x'], {
          env: {
            ...process.env,
            PATH: env.PATH,
            PODIUM_SESSION_RELAY: '',
            PODIUM_AGENT_RELAY: '',
            [relayVar]: `http://127.0.0.1:${port}/agent/s1`,
          },
        })
        let stderr = ''
        child.stderr.on('data', (c: Buffer) => {
          stderr += c.toString()
        })
        const status = await new Promise<number | null>((r) => child.on('close', r))

        expect(stderr).not.toContain('missing relay')
        expect(status).toBe(0)
        expect(received.path).toBe('/agent/s1/open')
        expect(received.body).toBe('https://example.test/x')
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    })
  }

  it('exits 2 when neither relay variable is bound', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-browser-shims-'))
    dirs.push(dir)
    const env = browserOpenEnv(dir, '/usr/bin')
    const result = spawnSync(join(dir, 'browser-shims', 'xdg-open'), ['https://example.test/x'], {
      env: { ...process.env, PATH: env.PATH, PODIUM_SESSION_RELAY: '', PODIUM_AGENT_RELAY: '' },
    })

    expect(result.status).toBe(2)
    expect(result.stderr.toString()).toContain('missing relay')
  })

  it('falls through to the real binary when no URL argument is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-browser-shims-'))
    dirs.push(dir)
    const realDir = mkdtempSync(join(tmpdir(), 'podium-real-bin-'))
    dirs.push(realDir)
    const marker = join(realDir, 'invoked')
    writeFileSync(join(realDir, 'xdg-open'), `#!/bin/sh\nprintf '%s' "$*" > "${marker}"\n`, {
      mode: 0o755,
    })

    const env = browserOpenEnv(dir, realDir)
    const shim = join(dir, 'browser-shims', 'xdg-open')
    const result = spawnSync(shim, ['README.md'], { env: { ...process.env, PATH: env.PATH } })

    expect(result.status).toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('README.md')
  })

  it('exits 2 for a non-URL invocation when no real binary exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'podium-browser-shims-'))
    dirs.push(dir)
    const emptyDir = mkdtempSync(join(tmpdir(), 'podium-empty-bin-'))
    dirs.push(emptyDir)

    const env = browserOpenEnv(dir, emptyDir)
    const shim = join(dir, 'browser-shims', 'xdg-open')
    const result = spawnSync(shim, ['README.md'], { env: { ...process.env, PATH: env.PATH } })

    expect(result.status).toBe(2)
  })
})
