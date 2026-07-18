import { afterAll, describe, expect, it } from 'bun:test'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { reviveCompatibilityBlockedJanitor } from '../apps/cli/src/podium-update'
import { registerMaintenanceRoute } from '../apps/server/src/modules/maintenance/route'
import { MaintenanceService } from '../apps/server/src/modules/maintenance/service'
import { type MessageRow, SessionStore } from '../apps/server/src/store'
import {
  MAINTENANCE_SCHEMA_VERSION,
  type MaintenanceCommand,
  type MaintenanceCommandReply,
} from '../packages/protocol/src/maintenance'
import { instanceServiceName } from '../packages/runtime/src/instance'

const ROOT = join(import.meta.dir, '..')
const JANITOR_FIXTURE = join(ROOT, 'scripts/fixtures/janitor-process-fixture.ts')
const WORKER_FIXTURE = join(ROOT, 'scripts/fixtures/publication-worker-process-fixture.ts')
const COMPAT_FIXTURE = join(ROOT, 'scripts/fixtures/compat-janitor-process-fixture.ts')
const TOKEN = 'acceptance-maintenance-token'
const roots = new Set<string>()
const units = new Set<string>()

type FaultBoundary = 'before-apply' | 'after-apply-before-ack'

function dueMessage(id: string): MessageRow {
  return {
    id,
    threadId: 'thread_' + id,
    inReplyTo: null,
    fromKind: 'system',
    fromSession: null,
    fromName: 'process-acceptance',
    fromIssue: null,
    toKind: 'operator',
    toId: null,
    kind: 'notification',
    urgency: 'fyi',
    lifecycle: 'wait',
    body: 'due',
    expiresAt: '2026-07-01T00:00:00.000Z',
    createdAt: '2026-06-30T00:00:00.000Z',
    status: 'queued',
    deliveredAt: null,
    deliveredTo: null,
    ackedBy: null,
    hop: 0,
    clampedFrom: null,
    remindedAt: null,
    factKey: null,
    factTarget: null,
    expectsResponse: false,
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + label)
    await Bun.sleep(25)
  }
}

function expiredEventCount(store: SessionStore, id: string): number {
  return store.events
    .listEventsSince(0)
    .filter((event) => event.kind === 'message.expired' && event.subject === id).length
}

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.add(dir)
  return dir
}

function maintenanceHarness(dir: string, leaseTtlMs = 1_000) {
  const dbPath = join(dir, 'podium.db')
  const store = new SessionStore(dbPath)
  const service = new MaintenanceService(
    store,
    {
      run<T>({ write }: { write: () => T }): T {
        return write()
      },
    },
    { leaseTtlMs },
  )
  const app = new Hono()
  let boundary: FaultBoundary | null = null
  let boundaryHit = deferred()
  let release = deferred()
  registerMaintenanceRoute(app, {
    authenticateToken: (token) => token === TOKEN,
    service: {
      handshake: (request) => service.handshake(request),
      apply: async (command: MaintenanceCommand): Promise<MaintenanceCommandReply> => {
        const activeBoundary = boundary
        if (activeBoundary === 'before-apply') {
          boundary = null
          boundaryHit.resolve()
          await release.promise
        }
        const reply = await service.apply(command)
        if (activeBoundary === 'after-apply-before-ack') {
          boundary = null
          boundaryHit.resolve()
          await release.promise
        }
        return reply
      },
    },
  })
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  return {
    dbPath,
    store,
    serverUrl: server.url.origin,
    arm(next: FaultBoundary): Promise<void> {
      boundary = next
      boundaryHit = deferred()
      release = deferred()
      return boundaryHit.promise
    },
    release(): void {
      release.resolve()
    },
    close(): void {
      release.resolve()
      server.stop(true)
      store.close()
    },
  }
}

