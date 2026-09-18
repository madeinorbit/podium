/** Real two-named-runtime proof for the consolidated box-bound machine files. */
import { expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stagePasswordForFirstBoot } from '../packages/runtime/src/auth-store'
import { ensureInstanceStateIdentity } from '../packages/runtime/src/instance'
import { prepareSetupEnrollment } from '../packages/runtime/src/setup-enrollment'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const allocated = new Set<number>()
function port(): number {
  for (;;) {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
    const value = server.port
    server.stop(true)
    if (value === undefined) throw new Error('missing bound port')
    if (!allocated.has(value)) { allocated.add(value); return value }
  }
}
async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${label}`)
    await Bun.sleep(50)
  }
}

it('keeps consolidated machine files independent across two named runtimes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'podium-state-runtimes-'))
  const children: ChildProcess[] = []
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const git = Bun.which('git')
  if (git) symlinkSync(git, join(bin, 'git'))
  try {
    const instances = await Promise.all(['blue', 'green'].map(async (id) => {
      const stateDir = join(root, id)
      ensureInstanceStateIdentity({ instanceId: id, dir: stateDir })
      prepareSetupEnrollment(true, true, stateDir)
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one' }))
      await stagePasswordForFirstBoot(`password-${id}`, stateDir)
      expect(readdirSync(stateDir).sort()).toEqual(['auth.json', 'config.json', 'instance.json', 'machine.json', 'machine.key'])
      const webDir = join(root, `${id}-web`)
      mkdirSync(webDir)
      const env = { ...process.env }
      // No relay, credentials or instance selection from the operator's live session.
      for (const key of Object.keys(env)) if (key.startsWith('PODIUM_')) delete env[key]
      delete env.NOTIFY_SOCKET
      delete env.ABDUCO_SOCKET_DIR
      const httpPort = port()
      Object.assign(env, {
        PODIUM_INSTANCE: id, PODIUM_STATE_DIR: stateDir,
        PODIUM_AGENT_HOME: join(root, `${id}-agents`), PODIUM_WEB_DIR: webDir,
        PODIUM_PORT: String(httpPort), PODIUM_HOOK_PORT: String(port()), PODIUM_AGENT_RELAY_PORT: String(port()),
        PODIUM_HOST: '127.0.0.1', PODIUM_NO_RELAY: '1', PODIUM_NO_SCOPE: '1',
        PODIUM_ABDUCO: join(root, 'missing-abduco'), PODIUM_PTY_BACKEND: 'bun-terminal',
        PATH: bin, SHELL: '/bin/bash',
      })
      const child = spawn(process.execPath, ['--conditions=@podium/source', join(ROOT, 'scripts/cli.ts'), '--instance', id, 'parent', '--takeover'], {
        cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      let output = ''
      child.stdout?.on('data', (data) => { output += data })
      child.stderr?.on('data', (data) => { output += data })
      return { id, stateDir, httpPort, child, output: () => output }
    }))
    const identities = new Set<string>()
    for (const instance of instances) {
      await until(async () => {
        if (instance.child.exitCode !== null) throw new Error(instance.output())
        try {
          const response = await fetch(`http://127.0.0.1:${instance.httpPort}/version`)
          return response.ok && (await response.json() as { instanceId: string }).instanceId === instance.id
        } catch { return false }
      }, `${instance.id} server`)
      await until(() => {
        const state = JSON.parse(readFileSync(join(instance.stateDir, 'machine.json'), 'utf8'))
        return state.connectivity?.state === 'connected' && typeof state.supervisor?.enrolledPublicKey === 'string'
      }, `${instance.id} authenticated supervisor`)
      const state = JSON.parse(readFileSync(join(instance.stateDir, 'machine.json'), 'utf8'))
      identities.add(state.machineId)
      expect(state.supervisor.machineId).toBe(state.machineId)
      for (const retired of ['machine.id', 'daemon.json', 'supervisor.json', 'connectivity.json']) {
        expect(existsSync(join(instance.stateDir, retired))).toBe(false)
      }
      expect(existsSync(join(instance.stateDir, 'machine.key'))).toBe(true)
      expect(existsSync(join(instance.stateDir, 'daemon.secret'))).toBe(false)
      // Quiesce writers before the census: an atomic machine.json replacement
      // may legitimately have a temporary file while the supervisor is running.
      // After graceful shutdown, leftover staging files must fail the fence.
      instance.child.kill('SIGTERM')
      await until(() => instance.child.exitCode !== null || instance.child.signalCode !== null,
        `${instance.id} census shutdown`, 15_000)
      // Enumerate EVERY root entry: no blanket directory/file exclusions. runtime/
      // owns sockets/process scratch; run/ and logs/ are the process registry
      // and its logs. These are directories, never persistent state-root files.
      // pending-update.json belongs only to an in-flight update; this fresh boot
      // has none. auth.json belongs only to the pre-boot setup handoff above.
      const allowedFiles = new Set([
        'cli-session.json', 'config.json',
        'instance.json', 'machine.json', 'machine.key',
        // Existing process lock, explicitly outside the persistent-file census.
        'daemon.lock',
        // Source-mode developer publisher token (design's developer-only exception).
        'dev-artifact-token',
        // The database and its SQLite sidecars are the master-data home.
        'podium.db', 'podium.db-wal', 'podium.db-shm', 'podium.db.snapshots.json',
      ])
      // bin/ holds extracted PTY executables, not master data.
      const allowedDirectories = new Set(['runtime', 'run', 'logs', 'bin'])
      const entries = readdirSync(instance.stateDir, { withFileTypes: true })
      expect(entries.map((entry) => entry.name).filter((name) =>
        !allowedFiles.has(name) && !allowedDirectories.has(name)),
      'unexpected state-root entries').toEqual([])
      for (const entry of entries) {
        if (allowedDirectories.has(entry.name)) expect(entry.isDirectory()).toBe(true)
        else {
          expect(entry.isFile()).toBe(true)
          expect(allowedFiles.has(entry.name), `unexpected state-root entry: ${entry.name}`).toBe(true)
        }
      }
      expect(existsSync(join(instance.stateDir, 'auth.json'))).toBe(false)
      expect(existsSync(join(instance.stateDir, 'pending-update.json'))).toBe(false)
    }
    expect(identities.size).toBe(2)
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    try {
      await until(() => children.every((child) => child.exitCode !== null || child.signalCode !== null), 'named runtime shutdown', 15_000)
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 150_000)
