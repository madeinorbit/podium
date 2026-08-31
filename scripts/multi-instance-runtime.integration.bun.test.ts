/**
 * Process-level acceptance proof for independent Podium instances [spec:SP-15aa].
 * Starts two real all-in-one runtimes and exercises their public CLI and APIs.
 *
 * Run: bun test --conditions=@podium/source ./scripts/multi-instance-runtime.integration.bun.test.ts
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { FIRST_ADMIN_USER_ID, asMachineId, asSessionId } from '@podium/model'
import { SESSION_COOKIE } from '@podium/protocol'
import {
  abducoSocketPath,
  killAbducoSession,
  resolveAbducoBin,
  spawnAbducoAgent,
} from '@podium/pty'
import {
  abducoSocketPathname,
  applyInstanceRuntimeEnv,
  durableSessionLabel,
  instanceSocketRuntimeDir,
  LINUX_UNIX_SOCKET_PATH_BYTES,
} from '@podium/runtime/instance'
import { encodeJoin } from '@podium/runtime/join'
import { openDatabase } from '@podium/runtime/sqlite'
import type { AppRouter } from '../apps/server/src/router'
import { machineFileKey } from '../apps/server/src/modules/logs/fleet-store'
import { SessionStore } from '../apps/server/src/store'
import { buildVendoredAbduco } from '../packages/pty/src/abduco-bin'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'scripts', 'cli.ts')
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'podium-multi-instance-'))
const RUNTIME_BIN = join(TEST_ROOT, 'bin')
mkdirSync(RUNTIME_BIN)
const git = Bun.which('git')
if (git) symlinkSync(git, join(RUNTIME_BIN, 'git'))

interface InstanceSpec {
  id: 'default' | 'blue'
  stateDir: string
  agentHome: string
  webDir: string
  port: number
  hookPort: number
  relayPort: number
}
interface RunningInstance extends InstanceSpec {
  child: ChildProcess
  output(): string
}
const running: RunningInstance[] = []
let packagedCli: string | undefined
const packagedSpecs: Array<{ executable: string; spec: InstanceSpec }> = []
let packagedSource: RunningInstance | undefined

const allocatedPorts = new Set<number>()
const freePort = (): number => {
  while (true) {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('reserved'),
    })
    const port = server.port
    server.stop(true)
    // Throw rather than `continue`: a listening socket that reports no port is a
    // broken assumption, and retrying it would spin this loop forever.
    if (port === undefined) throw new Error('Bun.serve reported no port for a bound socket')
    if (!allocatedPorts.has(port)) {
      allocatedPorts.add(port)
      return port
    }
  }
}

function makeSpec(id: InstanceSpec['id'], rootTag: string = id): InstanceSpec {
  const webDir = join(TEST_ROOT, `${rootTag}-web`)
  const agentHome = join(TEST_ROOT, `${rootTag}-agent-home`)
  mkdirSync(webDir, { recursive: true })
  mkdirSync(agentHome, { recursive: true })
  return {
    id,
    stateDir: join(TEST_ROOT, `${rootTag}-state`),
    agentHome,
    webDir,
    port: freePort(),
    hookPort: freePort(),
    relayPort: freePort(),
  }
}

function seedLegacyNamedState(spec: InstanceSpec): void {
  mkdirSync(spec.stateDir, { recursive: true })
  const path = join(spec.stateDir, 'podium.db')
  new SessionStore(path, asMachineId('00000000-0000-4000-8000-000000000734')).close()
  const db = openDatabase(path)
  db.prepare('DELETE FROM machines').run()
  db.prepare(
    `INSERT INTO machines
      (id, name, hostname, token_hash, created_at, last_seen_at, owner_user_id)
      VALUES ('local', 'legacy-host', 'legacy-host', 'legacy-token', 't', 't', NULL)`,
  ).run()
  db.close()
}

function instanceEnv(
  spec: InstanceSpec,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'PODIUM_AGENT_RELAY',
    'PODIUM_ISSUE_RELAY',
    'PODIUM_SESSION_ID',
    'PODIUM_SESSION_INSTANCE',
    'PODIUM_HOME',
    'NOTIFY_SOCKET',
    'ABDUCO_SOCKET_DIR',
    'TMUX_TMPDIR',
  ])
    delete env[key]
  Object.assign(env, {
    PODIUM_INSTANCE: spec.id,
    PODIUM_STATE_DIR: spec.stateDir,
    PODIUM_AGENT_HOME: spec.agentHome,
    PODIUM_WEB_DIR: spec.webDir,
    PODIUM_PORT: String(spec.port),
    PODIUM_HOOK_PORT: String(spec.hookPort),
    PODIUM_AGENT_RELAY_PORT: String(spec.relayPort),
    PODIUM_HOST: '127.0.0.1',
    PODIUM_NO_RELAY: '1',
    PODIUM_ABDUCO: join(TEST_ROOT, 'missing-abduco'),
    PODIUM_NO_SCOPE: '1',
    PODIUM_PTY_BACKEND: 'bun-terminal',
    PATH: RUNTIME_BIN,
    SHELL: '/bin/bash',
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/** Compile the real packaged entry in an isolated tree so its fixed embedded-file
 *  path cannot race with or depend on a developer's dist-bun artifacts. */
