/**
 * UPGRADE PROOF (POD-4428, Phase 0 step 3 of POD-4414): every session that exists
 * under the PREVIOUS release opens under this build with the legacy PTY code gone.
 *
 * WHAT RUNS, AND WHY NOTHING HERE IS A MOCK. "Previous release" is a second git
 * worktree at the integration base (dev/mw 67e96fdcd), prepared by
 * {@link ensureBaseTree} with its own checkout-local install. Its real server
 * (scripts/cli.ts `server`) and its real daemon (tests/e2e/daemon-process.ts,
 * the same entry the e2e lanes drive) boot against a fresh state dir; six
 * sessions are created through the old build's real tRPC API; old server and
 * daemon are SIGKILLed (pids asserted gone) while their podium-host sessions
 * keep running; then THIS build takes over the same state dir and DB — the new
 * server boots in-process (apps/server/src/test-support/enrolled-server, which
 * runs the real migration chain) and the new daemon boots as a real child
 * process — and every assertion below is read back over HTTP tRPC, a real
 * client websocket, the daemon child's own log, or SQL against the same file
 * the servers wrote.
 *
 * THE SIX SCENARIOS (created under the old build):
 *  (1) a live claude-code session bound through the old driver path
 *      (runtimeContract: 'generic-pty' — the old spawn API's driver request);
 *  (2) a hibernated grok + generic-pty session whose row is NULLed to
 *      selected_driver_id NULL (hibernate needs a resume ref no model-less
 *      box can earn, so the ref is seeded in sessionResumeRef shape; the park
 *      itself is the real old API; grok tolerates the unresolvable ref);
 *  (3) a live shell; (4) a login shell (agentKind shell + loginHarness);
 *  (5) a hibernated grok + generic-pty session holding two queued_messages rows
 *      (creation prompt queues row 1 at spawn — cursor is the only
 *      non-argv manifest; row 2 follows once live with a non-empty queue;
 *      pre-upgrade binds are accepted since forwarded rows persist without
 *      proof; the per-custody exactly-once is read off delivery_owner);
 *  (6) a live harness session holding one pending native-menu interaction row
 *      written with the exact columns the old InteractionService.ask inserts
 *      (the ask itself is driver-emitted, so only its trigger is synthetic —
 *      the row is byte-identical to what old code writes; see the insert).
 *
 * WHAT "OPENS" MEANS PER SCENARIO (asserted against the new build):
 *  (1) live again with a driver announced in bind (driverId on the session
 *      meta, runtimeContract derived true, selected_driver_id persisted);
 *  (2) still hibernated (resumable, not reaped), and after resurrect the
 *      driver is announced and selected_driver_id is filled;
 *  (3) live with no driver, and bytes relay end to end (a marker written
 *      through the server's sendText echoes back through the output frames);
 *  (4) live with no driver, keeping its login shape (shell + loginHarness)
 *      and a live relay in both directions (its PTY runs the harness auth
 *      flow, so echo is impossible by design — frames flowing is the proof);
 *  (5) the two rows drain through the gateway exactly once, in FIFO order
 *      (row 1's reservation strictly precedes row 2's, seconds apart —
 *      observed by polling owners; both rows survive with delivery_owner set
 *      by the new gateway — legacy typing would have deleted them; attempts
 *      clamp, never reset; 30s quiet proves no second forward);
 *  (6) interactions.answer traverses the gateway to the real driver (which
 *      truthfully reports unknown-interaction — no model ever turned, so it
 *      never observed the menu), the row settles as claimed exactly once, and
 *      a second answer loses the first-wins race.
 *
 * ARMING (DONE WHEN 1): this file must go red with POD-4426 reverted (binds
 * carry no driverId, so assertions (1)(2) fail) and red with POD-4427 reverted
 * (the typing loop deletes the queued rows on echo, so assertion (5)'s
 * rows-survive check fails). The red runs are recorded in VERIFY-4428.md.
 *
 * ISOLATION. The hermetic setup already scrubs the ambient session env; this
 * file additionally deletes every PODIUM_* var except an explicit allowlist
 * (a suite running inside a live Podium session must not inherit its relay,
 * instance, or supervisor identity), mints a fresh state dir + XDG_RUNTIME_DIR
 * + HOME per run (harness CLIs run for real — logged-out, at their login
 * screens — and must never touch the developer's ~/.claude), and restores the
 * process env afterwards. Child envs are built from the scrubbed set.
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { durableSessionLabel } from '@podium/runtime/instance'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { openDatabase } from '@podium/runtime/sqlite'
import { hostHasSession } from '@podium/process/durable'
import type { SessionId } from '@podium/model'
import { CAP_SYNC_HTTP_V1, CLIENT_WIRE_VERSION, encode, parseServerMessage } from '@podium/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startServer } from '../apps/server/src/test-support/enrolled-server'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUN = process.execPath

/** The previous release: the integration base this epic's branch started from. */
const BASE_SHA = '67e96fdcdc385618d3242265206d264c8b7341f1'
const BASE_DIR =
  process.env.PODIUM_UPGRADE_BASE_DIR ?? join(dirname(ROOT), 'podium-upgrade-base-4428')

const INSTANCE = 'up4428'
const PASSWORD = 'upgrade-4428-proof'
const BUN_CONDITIONS = '--conditions=@podium/source'

