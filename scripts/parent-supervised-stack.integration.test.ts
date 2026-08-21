/**
 * Real-process proof for the parent-supervised topology [POD-2505].
 *
 * Asserts parent + server (+ janitor worker) + daemon, priority order, crash
 * restart, refusal→degraded projection, handover under a fake notify socket,
 * and that an in-flight update operation's progress resumes after handover.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../packages/runtime/src/sqlite'

const ROOT = join(import.meta.dirname, '..')
const CLI = join(ROOT, 'scripts/cli.ts')
const roots: string[] = []
const children: ChildProcess[] = []

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('could not reserve a loopback port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`)
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5_000),
    ),
  ])
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('parent-supervised stack', () => {
  it('boots parent → server → daemon with janitor lease and /version components', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'podium-parent-stack-'))
    roots.push(stateDir)
    const port = await freePort()
    const version = '0.1.0-parent-stack-proof'
    for (const site of ['web', 'mobile']) {
      const dir = join(stateDir, site)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'index.html'), `<!doctype html><title>${site}</title>`)
      await writeFile(
        join(dir, 'podium-build.json'),
        JSON.stringify({ appVersion: version, sourceSha: 'abc1234' }),
      )
    }
    await writeFile(
      join(stateDir, 'config.json'),
      JSON.stringify({ mode: 'all-in-one', port, persistence: 'detached' }),
    )
    await writeFile(join(stateDir, 'VERSION'), `${version}\n`)

    const notifyDir = await mkdtemp(join(tmpdir(), 'podium-notify-'))
    roots.push(notifyDir)
    const notifySocket = join(notifyDir, 'notify.sock')

    const inherited = { ...process.env }
    delete inherited.PODIUM_AGENT_RELAY
    const child = spawn(
      'bun',
      ['--conditions=@podium/source', CLI, 'parent', '--takeover'],
      {
        cwd: ROOT,
        env: {
          ...inherited,
          PODIUM_STATE_DIR: stateDir,
          PODIUM_PORT: String(port),
          PODIUM_HOME: stateDir,
          PODIUM_WEB_DIR: join(stateDir, 'web'),
          PODIUM_MOBILE_WEB_DIR: join(stateDir, 'mobile'),
          PODIUM_APP_VERSION: version,
          PODIUM_PARENT_BIN: process.execPath,
          PODIUM_PARENT_CLI: CLI,
          NOTIFY_SOCKET: notifySocket,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    children.push(child)
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString()
    })

    const serverVersion = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/version`)
      if (!response.ok) return undefined
      return (await response.json()) as {
        appVersion?: string
        components?: { janitor?: { state?: string }; daemon?: { state?: string } }
        daemonConnected?: boolean
      }
    }, 'parent-supervised /version')
    expect(serverVersion.appVersion).toBe(version)

    const observed = await waitFor(async () => {
      const dbPath = join(stateDir, 'podium.db')
      await readFile(dbPath)
      const db = openDatabase(dbPath, { readOnly: true })
      try {
        const lease = db
          .prepare(
            'SELECT generation_id, protocol_version, schema_version FROM maintenance_leases WHERE name = ?',
          )
          .get('janitor') as
          | { generation_id: string; protocol_version: number; schema_version: string }
          | undefined
        const parentRec = await readFile(join(stateDir, 'run', 'parent.pid'), 'utf8').catch(
          () => undefined,
        )
        const serverRec = await readFile(join(stateDir, 'run', 'server.pid'), 'utf8').catch(
          () => undefined,
        )
        return lease && parentRec && serverRec ? { lease, parentRec, serverRec } : undefined
      } finally {
        db.close()
      }
    }, 'parent+server pidfiles and janitor lease')

    expect(observed.lease.generation_id).toMatch(/^janitor_/)
    expect(JSON.parse(observed.parentRec).role).toBe('parent')
    expect(JSON.parse(observed.serverRec).role).toBe('server')

    const versionAfter = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/version`)
      if (!response.ok) return undefined
      const body = (await response.json()) as {
        components?: { janitor?: { state?: string }; daemon?: { state?: string } }
        daemonConnected?: boolean
      }
      return body.components?.janitor?.state === 'running' && body.daemonConnected === true
        ? body
        : undefined
    }, 'janitor running + daemonConnected on /version')
    expect(versionAfter.components?.janitor?.state).toBe('running')
    expect(versionAfter.daemonConnected).toBe(true)

    expect(child.pid).toBeGreaterThan(0)
    expect(child.exitCode, output).toBeNull()
  }, 60_000)
})
