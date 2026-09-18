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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { asMachineId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { identityShapes, writeIdentityShape, type IdentityShape, serverReleaseMigrations, serverRows } from '../packages/runtime/src/fixtures/customer-upgrade'
import { mintUpdateSigningKey } from '../packages/runtime/src/update-signing-key'
import { DRIZZLE_MIGRATIONS } from '../apps/server/src/migrations/drizzle-manifest.generated'
import { runDrizzleMigrations } from '../apps/server/src/migrations'
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
  const expected = tag === 'v0.1.0' ? '241dd542e1494c68080d5fd2ef441d7c2e195b12' : 'd09e5d47a4c3200c2ded231269d91ff0d1d90cd1'
  expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()).toBe(expected)
  return cli
}

const children: ChildProcess[] = []
async function stopChildren(): Promise<void> {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    // Each runtime owns a process group, including any server/daemon children.
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) await closed
  }))
}
const interrupt = () => { void stopChildren().finally(() => process.exit(130)) }
const terminate = () => { void stopChildren().finally(() => process.exit(143)) }
process.once('SIGINT', interrupt)
process.once('SIGTERM', terminate)
afterEach(stopChildren)
afterAll(async () => {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', terminate)
  await stopChildren()
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'PODIUM_AGENT_RELAY', 'PODIUM_ISSUE_RELAY', 'PODIUM_SESSION_ID', 'PODIUM_SESSION_INSTANCE',
    'PODIUM_HOME', 'PODIUM_INSTANCE', 'PODIUM_INSTANCE_UUID', 'PODIUM_UNDER_PARENT',
    'PODIUM_SESSION_RELAY', 'NOTIFY_SOCKET', 'ABDUCO_SOCKET_DIR', 'PODIUM_DEV_SOURCE_ROOT',
    'PODIUM_SUPERVISOR_MACHINE_ID', 'PODIUM_SUPERVISOR_MACHINE_TOKEN',
    'PODIUM_SUPERVISOR_UPDATE_PUBKEY', 'PODIUM_SUPERVISOR_SERVICE_ASSIGNMENT',
    'PODIUM_PARENT_GENERATION', 'PODIUM_REHEARSAL',
    'PODIUM_APP_VERSION',
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
async function bootServer(cli: string, cwd: string, tag: string, stateDir = join(TEST_ROOT, `srv-${tag}`), sourceOnly = false): Promise<Server> {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one' }))
  const port = freePort()
  const child = spawn(
    process.execPath,
    sourceOnly ? ['--conditions=@podium/source', join(ROOT, 'scripts/fixtures/customer-upgrade-server.ts')] : ['--conditions=@podium/source', cli, '--instance', `skew-${tag}`, cwd === OLD_DAEMON ? 'server' : 'parent', '--takeover'],
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
async function launchDaemon(cli: string, cwd: string, tag: string, serverPort: number, pairCode?: string, identity?: { machineId: string; token?: string }, shape?: IdentityShape) {
  const stateDir = join(TEST_ROOT, `daemon-${tag}`)
  mkdirSync(stateDir, { recursive: true })
  const machineId = identity?.machineId ?? randomUUID()
  // Both release generations persist the daemon HELLO identity here. Seed it
  // independently of the server so an unrelated online host cannot satisfy us.
  writeFileSync(join(stateDir, 'daemon.json'), JSON.stringify({ ...identity, machineId }), { mode: 0o600 })
  if (shape) writeIdentityShape(stateDir, shape)
  const env = cleanEnv({ ...baseEnv(stateDir), PODIUM_INSTANCE: `skew-${tag}`,
    // Release builds bake this label; source builds normally report dev+SHA. The
    // checkout SHA is independently pinned above; this is the real release tree.
    ...(cwd === OLD_DAEMON ? { PODIUM_APP_VERSION: '0.1.0' } : {}),
    // Current CLI otherwise promotes remote daemon mode to a parent supervisor.
    ...(cwd === ROOT && !pairCode ? { PODIUM_UNDER_PARENT: '1' } : {}),

  })
  // join-config chooses systemd persistence. A bare CLI then delegates launch to
  // the host service manager; an explicit daemon subcommand stays in this group.
  const child = spawn(process.execPath, [
    '--conditions=@podium/source', shape ? join(ROOT, 'scripts/fixtures/customer-upgrade-daemon.ts') : cli, 'daemon', ...(cwd === ROOT ? ['--takeover'] : []),
    '--server', `ws://127.0.0.1:${serverPort}`, ...(pairCode ? ['--pair', pairCode] : []),
  ], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout?.on('data', (c) => (log += c))
  child.stderr?.on('data', (c) => (log += c))
  child.on('error', (error) => (log += `\nspawn failed: ${error.message}`))
  children.push(child)
  return {
    machineId,
    stateDir,
    exitCode: () => child.exitCode,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
      await closed
    },
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

  it('already-enrolled v0.1.0 daemon reconnects and becomes ready after server upgrade', async () => {
    // Obtain a genuine v0.1.0 token with the real old server/daemon ceremony.
    const old = await bootServer(oldDaemonCli, OLD_DAEMON, 'enroll-v010')
    const pairing = await old.api.machines.pairingCode.mutate()
    const captured = serverRows.machines.find((m) => m.id === 'machine-peer')!
    const enrolled = await launchDaemon(oldDaemonCli, OLD_DAEMON, 'enrolled', old.port, pairing.code, { machineId: captured.id })
    await waitFor(async () => (await old.api.machines.list.query()).find((m) => m.id === enrolled.machineId && m.online), () => enrolled.log())
    const identity = await waitFor(async () => {
      const saved = JSON.parse(readFileSync(join(enrolled.stateDir, 'daemon.json'), 'utf8')) as { machineId: string; token?: string }
      return saved.token ? saved : undefined
    }, () => `v0.1.0 persisted token\n${enrolled.log()}`)
    await enrolled.stop()
    expect(identity.machineId).toBe(captured.id)
    const tokenHash = createHash('sha256').update(identity.token!).digest('hex')

    // POD-3974's captured pre-upgrade database, with its sanitised placeholder
    // hash replaced by the token just issued by v0.1.0. No enrollment ledger and
    // no post-upgrade row injection: current server boot owns all migrations.
    const stateDir = join(TEST_ROOT, 'srv-upgraded')
    mkdirSync(stateDir, { recursive: true })
    // The server upgrades in place: its existing publisher key survives too.
    copyFileSync(join(TEST_ROOT, 'srv-enroll-v010', 'update-signing-key.json'), join(stateDir, 'update-signing-key.json'))
    const db = openDatabase(join(stateDir, 'podium.db'))
    try {
      const shipped = new Set(serverReleaseMigrations.migrations)
      const release = DRIZZLE_MIGRATIONS.filter((m) => shipped.has(m.name))
      expect(release.map((m) => m.name)).toEqual(serverReleaseMigrations.migrations)
      db.exec('PRAGMA foreign_keys = OFF')
      runDrizzleMigrations(db, release)
      for (const row of serverRows.machines) {
        const machine = row.id === captured.id ? { ...row, token_hash: tokenHash, app_version: '0.1.0' } : row
        const keys = Object.keys(machine)
        db.prepare(`INSERT INTO machines (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(machine))
      }
      for (const row of serverRows.sessions) {
        const keys = Object.keys(row)
        db.prepare(`INSERT INTO sessions (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row))
      }
      expect(db.prepare('SELECT count(*) AS n FROM machines').get()).toEqual({ n: serverRows.machines.length })
      expect(db.prepare('SELECT token_hash, owner_user_id FROM machines WHERE id = ?').get(identity.machineId))
        .toEqual({ token_hash: tokenHash, owner_user_id: 'user:sole' })
    } finally { db.close() }

    const server = await bootServer(currentCli, ROOT, 'upgraded', stateDir)
    const daemon = await launchDaemon(oldDaemonCli, OLD_DAEMON, 'enrolled', server.port, undefined, identity)
    const online = await waitFor(async () => (await server.api.machines.list.query())
      .find((m) => m.id === identity.machineId && m.online),
      () => `enrolled v0.1.0 ready after upgrade\n${daemon.log()}`)
    expect(online.id).toBe(asMachineId(identity.machineId))
    // v0.1.0 predates daemonReadiness telemetry. Readiness here is an actual
    // request/reply through this exact daemon, not a fabricated newer report.
    mkdirSync(join(daemon.stateDir, 'ready-proof'), { recursive: true })
    const listing = await server.api.repos.browse.query({ machineId: asMachineId(identity.machineId), path: daemon.stateDir })
    expect(listing.entries.some((entry) => entry.name === 'ready-proof')).toBe(true)
    expect(daemon.exitCode(), daemon.log()).toBeNull()
    const upgraded = openDatabase(join(stateDir, 'podium.db'))
    try {
      expect(upgraded.prepare('SELECT credential_kind, token_hash, public_key FROM machines WHERE id = ?').get(identity.machineId))
        .toEqual({ credential_kind: 'bearer-hash', token_hash: tokenHash, public_key: null })
    } finally { upgraded.close() }
    expect(existsSync(join(stateDir, 'enrollment.ledger'))).toBe(false)
    expect(await server.reachable()).toBe(true)
  }, 120_000)

  it('fresh v0.1.0 pairing refuses actionably and preserves the code for a current daemon', async () => {
    const server = await bootServer(currentCli, ROOT, 'new')
    const pairing = await server.api.machines.pairingCode.mutate()
    const daemon = await launchDaemon(oldDaemonCli, OLD_DAEMON, 'old-daemon', server.port, pairing.code)
    await waitFor(async () => daemon.exitCode() ?? undefined, () => `legacy pairing refusal\n${daemon.log()}`)
    expect(daemon.exitCode()).toBe(78)
    expect(daemon.log()).toContain('Daemon 0.1.0 cannot pair with this server: keypair enrollment is required; install the current daemon and pair again.')
    expect((await server.api.machines.list.query()).find((m) => m.id === daemon.machineId)).toBeUndefined()
    const current = await launchDaemon(currentCli, ROOT, 'retry-current', server.port, pairing.code)
    const online = await waitFor(async () => (await server.api.machines.list.query())
      .find((m) => m.id === current.machineId && m.online), () => `current daemon reuses unconsumed code\n${current.log()}`)
    expect(online.id).toBe(asMachineId(current.machineId))
    expect(online.online).toBe(true)
    expect(await server.reachable()).toBe(true)
  }, 120_000)

  it('new daemon + old server: the daemon connects and recovery is skipped, service preserved', async () => {
    // The old server (wire 2) does not gate the daemon HELLO on version, so a
    // current daemon that dials `/daemon` with no `?v=` is admitted. The design's
    // first branch: it connects, the old server returns no binding
    // confirmations, recovery is SKIPPED (never quarantine), and service holds.
    const server = await bootServer(oldServerCli, OLD_SERVER, 'old-server')
    const pairing = (await server.api.machines.pairingCode.mutate()) as { code: string }
    // Upgrade a genuinely enrolled release credential. Fresh current enrollment
    // belongs to the supervisor/keypair protocol the old server did not implement.
    const prior = await launchDaemon(oldDaemonCli, OLD_DAEMON, 'new-daemon', server.port, pairing.code)
    await waitFor(async () => (await server.api.machines.list.query()).find((m) => m.id === prior.machineId && m.online), () => prior.log())
    const identity = await waitFor(async () => {
      const saved = JSON.parse(readFileSync(join(prior.stateDir, 'daemon.json'), 'utf8')) as { machineId: string; token?: string }
      return saved.token ? saved : undefined
    }, () => prior.log())
    await prior.stop()
    await waitFor(async () => (await server.api.machines.list.query()).find((m) => m.id === prior.machineId && !m.online), 'old daemon disconnect before candidate reconnect')
    const daemon = await launchDaemon(currentCli, ROOT, 'new-daemon', server.port, undefined, identity)

    const online = await waitFor(
      async () => {
        const machines = (await server.api.machines.list.query()) as { id: string; online: boolean }[]
        return machines.find((m) => m.id === daemon.machineId && m.online)
      },
      () => `new daemon to connect to the old server\n${daemon.log()}`,
    )
    expect(online.id).toBe(daemon.machineId)
    expect(online.online).toBe(true)
    mkdirSync(join(daemon.stateDir, 'candidate-ready'), { recursive: true })
    const listing = await server.api.repos.browse.query({ machineId: asMachineId(daemon.machineId), path: daemon.stateDir })
    expect(listing.entries.some((entry) => entry.name === 'candidate-ready')).toBe(true)
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
    // A wire above the old server's CLIENT_WIRE_VERSION (2) is refused outright.
    expect(await status(3)).toBe(426)
    // A wire the old server supports is NOT refused for version (the WS
    // handshake itself fails these synthetic headers, but never with 426).
    expect(await status(2)).not.toBe(426)
    // Coordinator-first ordering holds: the refusal does not take the server
    // down, so the update path the daemon must reach is still answering.
    expect((await fetch(`http://127.0.0.1:${server.port}/version`)).status).toBe(200)
  }, 120_000)
})


// These rows require only the candidate tree. Missing old executables still fail
// the separate skew describe above, never silently skip its cross-version rows.
describe('customer upgrade real-install identities', () => {
  for (const shape of identityShapes) {
    it(`${shape.name}: first candidate boot authenticates ONLINE without inventing a machine`, async () => {
      const stateDir = join(TEST_ROOT, `shape-${shape.name}`)
      mkdirSync(stateDir)
      writeIdentityShape(stateDir, shape)
      writeFileSync(join(stateDir, 'update-signing-key.json'), JSON.stringify(mintUpdateSigningKey()))
      const hash = createHash('sha256').update(shape.token).digest('hex')
      const db = openDatabase(join(stateDir, 'podium.db'))
      try {
        const shipped = new Set(serverReleaseMigrations.migrations)
        runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.filter((m) => shipped.has(m.name)))
        for (const row of serverRows.machines) {
          const machine = row.id === shape.authenticatedId ? { ...row, token_hash: hash } : row
          const keys = Object.keys(machine)
          db.prepare(`INSERT INTO machines (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(machine))
        }
        expect(db.prepare('SELECT count(*) AS n FROM machines').get()).toEqual({ n: serverRows.machines.length })
        for (const id of shape.absentIds) expect(db.prepare('SELECT id FROM machines WHERE id = ?').get(id)).toBeUndefined()
        for (const id of shape.historicalIds) expect(db.prepare('SELECT hostname FROM machines WHERE id = ?').get(id)).toEqual({ hostname: 'laptop' })
      } finally { db.close() }
      const server = await bootServer(currentCli, ROOT, shape.name, stateDir, true)
      const daemon = await launchDaemon(currentCli, ROOT, shape.name, server.port, undefined,
        { machineId: shape.authenticatedId }, shape)
      await waitFor(async () => (await server.api.machines.list.query()).find((m) => m.id === shape.authenticatedId && m.online),
        () => `first ${shape.name} attach\n${daemon.log()}`)
      expect(daemon.exitCode(), daemon.log()).toBeNull()
      const machines = await server.api.machines.list.query()
      expect(machines.map((m) => m.id).sort()).toEqual(serverRows.machines.map((m) => asMachineId(m.id)).sort())
      for (const root of [stateDir, daemon.stateDir]) {
        const saved = JSON.parse(readFileSync(join(root, 'machine.json'), 'utf8'))
        expect(saved.machineId).toBe(shape.authenticatedId)
        expect(saved.daemon).toMatchObject(shape.daemon)
        if (shape.supervisor) expect(saved.supervisor).toMatchObject(shape.supervisor)
        else expect(saved.supervisor).toBeUndefined()
        expect(saved.legacy).toEqual({ machineId: shape.machineIdFile.trim() })
      }
      const upgraded = openDatabase(join(stateDir, 'podium.db'))
      try {
        expect(upgraded.prepare('SELECT token_hash FROM machines WHERE id = ?').get(shape.authenticatedId)).toEqual({ token_hash: hash })
        // The live daemon refreshes its own hostname; historical rows stay untouched.
        for (const id of shape.historicalIds.filter((id) => id !== shape.authenticatedId)) expect(upgraded.prepare('SELECT hostname FROM machines WHERE id = ?').get(id)).toEqual({ hostname: 'laptop' })
      } finally { upgraded.close() }
      await daemon.stop()
    }, 90_000)
  }
})