const savedEnv: Record<string, string | undefined> = {}
let stateDir = ''
let runLogDir = ''
let sockDirForCleanup = ''
const daemonDirs: string[] = []

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs: number,
  detail?: () => string,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await pred()) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `upgrade-4428: timed out waiting for ${what} after ${timeoutMs}ms${detail ? `\n${detail()}` : ''}`,
      )
    }
    await sleep(1000)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      s.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0))
    })
  })
}

function scrubEnv(): NodeJS.ProcessEnv {
  const allow = new Set([
    'PODIUM_STATE_DIR',
    'PODIUM_INSTANCE',
    'PODIUM_HOST',
    'PODIUM_NO_RELAY',
    'PODIUM_NO_SCOPE',
    'PODIUM_ADOPT_STATE',
    'PODIUM_AGENT_HOME',
    'PODIUM_HOST_SOCKET_DIR',
    'PODIUM_HOOK_PORT',
    'PODIUM_AGENT_RELAY_PORT',
    'PODIUM_LOG',
    'XDG_RUNTIME_DIR',
    'HOME',
  ])
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) {
    if (k.startsWith('PODIUM_') && !allow.has(k)) delete env[k]
  }
  return env
}

interface ProcHandle {
  pid: number
  logPath: string
  output: (maxChars?: number) => string
  kill: () => Promise<void>
}

function spawnLogged(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  tag: string,
): ProcHandle {
  let captured = ''
  const logPath = join(runLogDir || stateDir, `log-${tag}.txt`)
  // File-backed first: pipe capture alone has proven lossy across a daemon
  // restart cycle, and a silent child is the worst failure mode here.
  let fileFd: number | undefined
  try {
    fileFd = openSync(logPath, 'a')
  } catch {}
  const child = spawn(BUN, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const note = (c: unknown): void => {
    const s = String(c)
    captured += s
    if (captured.length > 512_000) captured = captured.slice(-256_000)
    if (fileFd !== undefined) {
      try {
        writeSync(fileFd, s)
      } catch {}
    }
  }
  child.stdout?.on('data', note)
  child.stderr?.on('data', note)
  child.on('exit', () => {
    try {
      writeFileSync(logPath, captured)
    } catch {}
    if (fileFd !== undefined) {
      try {
        closeSync(fileFd)
      } catch {}
    }
  })
  if (!child.pid) throw new Error(`upgrade-4428: failed to spawn ${tag}`)
  const pid = child.pid
  return {
    pid,
    logPath,
    output: (maxChars = 12_000) => captured.slice(-maxChars),
    kill: async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) process.kill(-pid, 'SIGKILL')
      } catch {}
      await waitFor(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }, `${tag} pid ${pid} to die`, 15_000, () => `tail:\n${captured.slice(-3000)}`)
      try {
        writeFileSync(logPath, captured)
      } catch {}
    },
  }
}

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

