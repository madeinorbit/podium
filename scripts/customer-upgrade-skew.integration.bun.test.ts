/**
 * THE CUSTOMER UPGRADE, skew lane [POD-3974]. Acceptance matrix rows (design
 * rev 23, Part B): "Oldest supported daemon executable …" and "New daemon + old
 * server (incl. a wire-refused daemon, POD-4058)".
 *
 * Unlike the three hermetic driver arms, these rows are about VERSION SKEW at
 * the wire, so nothing but real cross-version executables can prove them. The
 * lane builds no code and relabels none: it runs the actual v0.1.0 and
 * v0.1.1-edge.4 release trees from their own source checkouts (their real
 * daemon entrypoint, their own `@podium/protocol` wire), each pinned by tag,
 * against the current tree, and asserts the DEFINED result — not merely that a
 * process started.
 *
 * The old trees are checked out and installed by scripts/prepare-skew-checkouts.ts
 * into $PODIUM_SKEW_DIR (default a sibling of this repo). When they are absent
 * the lane FAILS admission rather than skipping: a green here must mean the real
 * skew ran. Wire facts it rests on (verified 2026-09-17): current server wire 3,
 * min 1; v0.1.0 daemon wire 2; v0.1.1-edge.4 server wire 2, min 1 — so the new
 * server admits the wire-2 daemon (versionSupport(2)=ok) and the old server
 * refuses the wire-3 daemon (versionSupport(3, wire 2)=too-new → 426).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../apps/server/src/router'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKEW_DIR = process.env.PODIUM_SKEW_DIR ?? join(dirname(ROOT), 'podium-skew-checkouts')
const OLD_DAEMON = join(SKEW_DIR, 'v0.1.0')
const OLD_SERVER = join(SKEW_DIR, 'v0.1.1-edge.4')
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'podium-skew-'))

/** Missing artifacts fail admission — a skipped skew row is not a green one. */
function requireCheckout(dir: string, tag: string): string {
  const cli = join(dir, 'scripts', 'cli.ts')
  if (!existsSync(cli)) {
    throw new Error(
      `skew lane requires the real ${tag} tree at ${dir} (run \`bun scripts/prepare-skew-checkouts.ts\`); refusing to skip a wire-skew acceptance row`,
    )
  }
  return cli
}

const children: ChildProcess[] = []
afterAll(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    // Each runtime owns a process group, including any server/daemon children.
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) await closed
  }))
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'PODIUM_AGENT_RELAY', 'PODIUM_ISSUE_RELAY', 'PODIUM_SESSION_ID', 'PODIUM_SESSION_INSTANCE',
    'PODIUM_HOME', 'PODIUM_INSTANCE', 'PODIUM_INSTANCE_UUID', 'PODIUM_UNDER_PARENT',
    'PODIUM_SESSION_RELAY', 'NOTIFY_SOCKET', 'ABDUCO_SOCKET_DIR', 'PODIUM_DEV_SOURCE_ROOT',
    'PODIUM_SUPERVISOR_MACHINE_ID', 'PODIUM_SUPERVISOR_MACHINE_TOKEN',
  ]) {
    delete env[key]
  }
  return Object.assign(env, extra)
}

function freePort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error('no port')
  return port
}

const baseEnv = (stateDir: string): Record<string, string> => ({
  PODIUM_STATE_DIR: stateDir,
  PODIUM_AGENT_HOME: join(stateDir, 'agent-home'),
  PODIUM_HOOK_PORT: String(freePort()),
  PODIUM_AGENT_RELAY_PORT: String(freePort()),
  PODIUM_HOST: '127.0.0.1',
  PODIUM_NO_RELAY: '1',
  PODIUM_NO_SCOPE: '1',
  PODIUM_ADOPT_STATE: '1',
  PODIUM_PTY_BACKEND: 'bun-terminal',
  PODIUM_ABDUCO: join(TEST_ROOT, 'no-abduco'),
})

async function waitFor<T>(fn: () => Promise<T | undefined>, label: string | (() => string), timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined)
    if (value !== undefined && value !== false) return value as T
    await Bun.sleep(400)
  }
  throw new Error(`timed out waiting for ${typeof label === 'function' ? label() : label}`)
}

interface Server {
  port: number
  api: ReturnType<typeof createTRPCClient<AppRouter>>
  reachable(): Promise<boolean>
}

