/** Real two-named-runtime proof for the consolidated box-bound machine files. */
import { expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    const instances = ['blue', 'green'].map((id) => {
      const stateDir = join(root, id)
      ensureInstanceStateIdentity({ instanceId: id, dir: stateDir })
      prepareSetupEnrollment(true, true, stateDir)
      writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one' }))
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
    })
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
      expect(existsSync(join(instance.stateDir, 'daemon.secret'))).toBe(true)
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