function openDb(ro = true): {
  get: (sql: string, ...params: unknown[]) => unknown
  all: (sql: string, ...params: unknown[]) => unknown[]
  run: (sql: string, ...params: unknown[]) => void
  close: () => void
} {
  const db = openDatabase(join(stateDir, 'podium.db'), ro ? { readOnly: true } : undefined)
  // The servers write constantly (boot, heartbeats, drains); a lock-free
  // read would flake SQLITE_BUSY against them.
  try {
    db.exec('PRAGMA busy_timeout = 15000')
  } catch {}
  return {
    get: (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as unknown,
    all: (sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as unknown[],
    run: (sql: string, ...params: unknown[]) => {
      db.prepare(sql).run(...params)
    },
    close: () => db.close(),
  }
}

/**
 * The previous-release checkout this proof upgrades FROM. Created on demand
 * (worktree + frozen install) and reused while its HEAD still pins BASE_SHA —
 * a green here must mean the real old tree ran, never a skip.
 */
async function ensureBaseTree(): Promise<string> {
  const headOf = (dir: string): string | undefined => {
    try {
      const text = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      return /^[0-9a-f]{40}$/.test(text) ? text : undefined
    } catch {
      return undefined
    }
  }
  const run = async (cmd: string[], cwd: string, what: string, timeoutMs: number): Promise<void> => {
    try {
      execFileSync(cmd[0]!, cmd.slice(1), { cwd, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e: any) {
      throw new Error(
        `upgrade-4428: ${what} failed in ${cwd}:\n${String(e?.stderr ?? e?.message ?? e).slice(-3000)}`,
      )
    }
  }
  if (!existsSync(join(BASE_DIR, 'scripts', 'cli.ts')) || headOf(BASE_DIR) !== BASE_SHA) {
    if (existsSync(BASE_DIR)) {
      throw new Error(
        `upgrade-4428: refusing to run against a non-base checkout at ${BASE_DIR} ` +
          `(HEAD ${headOf(BASE_DIR) ?? 'unknown'}, want ${BASE_SHA}); remove it or set PODIUM_UPGRADE_BASE_DIR`,
      )
    }
    await run(
      ['git', '-C', ROOT, 'worktree', 'add', '--detach', BASE_DIR, BASE_SHA],
      ROOT,
      'base worktree add',
      300_000,
    )
  }
  if (!existsSync(join(BASE_DIR, 'node_modules', '@podium', 'runtime'))) {
    await run([BUN, 'install', '--frozen-lockfile'], BASE_DIR, 'base install', 600_000)
  }
  if (!existsSync(join(BASE_DIR, 'scripts', 'cli.ts'))) {
    throw new Error(`upgrade-4428: base checkout at ${BASE_DIR} has no scripts/cli.ts`)
  }
  return BASE_DIR
}

function apiFor(port: number, cookie?: string): any {
  return createTRPCClient<any>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${port}/trpc`,
        ...(cookie ? { headers: { cookie } } : {}),
      }),
    ],
  })
}

async function login(port: number): Promise<{ api: any; cookie: string }> {
  const base = `http://127.0.0.1:${port}`
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (res.status !== 200) throw new Error(`upgrade-4428: login failed with ${res.status}`)
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
  if (!cookie) throw new Error('upgrade-4428: login set no cookie')
  return { api: apiFor(port, cookie), cookie }
}

function stripLoopbackPublicUrl(): void {
  try {
    const path = join(stateDir, 'config.json')
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof cfg.publicUrl === 'string') {
      delete cfg.publicUrl
      writeFileSync(path, JSON.stringify(cfg))
    }
  } catch {}
}

async function bootOldServer(baseDir: string, port: number): Promise<ProcHandle> {
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(),
    PODIUM_STATE_DIR: stateDir,
    PODIUM_INSTANCE: INSTANCE,
    PODIUM_PORT: String(port),
    PODIUM_HOST: '127.0.0.1',
    PODIUM_NO_RELAY: '1',
    PODIUM_NO_SCOPE: '1',
    PODIUM_ADOPT_STATE: '1',
    PODIUM_AGENT_HOME: join(stateDir, 'agent-home'),
    PODIUM_HOOK_PORT: '0',
    PODIUM_AGENT_RELAY_PORT: '0',
    XDG_RUNTIME_DIR: join(stateDir, 'xdg'),
    HOME: join(stateDir, 'home'),
    PODIUM_LOG: 'daemon:connection=info,daemon=info',
  }
  stripLoopbackPublicUrl()
  const proc = spawnLogged(
    [BUN_CONDITIONS, join(baseDir, 'scripts', 'cli.ts'), '--instance', INSTANCE, 'server', '--takeover'],
    baseDir,
    env,
    'old-server',
  )
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/version`)).ok
    } catch {
      return false
    }
  }, `old server on :${port}`, 180_000, () => `tail:\n${proc.output()}`)
  return proc
}

/** Kill and reboot the old server on the SAME port: the daemon reconnects
 *  transparently and live sessions reattach. Used to install SQL-seeded resume
 *  refs into the server's in-memory sessions (recovery rebuilds them from
 *  rows) before the real hibernate API runs. */
async function rebootOldServer(
  baseDir: string,
  port: number,
  oldServer: ProcHandle,
): Promise<ProcHandle> {
  const pid = oldServer.pid
  await oldServer.kill()
  if (!pidGone(pid)) throw new Error('upgrade-4428: old server pid survived reboot kill')
  return await bootOldServer(baseDir, port)
}

interface DaemonHandle extends ProcHandle {
  dir: string
}

/** A real daemon in its own process, via the tree's own daemon-process entry. */
async function bootDaemon(
  treeDir: string,
  serverPort: number,
  opts: { machineToken?: string; machineId?: string; tag: string },
): Promise<DaemonHandle> {
  const dir = mkdtempSync(join(tmpdir(), `podium-up4428-${opts.tag}-`))
  daemonDirs.push(dir)
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  const daemonOpts: Record<string, unknown> = {
    serverUrl: `ws://127.0.0.1:${serverPort}`,
    ...(opts.machineToken ? { machineToken: opts.machineToken } : {}),
    ...(opts.machineId ? { machineId: opts.machineId } : {}),
    discovery: { background: false, cachePath: join(dir, 'discovery.db'), homeDir: dir },
    metrics: { background: false },
    hooks: { port: 0, settingsDir: join(dir, 'hooks') },
    agentRelay: { port: 0 },
  }
  const readyFile = join(dir, 'daemon.ready')
  writeFileSync(join(dir, 'daemon-config.json'), JSON.stringify({ options: daemonOpts, readyFile }), {
    mode: 0o600,
  })
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(),
    PODIUM_STATE_DIR: stateDir,
    PODIUM_INSTANCE: INSTANCE,
    PODIUM_HOST: '127.0.0.1',
    PODIUM_NO_RELAY: '1',
    PODIUM_NO_SCOPE: '1',
    PODIUM_ADOPT_STATE: '1',
    PODIUM_AGENT_HOME: join(stateDir, 'agent-home'),
    XDG_RUNTIME_DIR: join(stateDir, 'xdg'),
    HOME: join(stateDir, 'home'),
    PODIUM_LOG: 'daemon:*=debug',
  }
  const proc = spawnLogged(
    [BUN_CONDITIONS, join(treeDir, 'tests', 'e2e', 'daemon-process.ts'), join(dir, 'daemon-config.json')],
    treeDir,
    env,
    opts.tag,
  )
  await waitFor(
    () => existsSync(readyFile),
    `${opts.tag} ready file`,
    240_000,
    () => `tail:\n${proc.output()}`,
  )
  return { ...proc, dir }
}

async function waitMachineOnline(api: any, machineId: string, what: string): Promise<void> {
  await waitFor(async () => {
    const machines = await api.machines.list.query().catch(() => [])
    return Array.isArray(machines) && machines.some((m: any) => m.id === machineId && m.online)
  }, `${what} online`, 180_000)
}

async function createSession(api: any, input: Record<string, unknown>): Promise<string> {
  let lastError: unknown
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    try {
      const created = await api.sessions.create.mutate(input)
      const sid = created?.sessionId ?? created?.id
      if (!sid) throw new Error(`no sessionId in ${JSON.stringify(created).slice(0, 200)}`)
      return sid as string
    } catch (e: any) {
      lastError = e
      if (!String(e?.message ?? e).includes('no assigned and available daemon')) throw e
      await sleep(2000)
    }
  }
  throw new Error(`upgrade-4428: sessions.create never found the daemon: ${String(lastError)}`)
}

