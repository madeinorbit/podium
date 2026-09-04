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
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parentAvailable } from '../apps/server/src/modules/updates/installed-restart'
import {
  ensureInstanceStateIdentity,
  instanceInstallDir,
  instanceStateDir,
} from '../packages/runtime/src/instance'
import { openDatabase } from '../packages/runtime/src/sqlite'

const ROOT = join(import.meta.dirname, '..')
/**
 * `resolveDevArtifactOrigin` refuses a loopback origin on purpose — a dev feed
 * is advertised to other machines, and a loopback URL would send each of them
 * back to itself. So the no-click proof serves its feed on a real routable
 * address of this box. A box with none REPORTS A SKIP rather than passing
 * vacuously, which is the difference between a proof and a guard nobody can
 * tell has stopped running.
 */
const ROUTABLE_IPV4 = Object.values(networkInterfaces())
  .flatMap((entries) => entries ?? [])
  .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address
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
  home: string
  instanceId: string
  installDir: string
  stateDir: string
  port: number
  version: string
  output: () => string
}

async function bootStack(
  takeover: boolean,
  extraEnv: Record<string, string> = {},
  options?: { instanceId?: string; config?: Record<string, unknown> },
): Promise<Stack> {
  const root = await mkdtemp(join(tmpdir(), 'podium-parent-stack-'))
  roots.push(root)
  const home = join(root, 'home')
  const instanceId = options?.instanceId ?? (takeover ? 'supervised-takeover' : 'supervised-normal')
  const instanceEnv = { HOME: home, PODIUM_INSTANCE: instanceId }
  const stateDir = instanceStateDir(instanceId, instanceEnv)
  const installDir = instanceInstallDir(instanceId, instanceEnv)
  ensureInstanceStateIdentity({ instanceId, dir: stateDir, env: instanceEnv })
  const port = await freePort()
  const version = '0.1.0-parent-stack-proof'
  for (const site of ['web', 'mobile']) {
    const dir = join(installDir, site)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.html'), `<!doctype html><title>${site}</title>`)
    await writeFile(
      join(dir, 'podium-build.json'),
      JSON.stringify({ appVersion: version, sourceSha: 'abc1234' }),
    )
  }
  await writeFile(
    join(stateDir, 'config.json'),
    JSON.stringify({ mode: 'all-in-one', port, persistence: 'detached', ...options?.config }),
  )
  await writeFile(join(installDir, 'VERSION'), `${version}\n`)

  const inherited = { ...process.env }
  delete inherited.PODIUM_AGENT_RELAY
  delete inherited.PODIUM_STATE_DIR
  delete inherited.NOTIFY_SOCKET
  const args = ['--conditions=@podium/source', CLI, 'parent', ...(takeover ? ['--takeover'] : [])]
  const child = spawn('bun', args, {
    cwd: ROOT,
    env: {
      ...inherited,
      HOME: home,
      PODIUM_INSTANCE: instanceId,
      PODIUM_PORT: String(port),
      PODIUM_HOME: installDir,
      PODIUM_WEB_DIR: join(installDir, 'web'),
      PODIUM_MOBILE_WEB_DIR: join(installDir, 'mobile'),
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
  return {
    parent: child,
    parentPid,
    home,
    instanceId,
    installDir,
    stateDir,
    port,
    version,
    output: () => output,
  }
}

interface VersionBody {
  appVersion?: string
  target?: { version?: string }
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
    return body?.daemonConnected === true &&
      body.components?.daemon?.state === 'connected' &&
      body.components?.janitor?.state === 'running'
      ? body
      : undefined
  }, `stack healthy; log:\n${stack.output()}`)
}

/** Run the server participant's real capability probe against this named instance. */
function participantCanResolveParent(stack: Stack): boolean {
  const prior = {
    home: process.env.HOME,
    instance: process.env.PODIUM_INSTANCE,
    stateDir: process.env.PODIUM_STATE_DIR,
  }
  process.env.HOME = stack.home
  process.env.PODIUM_INSTANCE = stack.instanceId
  delete process.env.PODIUM_STATE_DIR
  try {
    return parentAvailable()
  } finally {
    if (prior.home === undefined) delete process.env.HOME
    else process.env.HOME = prior.home
    if (prior.instance === undefined) delete process.env.PODIUM_INSTANCE
    else process.env.PODIUM_INSTANCE = prior.instance
    if (prior.stateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = prior.stateDir
  }
}

describe('parent-supervised stack', () => {
  it.each([
    { label: 'normal', takeover: false },
    { label: 'takeover', takeover: true },
  ])('discovers every supervised role after a $label boot', { retry: 0, timeout: 60_000 }, async ({
    takeover,
  }) => {
    const stack = await bootStack(takeover)

    const serverVersion = await waitFor(
      async () => await readVersion(stack.port),
      'parent-supervised /version',
    )
    expect(serverVersion.appVersion).toBe(stack.version)

    const observed = await waitFor(
      async () => {
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
          const daemonRec = await readFile(join(stack.stateDir, 'run', 'daemon.pid'), 'utf8').catch(
            () => undefined,
          )
          if (lease && parentRec && serverRec && daemonRec) {
            return { lease, parentRec, serverRec, daemonRec }
          }
          throw new Error(
            `missing lease=${!lease} parent=${!parentRec} server=${!serverRec} daemon=${!daemonRec}; ` +
              `log:\n${stack.output()}`,
          )
        } finally {
          db.close()
        }
      },
      'parent+server+daemon pidfiles and janitor lease',
      15_000,
    )

    expect(observed.lease.generation_id).toMatch(/^janitor_/)
    const records = [observed.parentRec, observed.serverRec, observed.daemonRec].map((record) =>
      JSON.parse(record),
    ) as Array<{ role: string; pid: number }>
    expect(records.map((record) => record.role)).toEqual(['parent', 'server', 'daemon'])
    expect(records.every((record) => alive(record.pid))).toBe(true)
    // The parent owns the record; the janitor has NO OS role of its own any more.
    expect(records[0]?.pid).toBe(stack.parentPid)
    expect(
      await readFile(join(stack.stateDir, 'run', 'janitor.pid'), 'utf8').catch(() => undefined),
    ).toBeUndefined()
    expect(participantCanResolveParent(stack)).toBe(true)

    const healthy = await waitHealthy(stack)
    expect(healthy.components?.janitor?.state).toBe('running')
    expect(healthy.components?.daemon?.state).toBe('connected')
    expect(healthy.daemonConnected).toBe(true)
    // The janitor's advance token — what the parent's watchdog rule reads.
    expect(typeof healthy.components?.janitor?.progressVersion).toBe('number')

    expect(stack.parent.exitCode, stack.output()).toBeNull()
    // Two OS children, no more: the janitor is inside the server.
    expect(childrenOf(stack.parentPid)).toHaveLength(2)
  })

  it('hands over on the real stack, and the successor finishes an in-flight update operation', async () => {
    const stack = await bootStack(true)
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

  /**
   * THE NO-CLICK PUBLICATION OBSERVATION, ON REAL PROCESSES (POD-2907).
   *
   * The hermetic proofs drive the service, the reconciler and the local
   * participant directly. This one drives none of them: it boots the real
   * parent + server + daemon, puts a REAL newer target on the coordinator's own
   * channel through the real feed resolver, and then does nothing at all.
   *
   * The stack is this host's shape — an INSTALLED coordinator that also
   * publishes (`PODIUM_APP_VERSION` set, so `runningFromSource` is false, plus
   * `PODIUM_DEV_SOURCE_ROOT`, so a dev feed exists). That is what makes its own
   * machine row `installed`, feed-capable, online and, the moment this feed
   * resolves, behind — the exact four facts the standing reconciliation reads.
   * The local daemon attaches under the host's own machine id, which is the
   * `machine.connected` that woke it on 2026-08-31.
   *
   * WHAT IS OBSERVED FROM OUTSIDE, and deliberately nothing internal:
   *   - `/version` reports the newer target, so the publication really landed;
   *   - the parent never reports a successor pid and the parent record never
   *     changes, so no handover was requested;
   *   - the server says why, in one line a journal keeps.
   *
   * The armed control is not run here, because it cannot be: the guard is in
   * the binary this spawns. It is armed in `coordinator-convergence.test.ts`
   * and in the no-click publication proof in `named-dev-release`, both of which
   * restart the coordinator when the fleet row does not say which machine it is.
   */
  it.skipIf(!ROUTABLE_IPV4)(
    'a newer target on the coordinator’s own channel does not restart it',
    async () => {
      const routable = ROUTABLE_IPV4
      if (!routable) throw new Error('unreachable: this case is skipped without a routable address')
      const feedVersion = '0.9.9-no-click-proof'
      /** The feed this server will pull from. A publication, with nobody clicking. */
      const feed = createHttpServer()
      const feedPort = await new Promise<number>((resolve, reject) => {
        feed.once('error', reject)
        feed.listen(0, routable, () => {
          const address = feed.address()
          if (!address || typeof address === 'string') return reject(new Error('no feed port'))
          resolve(address.port)
        })
      })
      const feedOrigin = `http://${routable}:${feedPort}`
      const artifactPath = `/updates/feed/dev/artifact/${feedVersion}/linux-x86_64`
      const manifest = JSON.stringify({
        version: feedVersion,
        critical: false,
        artifacts: {
          headless: {
            delivery: 'feed',
            platforms: {
              'linux-x86_64': {
                url: `${feedOrigin}${artifactPath}`,
                digest: 'sha256-no-click-proof',
                signature: 'no-click-signature',
              },
            },
          },
        },
      })
      const feedHits: string[] = []
      feed.on('request', (request, response) => {
        const url = request.url ?? ''
        feedHits.push(`${request.method} ${url}`)
        if (url.startsWith('/updates/feed/dev/podium-update.json')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(manifest)
          return
        }
        // The resolver HEAD-probes every artifact it is about to advertise.
        if (url.startsWith(artifactPath)) {
          response.writeHead(200, { 'content-length': '1' })
          response.end(request.method === 'HEAD' ? undefined : 'x')
          return
        }
        response.writeHead(404)
        response.end()
      })

      // A checkout for the publisher to exist against; it mints nothing here.
      const sourceRoot = await mkdtemp(join(tmpdir(), 'podium-no-click-source-'))
      roots.push(sourceRoot)

      let stack: Stack
      try {
        stack = await bootStack(
          true,
          {
            PODIUM_DEV_SOURCE_ROOT: sourceRoot,
            PODIUM_DEV_ARTIFACT_BASE_URL: feedOrigin,
            PODIUM_UPDATE_CHANNEL: 'dev',
          },
          { instanceId: 'supervised-no-click', config: { updateChannel: 'dev' } },
        )
        try {
          await waitFor(
            async () => {
              const body = await readVersion(stack.port)
              return body?.daemonConnected === true &&
                body.components?.daemon?.state === 'connected' &&
                body.components?.janitor?.state === 'running'
                ? body
                : undefined
            },
            'stack healthy',
            60_000,
          )
        } catch (error) {
          // The label is built before the wait, so it can never carry the log the
          // reader needs. Re-throw with the output as it stands NOW.
          throw new Error(`${String(error)}\nstack log:\n${stack.output()}`)
        }

        // 1. THE PUBLICATION LANDED. Boot resolved it; nobody clicked anything.
        /**
         * The parent writes each child to `<state>/logs/<role>.log` (its stdout
         * is the parent's own log under detached persistence), so the SERVER's
         * evidence is a file rather than this process's pipe.
         */
        const serverLog = async (): Promise<string> =>
          await readFile(join(stack.stateDir, 'logs', 'server.log'), 'utf8').catch(() => '')
        const resolved = await waitFor(
          async () => {
            const body = await readVersion(stack.port)
            return body?.target?.version === feedVersion ? body : undefined
          },
          'the dev target to resolve',
          30_000,
        ).catch(async (error) => {
          throw new Error(
            `${String(error)}\nfeed hits: ${JSON.stringify(feedHits)}\nserver log:\n${await serverLog()}`,
          )
        })
        expect(resolved.appVersion).toBe(stack.version)
        expect(resolved.target?.version).toBe(feedVersion)

        const parentRecordBefore = await readFile(join(stack.stateDir, 'run', 'parent.pid'), 'utf8')
        /** This host's own machine id, as the server's own attach line reports it. */
        const machineId = /daemon attached — the machine is now online machineId=(\S+)/.exec(
          await serverLog(),
        )?.[1]
        if (!machineId) throw new Error(`no daemon attach line yet:\n${await serverLog()}`)

        /**
         * 2. THE WAKING EDGE, for real: bounce the local daemon so it reattaches
         *    under this host's machine id. That reconnect IS what the reconciler
         *    listens to, and on 2026-08-31 it was the last thing before the
         *    successor.
         */
        const daemonPid = Number(
          JSON.parse(await readFile(join(stack.stateDir, 'run', 'daemon.pid'), 'utf8')).pid,
        )
        observedPids.add(daemonPid)
        process.kill(daemonPid, 'SIGTERM')
        await waitFor(
          async () => {
            const body = await readVersion(stack.port)
            return body?.daemonConnected === true &&
              Number(
                JSON.parse(await readFile(join(stack.stateDir, 'run', 'daemon.pid'), 'utf8')).pid,
              ) !== daemonPid
              ? true
              : undefined
          },
          `the local daemon to reattach; log:\n${stack.output()}`,
          60_000,
        )

        /**
         * 3. …AND THE SERVER SAID SO, in the one line a journal keeps — NAMING
         *    THE TARGET, which is what makes this observation non-vacuous. A
         *    refusal carrying `targetVersion=undefined` would be the reconciler
         *    declining a machine with nothing to converge to, which proves
         *    nothing at all; this one is the coordinator being held back from a
         *    release it really is behind.
         */
        await waitFor(
          async () =>
            (await serverLog()).includes(
              `reconciler left this coordinator alone — a handover needs an update operation ` +
                `machineId=${machineId} targetVersion=${feedVersion}`,
            )
              ? true
              : undefined,
          'the coordinator refusal to name this target',
          30_000,
        ).catch(async (error) => {
          throw new Error(`${String(error)}\nserver log:\n${await serverLog()}`)
        })

        // 4. NOTHING HAPPENED TO THIS SERVER. No successor, no grant, no handover.
        const log = await serverLog()
        expect(stack.output(), stack.output()).not.toContain('successor pid')
        expect(log, log).not.toContain('update grant issued')
        expect(await readFile(join(stack.stateDir, 'run', 'parent.pid'), 'utf8')).toBe(
          parentRecordBefore,
        )
        expect(stack.parent.exitCode, stack.output()).toBeNull()
        const still = await readVersion(stack.port)
        expect(still?.appVersion).toBe(stack.version)
      } finally {
        await new Promise<void>((resolve) => feed.close(() => resolve()))
      }
    },
    180_000,
  )
})
