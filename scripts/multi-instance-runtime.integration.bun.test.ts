/**
 * Process-level acceptance proof for independent Podium instances [spec:SP-15aa].
 * Starts two real all-in-one runtimes and exercises their public CLI and APIs.
 *
 * Run: bun test --conditions=@podium/source ./scripts/multi-instance-runtime.integration.bun.test.ts
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../apps/server/src/router'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(ROOT, 'scripts', 'cli.ts')
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'podium-multi-instance-'))
const RUNTIME_BIN = join(TEST_ROOT, 'bin')
mkdirSync(RUNTIME_BIN)
const git = Bun.which('git')
if (git) symlinkSync(git, join(RUNTIME_BIN, 'git'))

interface InstanceSpec {
  id: 'blue' | 'green'
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

function startInstance(spec: InstanceSpec): RunningInstance {
  const child = spawn(
    process.execPath,
    ['--conditions=@podium/source', CLI, '--instance', spec.id, 'all'],
    { cwd: ROOT, env: instanceEnv(spec), stdio: ['ignore', 'pipe', 'pipe'] },
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
function trpc(spec: InstanceSpec): ReturnType<typeof createTRPCClient<AppRouter>> {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `http://127.0.0.1:${spec.port}/trpc` })],
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
    const blue = startInstance(makeSpec('blue'))
    const green = startInstance(makeSpec('green'))
    await waitUntil(async () => (await version(blue))?.instanceId === 'blue', 'blue server')
    await waitUntil(async () => (await version(green))?.instanceId === 'green', 'green server')
    for (const [port, label] of [
      [blue.hookPort, 'blue hook'],
      [green.hookPort, 'green hook'],
      [blue.relayPort, 'blue relay'],
      [green.relayPort, 'green relay'],
    ] as const)
      await waitUntil(() => endpointIsListening(port), label)

    expect(
      new Set([
        blue.port,
        green.port,
        blue.hookPort,
        green.hookPort,
        blue.relayPort,
        green.relayPort,
      ]).size,
    ).toBe(6)
    expect(JSON.parse(readFileSync(join(blue.stateDir, 'instance.json'), 'utf8'))).toMatchObject({
      instanceId: 'blue',
    })
    expect(JSON.parse(readFileSync(join(green.stateDir, 'instance.json'), 'utf8'))).toMatchObject({
      instanceId: 'green',
    })
    expect(existsSync(join(blue.stateDir, 'runtime', 'abduco'))).toBe(true)
    expect(existsSync(join(green.stateDir, 'runtime', 'abduco'))).toBe(true)

    const title = 'Blue runtime acceptance'
    const created = await runCli(blue, [
      'issue',
      'create',
      '--repoPath',
      ROOT,
      '--title',
      title,
      '--json',
    ])
    expect(created.code, created.stderr).toBe(0)
    const blueList = await runCli(blue, ['issue', 'list', '--repoPath', ROOT, '--json'])
    const greenList = await runCli(green, ['issue', 'list', '--repoPath', ROOT, '--json'])
    const blueIssues = jsonOutput(blueList).data as Array<{ id: string; title: string }>
    const greenIssues = jsonOutput(greenList).data as Array<{ id: string; title: string }>
    const blueIssue = blueIssues.find((issue) => issue.title === title)
    expect(blueIssue).toBeDefined()
    expect(greenIssues.some((issue) => issue.title === title)).toBe(false)
    if (!blueIssue) throw new Error('blue issue was not persisted')
    expect((await runCli(green, ['issue', 'show', blueIssue.id, '--json'])).code).toBe(1)
    const foreignMutation = await runCli(green, [
      'issue',
      'update',
      blueIssue.id,
      '--title',
      'Crossed instance boundary',
      '--json',
    ])
    expect(foreignMutation.code).toBe(1)
    const blueAfterMutation = await runCli(blue, ['issue', 'show', blueIssue.id, '--json'])
    expect(blueAfterMutation.code, blueAfterMutation.stderr).toBe(0)
    expect((jsonOutput(blueAfterMutation).data as { title: string }).title).toBe(title)

    const relay = `http://127.0.0.1:${blue.relayPort}/agent/fake`
    const mismatch = await runCli(green, ['issue', 'list', '--repoPath', ROOT], {
      PODIUM_NO_RELAY: undefined,
      PODIUM_AGENT_RELAY: relay,
      PODIUM_SESSION_INSTANCE: 'blue',
    })
    expect(mismatch.code).toBe(2)
    expect(mismatch.stderr).toContain("belongs to instance 'blue', not 'green'")
    const explicit = await runCli(green, ['issue', 'list', '--repoPath', ROOT, '--json'], {
      PODIUM_NO_RELAY: '1',
      PODIUM_AGENT_RELAY: relay,
      PODIUM_SESSION_INSTANCE: 'blue',
    })
    expect(explicit.code, explicit.stderr).toBe(0)
    expect(jsonOutput(explicit).data).toEqual([])

    const blueApi = trpc(blue)
    const greenApi = trpc(green)
    const { sessionId } = await blueApi.sessions.create.mutate({ agentKind: 'shell', cwd: ROOT })
    await waitUntil(
      async () => (await blueApi.sessions.list.query()).some((s) => s.sessionId === sessionId),
      'blue session row',
    )
    expect((await greenApi.sessions.list.query()).some((s) => s.sessionId === sessionId)).toBe(
      false,
    )
    await greenApi.sessions.kill.mutate({ sessionId })
    expect((await blueApi.sessions.list.query()).some((s) => s.sessionId === sessionId)).toBe(true)
    await blueApi.sessions.kill.mutate({ sessionId })
    await waitUntil(
      async () => !(await blueApi.sessions.list.query()).some((s) => s.sessionId === sessionId),
      'blue session teardown',
    )

    const stopBlue = await runCli(blue, ['stop'])
    expect(stopBlue.code, stopBlue.stderr).toBe(0)
    await waitUntil(() => blue.child.exitCode !== null, 'blue exit')
    expect(await version(blue)).toBeUndefined()
    expect(await endpointIsListening(blue.hookPort)).toBe(false)
    expect((await version(green))?.instanceId).toBe('green')
    expect(await endpointIsListening(green.hookPort)).toBe(true)
    expect(await endpointIsListening(green.relayPort)).toBe(true)

    const stopGreen = await runCli(green, ['stop'])
    expect(stopGreen.code, stopGreen.stderr).toBe(0)
    await waitUntil(() => green.child.exitCode !== null, 'green exit')
  }, 180_000)
})