function spawnFixture(fixture: string, env: Record<string, string>) {
  let output = ''
  const child = spawn(process.execPath, ['--conditions=@podium/source', fixture], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    output += String(chunk)
  })
  return { child, output: () => output }
}

function spawnJanitor(dir: string, dbPath: string, serverUrl: string, startedFile: string) {
  return spawnFixture(JANITOR_FIXTURE, {
    PODIUM_ACCEPTANCE_SERVER_URL: serverUrl,
    PODIUM_ACCEPTANCE_TOKEN: TOKEN,
    PODIUM_ACCEPTANCE_DB_PATH: dbPath,
    PODIUM_ACCEPTANCE_TICK_MS: '100',
    PODIUM_ACCEPTANCE_STARTED_FILE: startedFile,
    PODIUM_STATE_DIR: dir,
  })
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error('process ' + (child.pid ?? 'unknown') + ' did not exit')
    }),
  ])
}

async function kill(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  await waitForExit(child)
}

function systemctl(unit: string, property: string): string {
  return execFileSync('systemctl', ['--user', 'show', unit, '--property=' + property, '--value'], {
    encoding: 'utf8',
  }).trim()
}

function runUnit(
  unit: string,
  properties: string[],
  env: Record<string, string>,
  command: string[],
): void {
  units.add(unit)
  execFileSync(
    'systemd-run',
    [
      '--user',
      '--quiet',
      '--unit=' + unit,
      '--working-directory=' + ROOT,
      ...properties.map((property) => '--property=' + property),
      ...Object.entries(env).map(([key, value]) => '--setenv=' + key + '=' + value),
      ...command,
    ],
    { stdio: 'pipe' },
  )
}

function systemdQuote(value: string): string {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
}

function linkUnit(unit: string, dir: string, env: Record<string, string>, command: string[]): void {
  units.add(unit)
  const unitPath = join(dir, unit)
  const environment = Object.entries(env)
    .map(([key, value]) => 'Environment=' + systemdQuote(key + '=' + value))
    .join('\n')
  writeFileSync(
    unitPath,
    [
      '[Unit]',
      'Description=Podium compatibility acceptance janitor',
      '',
      '[Service]',
      'Type=simple',
      'WorkingDirectory=' + ROOT,
      environment,
      'ExecStart=' + command.map(systemdQuote).join(' '),
      'Restart=on-failure',
      'RestartPreventExitStatus=78',
      '',
    ].join('\n'),
  )
  execFileSync('systemctl', ['--user', 'link', unitPath], { stdio: 'pipe' })
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
  execFileSync('systemctl', ['--user', 'start', unit], { stdio: 'pipe' })
}

function uniqueInstance(prefix: string): string {
  return (prefix + process.pid.toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 32)
}

function stopUnit(unit: string): void {
  try {
    execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' })
  } catch {}
  try {
    execFileSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' })
  } catch {}
  try {
    execFileSync('systemctl', ['--user', 'disable', unit], { stdio: 'ignore' })
  } catch {}
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
  } catch {}
  units.delete(unit)
}