function buildPackagedCli(): string {
  if (packagedCli) return packagedCli
  const buildRoot = join(TEST_ROOT, 'compiled-cli-build')
  const scriptsDir = join(buildRoot, 'scripts')
  const distDir = join(buildRoot, 'dist-bun')
  mkdirSync(scriptsDir, { recursive: true })
  mkdirSync(distDir, { recursive: true })
  for (const file of ['cli-compiled.ts', 'cli.ts', 'embedded-abduco.ts']) {
    cpSync(join(ROOT, 'scripts', file), join(scriptsDir, file))
  }
  for (const dir of ['apps', 'packages', 'node_modules']) {
    symlinkSync(join(ROOT, dir), join(buildRoot, dir), 'dir')
  }

  const embeddedAbduco = join(distDir, 'abduco.bin')
  expect(buildVendoredAbduco(embeddedAbduco)).toBe(embeddedAbduco)
  const executable = join(buildRoot, 'podium-cli')
  execFileSync(
    process.execPath,
    [
      'build',
      '--compile',
      '--conditions=@podium/source',
      '--define',
      'process.env.PODIUM_APP_VERSION="9.9.9"',
      join(scriptsDir, 'cli-compiled.ts'),
      join(buildRoot, 'apps/daemon/src/discovery-worker.ts'),
      '--outfile',
      executable,
    ],
    { cwd: buildRoot, stdio: 'pipe' },
  )
  packagedCli = executable
  return packagedCli
}

function startInstance(
  spec: InstanceSpec,
  overrides: Record<string, string | undefined> = {},
): RunningInstance {
  // This lane proves independent configured deployments, not first-run setup.
  // Say so explicitly now that an unconfigured process intentionally withholds
  // the operator data plane.
  mkdirSync(spec.stateDir, { recursive: true })
  const configFile = join(spec.stateDir, 'config.json')
  const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
  writeFileSync(configFile, JSON.stringify({ ...config, mode: 'all-in-one' }))
  const child = spawn(
    process.execPath,
    ['--conditions=@podium/source', CLI, '--instance', spec.id, 'all'],
    { cwd: ROOT, env: instanceEnv(spec, overrides), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    output += String(chunk)
  })
  child.once('exit', (code, signal) => {
    if (code && code !== 0) console.error(`${spec.id} exited ${code}/${signal}: ${output}`)
  })
  const result = { ...spec, child, output: () => output }
  running.push(result)
  return result
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      const diagnostics = running
        .map((instance) => `${instance.id} pid=${instance.child.pid}:\n${instance.output()}`)
        .join('\n')
      throw new Error(`timed out waiting for ${label}\n${diagnostics}`)
    }
    await Bun.sleep(50)
  }
}

async function version(spec: InstanceSpec): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${spec.port}/version`)
    return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
async function endpointIsListening(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`)).status === 404
  } catch {
    return false
  }
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}
async function runCli(
  spec: InstanceSpec,
  args: string[],
  overrides: Record<string, string | undefined> = {},
): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ['--conditions=@podium/source', CLI, '--instance', spec.id, ...args],
    { cwd: ROOT, env: instanceEnv(spec, overrides), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const code = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`CLI timed out: ${args.join(' ')}`))
    }, 20_000)
    child.once('error', reject)
    child.once('exit', (value) => {
      clearTimeout(timeout)
      resolve(value ?? 1)
    })
  })
  return { code, stdout, stderr }
}

