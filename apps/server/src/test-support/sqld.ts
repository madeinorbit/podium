/**
 * Local `sqld` for Turso-backend tests [POD-3272].
 *
 * The same server `turso dev` runs. Hosted Turso is MVCC and refuses virtual
 * tables; this harness is what CI can run.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const SQLD_CANDIDATES = [
  process.env.PODIUM_SQLD_PATH,
  join(homedir(), '.turso', 'sqld'),
  'sqld',
].filter((p): p is string => typeof p === 'string' && p.length > 0)

export function sqldBinary(): string | undefined {
  for (const candidate of SQLD_CANDIDATES) {
    if (candidate === 'sqld') {
      const found = (process.env.PATH ?? '')
        .split(':')
        .map((dir) => join(dir, 'sqld'))
        .find((p) => existsSync(p))
      if (found !== undefined) return found
      continue
    }
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('no port assigned'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

async function waitForReady(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`sqld did not become ready at ${url}: ${String(lastError)}`)
}

export interface LocalSqld {
  readonly config: { url: string }
  readonly dbPath: string
  stop(): Promise<void>
  dispose(): Promise<void>
}

export async function startLocalSqld(): Promise<LocalSqld> {
  const dbPath = await mkdtemp(join(tmpdir(), 'pod3272-sqld-'))
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const binary = sqldBinary()
  if (binary === undefined) throw new Error('sqld is not installed')
  const child = spawn(binary, ['--db-path', dbPath, '--http-listen-addr', `127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
  }
  try {
    await waitForReady(url)
  } catch (error) {
    await stop()
    throw error
  }
  return {
    config: { url },
    dbPath,
    stop,
    dispose: async () => {
      await stop()
      await rm(dbPath, { recursive: true, force: true })
    },
  }
}