afterAll(() => {
  for (const unit of units) stopUnit(unit)
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('real process death acceptance [spec:SP-c29e]', () => {
  for (const boundary of ['before-apply', 'after-apply-before-ack'] as const) {
    it('SIGKILLs the janitor ' + boundary + ' and recovers exactly once', async () => {
      const dir = makeRoot('podium-janitor-' + boundary + '-')
      const harness = maintenanceHarness(dir)
      const message = dueMessage('msg_' + boundary)
      harness.store.messages.addMessage(message)
      const boundaryHit = harness.arm(boundary)
      const firstStarted = join(dir, 'first.started')
      const first = spawnJanitor(dir, harness.dbPath, harness.serverUrl, firstStarted)
      try {
        await Promise.race([
          boundaryHit,
          Bun.sleep(10_000).then(() => {
            throw new Error('janitor did not reach ' + boundary + ': ' + first.output())
          }),
        ])
        expect(first.child.pid).toBeGreaterThan(0)
        if (boundary === 'before-apply') {
          expect(harness.store.messages.getMessage(message.id)?.status).toBe('queued')
        } else {
          expect(harness.store.messages.getMessage(message.id)?.status).toBe('expired')
          expect(expiredEventCount(harness.store, message.id)).toBe(1)
        }
        await kill(first.child, 'SIGKILL')
        expect(first.child.signalCode).toBe('SIGKILL')
        harness.release()

        await Bun.sleep(1_100)
        const recoveredStarted = join(dir, 'recovered.started')
        const recovered = spawnJanitor(dir, harness.dbPath, harness.serverUrl, recoveredStarted)
        try {
          await waitUntil(
            () => harness.store.messages.getMessage(message.id)?.status === 'expired',
            'janitor recovery apply',
          )
          await waitUntil(() => existsSync(recoveredStarted), 'recovered janitor start')
          expect(expiredEventCount(harness.store, message.id)).toBe(1)
          expect(Number(readFileSync(recoveredStarted, 'utf8'))).toBe(recovered.child.pid)
        } finally {
          await kill(recovered.child, 'SIGTERM')
        }
      } finally {
        if (first.child.exitCode === null && first.child.signalCode === null) {
          await kill(first.child, 'SIGKILL')
        }
        harness.close()
      }
    }, 30_000)
  }

  it('SIGKILLs the real publication-worker host mid-job and rebuilds after restart', async () => {
    const dir = makeRoot('podium-publication-worker-kill-')
    const dispatched = join(dir, 'dispatched')
    const result = join(dir, 'result.json')
    const first = spawnFixture(WORKER_FIXTURE, {
      PODIUM_ACCEPTANCE_DISPATCHED_FILE: dispatched,
      PODIUM_ACCEPTANCE_RESULT_FILE: result,
      PODIUM_ACCEPTANCE_HOLD_AFTER_DISPATCH: '1',
      PODIUM_ACCEPTANCE_SESSION_COUNT: '20000',
    })
    await waitUntil(() => existsSync(dispatched), 'publication dispatch')
    await kill(first.child, 'SIGKILL')
    expect(first.child.signalCode).toBe('SIGKILL')
    expect(existsSync(result)).toBe(false)

    rmSync(dispatched, { force: true })
    const recovered = spawnFixture(WORKER_FIXTURE, {
      PODIUM_ACCEPTANCE_DISPATCHED_FILE: dispatched,
      PODIUM_ACCEPTANCE_RESULT_FILE: result,
      PODIUM_ACCEPTANCE_SESSION_COUNT: '20000',
    })
    await waitForExit(recovered.child, 30_000)
    expect(recovered.child.exitCode, recovered.output()).toBe(0)
    const parsed = JSON.parse(readFileSync(result, 'utf8')) as {
      sessionCount: number
      metrics: Record<string, number>
    }
    expect(parsed.sessionCount).toBe(20_000)
    expect(parsed.metrics).toMatchObject({
      queueDepth: 0,
      completedJobs: 1,
      failures: 0,
    })
  }, 60_000)
})

describe('real user-systemd recovery acceptance [spec:SP-c29e]', () => {
  it('restarts a progress-hung janitor with SIGKILL and stays healthy after recovery', async () => {
    const dir = makeRoot('podium-janitor-watchdog-')
    const harness = maintenanceHarness(dir)
    const instanceId = uniqueInstance('accw')
    const unit = instanceServiceName('janitor', instanceId)
    const startedFile = join(dir, 'watchdog.started')
    runUnit(
      unit,
      [
        'Type=notify',
        'NotifyAccess=all',
        'WatchdogSec=2s',
        'WatchdogSignal=SIGKILL',
        'Restart=always',
        'RestartSec=100ms',
      ],
      {
        PODIUM_ACCEPTANCE_SERVER_URL: harness.serverUrl,
        PODIUM_ACCEPTANCE_TOKEN: TOKEN,
        PODIUM_ACCEPTANCE_DB_PATH: harness.dbPath,
        PODIUM_ACCEPTANCE_TICK_MS: '250',
        PODIUM_ACCEPTANCE_STARTED_FILE: startedFile,
        PODIUM_STATE_DIR: dir,
      },
      [process.execPath, '--conditions=@podium/source', JANITOR_FIXTURE],
    )
    try {
      await waitUntil(() => existsSync(startedFile), 'watchdog janitor start')
      const firstPid = Number(systemctl(unit, 'MainPID'))
      expect(firstPid).toBeGreaterThan(0)

      const message = dueMessage('msg_watchdog_restart')
      const boundaryHit = harness.arm('after-apply-before-ack')
      harness.store.messages.addMessage(message)
      await Promise.race([
        boundaryHit,
        Bun.sleep(10_000).then(() => {
          throw new Error('janitor did not enter watchdog hang')
        }),
      ])
      expect(harness.store.messages.getMessage(message.id)?.status).toBe('expired')
      await waitUntil(
        () => {
          const pid = Number(systemctl(unit, 'MainPID'))
          return pid > 0 && pid !== firstPid
        },
        'systemd watchdog SIGKILL restart',
        15_000,
      )
      harness.release()
      const recoveredPid = Number(systemctl(unit, 'MainPID'))
      expect(recoveredPid).not.toBe(firstPid)
      expect(Number(systemctl(unit, 'NRestarts'))).toBeGreaterThanOrEqual(1)
      expect(expiredEventCount(harness.store, message.id)).toBe(1)
      await Bun.sleep(4_500)
      expect(Number(systemctl(unit, 'MainPID'))).toBe(recoveredPid)
      expect(systemctl(unit, 'ActiveState')).toBe('active')
    } finally {
      stopUnit(unit)
      harness.close()
    }
  }, 40_000)

  it('revives exit-78 only after a real maintenance schema catch-up', async () => {
    const dir = makeRoot('podium-janitor-compat-')
    const harness = maintenanceHarness(dir)
    const instanceId = uniqueInstance('accc')
    const unit = instanceServiceName('janitor', instanceId)
    const schemaFile = join(dir, 'schema-version')
    const readyFile = join(dir, 'compat.ready')
    writeFileSync(schemaFile, 'maintenance-v1')
    linkUnit(
      unit,
      dir,
      {
        PODIUM_ACCEPTANCE_SERVER_URL: harness.serverUrl,
        PODIUM_ACCEPTANCE_TOKEN: TOKEN,
        PODIUM_ACCEPTANCE_SCHEMA_FILE: schemaFile,
        PODIUM_ACCEPTANCE_READY_FILE: readyFile,
      },
      [process.execPath, '--conditions=@podium/source', COMPAT_FIXTURE],
    )
    try {
      await waitUntil(
        () =>
          systemctl(unit, 'ExecMainStatus') === '78' && systemctl(unit, 'ActiveState') === 'failed',
        'compatibility exit 78',
      )
      expect(existsSync(readyFile)).toBe(false)
      writeFileSync(schemaFile, MAINTENANCE_SCHEMA_VERSION)
      expect(readFileSync(schemaFile, 'utf8')).toBe(MAINTENANCE_SCHEMA_VERSION)
      expect(reviveCompatibilityBlockedJanitor(instanceId)).toBe(true)
      await waitUntil(() => existsSync(readyFile), 'compatibility unit revival')
      expect(readFileSync(readyFile, 'utf8')).toStartWith(MAINTENANCE_SCHEMA_VERSION + ':')
      expect(systemctl(unit, 'ActiveState')).toBe('active')
      expect(Number(systemctl(unit, 'MainPID'))).toBeGreaterThan(0)
    } finally {
      stopUnit(unit)
      harness.close()
    }
  }, 30_000)
})