async function runPackagedCli(
  executable: string,
  spec: InstanceSpec,
  args: string[],
): Promise<CliResult> {
  const child = spawn(executable, args, {
    // A packaged executable must not depend on being launched from the checkout.
    cwd: TEST_ROOT,
    env: instanceEnv(spec, { PODIUM_APP_VERSION: undefined }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const code = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`packaged CLI timed out: ${args.join(' ')}`))
    }, 90_000)
    child.once('error', reject)
    child.once('exit', (value) => {
      clearTimeout(timeout)
      resolve(value ?? 1)
    })
  })
  return { code, stdout, stderr }
}

function packagedDiagnostics(spec: InstanceSpec): string {
  const files = [
    'config.json',
    'connectivity.json',
    'logs/parent.log',
    'logs/daemon.log',
    'logs/parent.ndjson',
    'logs/daemon.ndjson',
    'run/parent.pid',
    'run/daemon.pid',
  ]
  return files
    .map((relative) => {
      const path = join(spec.stateDir, relative)
      return existsSync(path)
        ? `--- ${relative} ---\n${readFileSync(path, 'utf8')}`
        : `--- ${relative}: missing ---`
    })
    .join('\n')
}

function jsonOutput(result: CliResult): { data?: unknown } {
  const line = result.stdout
    .trim()
    .split('\n')
    .findLast((candidate) => candidate.startsWith('{'))
  if (!line) throw new Error(`missing JSON output: ${result.stdout} ${result.stderr}`)
  return JSON.parse(line) as { data?: unknown }
}
function trpc(spec: InstanceSpec, cookie?: string): ReturnType<typeof createTRPCClient<AppRouter>> {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${spec.port}/trpc`,
        ...(cookie ? { headers: { cookie } } : {}),
      }),
    ],
  })
}

async function packagedCoordinator(): Promise<RunningInstance> {
  if (!packagedSource) {
    packagedSource = startInstance(makeSpec('default', 'packaged-join-source'))
    await waitUntil(
      async () => (await version(packagedSource!))?.instanceId === 'default',
      'packaged join source',
    )
  }
  return packagedSource
}

afterAll(async () => {
  for (const { executable, spec } of packagedSpecs) {
    await runPackagedCli(executable, spec, ['stop']).catch(() => {})
  }
  for (const instance of running) {
    if (instance.child.exitCode === null && instance.child.signalCode === null) {
      instance.child.kill('SIGKILL')
      await new Promise<void>((resolve) => instance.child.once('exit', () => resolve()))
    }
  }
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('long instance durable sockets', () => {
  it('arms the old overflow, starts a real bounded session, and refuses an impossible override', async () => {
    const bin = resolveAbducoBin({ fresh: true })
    if (!bin) throw new Error('multi-instance acceptance requires abduco')

    const instanceId = `update-e2e-${'x'.repeat(21)}`
    const sessionId = asSessionId(randomUUID())
    const oldLabel = `podium-${instanceId}-${sessionId}`
    const socketTestRoot = mkdtempSync('/tmp/podium-mi-socket-')
    const stateDir = join(socketTestRoot, instanceId, 'state')
    const oldSocketDir = join(stateDir, 'runtime', 'abduco')
    const impossibleDir = join('/tmp', `podium-refusal-${process.pid}-${'x'.repeat(28)}`)
    mkdirSync(oldSocketDir, { recursive: true })
    const oldPath = abducoSocketPathname(
      oldSocketDir,
      oldLabel,
      userInfo().username,
      hostname(),
    )
    expect(Buffer.byteLength(oldPath)).toBeGreaterThan(LINUX_UNIX_SOCKET_PATH_BYTES)

    const previous = {
      PODIUM_INSTANCE: process.env.PODIUM_INSTANCE,
      PODIUM_STATE_DIR: process.env.PODIUM_STATE_DIR,
      PODIUM_ABDUCO: process.env.PODIUM_ABDUCO,
      ABDUCO_SOCKET_DIR: process.env.ABDUCO_SOCKET_DIR,
      TMUX_TMPDIR: process.env.TMUX_TMPDIR,
      PODIUM_NO_SCOPE: process.env.PODIUM_NO_SCOPE,
    }
    const restore = () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    let session: Awaited<ReturnType<typeof spawnAbducoAgent>> | undefined
    let label: string | undefined
    try {
      // ABDUCO_SOCKET_DIR is only abduco's first candidate. If it cannot bind there,
      // the native tool silently falls through HOME, TMPDIR, and /tmp, so a relative
      // label cannot force this negative control. An absolute name has no fallback and
      // proves the legacy pathname itself exceeds sun_path before the bounded product
      // derivation below is allowed to succeed.
      const old = spawnSync(bin, ['-n', oldPath, '/bin/true'], {
        env: { ...process.env, PODIUM_NO_SCOPE: '1' },
        encoding: 'utf8',
      })
      expect(old.status).not.toBe(0)
      expect(old.stderr).toMatch(/File name too long|Filename too long/)

      process.env.PODIUM_INSTANCE = instanceId
      process.env.PODIUM_STATE_DIR = stateDir
      process.env.PODIUM_ABDUCO = bin
      delete process.env.ABDUCO_SOCKET_DIR
      delete process.env.TMUX_TMPDIR
      process.env.PODIUM_NO_SCOPE = '1'
      applyInstanceRuntimeEnv(instanceId, process.env, stateDir)
      label = durableSessionLabel(sessionId, instanceId)
      expect(process.env.ABDUCO_SOCKET_DIR).toMatch(/^\/tmp\/pd-[A-Za-z0-9_-]{10}$/)

      session = await spawnAbducoAgent({
        label,
        cmd: '/bin/sh',
        args: ['-c', 'sleep 30'],
        cols: 80,
        rows: 24,
      })
      expect(abducoSocketPath(label, process.env)).toBeDefined()
      session.dispose()
      session = undefined
      await killAbducoSession(label)

      mkdirSync(impossibleDir, { recursive: true })
      const impossiblePath = abducoSocketPathname(
        impossibleDir,
        label,
        userInfo().username,
        hostname(),
      )
      expect(Buffer.byteLength(impossiblePath)).toBeGreaterThan(LINUX_UNIX_SOCKET_PATH_BYTES)
      const raw = spawnSync(bin, ['-n', impossiblePath, '/bin/true'], {
        env: { ...process.env, PODIUM_NO_SCOPE: '1' },
        encoding: 'utf8',
      })
      expect(raw.status).not.toBe(0)
      expect(raw.stderr).toMatch(/File name too long|Filename too long/)

      await expect(
        spawnAbducoAgent({
          label,
          cmd: '/bin/true',
          cols: 80,
          rows: 24,
          env: { ABDUCO_SOCKET_DIR: impossibleDir, PODIUM_INSTANCE: instanceId },
        }),
      ).rejects.toThrow(
        new RegExp(
          `instance '${instanceId}'.*Linux sun_path \\(108 bytes.*107 pathname bytes usable\\)`,
        ),
      )
    } finally {
      session?.dispose()
      if (label) await killAbducoSession(label)
      restore()
      rmSync(impossibleDir, { recursive: true, force: true })
      rmSync(socketTestRoot, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('multi-instance runtime isolation', () => {
  it('keeps packaged diagnostics state-free while foreign roots still refuse mutation', () => {
    const foreign = makeSpec('blue', 'foreign-blue')
    mkdirSync(foreign.stateDir, { recursive: true })
    writeFileSync(join(foreign.stateDir, 'belongs-to-something-else'), 'foreign state\n')
    const executable = buildPackagedCli()
    const run = (argv: string[]) =>
      spawnSync(executable, argv, {
        cwd: ROOT,
        env: instanceEnv(foreign, {
          PODIUM_ABDUCO: undefined,
          PODIUM_ADOPT_STATE: undefined,
          PODIUM_APP_VERSION: '9.9.9',
          PODIUM_RUN_MODE: 'detached',
        }),
        encoding: 'utf8',
      })

    const versionResult = run(['--version'])
    expect(versionResult.status, versionResult.stderr).toBe(0)
    expect(versionResult.stdout.trim()).toBe('podium 9.9.9')

    const helpResult = run(['--help'])
    expect(helpResult.status, helpResult.stderr).toBe(0)
    expect(helpResult.stdout).toContain('Usage: podium [command] [--flags]')

    // Neither diagnostic may claim or otherwise populate the foreign root, including
    // the packaged entry's embedded-abduco initialization.
    expect(existsSync(join(foreign.stateDir, 'instance.json'))).toBe(false)
    expect(existsSync(join(foreign.stateDir, 'bin', 'abduco'))).toBe(false)

    const mutation = run(['channel', 'edge'])
    expect(mutation.status).toBe(2)
    expect(mutation.stderr).toContain('refusing to adopt non-empty state directory')
    expect(mutation.stderr).toContain("for instance 'blue'")
    expect(existsSync(join(foreign.stateDir, 'instance.json'))).toBe(false)
    expect(existsSync(join(foreign.stateDir, 'config.json'))).toBe(false)
  })
  it('accepts a legitimate daemon from the compiled packaged join path', async () => {
    const source = await packagedCoordinator()
    const sourceApi = trpc(source)
    const pairing = await sourceApi.machines.pairingCode.mutate()
    const fleet = makeSpec('blue', 'packaged-accepted-member')
    const executable = buildPackagedCli()
    packagedSpecs.push({ executable, spec: fleet })
    const token = encodeJoin({
      v: 1,
      serverUrl: `ws://127.0.0.1:${source.port}`,
      pairCode: pairing.code,
    })

    const joined = await runPackagedCli(executable, fleet, [
      'setup',
      '--join',
      token,
      '--persist',
      'detached',
    ])

    expect(joined.code, `${joined.stdout}\n${joined.stderr}\n${packagedDiagnostics(fleet)}`).toBe(0)
    expect(joined.stdout).toContain('podium joined as')
    const identity = JSON.parse(readFileSync(join(fleet.stateDir, 'daemon.json'), 'utf8')) as {
      machineId: string
      token?: string
    }
    expect(identity.token).toBeTruthy()
    await waitUntil(
      async () =>
        (await sourceApi.machines.list.query()).some(
          (machine) => machine.id === identity.machineId && machine.online,
        ),
      'compiled packaged daemon enrollment',
    )
    expect(
      JSON.parse(readFileSync(join(fleet.stateDir, 'connectivity.json'), 'utf8')),
    ).toMatchObject({
      state: 'connected',
    })
  }, 120_000)

  /**
   * FLEET DAEMON LOG CAPTURE, ACROSS THE SOCKET (POD-3156).
   *
   * The hermetic roundtrip in `apps/server/src/modules/logs/` drives every
   * schema, table and filename rule in this path, and deliberately stops at the
   * socket. This is the half it cannot hold: TWO INDEPENDENT RUNTIMES — a
   * coordinator and a separately-installed, separately-stated daemon that
   * enrolled with a real pair code over a real WebSocket — where the machine the
   * records are filed under is one the SERVER AUTHENTICATED rather than one a
   * test injected.
   *
   * It is the multi-instance lane rather than a unit test for the reason
   * docs/multi-instance.md gives: an acceptance about separate deployments has
   * to start separate deployments, and multiple clients routed to one runtime
   * would prove the opposite of what is claimed.
   */
  it('raises a joined remote daemon from the coordinator and keeps its records centrally', async () => {
    const source = await packagedCoordinator()
    const sourceApi = trpc(source)
    const pairing = await sourceApi.machines.pairingCode.mutate()
    const fleet = makeSpec('blue', 'packaged-log-capture-member')
    const executable = buildPackagedCli()
    packagedSpecs.push({ executable, spec: fleet })
    const token = encodeJoin({
      v: 1,
      serverUrl: `ws://127.0.0.1:${source.port}`,
      pairCode: pairing.code,
    })

    const joined = await runPackagedCli(executable, fleet, [
      'setup',
      '--join',
      token,
      '--persist',
      'detached',
    ])
    expect(joined.code, `${joined.stdout}\n${joined.stderr}\n${packagedDiagnostics(fleet)}`).toBe(0)
    const identity = JSON.parse(readFileSync(join(fleet.stateDir, 'daemon.json'), 'utf8')) as {
      machineId: string
    }
    await waitUntil(
      async () =>
        (await sourceApi.machines.list.query()).some(
          (machine) => machine.id === identity.machineId && machine.online,
        ),
      'remote daemon enrollment for log capture',
    )

    // The file is named by the same rule the server files under, imported rather
    // than restated — a test that derived the name its own way could pass while
    // the operator's `podium logs fleet-<machine>` looked in the wrong place.
    const fleetFile = join(
      source.stateDir,
      'logs',
      'fleet',
      `${machineFileKey(identity.machineId)}.ndjson`,
    )
    const central = (): string => (existsSync(fleetFile) ? readFileSync(fleetFile, 'utf8') : '')

    // DEFAULT CLOSED. An enrolled, connected, actively-logging daemon has sent
    // nothing, because nobody asked it to.
    expect(existsSync(fleetFile)).toBe(false)

    const raised = await sourceApi.logs.setDaemonLevel.mutate({
      level: 'debug',
      ttlMs: 600_000,
      target: { machineId: identity.machineId },
    })
    expect(raised.daemons.map((d) => String(d.machineId))).toEqual([identity.machineId])

    await waitUntil(
      () => central().includes('daemon log level raised'),
      'the raised daemon’s records reaching the coordinator',
    )

    const records = central()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    // FILED UNDER THE AUTHENTICATED MACHINE, every one of them. The frame carries
    // no machine field at all; this is the server's own answer on disk.
    expect(records.length).toBeGreaterThan(0)
    expect(records.every((r) => r.machineId === identity.machineId)).toBe(true)
    // The raise ships what the daemon had already recorded, so the central file
    // starts before the operator's command rather than at it.
    expect(records.some((r) => String(r.ns).startsWith('daemon'))).toBe(true)

    // AND THE WAY BACK, in the same file, which is what tells a later reader
    // that the stream stopping was an expiry rather than a dead machine.
    await sourceApi.logs.setDaemonLevel.mutate({
      level: null,
      target: { machineId: identity.machineId },
    })
    await waitUntil(
      () => central().includes('daemon log level restored'),
      'the reset reaching the remote daemon',
    )
  }, 180_000)

  it('returns nonzero with the auth reason when packaged join is rejected', async () => {
    const source = await packagedCoordinator()
    const fleet = makeSpec('blue', 'packaged-rejected-member')
    const executable = buildPackagedCli()
    packagedSpecs.push({ executable, spec: fleet })
    const token = encodeJoin({
      v: 1,
      serverUrl: `ws://127.0.0.1:${source.port}`,
      pairCode: 'not-a-valid-pair-code-00000000',
    })

    const rejected = await runPackagedCli(executable, fleet, [
      'setup',
      '--join',
      token,
      '--persist',
      'detached',
    ])

    expect(
      rejected.code,
      `${rejected.stdout}\n${rejected.stderr}\n${packagedDiagnostics(fleet)}`,
    ).not.toBe(0)
    expect(rejected.stderr, packagedDiagnostics(fleet)).toContain(
      'peerHelloRejected: invalid or expired code',
    )
    expect(rejected.stderr).toContain('daemon was rejected by the server')
    expect(rejected.stdout).not.toContain('podium joined as')
    expect(
      JSON.parse(readFileSync(join(fleet.stateDir, 'connectivity.json'), 'utf8')),
    ).toMatchObject({
      state: 'unauthorized',
    })
  }, 120_000)

  it('claims an absent named root before the compiled launcher materializes abduco', async () => {
    const namedSpec = makeSpec('blue', 'cold-blue')
    expect(existsSync(namedSpec.stateDir)).toBe(false)
    const executable = buildPackagedCli()
    const child = spawn(executable, ['channel', 'edge'], {
      cwd: ROOT,
      env: instanceEnv(namedSpec, {
        PODIUM_ABDUCO: undefined,
        PODIUM_ADOPT_STATE: undefined,
        PODIUM_APP_VERSION: '9.9.9',
        PODIUM_RUN_MODE: 'detached',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const code = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('compiled CLI timed out'))
      }, 20_000)
      child.once('error', reject)
      child.once('exit', (value) => {
        clearTimeout(timeout)
        resolve(value ?? 1)
      })
    })

    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(existsSync(join(namedSpec.stateDir, 'bin', 'abduco'))).toBe(true)
    expect(
      JSON.parse(readFileSync(join(namedSpec.stateDir, 'instance.json'), 'utf8')),
    ).toMatchObject({ instanceId: 'blue' })
    expect(JSON.parse(readFileSync(join(namedSpec.stateDir, 'config.json'), 'utf8'))).toMatchObject(
      {
        updateChannel: 'edge',
      },
    )

    const named = startInstance(namedSpec, {
      PODIUM_ADOPT_STATE: undefined,
      PODIUM_ABDUCO: join(namedSpec.stateDir, 'bin', 'abduco'),
    })
    await waitUntil(async () => (await version(named))?.instanceId === 'blue', 'clean named server')
    expect(JSON.parse(readFileSync(join(namedSpec.stateDir, 'config.json'), 'utf8'))).toMatchObject(
      {
        mode: 'all-in-one',
        updateChannel: 'edge',
      },
    )
    named.child.kill('SIGKILL')
    await new Promise<void>((resolve) => named.child.once('exit', () => resolve()))
  })

  it('keeps live runtimes, agents, commands, data, and lifecycle disjoint', async () => {
    const compat = startInstance(makeSpec('default'))
    const namedSpec = makeSpec('blue')
    seedLegacyNamedState(namedSpec)
    const named = startInstance(namedSpec, { PODIUM_ADOPT_STATE: '1' })
    await waitUntil(async () => (await version(compat))?.instanceId === 'default', 'compat server')
    await waitUntil(async () => (await version(named))?.instanceId === 'blue', 'named server')
    for (const [port, label] of [
      [compat.hookPort, 'compat hook'],
      [named.hookPort, 'named hook'],
      [compat.relayPort, 'compat relay'],
      [named.relayPort, 'named relay'],
    ] as const)
      await waitUntil(() => endpointIsListening(port), label)

    expect(
      new Set([
        compat.port,
        named.port,
        compat.hookPort,
        named.hookPort,
        compat.relayPort,
        named.relayPort,
      ]).size,
    ).toBe(6)
    expect(JSON.parse(readFileSync(join(compat.stateDir, 'instance.json'), 'utf8'))).toMatchObject({
      instanceId: 'default',
    })
    expect(JSON.parse(readFileSync(join(named.stateDir, 'instance.json'), 'utf8'))).toMatchObject({
      instanceId: 'blue',
    })
    expect(existsSync(join(compat.stateDir, 'runtime', 'abduco'))).toBe(false)
    expect(existsSync(join(named.stateDir, 'runtime', 'abduco'))).toBe(false)
    expect(existsSync(instanceSocketRuntimeDir('blue', named.stateDir))).toBe(true)

    const inspectBoot = (spec: InstanceSpec) => {
      const db = openDatabase(join(spec.stateDir, 'podium.db'))
      const rows = db
        .prepare('SELECT id, owner_user_id AS ownerUserId FROM machines ORDER BY id')
        .all() as { id: string; ownerUserId: string | null }[]
      const columns = db.prepare('PRAGMA table_info(machines)').all() as { name: string }[]
      db.close()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.ownerUserId).toBe(FIRST_ADMIN_USER_ID)
      expect(rows.some((row) => row.ownerUserId === null)).toBe(false)
      expect(rows.some((row) => row.id === 'local' || row.id === '__local__')).toBe(false)
      expect(columns.some((column) => column.name === 'instance_id')).toBe(false)
      return rows[0]!.id
    }
    const compatMachineId = inspectBoot(compat)
    const namedMachineId = inspectBoot(named)
    expect(readFileSync(join(compat.stateDir, 'machine.id'), 'utf8').trim()).toBe(compatMachineId)
    expect(readFileSync(join(named.stateDir, 'machine.id'), 'utf8').trim()).toBe(namedMachineId)

    // A second authenticated member is still inside the SAME named deployment,
    // but the instance label grants no execute authority over its host machine.
    const memberToken = 'named-instance-member'
    const memberDb = openDatabase(join(named.stateDir, 'podium.db'))
    memberDb
      .prepare(
        `INSERT INTO users (id, display_name, role, created_at, disabled_at)
         VALUES ('user:member', 'Member', 'member', '2026-08-02T00:00:00.000Z', NULL)`,
      )
      .run()
    memberDb
      .prepare(
        `INSERT INTO client_sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, 'user:member', '2026-08-02T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`,
      )
      .run(createHash('sha256').update(memberToken).digest('hex'))
    memberDb.close()
    const memberApi = trpc(named, SESSION_COOKIE + '=' + memberToken)
    await expect(
      memberApi.sessions.create.mutate({
        agentKind: 'shell',
        cwd: ROOT,
        machineId: namedMachineId,
      }),
    ).rejects.toThrow(/unknown machine/)
    expect(await trpc(named).sessions.list.query()).toEqual([])

    const namedOwnerApi = trpc(named)
    const namedOwnerSession = await namedOwnerApi.sessions.create.mutate({
      agentKind: 'shell',
      cwd: ROOT,
      machineId: namedMachineId,
    })
    const namedOwnerDb = openDatabase(join(named.stateDir, 'podium.db'))
    const namedOwnerRow = namedOwnerDb
      .prepare('SELECT durable_label AS durableLabel FROM sessions WHERE id = ?')
      .get(namedOwnerSession.sessionId) as { durableLabel: string }
    namedOwnerDb.close()
    expect(namedOwnerRow.durableLabel).toBe(`podium-blue-${namedOwnerSession.sessionId}`)
    expect(namedOwnerRow.durableLabel).not.toContain('user:')
    await namedOwnerApi.sessions.kill.mutate({ sessionId: namedOwnerSession.sessionId })

    const title = 'Default runtime acceptance'
    const created = await runCli(compat, [
      'issue',
      'create',
      '--repoPath',
      ROOT,
      '--title',
      title,
      '--json',
    ])
    expect(created.code, created.stderr).toBe(0)
    const compatList = await runCli(compat, ['issue', 'list', '--repoPath', ROOT, '--json'])
    const namedList = await runCli(named, ['issue', 'list', '--repoPath', ROOT, '--json'])
    const compatIssues = jsonOutput(compatList).data as Array<{ id: string; title: string }>
    const namedIssues = jsonOutput(namedList).data as Array<{ id: string; title: string }>
    const compatIssue = compatIssues.find((issue) => issue.title === title)
    expect(compatIssue).toBeDefined()
    expect(namedIssues.some((issue) => issue.title === title)).toBe(false)
    if (!compatIssue) throw new Error('compat issue was not persisted')
    expect((await runCli(named, ['issue', 'show', compatIssue.id, '--json'])).code).toBe(1)
    const foreignMutation = await runCli(named, [
      'issue',
      'update',
      compatIssue.id,
      '--title',
      'Crossed instance boundary',
      '--json',
    ])
    expect(foreignMutation.code).toBe(1)
    const compatAfterMutation = await runCli(compat, ['issue', 'show', compatIssue.id, '--json'])
    expect(compatAfterMutation.code, compatAfterMutation.stderr).toBe(0)
    expect((jsonOutput(compatAfterMutation).data as { title: string }).title).toBe(title)

    const relay = `http://127.0.0.1:${compat.relayPort}/agent/fake`
    const mismatch = await runCli(named, ['issue', 'list', '--repoPath', ROOT], {
      PODIUM_NO_RELAY: undefined,
      PODIUM_AGENT_RELAY: relay,
      PODIUM_SESSION_INSTANCE: 'default',
    })
    expect(mismatch.code).toBe(2)
    expect(mismatch.stderr).toContain("belongs to instance 'default', not 'blue'")
    const explicit = await runCli(named, ['issue', 'list', '--repoPath', ROOT, '--json'], {
      PODIUM_NO_RELAY: '1',
      PODIUM_AGENT_RELAY: relay,
      PODIUM_SESSION_INSTANCE: 'default',
    })
    expect(explicit.code, explicit.stderr).toBe(0)
    expect(jsonOutput(explicit).data).toEqual([])

    const compatApi = trpc(compat)
    const namedApi = trpc(named)
    const { sessionId } = await compatApi.sessions.create.mutate({ agentKind: 'shell', cwd: ROOT })
    await waitUntil(
      async () => (await compatApi.sessions.list.query()).some((s) => s.sessionId === sessionId),
      'compat session row',
    )
    expect((await namedApi.sessions.list.query()).some((s) => s.sessionId === sessionId)).toBe(
      false,
    )
    await namedApi.sessions.kill.mutate({ sessionId })
    expect((await compatApi.sessions.list.query()).some((s) => s.sessionId === sessionId)).toBe(
      true,
    )
    await compatApi.sessions.kill.mutate({ sessionId })
    await waitUntil(
      async () => !(await compatApi.sessions.list.query()).some((s) => s.sessionId === sessionId),
      'compat session teardown',
    )

    const stopCompat = await runCli(compat, ['stop'])
    expect(stopCompat.code, stopCompat.stderr).toBe(0)
    await waitUntil(() => compat.child.exitCode !== null, 'compat exit')
    expect(await version(compat)).toBeUndefined()
    expect(await endpointIsListening(compat.hookPort)).toBe(false)
    expect((await version(named))?.instanceId).toBe('blue')
    expect(await endpointIsListening(named.hookPort)).toBe(true)
    expect(await endpointIsListening(named.relayPort)).toBe(true)

    const stopNamed = await runCli(named, ['stop'])
    expect(stopNamed.code, stopNamed.stderr).toBe(0)
    await waitUntil(() => named.child.exitCode !== null, 'named exit')
  }, 180_000)
})
