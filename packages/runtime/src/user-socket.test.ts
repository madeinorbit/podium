import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listenUserSocket, serverControlSocketPath } from './user-socket'

function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET' }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('listenUserSocket', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-user-socket-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves on a 0600 socket inside a 0700 directory, and removes it on close', async () => {
    const path = join(dir, 'run', 'test.sock')
    const server = await listenUserSocket(path, (_req, res) => res.end('hi'), 'test socket')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'run')).mode & 0o777).toBe(0o700)
    expect(await get(path, '/')).toEqual({ status: 200, body: 'hi' })
    await server.close()
    expect(() => statSync(path)).toThrow()
  })

  it('replaces a stale socket file a crashed process left behind', async () => {
    const path = join(dir, 'stale.sock')
    writeFileSync(path, '')
    const server = await listenUserSocket(path, (_req, res) => res.end('fresh'), 'test socket')
    expect((await get(path, '/')).body).toBe('fresh')
    await server.close()
  })

  it('never steals a socket another process is still listening on', async () => {
    const path = join(dir, 'live.sock')
    const first = await listenUserSocket(path, (_req, res) => res.end('first'), 'test socket')
    await expect(
      listenUserSocket(path, (_req, res) => res.end('second'), 'test socket'),
    ).rejects.toMatchObject({
      code: 'EADDRINUSE',
      message: expect.stringContaining('test socket already in use'),
    })
    expect((await get(path, '/')).body).toBe('first')
    await first.close()
  })
})

describe('serverControlSocketPath', () => {
  it('lives in the state root run directory', () => {
    expect(serverControlSocketPath({ root: '/home/u/.podium', platform: 'linux' })).toBe(
      '/home/u/.podium/run/control.sock',
    )
  })
  it('moves to the short per-instance socket directory when Linux cannot fit the path', () => {
    const deep = `/home/u/${'x'.repeat(120)}`
    const path = serverControlSocketPath({ root: deep, instanceId: 'default', platform: 'linux' })
    expect(path.startsWith('/tmp/pd-')).toBe(true)
    expect(path.endsWith('/control.sock')).toBe(true)
    // Same inputs, same answer: the server and its callers derive it independently.
    expect(serverControlSocketPath({ root: deep, instanceId: 'default', platform: 'linux' })).toBe(
      path,
    )
  })
})
