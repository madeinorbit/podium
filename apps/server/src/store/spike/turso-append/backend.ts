/**
 * A real libsql server for the proof to run against [POD-3250].
 *
 * WHY A SERVER AND NOT A FAKE. Every question this proof asks is a question
 * about the ENGINE and the TRANSPORT: whether `lastInsertRowid` arriving over
 * hrana is the connection's, whether `sqlite_sequence` rolls back with the
 * transaction remotely, what a second writer receives. A fake would answer all
 * three by construction, which is the definition of a test that cannot fail.
 * So the tests start `sqld` — the same server `turso dev` runs — and talk to it
 * over HTTP.
 *
 * WHAT THIS BACKEND IS NOT. `sqld` is not the hosted engine: POD-3251 found the
 * hosted databases run in MVCC mode and refuse virtual tables, so at least one
 * behaviour already differs. This harness is what CI can run; the results
 * document reports every proof run against BOTH this and the hosted spike
 * database, and names the places they disagree.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendConfig } from './client'

/** Where the Turso CLI installs `sqld`; it is not on `PATH` on this machine. */
const SQLD_CANDIDATES = [
  process.env.PODIUM_SQLD_PATH,
  join(homedir(), '.turso', 'sqld'),
  'sqld',
].filter((p): p is string => typeof p === 'string' && p.length > 0)

/**
 * The `sqld` binary, or `undefined` when this machine has none.
 *
 * SYNCHRONOUS AND BY EXISTENCE, so a test file can decide whether to declare
 * its suite at all before any async work has run. The bare name `sqld` is
 * resolved through `PATH` because it is the one candidate that is not a path.
 */
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

export interface LocalServer {
  readonly config: BackendConfig
  /** The directory the database lives in — kept across a restart. */
  readonly dbPath: string
  /** Stop the process but KEEP the data, so a restart can continue from it. */
  stop(): Promise<void>
  /** Stop and delete everything. */
  dispose(): Promise<void>
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

/**
 * Start `sqld` on a free port over a persistent directory.
 *
 * PERSISTENT, not the ephemeral default `turso dev` uses, because the restart
 * proof is exactly "the process went away and the sequence continued". An
 * in-memory server would make that proof pass by having no state to lose, which
 * is the wrong reason.
 */
export async function startLocalServer(existing?: { dbPath: string }): Promise<LocalServer> {
  const dbPath = existing?.dbPath ?? (await mkdtemp(join(tmpdir(), 'pod3250-sqld-')))
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`

  let started: ReturnType<typeof spawn> | undefined
  let lastSpawnError: unknown
  const binary = sqldBinary()
  for (const bin of binary === undefined ? SQLD_CANDIDATES : [binary]) {
    const child = spawn(bin, ['--db-path', dbPath, '--http-listen-addr', `127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const failed = await new Promise<boolean>((resolve) => {
      const onError = (error: unknown) => {
        lastSpawnError = error
        resolve(true)
      }
      child.once('error', onError)
      setTimeout(() => {
        child.off('error', onError)
        resolve(false)
      }, 250)
    })
    if (!failed) {
      started = child
      break
    }
  }
  if (started === undefined) {
    throw new Error(
      `could not start sqld (tried ${SQLD_CANDIDATES.join(', ')}): ${String(lastSpawnError)}. ` +
        'Install the Turso CLI or set PODIUM_SQLD_PATH.',
    )
  }
  const child = started

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

/** True when `sqld` can be started at all — the tests skip rather than fail without it. */
export async function sqldAvailable(): Promise<boolean> {
  try {
    const server = await startLocalServer()
    await server.dispose()
    return true
  } catch {
    return false
  }
}
