/**
 * POD-2873 — daemon restart reattach with the creator's agent HOME.
 *
 * This is a real split server/daemon drive, not a unit test.  The shell wrapper
 * puts each arm in its own mount namespace so the product can use its natural
 * HOME and default state resolver without touching the operator's instance.
 * The driver creates one shell terminal, records the whole server row and a
 * direct socket walk, restarts only the daemon, and reads both surfaces again.
 *
 * `POD2873_EXPECT=legacy` is the pre-fix control: it must show the old
 * session-not-found reattach result.  The fixed arms require a live row, no
 * spawn failure, and a live socket after the restart.
 */

import { Database } from 'bun:sqlite'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { hostname, homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { loadConfig, resolveAgentHomeDir, saveConfig } from '@podium/runtime/config'
import { instanceAbducoSocketRoots } from '@podium/runtime/abduco-socket'
import { instanceStateDir } from '@podium/runtime/instance'

type JsonObject = Record<string, unknown>

const ARM = process.env.POD2873_ARM ?? 'unnamed-arm'
const EXPECT = process.env.POD2873_EXPECT ?? 'fixed'
const ARM_ROOT = process.env.POD2873_ARM_ROOT
if (!ARM_ROOT) throw new Error('POD2873_ARM_ROOT is required')

const SOURCE_REPO = process.env.POD2873_SOURCE_REPO
if (!SOURCE_REPO) throw new Error('POD2873_SOURCE_REPO is required')
const SOURCE_SHA = process.env.POD2873_SOURCE_SHA ?? '(not supplied)'
const INSTANCE = process.env.PODIUM_INSTANCE ?? 'default'
const HOST = process.env.PODIUM_HOST ?? '127.0.0.1'
const PORT = Number(process.env.PODIUM_PORT)
const BASE = `http://${HOST}:${PORT}`
const PASSWORD = process.env.PODIUM_PASSWORD ?? 'pod2873'
const WORKDIR = join(ARM_ROOT, 'working-directory')
const STATE = instanceStateDir(INSTANCE, process.env)
const DB_PATH = join(STATE, 'podium.db')
const AGENT_HOME = resolveAgentHomeDir(loadConfig(), process.env)
const USERNAME = userInfo().username

if (!Number.isInteger(PORT) || PORT < 1024) throw new Error(`invalid PODIUM_PORT=${PORT}`)
if (process.env.PODIUM_STATE_DIR) throw new Error('rig refuses PODIUM_STATE_DIR')
if (process.env.ABDUCO_SOCKET_DIR) throw new Error('rig refuses ABDUCO_SOCKET_DIR')
if (process.env.TMUX_TMPDIR) throw new Error('rig refuses TMUX_TMPDIR')
if (!process.env.HOME) throw new Error('rig requires the natural HOME environment')
if (INSTANCE === 'default' && EXPECT === 'fixed' && ARM.includes('custom') && AGENT_HOME === process.env.HOME) {
  throw new Error('custom-default arm did not resolve a distinct PODIUM_AGENT_HOME')
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString()
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? Number(item) : item))

const componentLog = (name: 'server' | 'daemon') => join(ARM_ROOT, `${name}.log`)
const appendMarker = (name: 'server' | 'daemon', marker: string) => {
  appendFileSync(componentLog(name), `${marker}\n`)
}

const boot = (name: 'server' | 'daemon'): ChildProcess => {
  const log = componentLog(name)
  mkdirSync(ARM_ROOT, { recursive: true })
  const marker = `=== boot ${name} source_sha=${SOURCE_SHA} at=${stamp()} ===`
  appendMarker(name, marker)
  const fd = openSync(log, 'a')
  const child = spawn(process.execPath, ['--conditions=@podium/source', `scripts/${name}.ts`], {
    cwd: SOURCE_REPO,
    env: { ...process.env },
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  console.log(`${stamp()} booted ${name} pid=${child.pid ?? '?'} source_sha=${SOURCE_SHA}`)
  return child
}

const childExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

const stop = async (child: ChildProcess | undefined, name: string) => {
  if (!child || childExited(child)) return
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 5_000
  while (!childExited(child) && Date.now() < deadline) await wait(100)
  if (!childExited(child)) {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
    await wait(200)
  }
  console.log(`${stamp()} stopped ${name} pid=${child.pid ?? '?'}`)
}

const waitFor = async (predicate: () => boolean, timeoutMs: number, intervalMs = 250) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await wait(intervalMs)
  }
  return predicate()
}

