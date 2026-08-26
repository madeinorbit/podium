/**
 * Real-process proof for the native shell's supervised backend shape.
 *
 * Tauri launches one bundled child for a local all-in-one installation. That one
 * PID must host the server, janitor, and daemon together: updating the signed app
 * then replaces all three components in one shell restart. Planner tests can
 * establish the requested roles, but only a real boot can establish that the
 * janitor actually handshakes and the supervised daemon actually reports.
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

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
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

describe('desktop-supervised local stack', () => {
  it('hosts a live server, janitor lease, and supervised daemon in one versioned child', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'podium-desktop-stack-'))
    roots.push(stateDir)
    const port = await freePort()
    const version = '0.1.0-native-stack-proof'
    for (const site of ['web', 'mobile']) {
      const dir = join(stateDir, site)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'index.html'), `<!doctype html><title>${site}</title>`)
      await writeFile(
        join(dir, 'podium-build.json'),
        JSON.stringify({ appVersion: version, sourceSha: 'abc1234' }),
      )
    }
    await writeFile(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one', port }))

    const inherited = { ...process.env }
    delete inherited.PODIUM_AGENT_RELAY
    const child = spawn('bun', ['--conditions=@podium/source', CLI, '--takeover'], {
      cwd: ROOT,
      env: {
        ...inherited,
        PODIUM_STATE_DIR: stateDir,
        PODIUM_PORT: String(port),
        PODIUM_WEB_DIR: join(stateDir, 'web'),
        PODIUM_MOBILE_WEB_DIR: join(stateDir, 'mobile'),
        PODIUM_APP_VERSION: version,
        PODIUM_DESKTOP_SUPERVISED: '1',
        PODIUM_SUPERVISOR_PID: String(process.pid),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
        mobileWeb?: { present: boolean; appVersion?: string; digest?: string }
      }
    }, 'the local server')
    expect(serverVersion.appVersion).toBe(version)
    expect(serverVersion.mobileWeb).toEqual({
      present: true,
      appVersion: version,
      digest: 'abc1234',
    })
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('<title>web</title>')
    expect(await (await fetch(`http://127.0.0.1:${port}/mobile`)).text()).toContain(
      '<title>mobile</title>',
    )

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
        const machine = db
          .prepare(
            'SELECT app_version, supervised, install_kind FROM machines WHERE app_version = ?',
          )
          .get(version) as
          | { app_version: string; supervised: number; install_kind: string }
          | undefined
        return lease && machine ? { lease, machine } : undefined
      } finally {
        db.close()
      }
    }, 'the janitor lease and daemon build report')

    expect(observed.lease.generation_id).toMatch(/^janitor_/)
    expect(observed.lease.protocol_version).toBeGreaterThan(0)
    expect(observed.lease.schema_version).toMatch(/^maintenance-/)
    expect(observed.machine).toEqual({
      app_version: version,
      supervised: 1,
      install_kind: 'installed',
    })
    expect(child.pid).toBeGreaterThan(0)
    expect(child.exitCode, output).toBeNull()
  }, 45_000)
})
