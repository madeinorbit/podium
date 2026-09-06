import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeMachineUpdateAdapter } from './machine-update-native'
import type { MachineUpdateExecutor } from './machine-update'

interface Endpoint {
  socketPath: string
  token: string
  pid: number
}
const endpointPath = (runtimeDir: string) => join(runtimeDir, 'machine-update-control.json')
/** Instance-scoped local adapter boundary, private to the owning OS user. */
export async function startMachineUpdateControl(
  runtimeDir: string,
  executor: MachineUpdateExecutor,
  native?: NativeMachineUpdateAdapter,
): Promise<{ close(): Promise<void> }> {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  const key = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 20)
  const root = join(tmpdir(), `podium-update-${process.getuid?.() ?? 'user'}-${key}`)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const endpoint: Endpoint = {
    socketPath:
      process.platform === 'win32'
        ? String.raw`\\.\pipe\podium-update-${key}-${process.pid}`
        : join(root, `${process.pid}.sock`),
    token: randomBytes(32).toString('hex'),
    pid: process.pid,
  }
  const server = createServer(async (req, res) => {
    const bearer = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${endpoint.token}`)
    if (bearer.length !== expected.length || !timingSafeEqual(bearer, expected)) {
      res.writeHead(401).end()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    const json = (value: unknown) => {
      const body = JSON.stringify(value)
      res.setHeader('Content-Length', Buffer.byteLength(body))
      res.end(body)
    }
    try {
      if (req.method === 'GET' && req.url === '/native/work' && native) {
        json(native.next() ?? null)
        return
      }
      if (req.method === 'GET' && req.url === '/status') {
        json(executor.snapshot() ?? null)
        return
      }
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1024 * 1024) throw new Error('control request too large')
      }
      const parsed = JSON.parse(body)
      if (req.method === 'POST' && req.url === '/native/progress' && native) {
        json({ recorded: native.progress(parsed.id, parsed.percent) })
        return
      }
      if (req.method === 'POST' && req.url === '/native/result' && native) {
        json({ recorded: native.finish(parsed.id, parsed.error) })
        return
      }
      if (req.method === 'POST' && (req.url === '/grant' || req.url === '/prepare')) {
        // Return admission promptly; durable status is the completion contract.
        await executor.accept(parsed, false, req.url === '/prepare', { kind: 'local' })
        res.statusCode = 202
        json({ accepted: true })
        return
      }
      if (req.method === 'POST' && req.url === '/activate') {
        await executor.activate(parsed.grantId)
        json({ accepted: true })
        return
      }
      if (req.method === 'POST' && req.url === '/cancel') {
        json({ canceled: await executor.cancel(parsed.grantId) })
        return
      }
      res.writeHead(404).end()
    } catch (error) {
      res.writeHead(409).end(JSON.stringify({ error: String(error) }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint.socketPath, resolve)
  })
  if (process.platform !== 'win32') chmodSync(endpoint.socketPath, 0o600)
  const temporary = `${endpointPath(runtimeDir)}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(endpoint), { mode: 0o600 })
  renameSync(temporary, endpointPath(runtimeDir))
  return {
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(endpoint.socketPath, { force: true })
      try {
        if (JSON.parse(readFileSync(endpointPath(runtimeDir), 'utf8')).pid === process.pid)
          rmSync(endpointPath(runtimeDir), { force: true })
      } catch {}
      try {
        rmdirSync(root)
      } catch {}
    },
  }
}
export async function requestMachineUpdate(
  runtimeDir: string,
  path: '/grant' | '/prepare' | '/activate' | '/cancel' | '/status',
  body?: unknown,
): Promise<unknown> {
  const endpoint = JSON.parse(readFileSync(endpointPath(runtimeDir), 'utf8')) as Endpoint
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: endpoint.socketPath,
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(data || `supervisor control HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch (error) {
            reject(error)
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('supervisor control timed out')))
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