async function waitStatus(
  api: any,
  sessionId: string,
  status: string,
  what: string,
  timeoutMs = 180_000,
): Promise<any> {
  let last: any
  await waitFor(async () => {
    const list = await api.sessions.list.query().catch(() => [])
    last = Array.isArray(list) ? list.find((s: any) => (s.sessionId ?? s.id) === sessionId) : undefined
    if (last?.status === 'exited' && status === 'live') {
      throw new Error(
        `upgrade-4428: ${what} exited instead of going live: spawnFailure=${String(last?.spawnFailure ?? '').slice(0, 1500)} exitCode=${last?.exitCode}`,
      )
    }
    return last?.status === status
  }, `${what} -> ${status}`, timeoutMs, () => `last: ${JSON.stringify({ ...last, spawnFailure: last?.spawnFailure }).slice(0, 2000)}`)
  return last
}

function sessionMeta(api: any, sessionId: string): Promise<any> {
  return api.sessions.list.query().then((list: any[]) =>
    (Array.isArray(list) ? list : []).find((s: any) => (s.sessionId ?? s.id) === sessionId),
  )
}

/** Attach a real client socket and collect PTY bytes as text. */
async function attachCollector(port: number, sessionId: string, cookie?: string): Promise<{
  text: () => string
  close: () => void
}> {
  let text = ''
  // Setup-completed servers gate the client socket: attach with the login
  // cookie (bare sockets are refused with a non-101, as the first new-phase
  // run showed).
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/client?v=${CLIENT_WIRE_VERSION}&cap=${CAP_SYNC_HTTP_V1}`,
    cookie ? { headers: { cookie } } : undefined,
  )
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  ws.on('error', () => {})
  ws.on('message', (raw: any) => {
    try {
      const msg = parseServerMessage(String(raw)) as any
      if (msg.type === 'outputFrame' && typeof msg.data === 'string') {
        text += Buffer.from(msg.data, 'base64').toString('utf8')
      }
    } catch {}
  })
  ws.send(encode({ type: 'attach', sessionId } as any))
  return { text: () => text, close: () => ws.close() }
}

beforeAll(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PODIUM_')) savedEnv[k] = process.env[k]
  }
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16)}`
  stateDir = join(tmpdir(), `up4428-${tag}`)
  mkdirSync(stateDir, { recursive: true })
  runLogDir = join('/tmp/opencode/4428', `up4428-logs-${tag}`)
  mkdirSync(runLogDir, { recursive: true })
  sockDirForCleanup = join('/tmp', `up4428s-${tag}`)
  const sockDir = sockDirForCleanup
  mkdirSync(sockDir, { recursive: true })
  mkdirSync(join(stateDir, 'home'), { recursive: true })
  mkdirSync(join(stateDir, 'xdg'), { recursive: true })
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ mode: 'all-in-one' }))
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PODIUM_')) delete process.env[k]
  }
  process.env.PODIUM_STATE_DIR = stateDir
  process.env.PODIUM_INSTANCE = INSTANCE
  process.env.PODIUM_HOST = '127.0.0.1'
  process.env.PODIUM_NO_RELAY = '1'
  process.env.PODIUM_NO_SCOPE = '1'
  process.env.PODIUM_ADOPT_STATE = '1'
  process.env.PODIUM_AGENT_HOME = join(stateDir, 'agent-home')
  process.env.PODIUM_HOST_SOCKET_DIR = sockDir
  process.env.XDG_RUNTIME_DIR = join(stateDir, 'xdg')
})

afterAll(() => {
  console.log(`upgrade-4428: stateDir=${stateDir} logs=${runLogDir}`)
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PODIUM_') || k === 'XDG_RUNTIME_DIR') delete process.env[k]
  }
  if (sockDirForCleanup) rmSync(sockDirForCleanup, { recursive: true, force: true })
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v
  }
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