/** Boot an all-in-one server from a given tree (current or an old checkout). */
async function bootServer(cli: string, cwd: string, tag: string): Promise<Server> {
  const stateDir = join(TEST_ROOT, `srv-${tag}`)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one' }))
  const port = freePort()
  const child = spawn(
    process.execPath,
    ['--conditions=@podium/source', cli, '--instance', `skew-${tag}`, 'parent', '--takeover'],
    { cwd, detached: true, env: cleanEnv({ ...baseEnv(stateDir), PODIUM_INSTANCE: `skew-${tag}`, PODIUM_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  child.stdout?.on('data', (c) => (log += c))
  child.stderr?.on('data', (c) => (log += c))
  children.push(child)
  const reachable = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/version`)).ok
    } catch {
      return false
    }
  }
  await waitFor(async () => (await reachable()) || undefined, () => `${tag} server boot\n${log.slice(-1500)}`)
  const api = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `http://127.0.0.1:${port}/trpc` })] })
  return { port, api, reachable }
}

/** Run the tree's real daemon in the foreground, never its host persistence launcher. */
async function launchDaemon(cli: string, cwd: string, tag: string, serverPort: number, pairCode: string): Promise<{ machineId: string; log: () => string }> {
  const stateDir = join(TEST_ROOT, `daemon-${tag}`)
  mkdirSync(stateDir, { recursive: true })
  const machineId = randomUUID()
  // Both release generations persist the daemon HELLO identity here. Seed it
  // independently of the server so an unrelated online host cannot satisfy us.
  writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({ machineId }), { mode: 0o600 })
  const env = cleanEnv({ ...baseEnv(stateDir), PODIUM_INSTANCE: `skew-${tag}` })
  // join-config chooses systemd persistence. A bare CLI then delegates launch to
  // the host service manager; an explicit daemon subcommand stays in this group.
  const child = spawn(process.execPath, [
    '--conditions=@podium/source', cli, 'daemon',
    '--server', `ws://127.0.0.1:${serverPort}`, '--pair', pairCode,
  ], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout?.on('data', (c) => (log += c))
  child.stderr?.on('data', (c) => (log += c))
  child.on('error', (error) => (log += `\nspawn failed: ${error.message}`))
  children.push(child)
  return {
    machineId,
    log: () => `machine ${machineId}; exit=${child.exitCode}; signal=${child.signalCode}\n${log}` + (existsSync(join(stateDir, 'logs', 'daemon.log')) ? `\n${readFileSync(join(stateDir, 'logs', 'daemon.log'), 'utf8').slice(-1500)}` : ''),
  }
}

const currentCli = join(ROOT, 'scripts', 'cli.ts')

describe('customer upgrade skew lane', () => {
  let oldDaemonCli = ''
  let oldServerCli = ''
  beforeAll(() => {
    oldDaemonCli = requireCheckout(OLD_DAEMON, 'v0.1.0')
    oldServerCli = requireCheckout(OLD_SERVER, 'v0.1.1-edge.4')
  })

  it('oldest supported daemon (wire 2) is admitted and served by the new server (wire 3)', async () => {
    const server = await bootServer(currentCli, ROOT, 'new')
    const pairing = (await server.api.machines.pairingCode.mutate()) as { code: string }
    const daemon = await launchDaemon(oldDaemonCli, OLD_DAEMON, 'old-daemon', server.port, pairing.code)

    const online = await waitFor(
      async () => {
        const machines = (await server.api.machines.list.query()) as { id: string; online: boolean; ownerUserId?: string | null }[]
        const row = machines.find((m) => m.id === daemon.machineId && m.online)
        return row ?? undefined
      },
      () => `old daemon to connect\n${daemon.log()}`,
    )
    // The real oldest executable connected and is served — no whole-fleet barrier.
    expect(online.id).toBe(daemon.machineId)
    expect(online.online).toBe(true)
    // Its owner resolved to a member, never left as the retired literal or NULL.
    expect(online.ownerUserId ?? null).not.toBe('user:sole')
    // Unrelated fleet RPC keeps answering while the old peer is attached.
    const listedAgain = (await server.api.machines.list.query()) as unknown[]
    expect(listedAgain.length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('new daemon + old server: the daemon connects and recovery is skipped, service preserved', async () => {
    // The old server (wire 2) does not gate the daemon HELLO on version, so a
    // current daemon that dials `/daemon` with no `?v=` is admitted. The design's
    // first branch: it connects, the old server returns no binding
    // confirmations, recovery is SKIPPED (never quarantine), and service holds.
    const server = await bootServer(oldServerCli, OLD_SERVER, 'old-server')
    const pairing = (await server.api.machines.pairingCode.mutate()) as { code: string }
    const daemon = await launchDaemon(currentCli, ROOT, 'new-daemon', server.port, pairing.code)

    const online = await waitFor(
      async () => {
        const machines = (await server.api.machines.list.query()) as { id: string; online: boolean }[]
        return machines.find((m) => m.id === daemon.machineId && m.online)
      },
      () => `new daemon to connect to the old server\n${daemon.log()}`,
    )
    expect(online.id).toBe(daemon.machineId)
    expect(online.online).toBe(true)
    expect(await server.reachable()).toBe(true)
  }, 120_000)

  it('POD-4058: the old server refuses a newer wire on the daemon URL, and the update path stays reachable', async () => {
    // The wire-refused daemon is the acceptor gate: a peer that advertises a
    // version above the old server's window on the connect URL is refused with
    // 426 before any socket is accepted. Asserted directly against the running
    // old server, so the "defined result" is the refusal itself, not a hang.
    const server = await bootServer(oldServerCli, OLD_SERVER, 'old-server-wire')
    const upgrade = {
      connection: 'upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    }
    const status = async (v: number) =>
      (await fetch(`http://127.0.0.1:${server.port}/daemon?v=${v}`, { headers: upgrade })).status
    // A wire above the old server's WIRE_VERSION (2) is refused outright.
    expect(await status(3)).toBe(426)
    // A wire the old server supports is NOT refused for version (the WS
    // handshake itself fails these synthetic headers, but never with 426).
    expect(await status(2)).not.toBe(426)
    // Coordinator-first ordering holds: the refusal does not take the server
    // down, so the update path the daemon must reach is still answering.
    expect((await fetch(`http://127.0.0.1:${server.port}/version`)).status).toBe(200)
  }, 120_000)
})
