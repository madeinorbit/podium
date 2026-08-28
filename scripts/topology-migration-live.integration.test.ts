/**
 * LIVE kill matrix for the single-unit topology migration [POD-2506].
 *
 * Every row launches a private systemd user manager with its own runtime and
 * config roots, three real legacy units, and real OS processes. The parent unit
 * runs the same real ParentProcess fixture used by the parent lifecycle suite;
 * its server owns a real loopback port and its takeover kills the legacy holder.
 * The migrator itself is SIGKILLed at each production transition boundary.
 * Nothing in this file addresses the hosting user's live systemd manager.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const FIXTURE = join(ROOT, 'scripts/fixtures/parent-stack-fixture.ts')
const TOPOLOGY_URL = pathToFileURL(join(ROOT, 'apps/cli/src/topology-reconcile.ts')).href
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

const phases = [
  'before-parent-write',
  'after-parent-write',
  'after-parent-enable',
  'external-during-parent-health-wait',
  'after-parent-healthy-before-retire',
  'after-stop-legacy-unit',
  'after-all-legacy-stopped-before-remove',
] as const

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value !== undefined) return value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ''}`)
}

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

function unitBody(execStart: string, env: Record<string, string>): string {
  const environment = Object.entries(env)
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join('\n')
  return `[Unit]
Description=isolated topology migration fixture

[Service]
Type=simple
${environment}
ExecStart=${execStart}
Restart=always
RestartSec=100ms
TimeoutStopSec=5s

[Install]
WantedBy=default.target
`
}

function parentBody(env: Record<string, string>): string {
  const environment = Object.entries(env)
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join('\n')
  return `[Unit]
Description=isolated podium parent fixture

[Service]
Type=notify
NotifyAccess=all
${environment}
ExecStart=${BUN} --conditions=@podium/source ${FIXTURE} parent --takeover
Restart=always
RestartSec=100ms
TimeoutStartSec=15s
TimeoutStopSec=5s

[Install]
WantedBy=default.target
`
}

interface PrivateManager {
  process: ChildProcess
  env: NodeJS.ProcessEnv
  output: () => string
}

function ctlResult(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync('systemctl', ['--user', ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function ctl(env: NodeJS.ProcessEnv, args: string[]): string {
  return execFileSync('systemctl', ['--user', ...args], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function unitState(env: NodeJS.ProcessEnv, unit: string): string {
  const result = ctlResult(env, ['show', unit, '--property=ActiveState', '--value'])
  return result.status === 0 ? result.stdout.trim() : 'missing'
}

function enableState(env: NodeJS.ProcessEnv, unit: string): string {
  const result = ctlResult(env, ['is-enabled', unit])
  return result.stdout.trim()
}

async function startManager(runtimeDir: string, configHome: string): Promise<PrivateManager> {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  // Widened deliberately: this repo types process.env to its KNOWN keys, so the
  // three deletes below are exactly the keys that type does not admit. The point
  // of this env is to strip inherited session plumbing before starting a private
  // systemd, so it has to be able to name keys the narrow type does not.
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: configHome,
  }
  delete env.PODIUM_AGENT_RELAY
  delete env.NOTIFY_SOCKET
  delete env.DBUS_SESSION_BUS_ADDRESS
  const manager = spawn(
    'systemd',
    ['--user', '--unit=default.target', '--log-target=console', '--log-level=warning'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  manager.stdout?.on('data', (chunk) => (output += String(chunk)))
  manager.stderr?.on('data', (chunk) => (output += String(chunk)))
  await until(() => {
    if (manager.exitCode !== null || manager.signalCode !== null) {
      throw new Error(`private systemd exited early: ${output}`)
    }
    return ctlResult(env, ['show-environment']).status === 0 ? true : undefined
  }, 'private systemd manager')
  return { process: manager, env, output: () => output }
}

async function stopManager(manager: PrivateManager): Promise<void> {
  if (!alive(manager.process.pid)) return
  ctlResult(manager.env, ['exit'])
  await until(
    () =>
      manager.process.exitCode !== null || manager.process.signalCode !== null ? true : undefined,
    `private systemd exit; log:\n${manager.output()}`,
    10_000,
  ).catch(() => {
    manager.process.kill('SIGKILL')
    throw new Error(`private systemd did not exit; log:\n${manager.output()}`)
  })
}

function migratorSource(): string {
  return `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { reconcileSupervision } = await import(${JSON.stringify(TOPOLOGY_URL)})
const phase = process.env.FIXTURE_KILL_PHASE
const unitDir = process.env.FIXTURE_UNIT_DIR
const checkpointPath = process.env.FIXTURE_CHECKPOINT
const notifyPath = process.env.FIXTURE_NOTIFY_LOG
const parentBody = process.env.FIXTURE_PARENT_BODY
const checkpoint = async (value) => {
  const matches = value.phase === phase &&
    (phase !== 'after-stop-legacy-unit' || value.remaining > 0)
  if (!matches) return
  writeFileSync(checkpointPath, JSON.stringify(value))
  process.kill(process.pid, 'SIGKILL')
  await new Promise(() => {})
}
const parentHealthy = async () => {
  if (phase === 'external-during-parent-health-wait') return false
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (existsSync(notifyPath) && readFileSync(notifyPath, 'utf8').split('\\n').includes('READY=1')) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}
await reconcileSupervision({
  checkpoint,
  parentHealthy,
  writeUnit: (unit) => {
    const path = join(unitDir, unit)
    writeFileSync(path, parentBody)
    return path
  },
  healthTimeoutMs: 20_000,
})
`
}

async function workingParent(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`)
    if (!response.ok) return false
    const body = (await response.json()) as { daemonConnected?: boolean }
    return body.daemonConnected === true
  } catch {
    return false
  }
}

describe('single-unit migration live kill matrix', () => {
  it.each(phases)('SIGKILL at %s leaves a live legacy topology or a working parent', async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'podium-topology-live-'))
    const runtimeDir = join(root, 'runtime')
    const configHome = join(root, 'config')
    const unitDir = join(configHome, 'systemd', 'user')
    const stateDir = join(root, 'state')
    const checkpointPath = join(root, 'checkpoint.json')
    const notifyPath = join(stateDir, 'run', 'fixture-notify.log')
    const port = await freePort()
    const instanceId = `kill${phases.indexOf(phase)}`
    const parentUnit = `podium-${instanceId}.service`
    const legacyUnits = [
      `podium-${instanceId}-server.service`,
      `podium-${instanceId}-janitor.service`,
      `podium-${instanceId}-daemon.service`,
    ]
    mkdirSync(unitDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'VERSION'), '1.0.0\n')
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ mode: 'all-in-one', persistence: 'systemd', port }),
    )
    const serviceEnv = {
      PODIUM_STATE_DIR: stateDir,
      PODIUM_HOME: stateDir,
      PODIUM_PORT: String(port),
      PODIUM_INSTANCE: instanceId,
      PODIUM_APP_VERSION: '1.0.0',
    }
    writeFileSync(
      join(unitDir, legacyUnits[0] as string),
      unitBody(`${BUN} --conditions=@podium/source ${FIXTURE} server`, serviceEnv),
    )
    writeFileSync(
      join(unitDir, legacyUnits[1] as string),
      unitBody('/usr/bin/sleep infinity', serviceEnv),
    )
    writeFileSync(
      join(unitDir, legacyUnits[2] as string),
      unitBody(`${BUN} --conditions=@podium/source ${FIXTURE} daemon`, serviceEnv),
    )
    const renderedParent = parentBody({
      ...serviceEnv,
      FIXTURE_SERVER_HEALTH_DELAY_MS: '1500',
    })

    let manager: PrivateManager | undefined
    let migrator: ChildProcess | undefined
    try {
      manager = await startManager(runtimeDir, configHome)
      ctl(manager.env, ['daemon-reload'])
      ctl(manager.env, ['enable', '--now', ...legacyUnits])
      await until(
        () =>
          legacyUnits.every((unit) => unitState(manager!.env, unit) === 'active')
            ? true
            : undefined,
        'all three legacy units active',
      )

      migrator = spawn(BUN, ['--conditions=@podium/source', '--eval', migratorSource()], {
        cwd: ROOT,
        env: {
          ...manager.env,
          PODIUM_STATE_DIR: stateDir,
          PODIUM_INSTANCE: instanceId,
          FIXTURE_KILL_PHASE: phase,
          FIXTURE_UNIT_DIR: unitDir,
          FIXTURE_CHECKPOINT: checkpointPath,
          FIXTURE_NOTIFY_LOG: notifyPath,
          FIXTURE_PARENT_BODY: renderedParent,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let migrationOutput = ''
      migrator.stdout?.on('data', (chunk) => (migrationOutput += String(chunk)))
      migrator.stderr?.on('data', (chunk) => (migrationOutput += String(chunk)))

      let checkpoint: { phase: string; unit?: string; remaining?: number } = { phase }
      if (phase === 'external-during-parent-health-wait') {
        await until(() => {
          if (migrator?.exitCode !== null || migrator?.signalCode !== null) {
            throw new Error(`migrator exited before health wait: ${migrationOutput}`)
          }
          return unitState(manager!.env, parentUnit) === 'activating' ? true : undefined
        }, 'parent unit activating inside its notify health wait')
        migrator.kill('SIGKILL')
        checkpoint = { phase }
      } else {
        checkpoint = await until(() => {
          if (existsSync(checkpointPath)) {
            return JSON.parse(readFileSync(checkpointPath, 'utf8')) as typeof checkpoint
          }
          if (migrator?.exitCode !== null || migrator?.signalCode !== null) {
            throw new Error(`migrator exited before ${phase}: ${migrationOutput}`)
          }
          return undefined
        }, phase)
        expect(checkpoint.phase).toBe(phase)
      }
      await until(
        () => (migrator?.signalCode === 'SIGKILL' ? true : undefined),
        `migrator SIGKILL at ${phase}`,
      )

      if (
        phase === 'before-parent-write' ||
        phase === 'after-parent-write' ||
        phase === 'after-parent-enable'
      ) {
        expect(legacyUnits.map((unit) => unitState(manager!.env, unit))).toEqual([
          'active',
          'active',
          'active',
        ])
        if (phase === 'before-parent-write') expect(existsSync(join(unitDir, parentUnit))).toBe(false)
        if (phase === 'after-parent-write') expect(unitState(manager.env, parentUnit)).toBe('inactive')
        if (phase === 'after-parent-enable') {
          expect(enableState(manager.env, parentUnit)).toBe('enabled')
          expect(unitState(manager.env, parentUnit)).toBe('inactive')
        }
      } else {
        // AWAITED on purpose: workingParent is async, so the unawaited call
        // returned a Promise, which is always truthy — this waited for nothing
        // and passed instantly without ever checking that the parent came back.
        // `until` accepts an async reader, so the fix is to await it here.
        await until(
          async () => ((await workingParent(port)) ? true : undefined),
          `working parent after SIGKILL at ${phase}`,
        )
        expect(['active', 'activating']).toContain(unitState(manager.env, parentUnit))
      }

      if (phase === 'external-during-parent-health-wait') {
        for (const unit of legacyUnits) {
          const runtimeMask = join(runtimeDir, 'systemd', 'user', unit)
          expect(readlinkSync(runtimeMask)).toBe('/dev/null')
          expect(lstatSync(join(unitDir, unit)).isSymbolicLink()).toBe(false)
        }
      }
      if (phase === 'after-stop-legacy-unit') {
        expect(checkpoint.unit).toBeTruthy()
        expect(unitState(manager.env, checkpoint.unit as string)).toBe('inactive')
        expect(legacyUnits.every((unit) => existsSync(join(unitDir, unit)))).toBe(true)
        expect(checkpoint.remaining).toBeGreaterThan(0)
      }
      if (phase === 'after-all-legacy-stopped-before-remove') {
        expect(legacyUnits.map((unit) => unitState(manager!.env, unit))).toEqual([
          'inactive',
          'inactive',
          'inactive',
        ])
        expect(legacyUnits.every((unit) => existsSync(join(unitDir, unit)))).toBe(true)
      }
    } finally {
      if (migrator && alive(migrator.pid)) migrator.kill('SIGKILL')
      if (manager) await stopManager(manager)
      // systemd deliberately creates this mode-000 sentinel in every runtime
      // tree; make its directory traversable before removing the private root.
      try {
        chmodSync(join(runtimeDir, 'systemd', 'inaccessible', 'dir'), 0o700)
      } catch {
        // Manager never created it (for example, failed before startup).
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)
})
