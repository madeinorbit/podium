/**
 * FULL-STACK proof for the parent-supervised topology [POD-2505].
 *
 * This file drives the REAL `scripts/cli.ts` — the real parent, the real server
 * with the janitor co-hosted, the real daemon, a real SQLite database — and
 * asserts exactly two things:
 *
 *   1. TOPOLOGY: parent + server (+ janitor) + daemon come up in priority order
 *      from the install invocation, and `/version` reports the components.
 *   2. HANDOVER + PROGRESS RESUME: a self-handover on the real stack completes —
 *      the old parent exits only after the successor is serving with its daemon
 *      connected — and an update operation left `running` in the database is
 *      ADOPTED by the successor's server and finished. Progress lives in the DB;
 *      the acceptance sentence is that the new server picks it up.
 *
 * The lifecycle guarantees that need many quick spawns and deaths — crash
 * restart with backoff, refusal staying parked, SIGTERM during boot reaping its
 * children, a doomed successor being killed — are proved against real processes
 * in scripts/parent-lifecycle.integration.test.ts, which uses a fixture stack so
 * each case costs a second rather than a minute.
 *
 * A VERSION-CHANGING handover is not provable here: a source-checkout server
 * bakes its version from PODIUM_APP_VERSION, which the successor inherits, so
 * both sides of the handover are the same version by construction. The
 * version-gate arm (successor must serve the NEW version before the old parent
 * exits) is the lifecycle suite's, where a bundle swap can be simulated by
 * rewriting VERSION.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../packages/runtime/src/sqlite'

const ROOT = join(import.meta.dirname, '..')
const CLI = join(ROOT, 'scripts/cli.ts')
const roots: string[] = []
const children: ChildProcess[] = []
/** Every pid this file has seen, so nothing it starts can outlive it. */
const observedPids = new Set<number>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function childrenOf(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
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

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  label: string,
  ms = 45_000,
): Promise<T> {
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

/**
 * Reap EVERYTHING, then fail on anything that ignored SIGTERM.
 *
 * The earlier version of this helper SIGKILLed the parent after 5s and never
 * looked at its grandchildren, so a leak in the code under test escaped as a
 * leak on the machine: two server+daemon stacks survived a run by 28 minutes.
 * Surviving a full SIGTERM grace is also the signature of review finding 18, so
 * it is asserted here rather than quietly cleaned up.
 */
afterEach(async () => {
  for (const child of children.splice(0)) if (child.pid) observedPids.add(child.pid)
  for (const pid of [...observedPids]) {
    if (alive(pid)) for (const kid of childrenOf(pid)) observedPids.add(kid)
  }
  for (const pid of observedPids) {
    if (!alive(pid)) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && [...observedPids].some(alive)) {
    await new Promise((r) => setTimeout(r, 150))
  }
  const stubborn = [...observedPids].filter(alive)
  for (const pid of stubborn) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  observedPids.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  expect(stubborn, `${stubborn.length} process(es) ignored SIGTERM`).toEqual([])
})

interface Stack {
  parent: ChildProcess
  parentPid: number
  stateDir: string
  port: number
  version: string
  output: () => string
}

async function bootStack(extraEnv: Record<string, string> = {}): Promise<Stack> {
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

  const inherited = { ...process.env }
  delete inherited.PODIUM_AGENT_RELAY
  delete inherited.NOTIFY_SOCKET
  const child = spawn('bun', ['--conditions=@podium/source', CLI, 'parent', '--takeover'], {
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
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  const parentPid = child.pid as number
  observedPids.add(parentPid)
  let output = ''
  child.stdout?.on('data', (chunk) => (output += String(chunk)))
  child.stderr?.on('data', (chunk) => (output += String(chunk)))
  return { parent: child, parentPid, stateDir, port, version, output: () => output }
}

interface VersionBody {
  appVersion?: string
  components?: {
    janitor?: { state?: string; progressVersion?: number }
    daemon?: { state?: string }
  }
  daemonConnected?: boolean
}

async function readVersion(port: number): Promise<VersionBody | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/version`)
  if (!response.ok) return undefined
  return (await response.json()) as VersionBody
}

/** Wait until the WHOLE stack is up: server on the version, local daemon connected. */
async function waitHealthy(stack: Stack): Promise<VersionBody> {
  return await waitFor(async () => {
    const body = await readVersion(stack.port)
    return body?.daemonConnected === true ? body : undefined
  }, `stack healthy; log:\n${stack.output()}`)
}

describe('parent-supervised stack', () => {
  it('boots parent → server → daemon with janitor lease and /version components', async () => {
    const stack = await bootStack()

    const serverVersion = await waitFor(
      async () => await readVersion(stack.port),
      'parent-supervised /version',
    )
    expect(serverVersion.appVersion).toBe(stack.version)

    const observed = await waitFor(async () => {
      const dbPath = join(stack.stateDir, 'podium.db')
      await readFile(dbPath)
      const db = openDatabase(dbPath, { readOnly: true })
      try {
        const lease = db
          .prepare(
            'SELECT generation_id, protocol_version, schema_version FROM maintenance_leases WHERE name = ?',
          )
          .get('janitor') as { generation_id: string } | undefined
        const parentRec = await readFile(join(stack.stateDir, 'run', 'parent.pid'), 'utf8').catch(
          () => undefined,
        )
        const serverRec = await readFile(join(stack.stateDir, 'run', 'server.pid'), 'utf8').catch(
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
    // The parent owns the record; the janitor has NO OS role of its own any more.
    expect(JSON.parse(observed.parentRec).pid).toBe(stack.parentPid)

    const healthy = await waitHealthy(stack)
    expect(healthy.components?.janitor?.state).toBe('running')
    expect(healthy.components?.daemon?.state).toBe('connected')
    expect(healthy.daemonConnected).toBe(true)
    // The janitor's advance token — what the parent's watchdog rule reads.
    expect(typeof healthy.components?.janitor?.progressVersion).toBe('number')

    expect(stack.parent.exitCode, stack.output()).toBeNull()
    // Two OS children, no more: the janitor is inside the server.
    expect(childrenOf(stack.parentPid)).toHaveLength(2)
  }, 90_000)

  it('hands over on the real stack, and the successor finishes an in-flight update operation', async () => {
    const stack = await bootStack()
    await waitHealthy(stack)
    const oldServerPid = Number(
      JSON.parse(await readFile(join(stack.stateDir, 'run', 'server.pid'), 'utf8')).pid,
    )
    observedPids.add(oldServerPid)

    /**
     * An update operation caught mid-flight: its `server` step is RUNNING and
     * nothing in this process will finish it. Only a server that boots, reads
     * the row and reconciles it against its own version can — which is the
     * acceptance sentence, and the reason progress lives in the database.
     */
    const now = Date.now()
    const operation = {
      id: 'op-handover-resume',
      kind: 'update',
      state: 'running' as const,
      exclusionGroup: 'lifecycle',
      createdAt: now,
      updatedAt: now,
      details: {
        target: { version: stack.version, critical: false, artifacts: {} },
        fromVersion: stack.version,
      },
      steps: [
        {
          id: 'server',
          state: 'running' as const,
          title: 'Updating your server',
          startedAt: now,
          attempts: 1,
        },
      ],
    }
    const db = openDatabase(join(stack.stateDir, 'podium.db'))
    try {
      db.exec('PRAGMA busy_timeout = 5000')
      db.prepare(
        `INSERT INTO operations
           (id, kind, exclusion_group, state, created_at, updated_at, finished_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        operation.id,
        operation.kind,
        operation.exclusionGroup,
        operation.state,
        operation.createdAt,
        operation.updatedAt,
        null,
        JSON.stringify(operation),
      )
    } finally {
      db.close()
    }

    // Ask the live parent to hand over. No supervisor is involved.
    const { writeParentRequest } = await import('../packages/runtime/src/parent-control')
    writeParentRequest(
      {
        requestId: 'stack-handover',
        kind: 'handover',
        expectedVersion: stack.version,
        requestedAt: new Date().toISOString(),
      },
      stack.stateDir,
    )
    process.kill(stack.parentPid, 'SIGUSR1')

    // The OLD parent exits — on its own terms, code 0, after the gate passed.
    await waitFor(
      async () => (stack.parent.exitCode !== null ? true : undefined),
      `old parent to exit after handover; log:\n${stack.output()}`,
      90_000,
    )
    expect(stack.parent.exitCode, stack.output()).toBe(0)

    // A successor owns the role, and it is NOT the parent that just exited.
    const successorPid = await waitFor(async () => {
      const record = await readFile(join(stack.stateDir, 'run', 'parent.pid'), 'utf8').catch(
        () => undefined,
      )
      if (!record) return undefined
      const pid = Number(JSON.parse(record).pid)
      return pid && pid !== stack.parentPid && alive(pid) ? pid : undefined
    }, 'successor parent to claim the role')
    observedPids.add(successorPid)
    for (const kid of childrenOf(successorPid)) observedPids.add(kid)

    // Serving again, with the local daemon connected: the successor's own gate.
    const after = await waitFor(async () => {
      const body = await readVersion(stack.port)
      return body?.daemonConnected === true ? body : undefined
    }, 'successor stack healthy')
    expect(after.appVersion).toBe(stack.version)

    /**
     * THE ACCEPTANCE SENTENCE: the in-flight operation resumes and completes
     * after the handover. `adoptOnBoot` re-enters the `server` step, which
     * observes the running version against the target and finishes it.
     */
    const finished = await waitFor(async () => {
      const readDb = openDatabase(join(stack.stateDir, 'podium.db'), { readOnly: true })
      try {
        const row = readDb
          .prepare('SELECT state, payload FROM operations WHERE id = ?')
          .get(operation.id) as { state: string; payload: string } | undefined
        return row && row.state !== 'running' ? row : undefined
      } finally {
        readDb.close()
      }
    }, 'the adopted operation to reach an outcome')

    expect(finished.state, `operation payload: ${finished.payload}`).toBe('done')
    const payload = JSON.parse(finished.payload) as {
      steps?: Array<{ id: string; state: string; detail?: string }>
    }
    const serverStep = payload.steps?.find((step) => step.id === 'server')
    expect(serverStep?.state, 'the resumed server step must finish').toBe('done')
  }, 120_000)
})