describe('upgrade proof: previous-release sessions open under this build', () => {
  it('reattaches, resumes, relays, drains and answers old sessions', { retry: 0, timeout: 900_000 }, async () => {
    const baseDir = await ensureBaseTree()
    const base = `http://127.0.0.1`
    const oldPort = await freePort()
    let oldServer = await bootOldServer(baseDir, oldPort)
    let oldDaemon: DaemonHandle | undefined
    let newDaemon: DaemonHandle | undefined
    let newServer: Awaited<ReturnType<typeof startServer>> | undefined
    let attemptsPre: number[] = []
    try {
      // -- OLD BUILD: enroll, pair the host identity, boot the old daemon ----
      const anon = apiFor(oldPort)
      await anon.setup.complete.mutate({ publicUrl: `${base}:${oldPort}`, password: PASSWORD })
      const { api: oldApi } = await login(oldPort)
      const hostId = readOrCreateLocalMachineId()
      oldDaemon = await bootDaemon(baseDir, oldPort, { machineId: hostId, tag: 'old-daemon' })
      await waitMachineOnline(oldApi, hostId, 'old daemon')

      const cwd = join(stateDir, 'work')
      mkdirSync(cwd, { recursive: true })

      // (1) live harness session through the old driver path.
      const sHarness = await createSession(oldApi, {
        agentKind: 'claude-code',
        cwd,
        runtimeContract: 'generic-pty',
      })
      await waitStatus(oldApi, sHarness, 'live', 'old harness session')
      const oldHarnessMeta = await sessionMeta(oldApi, sHarness)
      expect(oldHarnessMeta?.driverId, 'old build binds the driver').toBe('generic-pty')

      // (2) hibernated harness session with selected_driver_id NULL.
      //
      // A grok + generic-pty session. hibernate() requires a resume ref, and
      // no model-less box can get a harness-minted one (terminal harnesses
      // report it after turns; server families need login; the SDK needs
      // auth) — so the ref is seeded with the exact shape sessionResumeRef
      // would carry (kind from the manifest's resumeKind). The PARK itself
      // (status flip, process kill, row shape) is the real old API, and the
      // NULL driver column is the documented old-row shape. Post-upgrade,
      // resurrect spawns `grok --resume <ref>`; grok tolerates an unresolvable
      // ref by staying alive (verified by hand), so the session genuinely
      // returns to live with a driver.
      const sHib = await createSession(oldApi, {
        agentKind: 'grok',
        cwd,
        runtimeContract: 'generic-pty',
      })
      await waitStatus(oldApi, sHib, 'live', 'hibernation candidate')
      {
        const db = openDb(false)
        try {
          db.run(
            'UPDATE sessions SET resume_kind = ?, resume_value = ? WHERE id = ?',
            'grok-session',
            `up4428-${sHib.slice(0, 8)}`,
            sHib,
          )
        } finally {
          db.close()
        }
      }

      // (3) live shell. (4) login shell.
      const sShell = await createSession(oldApi, { agentKind: 'shell', cwd })
      await waitStatus(oldApi, sShell, 'live', 'old shell')
      const loginAttempt = await oldApi.accounts.login.mutate({ harness: 'claude-code' })
      const sLogin = loginAttempt?.sessionId as string
      expect(sLogin, 'login returns a session').toBeTruthy()
      await waitStatus(oldApi, sLogin, 'live', 'old login shell')

      // (5) a second parked grok session. Same seeded-ref shape as (2): the
      // ref (seeded BEFORE the restart, installed by it) unlocks the real
      // hibernate call, and parked rows are written by resumeAndSend (which
      // queueTexts for non-live sessions — sendText would wake-and-deliver).
      // A parked drain HOLDS rows without typing or forwarding, so both rows
      // sit deterministically; the post-upgrade bind is their first delivery.
      const sQueue = await createSession(oldApi, {
        agentKind: 'grok',
        cwd,
        runtimeContract: 'generic-pty',
      })
      await waitStatus(oldApi, sQueue, 'live', 'queue candidate')
      const t1 = `up4428-first-${sQueue.slice(0, 8)}`
      const t2 = `up4428-second-${sQueue.slice(0, 8)}`
      {
        const db = openDb(false)
        try {
          db.run(
            'UPDATE sessions SET resume_kind = ?, resume_value = ? WHERE id = ?',
            'grok-session',
            `up4428-${sQueue.slice(0, 8)}`,
            sQueue,
          )
        } finally {
          db.close()
        }
      }

      // Install the seeded refs into memory via a real server restart cycle.
      oldServer = await rebootOldServer(baseDir, oldPort, oldServer)
      await waitStatus(oldApi, sHarness, 'live', 'harness session after old restart')
      await waitStatus(oldApi, sHib, 'live', 'hibernation candidate after old restart')
      await waitStatus(oldApi, sQueue, 'live', 'queue session after old restart')
      const hibRes2 = await oldApi.sessions.hibernate.mutate({ sessionId: sHib })
      expect(hibRes2, `(2) hibernate refused: ${JSON.stringify(hibRes2).slice(0, 300)}`).toMatchObject({ ok: true })
      await waitStatus(oldApi, sHib, 'hibernated', 'hibernated session')
      const qhibRes = await oldApi.sessions.hibernate.mutate({ sessionId: sQueue })
      expect(qhibRes, `(5) hibernate refused: ${JSON.stringify(qhibRes).slice(0, 300)}`).toMatchObject({ ok: true })
      await waitStatus(oldApi, sQueue, 'hibernated', 'queue session parked')
      // Both rows are INSERTED, not sent: every send API wakes a parked
      // session (queueText auto-resurrects; the seam wakes-and-delivers), and
      // a woken session drains through legacy typing which echo-deletes the
      // rows. The insert carries exactly the columns queueText's enqueue
      // writes (same order, attempts 0, no delegation) — shape-exact, only
      // the trigger synthetic. Nothing drains a parked session pre-upgrade
      // (parked drains hold; the sweep holds too), so the rows freeze.
      {
        const db = openDb(false)
        try {
          const admin = db.get("SELECT id AS id FROM users WHERE role = 'admin' LIMIT 1") as any
          const adminId = admin?.id as string
          expect(adminId, '(5) admin user exists for row principal').toBeTruthy()
          const now = Date.now()
          // The attribution triple must be complete: authorizeAtDrain
          // re-resolves actor==onBehalfOf==user against the live world, and a
          // NULL on_behalf_of refuses (then deletes) the row at drain.
          const ins = (id: string, text: string, at: number): void => {
            db.run(
              'INSERT INTO queued_messages (id, session_id, text, queued_at, input_origin, attempts, principal_kind, principal_ref, delegation_ref, actor_kind, actor_id, on_behalf_of, source_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              id,
              sQueue,
              text,
              at,
              'controller',
              0,
              'user',
              adminId,
              null,
              'user',
              adminId,
              adminId,
              null,
            )
          }
          ins(`qmsg_up4428_${sQueue.slice(0, 8)}_1`, t1, now)
          ins(`qmsg_up4428_${sQueue.slice(0, 8)}_2`, t2, now + 1)
        } finally {
          db.close()
        }
      }
      await waitFor(
        () => {
          const db = openDb()
          try {
            const rows = db.all(
              'SELECT text, attempts FROM queued_messages WHERE session_id = ? ORDER BY queued_at ASC',
              sQueue,
            ) as any[]
            return rows.length === 2 && rows[0]?.text === t1 && rows[1]?.text === t2
          } finally {
            db.close()
          }
        },
        '(5) two rows queued while parked',
        15_000,
      )

      // (6) live harness session with a pending native-menu interaction row.
      // The ask itself is driver-emitted, so only its trigger is synthetic:
      // the row below carries exactly the columns InteractionService.ask
      // inserts (id, session, kind, payload, source, answerable, fingerprint,
      // status asked, asked_at).
      const sMenu = await createSession(oldApi, {
        agentKind: 'claude-code',
        cwd,
        runtimeContract: 'generic-pty',
      })
      await waitStatus(oldApi, sMenu, 'live', 'menu session')
      const ixnId = `ixn_up4428_${sMenu.slice(0, 8)}`
      const askedAt = new Date().toISOString()
      {
        const db = openDb(false)
        try {
          db.run(
            'INSERT INTO pending_interactions (id, session_id, kind, payload_json, source, answerable, fingerprint, status, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ixnId,
            sMenu,
            'question',
            JSON.stringify({
              questions: [
                {
                  question: 'Pick one for the upgrade proof',
                  header: '',
                  multiSelect: false,
                  options: [{ label: 'alpha-4428' }, { label: 'beta-4428' }],
                },
              ],
            }),
            'hook',
            1,
            `fp-up4428-${sMenu}`,
            'asked',
            askedAt,
          )
        } finally {
          db.close()
        }
      }
      // NULL the driver column as the LAST old-phase act: any server write
      // (reattach fills, hibernate persists the live draft) refills it from
      // the in-memory session, so only a NULL postdating every old write
      // reaches the upgrade in the old-row shape.
      {
        const db = openDb(false)
        try {
          db.run('UPDATE sessions SET selected_driver_id = NULL WHERE id = ?', sHib)
        } finally {
          db.close()
        }
      }
      // Old-build state, read back from the same file the new build will open.
      {
        const db = openDb()
        try {
          const nullDriver = db.get('SELECT selected_driver_id AS d FROM sessions WHERE id = ?', sHib) as any
          expect(nullDriver?.d, 'hibernated row carries NULL driver').toBeNull()
          const rows = db.all(
            'SELECT id, text, attempts FROM queued_messages WHERE session_id = ? ORDER BY queued_at ASC',
            sQueue,
          ) as any[]
          expect(rows.map((r) => r.text)).toEqual([t1, t2])
          // attempts counts forwards (legacy typing attempts pre-upgrade, the
          // reservation post-upgrade). Snapshot it: the post-drain assertion
          // below requires EXACTLY one more forward per row, whatever the
          // pre-upgrade history is.
          attemptsPre = rows.map((r) => r.attempts as number)
          const ixn = db.get('SELECT status FROM pending_interactions WHERE id = ?', ixnId) as any
          expect(ixn?.status, 'interaction row pending').toBe('asked')
          const loginRow = db.get('SELECT agent_kind AS k, login_harness AS h FROM sessions WHERE id = ?', sLogin) as any
          expect(loginRow?.k, 'login row is a shell').toBe('shell')
          expect(loginRow?.h, 'login row names its harness').toBe('claude-code')
        } finally {
          db.close()
        }
      }

      // -- CUTOVER: old processes die, hosts survive -------------------------
      if (oldDaemon) {
        const oldDaemonPid2 = oldDaemon.pid
        await oldDaemon.kill()
        expect(pidGone(oldDaemonPid2), 'old daemon pid is gone before the new one attaches').toBe(true)
        oldDaemon = undefined
      }
      const oldServerPid = oldServer.pid
      await oldServer.kill()
      expect(pidGone(oldServerPid), 'old server pid is gone').toBe(true)
      // Live sessions hold hosts at cutover (hibernate kills sHib's host by
      // design, so it is logged, not asserted).
      // sQueue's host may not have materialized in the ~1s before the kill:
      // present => reattach adopts it, absent => the new build spawns fresh.
      // Both converge to live; the assertion set covers both.
      // sHib and sQueue are hibernated (hosts killed by hibernate): logged,
      // not asserted. The four live sessions prove hosts outlive the daemon.
      for (const [sid, why] of [
        [sHib, 'hibernate kill by design'],
        [sQueue, 'hibernate kill by design'],
      ] as const) {
        console.log(
          `upgrade-4428: host present at cutover for ${sid.slice(0, 8)} (${why}): ${await hostHasSession(durableSessionLabel(sid as SessionId, INSTANCE))}`,
        )
      }
      for (const sid of [sHarness, sShell, sLogin, sMenu]) {
        const label = durableSessionLabel(sid as SessionId, INSTANCE)
        expect(await hostHasSession(label), `host survives for ${sid.slice(0, 8)}`).toBe(true)
      }
      // -- NEW BUILD takes over the same state dir and DB --------------------
      stripLoopbackPublicUrl()
      newServer = await startServer({ port: 0 })
      const newPort = (newServer as unknown as { port: number }).port
      {
        const db = openDb()
        try {
          const cols = db.all('PRAGMA table_info(queued_messages)') as any[]
          expect(cols.map((c) => c.name)).toContain('delivery_owner')
        } finally {
          db.close()
        }
      }
      const { api: newApi, cookie: newCookie } = await login(newPort)
      newDaemon = await bootDaemon(ROOT, newPort, {
        machineToken: (newServer as unknown as { machineToken: string }).machineToken,
        machineId: hostId,
        tag: 'new-daemon',
      })
      await waitMachineOnline(newApi, hostId, 'new daemon')

      // (1) reattached with a driver announced in bind.
      {
        const meta = await waitStatus(newApi, sHarness, 'live', 'upgraded harness')
        expect(meta?.driverId, '(1) driver announced in bind').toBe('generic-pty')
        // NOTE: the derived in-memory runtimeContract flag is transient and
        // not projected on the list meta; driverId on the bind IS the wire
        // signal (daemon-lifecycle derives the flag from exactly this), and
        // selected_driver_id below is its durable proof.
        const db = openDb()
        try {
          const row = db.get('SELECT selected_driver_id AS d, status AS s FROM sessions WHERE id = ?', sHarness) as any
          expect(row?.d, '(1) driver persisted').toBe('generic-pty')
          expect(row?.s).toBe('live')
        } finally {
          db.close()
        }
      }

      // (2) hibernated, resumable; resume announces the driver and fills the column.
      {
        const meta = await sessionMeta(newApi, sHib)
        expect(meta?.status, '(2) still hibernated, not reaped').toBe('hibernated')
        await newApi.sessions.resurrect.mutate({ sessionId: sHib })
        const live = await waitStatus(newApi, sHib, 'live', 'resumed hibernated session', 180_000)
        expect(live?.driverId, '(2) driver announced after resume').toBe('generic-pty')
        const db = openDb()
        try {
          const row = db.get('SELECT selected_driver_id AS d FROM sessions WHERE id = ?', sHib) as any
          expect(row?.d, '(2) driver column filled').toBe('generic-pty')
        } finally {
          db.close()
        }
      }

      // (3) a plain shell relays end to end: a marker written through the
      // server's sendText echoes back through the output frames.
      {
        const marker = `up4428-shell-${sShell.slice(0, 8)}`
        const meta = await waitStatus(newApi, sShell, 'live', 'upgraded (3) shell')
        expect(meta?.agentKind, '(3) still a shell').toBe('shell')
        expect(meta?.driverId ?? null, '(3) driverless').toBeNull()
        const collector = await attachCollector(newPort, sShell, newCookie)
        try {
          await newApi.sessions.sendText.mutate({ sessionId: sShell, text: `echo ${marker}` })
          await waitFor(
            () => collector.text().includes(marker),
            '(3) echo through the server output log',
            60_000,
          )
        } finally {
          collector.close()
        }
      }
      // (4) a login shell keeps its shape and a live relay. Its PTY runs the
      // harness's own auth flow (`claude auth login`), NOT a shell — so no
      // echo is possible by design ((3) covers echo semantics). What the
      // upgrade must preserve is the login shape (shell + loginHarness, no
      // driver) with frames flowing both directions.
      {
        const meta = await waitStatus(newApi, sLogin, 'live', 'upgraded (4) login shell')
        expect(meta?.agentKind, '(4) still a shell').toBe('shell')
        expect(meta?.driverId ?? null, '(4) driverless').toBeNull()
        const db = openDb()
        try {
          const row = db.get('SELECT login_harness AS h FROM sessions WHERE id = ?', sLogin) as any
          expect(row?.h, '(4) login harness preserved').toBe('claude-code')
        } finally {
          db.close()
        }
        const collector = await attachCollector(newPort, sLogin, newCookie)
        try {
          await waitFor(
            () => collector.text().length > 0,
            '(4) output frames flow',
            60_000,
          )
          const res = (await newApi.sessions.sendText.mutate({
            sessionId: sLogin,
            text: 'up4428-login-write-probe',
          })) as any
          expect(res?.ok, '(4) write path accepts').toBe(true)
        } finally {
          collector.close()
        }
      }

      // (5) the two rows drain through the gateway exactly once, in order.
      //
      // The reservation precedes every forward, and the drain forwards
      // head-first awaiting each receipt — so row 1's owner flips strictly
      // before row 2's, seconds apart (one verification window). Polling the
      // owners at 1s observes that order directly; PTY bytes cannot (the
      // resurrected grok sits at its restore screen, not a composer). Without
      // a model turn there is no delivery proof, so the rows stay queued; the
      // 30s quiet afterwards proves no second forward. A legacy retype would
      // have deleted the rows instead — the 4427-reverted red detector.
      {
        // The owner poll starts BEFORE the resurrect (both NULL guaranteed)
        // at 250ms — the forwards land seconds apart (one verification
        // window each), so the transition order is observed, not inferred.
        let tRow1Set = 0
        let tRow2Set = 0
        const pollOwners = (): boolean => {
          const db = openDb()
          try {
            const rows = db.all(
              'SELECT text, delivery_owner FROM queued_messages WHERE session_id = ? ORDER BY queued_at ASC',
              sQueue,
            ) as any[]
            const now = Date.now()
            if (!tRow1Set && rows[0]?.delivery_owner === 'daemon') tRow1Set = now
            if (!tRow2Set && rows[1]?.delivery_owner === 'daemon') tRow2Set = now
            return tRow1Set > 0 && tRow2Set > 0
          } finally {
            db.close()
          }
        }
        if (pollOwners()) throw new Error('upgrade-4428: rows already reserved pre-resurrect')
        await newApi.sessions.resurrect.mutate({ sessionId: sQueue })
        // The owner poll runs CONCURRENTLY with the live-wait: the justBound
        // drain starts at bind, possibly before live is visible, and both
        // reserves would land before a sequential poll ever starts. At 250ms
        // against ~5s-apart forwards, the transition order is observed.
        await Promise.all([
          waitStatus(newApi, sQueue, 'live', 'resumed queue session'),
          (async () => {
            const deadline = Date.now() + 120_000
            while (!pollOwners()) {
              if (Date.now() > deadline) {
                throw new Error('upgrade-4428: timed out waiting for both rows reserved post-upgrade')
              }
              await sleep(250)
            }
          })(),
        ])
        expect(tRow1Set, '(5) row 1 reserved').toBeGreaterThan(0)
        expect(tRow2Set, '(5) row 2 reserved').toBeGreaterThan(0)
        expect(tRow1Set < tRow2Set, '(5) FIFO order: row 1 reserved before row 2').toBe(true)
        const db = openDb()
        try {
          const rows = db.all(
            'SELECT id, text, attempts, delivery_owner FROM queued_messages WHERE session_id = ? ORDER BY queued_at ASC',
            sQueue,
          ) as any[]
          expect(rows.map((r) => r.text), '(5) no row lost').toEqual([t1, t2])
          expect(
            rows.map((r) => r.delivery_owner),
            '(5) new gateway reserved both rows',
          ).toEqual(['daemon', 'daemon'])
          expect(
            rows.map((r) => r.attempts),
            `(5) attempts clamped, never reset (pre ${JSON.stringify(attemptsPre)})`,
          ).toEqual(attemptsPre.map((a) => Math.max(a, 1)))
        } finally {
          db.close()
        }
        await sleep(30_000)
        {
          const db = openDb()
          try {
            const again = db.all(
              'SELECT text, delivery_owner FROM queued_messages WHERE session_id = ? ORDER BY queued_at ASC',
              sQueue,
            ) as any[]
            expect(again.map((r) => r.text), '(5) still exactly two rows').toEqual([t1, t2])
            expect(
              again.map((r) => r.delivery_owner),
              '(5) owners undisturbed',
            ).toEqual(['daemon', 'daemon'])
          } finally {
            db.close()
          }
        }
      }

      // (6) gateway.answer resolves the interaction.
      //
      // Honest semantics, stated plainly: no model ever turned in this
      // session, so the new daemon's driver never OBSERVED this menu — its
      // interaction map has no entry for it, and populating that map has no
      // production path (asks flow daemon -> server only). The driver
      // therefore answers unknown-interaction, and the server keeps the row
      // as claimed (answered, delivery unverified) rather than reporting an
      // ok:true that would claim keystrokes landed on a menu nobody saw.
      // What this pins is everything the UPGRADE could break: the old row is
      // still asked and answerable, the answer traverses the gateway to the
      // real driver and back, the claim settles exactly once (a second answer
      // loses the first-wins race), and nothing is typed twice.
      {
        const open = await newApi.interactions.forSession.query({ sessionId: sMenu })
        const rows = Array.isArray(open) ? open : (open as any)?.rows ?? []
        expect(rows.some((r: any) => (r.id ?? r.interactionId) === ixnId), '(6) ask still open').toBe(true)
        const outcome = (await newApi.interactions.answer.mutate({
          id: ixnId,
          answer: { kind: 'question', selections: [{ optionIndices: [0] }] },
        })) as any
        expect(outcome?.reason, `(6) driver truthfully reports: ${JSON.stringify(outcome).slice(0, 200)}`).toBe(
          'unknown-interaction',
        )
        const db = openDb()
        try {
          const row = db.get(
            'SELECT status AS s, answer_json AS a, delivered_via AS v FROM pending_interactions WHERE id = ?',
            ixnId,
          ) as any
          expect(row?.s, '(6) row claimed').toBe('answered')
          expect(String(row?.a ?? ''), '(6) answer recorded').toContain('optionIndices')
          const second = (await newApi.interactions.answer.mutate({
            id: ixnId,
            answer: { kind: 'question', selections: [{ optionIndices: [1] }] },
          })) as any
          expect(second?.reason, '(6) first answer wins').toBe('already-answered')
          void row?.v
        } finally {
          db.close()
        }
      }
    } finally {
      try {
        const { copyFileSync, existsSync } = await import('node:fs')
        // Copy the WAL pair too: recent writes (including the whole
        // post-upgrade phase) may live only there.
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
          const src = join(stateDir, `podium.db${suffix}`)
          if (stateDir && existsSync(src)) {
            try {
              copyFileSync(src, join(runLogDir, `final-podium.db${suffix}`))
            } catch {}
          }
        }
      } catch {}
      if (newDaemon) {
        await newDaemon.kill().catch(() => {})
      }
      try {
        const { killHostSession } = await import('@podium/process/durable')
        for (const sid of [sHarness, sHib, sShell, sLogin, sQueue, sMenu]) {
          try {
            await killHostSession(durableSessionLabel(sid as SessionId, INSTANCE))
          } catch {}
        }
      } catch {}
      for (const d of daemonDirs.splice(0)) rmSync(d, { recursive: true, force: true })
      if (newServer) await newServer.close().catch(() => {})
      try {
        oldDaemon && (await oldDaemon.kill().catch(() => {}))
      } catch {}
      try {
        await oldServer.kill().catch(() => {})
      } catch {}
    }
  })
})
