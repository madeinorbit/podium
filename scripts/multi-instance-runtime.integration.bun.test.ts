/**
 * Process-level acceptance proof for independent Podium instances [spec:SP-15aa].
 * Starts two real all-in-one runtimes and exercises their public CLI and APIs.
 *
 * Run: bun test --conditions=@podium/source ./scripts/multi-instance-runtime.integration.bun.test.ts
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { FIRST_ADMIN_USER_ID, asMachineId } from '@podium/model'
import { SESSION_COOKIE } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import type { AppRouter } from '../apps/server/src/router'
import { SessionStore } from '../apps/server/src/store'

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

const freePorts = (() => {
  const servers = Array.from({ length: 6 }, () =>
    Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('reserved'),
    }),
  )
  const ports = servers.map((server) => server.port)
  for (const server of servers) server.stop(true)
  return ports
})()
const freePort = (): number => {
  const port = freePorts.shift()
  if (port === undefined) throw new Error('port pool exhausted')
  return port
}

function makeSpec(id: InstanceSpec['id']): InstanceSpec {
  const webDir = join(TEST_ROOT, `${id}-web`)
  const agentHome = join(TEST_ROOT, `${id}-agent-home`)
  mkdirSync(webDir, { recursive: true })
  mkdirSync(agentHome, { recursive: true })
  return {
    id,
    stateDir: join(TEST_ROOT, `${id}-state`),
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
    PODIUM_PTY_BACKEND: 'node-pty',
    PATH: RUNTIME_BIN,
    SHELL: '/bin/bash',
  })
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

function startInstance(
  spec: InstanceSpec,
  overrides: Record<string, string | undefined> = {},
): RunningInstance {
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

afterAll(async () => {
  for (const instance of running) {
    if (instance.child.exitCode === null && instance.child.signalCode === null) {
      instance.child.kill('SIGKILL')
      await new Promise<void>((resolve) => instance.child.once('exit', () => resolve()))
    }
  }
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('multi-instance runtime isolation', () => {
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
    expect(existsSync(join(named.stateDir, 'runtime', 'abduco'))).toBe(true)

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