const waitForHealth = async () => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) return
    } catch {
      // boot in progress
    }
    await wait(250)
  }
  throw new Error(`server never served ${BASE}/health; see ${componentLog('server')}`)
}

const waitForLog = async (name: 'server' | 'daemon', text: string, timeoutMs: number) => {
  const path = componentLog(name)
  const ok = await waitFor(() => {
    try {
      return readFileSync(path, 'utf8').includes(text)
    } catch {
      return false
    }
  }, timeoutMs, 250)
  if (!ok) throw new Error(`${name} never logged ${JSON.stringify(text)}; see ${path}`)
}

let cookie = ''
const login = async () => {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`)
  const values = response.headers.getSetCookie?.() ?? []
  cookie = values.map((value) => value.split(';')[0]).join('; ')
  if (!cookie) throw new Error('login returned no session cookie')
}

const mutate = async (path: string, input: unknown): Promise<JsonObject> => {
  const response = await fetch(`${BASE}/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(input),
  })
  return (await response.json()) as JsonObject
}

const query = async (path: string, input: unknown): Promise<JsonObject> => {
  const url = `${BASE}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
  const response = await fetch(url, { headers: { cookie } })
  return (await response.json()) as JsonObject
}

const apiStatus = async (sessionId: string): Promise<JsonObject | undefined> => {
  const response = await query('sessions.status', { ref: sessionId })
  const result = response.result as JsonObject | undefined
  return result?.data as JsonObject | undefined
}

/** Read the complete persisted session row, including spawn_failure. */
const dbRow = (sessionId: string): JsonObject | undefined => {
  if (!existsSync(DB_PATH)) return undefined
  try {
    const db = new Database(DB_PATH, { readonly: true })
    try {
      return db.query('select * from sessions where id = ?').get(sessionId) as JsonObject | undefined
    } finally {
      db.close()
    }
  } catch {
    // The server can hold the file during its first migration; the next poll can read it.
    return undefined
  }
}

const statusValue = (api: JsonObject | undefined, row: JsonObject | undefined) =>
  String(row?.status ?? api?.status ?? '?')
const isLive = (api: JsonObject | undefined, row: JsonObject | undefined) =>
  statusValue(api, row) === 'live' || statusValue(api, row) === 'running'

const waitForSpawn = async (sessionId: string) => {
  let api: JsonObject | undefined
  let row: JsonObject | undefined
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    api = await apiStatus(sessionId)
    row = dbRow(sessionId)
    if (row?.spawn_failure || isLive(api, row)) return { api, row }
    await wait(500)
  }
  return { api: await apiStatus(sessionId), row: dbRow(sessionId) }
}
const waitForReattach = async (sessionId: string) => {
  const startedAt = Date.now()
  const deadline = startedAt + 20_000
  let api: JsonObject | undefined
  let row: JsonObject | undefined
  while (Date.now() < deadline) {
    api = await apiStatus(sessionId)
    row = dbRow(sessionId)
    const status = statusValue(api, row)
    const terminal = status !== 'live' && status !== 'running' && status !== 'reconnecting'
    if ((EXPECT === 'legacy' && terminal) || (EXPECT !== 'legacy' && (isLive(api, row) || row?.spawn_failure || terminal))) {
      return { api, row, status, elapsedMs: Date.now() - startedAt }
    }
    await wait(500)
  }
  api = await apiStatus(sessionId)
  row = dbRow(sessionId)
  return { api, row, status: statusValue(api, row), elapsedMs: Date.now() - startedAt }
}

interface SocketDirReading {
  why: string
  dir: string
  exists: boolean
  matches: string[]
}

interface SocketReading {
  dirs: SocketDirReading[]
  sockets: { path: string; live: boolean; bytes: number; why: string }[]
}

/**
 * Directly read every root the create/probe chain could use.  This deliberately
 * does not call Podium's socket resolver.  Each directory is read once per
 * snapshot, and only the exact session label is retained from its listing.
 */
const socketDirs = (): { why: string; dir: string }[] => {
  const candidates: { why: string; dir: string }[] = []
  if (INSTANCE !== 'default') {
    for (const root of instanceAbducoSocketRoots(INSTANCE, process.env)) {
      candidates.push({ why: `named socket-root candidate ${root}`, dir: join(root, 'abduco', USERNAME) })
    }
  }
  candidates.push({ why: 'agent HOME/.abduco', dir: join(AGENT_HOME, '.abduco') })
  candidates.push({ why: 'daemon HOME/.abduco', dir: join(process.env.HOME as string, '.abduco') })
  if (process.env.TMPDIR) {
    candidates.push({ why: 'TMPDIR/abduco/<user>', dir: join(process.env.TMPDIR, 'abduco', USERNAME) })
  }
  candidates.push({ why: '/tmp/abduco/<user>', dir: join('/tmp', 'abduco', USERNAME) })
  const seen = new Set<string>()
  return candidates.filter(({ dir }) => {
    if (seen.has(dir)) return false
    seen.add(dir)
    return true
  })
}

const scanSockets = (label: string): SocketReading => {
  const dirs: SocketDirReading[] = []
  const sockets: SocketReading['sockets'] = []
  for (const candidate of socketDirs()) {
    let names: string[]
    try {
      names = readdirSync(candidate.dir)
    } catch {
      dirs.push({ ...candidate, exists: false, matches: [] })
      continue
    }
    const matches = names.filter((name) => name === label || name.startsWith(`${label}@`))
    dirs.push({ ...candidate, exists: true, matches })
    for (const name of matches) {
      const path = join(candidate.dir, name)
      try {
        const mode = statSync(path).mode
        sockets.push({
          path,
          live: (mode & 0o010) === 0,
          bytes: Buffer.byteLength(path, 'utf8'),
          why: candidate.why,
        })
      } catch {
        // The master exited between readdir and stat.
      }
    }
  }
  return { dirs, sockets }
}

const printSockets = (reading: SocketReading) => {
  for (const dir of reading.dirs) {
    console.log(`  scanned ${dir.exists ? 'present' : 'absent'} ${dir.dir} (${dir.why})`)
    if (dir.matches.length > 0) console.log(`    matching entries ${json(dir.matches)}`)
  }
  if (reading.sockets.length === 0) {
    console.log('  no socket carrying this label in the scanned surface')
  } else {
    for (const socket of reading.sockets) {
      console.log(
        `  ${socket.live ? 'LIVE' : 'terminated'} ${socket.path} (${socket.bytes} bytes; ${socket.why})`,
      )
    }
  }
}

const processIdsForLabel = (label: string): number[] => {
  try {
    const output = Bun.spawnSync(['ps', '-eo', 'pid=,args=']).stdout.toString()
    const pids: number[] = []
    for (const line of output.split('\n')) {
      if (!line.includes(`-n ${label} `)) continue
      const match = /^\s*(\d+)\s+/.exec(line)
      if (match) pids.push(Number(match[1]))
    }
    return pids.filter((pid) => pid !== process.pid)
  } catch {
    return []
  }
}

const killLabel = async (label: string) => {
  for (const pid of processIdsForLabel(label)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  await wait(500)
  for (const pid of processIdsForLabel(label)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

const printSnapshot = (
  title: string,
  api: JsonObject | undefined,
  row: JsonObject | undefined,
  sockets: SocketReading,
) => {
  console.log(`\n--- ${title} ---------------------------------------------`)
  console.log(`  API status      ${statusValue(api, undefined)}`)
  console.log(`  DB status       ${statusValue(undefined, row)}`)
  console.log(`  API row (full)  ${json(api ?? null)}`)
  console.log(`  DB row (full)   ${json(row ?? null)}`)
  console.log('  direct sockets (whole scanned surface)')
  printSockets(sockets)
}

let daemon: ChildProcess | undefined
let server: ChildProcess | undefined
let sessionId: string | undefined
let durableLabel: string | undefined

const cleanup = async () => {
  if (sessionId) {
    try {
      await mutate('sessions.kill', { sessionId })
    } catch {
      // The server may already be down; exact-label cleanup below is the fallback.
    }
  }
  if (durableLabel) await killLabel(durableLabel)
  await stop(daemon, 'daemon')
  await stop(server, 'server')
}

const main = async () => {
  console.log(`\n=== POD-2873 ${ARM} ================================================`)
  console.log(`  source SHA       ${SOURCE_SHA}`)
  console.log(`  server/daemon    ${SOURCE_REPO}`)
  console.log(`  web bundle       not loaded (direct API terminal drive)`)
  console.log(`  instance         ${INSTANCE}`)
  console.log(`  HOME             ${process.env.HOME} (natural; not overridden)`)
  console.log(`  agent HOME       ${AGENT_HOME}${AGENT_HOME === process.env.HOME ? ' (same)' : ' (distinct)'}`)
  console.log(`  state root       ${STATE} (product-derived; PODIUM_STATE_DIR unset)`)
  console.log(`  socket override  ${process.env.ABDUCO_SOCKET_DIR ?? '<unset>'}`)
  console.log(`  endpoints        ${BASE} hook=${process.env.PODIUM_HOOK_PORT} relay=${process.env.PODIUM_AGENT_RELAY_PORT}`)
  console.log(`  expectation       ${EXPECT}`)
  console.log(`  working directory ${WORKDIR}`)

  mkdirSync(WORKDIR, { recursive: true, mode: 0o700 })

  // First-run setup through the runtime writer used by `podium setup`; no
  // config.json or instance marker is fabricated by the shell rig.
  saveConfig({ ...loadConfig(), mode: 'all-in-one' })
  mkdirSync(AGENT_HOME, { recursive: true, mode: 0o700 })
  // Seed the already-built vendored binary only AFTER the named state root is
  // claimed.  Putting it there before saveConfig would make a named root look
  // like an attempted adoption of someone else's non-empty state.
  const stagedAbduco = join(ARM_ROOT, 'abduco')
  const cachePath = join(STATE, 'bin', 'abduco')
  if (!existsSync(stagedAbduco)) throw new Error(`missing staged abduco binary: ${stagedAbduco}`)
  mkdirSync(join(STATE, 'bin'), { recursive: true, mode: 0o700 })
  copyFileSync(stagedAbduco, cachePath)

  server = boot('server')
  await waitForHealth()
  console.log(`${stamp()} server healthy on ${BASE}`)

  daemon = boot('daemon')
  await waitForLog('daemon', 'podium daemon up: connected to', 30_000)
  console.log(`${stamp()} daemon connected to server`)
  await login()

  const created = await mutate('sessions.create', { cwd: WORKDIR, agentKind: 'shell' })
  const createdResult = created.result as JsonObject | undefined
  const createdData = createdResult?.data as JsonObject | undefined
  sessionId = createdData?.sessionId as string | undefined
  if (!sessionId) throw new Error(`sessions.create failed: ${json(created)}`)
  console.log(`${stamp()} terminal session ${sessionId} created`)

  const first = await waitForSpawn(sessionId)
  const firstLabel = (first.row?.durable_label ?? first.api?.durableLabel) as string | undefined
  if (!firstLabel) throw new Error(`session ${sessionId} published no durable label: ${json(first)}`)
  durableLabel = firstLabel
  console.log(`  durable label    ${durableLabel}`)
  const beforeSockets = scanSockets(durableLabel)
  printSnapshot('BEFORE DAEMON RESTART — positive control', first.api, first.row, beforeSockets)
  const beforeLive = isLive(first.api, first.row) && beforeSockets.sockets.some((socket) => socket.live)
  if (!beforeLive) {
    throw new Error('positive control failed: no live row plus live terminal socket before restart')
  }
  console.log('  POSITIVE CONTROL  live row and live terminal master are both present')
  console.log(`  abduco processes  ${json(processIdsForLabel(durableLabel))}`)

  appendMarker('daemon', `=== restarting daemon for ${ARM} at ${stamp()} ===`)
  await stop(daemon, 'daemon')
  daemon = boot('daemon')
  await waitForLog('daemon', 'podium daemon up: connected to', 30_000)
  const settled = await waitForReattach(sessionId)
  const afterApi = settled.api
  const afterRow = settled.row
  const afterSockets = scanSockets(durableLabel)
  console.log(`  post-restart settle ${settled.status} after ${settled.elapsedMs} ms`)
  printSnapshot('AFTER DAEMON RESTART — row watched by the operator', afterApi, afterRow, afterSockets)
  const afterLive = isLive(afterApi, afterRow) && afterSockets.sockets.some((socket) => socket.live)
  if (EXPECT === 'legacy') {
    const afterGone = settled.status !== 'live' && settled.status !== 'running' && settled.status !== 'reconnecting'
    const orphaned = afterGone && afterSockets.sockets.some((socket) => socket.live)
    if (!orphaned) {
      throw new Error('legacy control did not leave a live master behind a gone session row')
    }
    console.log('  LEGACY CONTROL    PASS — the row went gone while its live master remained on disk')
  } else {
    const spawnFailure = afterRow?.spawn_failure
    if (!afterLive || spawnFailure) {
      throw new Error(
        `fixed arm failed after restart: live=${afterLive} spawn_failure=${json(spawnFailure)} row=${json(afterRow)}`,
      )
    }
    console.log('  FIXED ARM         PASS — reattach found the live master after daemon restart')
  }
}

try {
  await main()
} finally {
  await cleanup()
}
