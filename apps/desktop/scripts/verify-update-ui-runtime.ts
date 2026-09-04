#!/usr/bin/env bun
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import { createConnection, createServer } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
/**
 * Prove packaged Linux desktop updates through the real Tauri/WebKitGTK UI.
 *
 * This is deliberately not a browser test. It builds two signed AppImages, launches the old one
 * under a dedicated Xvfb server, and uses XTest pointer events to press the panel's real primary
 * action. The all-in-one arm proves the supervised local payload/server and its served web/mobile
 * assets converge before the shell restart. The daemon arm proves a remote primary, the desktop's
 * supervised daemon, and a selected fleet participant converge before the shell restart.
 *
 * The controls are part of the same drive: first, withholding the pointer action must produce no
 * operation; second, an actually-offline fleet participant must make the strict convergence grader
 * fail before standing reconciliation brings it current. All state, payloads, XDG roots, ports,
 * process trees, update identities and X displays are isolated from standing Podium instances.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { defaultInstancePorts } from '../../../packages/runtime/src/instance'
import {
  allocateDevPublishVersion,
  buildDevBundle,
  developmentHeadSha,
  devFeedManifestPath,
  devTarget,
  migrationsAtRevision,
  readCheckoutReleaseBase,
  requireDefinedMigrations,
} from '../../server/src/modules/updates/dev-bundle'
import {
  readDevPublisherState,
  writeDevPublisherState,
} from '../../server/src/modules/updates/dev-publisher-state'
import {
  readOrCreateDevArtifactToken,
  readOrCreateUpdateSigningKey,
} from '../../server/src/modules/updates/signing-key'
import type { AppRouter } from '../../server/src/router'

const repoRoot = resolve(import.meta.dirname, '../../..')
const harnessRelativePath = 'apps/desktop/scripts/verify-update-ui-runtime.ts'
const harnessOnlyPaths = [
  'apps/desktop/package.json',
  harnessRelativePath,
  'apps/desktop/scripts/x11-window-drive.py',
  'docs/agents/updater-acceptance.md',
]
const desktopDir = join(repoRoot, 'apps/desktop')
const tauriDir = join(desktopDir, 'src-tauri')
const x11Driver = join(desktopDir, 'scripts/x11-window-drive.py')
const outputArg = process.argv.find((arg) => arg.startsWith('--out='))
const prepare = process.argv.includes('--prepare')
const topologyArg = process.argv.find((arg) => arg.startsWith('--topology='))?.slice('--topology='.length)
const topology = topologyArg ?? 'both'
if (!['both', 'all-in-one', 'daemon'].includes(topology)) {
  throw new Error(`unknown native proof topology ${topologyArg}`)
}
const evidencePath = resolve(
  outputArg?.slice('--out='.length) ?? '.tmp/pod-2973-linux-native-update.json',
)
const evidenceDir = dirname(evidencePath)
const nativeTitle = 'Podium ADE'
const issue = 'POD-2973'
const screenshots = {
  allInOneOffer: evidencePath.replace(/\.json$/u, '-linux-all-in-one-offer.png'),
  allInOneApplying: evidencePath.replace(/\.json$/u, '-linux-all-in-one-applying.png'),
  allInOneReload: evidencePath.replace(/\.json$/u, '-linux-all-in-one-reload.png'),
  allInOneReloadAgain: evidencePath.replace(/\.json$/u, '-linux-all-in-one-reload-again.png'),
  allInOneRestart: evidencePath.replace(/\.json$/u, '-linux-all-in-one-restart.png'),
  allInOneCurrent: evidencePath.replace(/\.json$/u, '-linux-all-in-one-current.png'),
  daemonOffer: evidencePath.replace(/\.json$/u, '-linux-daemon-offer.png'),
  daemonIncomplete: evidencePath.replace(/\.json$/u, '-linux-daemon-incomplete-control.png'),
  daemonReload: evidencePath.replace(/\.json$/u, '-linux-daemon-reload.png'),
  daemonReloadAgain: evidencePath.replace(/\.json$/u, '-linux-daemon-reload-again.png'),
  daemonRestart: evidencePath.replace(/\.json$/u, '-linux-daemon-restart.png'),
  daemonCurrent: evidencePath.replace(/\.json$/u, '-linux-daemon-current.png'),
}

type Api = ReturnType<typeof createTRPCClient<AppRouter>>
type Json = Record<string, unknown>
type OperationRow = {
  id: string
  kind?: string
  state?: string
  createdAt?: string
  updatedAt?: string
  finishedAt?: string
  steps?: Array<{ id?: string; state?: string; places?: Array<{ id?: string; state?: string }> }>
  deferred?: Array<{ id?: string; reason?: string }>
  details?: { target?: { version?: string } }
}
type FleetMachine = {
  id: string
  name?: string
  version?: string
  online?: boolean
  supervised?: boolean
  installKind?: string
  components?: string[]
}
type FleetSnapshot = {
  appVersion?: string
  sourceDigest?: string
  servedWebDigest?: string
  servedMobileWeb?: { present?: boolean; appVersion?: string; digest?: string }
  targetVersion?: string
  machines?: FleetMachine[]
}
type MachineRow = {
  id: string
  name?: string
  hostname?: string
  online?: boolean
  appVersion?: string
  supervised?: boolean
  installKind?: string
  components?: string[]
}
type Fixture = {
  root: string
  state: string
  payload: string
  home: string
  xdg: string
  agentHome: string
  instance: string
}
type ManagedProcess = { child: ChildProcess; label: string; output: string[] }
type Display = { child: ChildProcess; name: string }
type TlsProxy = {
  server: ReturnType<typeof createHttpsServer>
  origin: string
  certificate: string
  requests: string[]
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs = 120_000,
  pollMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await sleep(pollMs)
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`)
}

function run(command: string, args: string[], cwd = repoRoot, env = process.env): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status ?? result.signal}`)
  }
}

function gitText(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : undefined
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  )
  if (!port) throw new Error('could not allocate an isolated port')
  return port
}

function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  throw new Error('daemon topology needs one non-loopback IPv4 address')
}

async function startTlsProxy(
  root: string,
  backendPort: number,
  appImage: Buffer,
): Promise<TlsProxy> {
  const address = lanAddress()
  const trustCertificate = join(root, 'update-e2e-ca.crt')
  const trustKey = join(root, 'update-e2e-ca.key')
  const certificate = join(root, 'update-e2e.crt')
  const certificateRequest = join(root, 'update-e2e.csr')
  const extensions = join(root, 'update-e2e.ext')
  const key = join(root, 'update-e2e.key')
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Podium native update test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    trustKey,
    '-out',
    trustCertificate,
  ])
  run('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=podium-native-update.test',
    '-keyout',
    key,
    '-out',
    certificateRequest,
  ])
  writeFileSync(
    extensions,
    [
      '[server]',
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=IP:127.0.0.1,IP:${address},DNS:localhost`,
      '',
    ].join('\n'),
  )
  run('openssl', [
    'x509',
    '-req',
    '-in',
    certificateRequest,
    '-CA',
    trustCertificate,
    '-CAkey',
    trustKey,
    '-CAcreateserial',
    '-days',
    '1',
    '-sha256',
    '-extfile',
    extensions,
    '-extensions',
    'server',
    '-out',
    certificate,
  ])
  const requests: string[] = []
  const server = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (request, response) => {
      const path = request.url ?? '/'
      requests.push(`${request.method ?? 'GET'} ${path}`)
      if (new URL(path, 'https://podium-native-update.test').pathname === '/desktop.AppImage') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(appImage.byteLength),
        })
        response.end(appImage)
        return
      }
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: backendPort,
          method: request.method,
          path,
          headers: request.headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
          upstreamResponse.pipe(response)
        },
      )
      upstream.on('error', (error) => {
        if (!response.headersSent) response.writeHead(502)
        response.end(String(error))
      })
      request.pipe(upstream)
    },
  )
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', resolveListen)
  })
  const bound = server.address()
  const port = typeof bound === 'object' && bound ? bound.port : undefined
  if (!port) throw new Error('could not bind the isolated TLS update proxy')
  return { server, origin: `https://${address}:${port}`, certificate: trustCertificate, requests }
}

function tlsTrust(proxy: TlsProxy): NodeJS.ProcessEnv {
  return {
    NODE_EXTRA_CA_CERTS: proxy.certificate,
    SSL_CERT_FILE: proxy.certificate,
  }
}

function trpc(origin: string): Api {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${origin}/trpc` })] })
}

async function httpJson(origin: string, path: string): Promise<Json> {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`)
  return (await response.json()) as Json
}

async function health(origin: string): Promise<Json | undefined> {
  try {
    const response = await fetch(new URL('/health', origin), {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return undefined
    const body = await response.text()
    return body === 'ok' ? { status: response.status, body } : undefined
  } catch {
    return undefined
  }
}

async function operationHistory(api: Api): Promise<OperationRow[]> {
  return (await api.operations.history.query({ kind: 'update', limit: 20 })) as OperationRow[]
}

async function newestOperationAfter(
  api: Api,
  before: Set<string>,
): Promise<OperationRow | undefined> {
  return (await operationHistory(api)).find((row) => !before.has(row.id))
}

async function proveBrokenAction(
  api: Api,
  before: Set<string>,
  durationMs = 4_000,
): Promise<string> {
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    const unexpected = await newestOperationAfter(api, before)
    if (unexpected) throw new Error(`broken-action control unexpectedly created ${unexpected.id}`)
    await sleep(250)
  }
  return 'timed out waiting for a new operation while the native pointer action was withheld'
}

async function seedWorkspace(api: Api, machineId?: string): Promise<void> {
  await api.repos.add.mutate({ path: repoRoot, ...(machineId ? { machineId } : {}) })
  await waitFor(
    async () => {
      const repos = await api.repos.list.query()
      return JSON.stringify(repos).includes(repoRoot) ? repos : undefined
    },
    'isolated workspace seed',
    30_000,
    250,
  )
  await sleep(3_000)
}

async function proveExpectedFailure(label: string, action: () => Promise<void>): Promise<string> {
  try {
    await action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(`${label} control did not fail`)
}

async function fixture(prefix: string, instance: string): Promise<Fixture> {
  const root = await mkdtemp(`/tmp/${prefix}-`)
  const value = {
    root,
    state: join(root, 'state'),
    payload: join(root, 'payload'),
    home: join(root, 'home'),
    xdg: join(root, 'xdg'),
    agentHome: join(root, 'agent-home'),
    instance,
  }
  await Promise.all([
    mkdir(value.state, { recursive: true }),
    mkdir(value.home, { recursive: true }),
    mkdir(join(value.xdg, 'config'), { recursive: true }),
    mkdir(join(value.xdg, 'cache'), { recursive: true }),
    mkdir(join(value.xdg, 'data'), { recursive: true }),
    mkdir(value.agentHome, { recursive: true }),
  ])
  return value
}

function isolatedEnv(value: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: value.home,
    USER: process.env.USER ?? 'podium-runtime',
    PATH: `${process.env.HOME ?? '/home/mgw'}/.cargo/bin:/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(value.xdg, 'config'),
    XDG_CACHE_HOME: join(value.xdg, 'cache'),
    XDG_DATA_HOME: join(value.xdg, 'data'),
    PODIUM_STATE_DIR: value.state,
    PODIUM_PAYLOAD_HOME: value.payload,
    PODIUM_AGENT_HOME: value.agentHome,
    PODIUM_INSTANCE: value.instance,
    PODIUM_ADOPT_STATE: '1',
    PODIUM_NO_RELAY: '1',
    PODIUM_LOG_LEVEL: 'info',
    NO_AT_BRIDGE: '1',
    ...extra,
  }
}

function spawnManaged(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = repoRoot,
): ManagedProcess {
  const output: string[] = []
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString()
    output.push(text)
    process.stdout.write(`[${label}] ${text}`)
  })
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString()
    output.push(text)
    process.stderr.write(`[${label}] ${text}`)
  })
  child.once('error', (error) => {
    const text = `[process error] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
    output.push(text)
    process.stderr.write(`[${label}] ${text}`)
  })
  child.once('exit', (code, signal) => {
    const text = `[process exit] code=${String(code)} signal=${String(signal)}\n`
    output.push(text)
    process.stderr.write(`[${label}] ${text}`)
  })
  return { child, label, output }
}
function retainFailureSnapshot(value: Fixture, label: string, managed?: ManagedProcess): void {
  const readTail = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8').split('\n').slice(-160).join('\n')
    } catch {
      return null
    }
  }
  const files: Json = {}
  for (const name of ['config.json', 'connectivity.json', 'daemon.json', 'running-version', 'update-ownership']) {
    try {
      files[name] = readFileSync(join(value.state, name), 'utf8')
    } catch {
      files[name] = null
    }
  }
  const logs: Json = {}
  for (const name of ['desktop-native.ndjson', 'daemon.ndjson', 'daemon.log', 'server.ndjson', 'parent.ndjson']) {
    logs[name] = readTail(join(value.state, 'logs', name))
  }
  writeJson(join(value.root, 'failure-snapshot.json'), {
    capturedAt: new Date().toISOString(),
    label,
    state: value.state,
    instance: value.instance,
    child: managed
      ? {
          pid: managed.child.pid ?? null,
          exitCode: managed.child.exitCode,
          signalCode: managed.child.signalCode,
          outputTail: managed.output.join('').slice(-20_000),
        }
      : null,
    files,
    logs,
  })
}

async function statePids(state: string): Promise<number[]> {
  const pids: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const raw = await readFile(`/proc/${entry}/environ`, 'utf8')
      if (raw.split('\0').includes(`PODIUM_STATE_DIR=${state}`)) pids.push(Number(entry))
    } catch {}
  }
  return pids
}

async function stopState(state: string): Promise<void> {
  const own = process.pid
  for (const pid of await statePids(state)) {
    if (pid === own) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  await sleep(1_500)
  for (const pid of await statePids(state)) {
    if (pid === own) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

function freeDisplay(): string {
  for (let display = 90; display < 160; display += 1) {
    if (!existsSync(`/tmp/.X${display}-lock`)) return `:${display}`
  }
  throw new Error('no isolated Xvfb display in :90..:159')
}

async function startDisplay(): Promise<Display> {
  const name = freeDisplay()
  const child = spawn('Xvfb', [name, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await sleep(350)
  if (child.exitCode !== null || child.signalCode !== null) throw new Error('Xvfb exited early')
  return { child, name }
}

function x11(display: string, command: 'id' | 'geometry', timeout = 15): string | undefined {
  const result = spawnSync('python3', [x11Driver, command, nativeTitle, String(timeout)], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', DISPLAY: display },
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function assertX11DriverContract(): void {
  const source = readFileSync(x11Driver, 'utf8')
  const requiredWitnesses = [
    'def geometry(',
    'def click(',
    'XTestFakeButtonEvent',
    '\"title\", \"id\", \"geometry\", \"type\", \"click\"',
  ]
  const missing = requiredWitnesses.filter((witness) => !source.includes(witness))
  if (missing.length > 0) {
    throw new Error(`native X11 driver is missing harness commands: ${missing.join(', ')}`)
  }
}

function settleNativeUpdatePrompt(
  display: string,
):
  | { present: false }
  | { present: true; dismissal: 'Not now'; pointer: { x: number; y: number; windowId: string } } {
  const result = spawnSync('python3', [x11Driver, 'geometry', 'Podium Update', '3'], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', DISPLAY: display },
    encoding: 'utf8',
  })
  if (result.status !== 0) return { present: false }
  const raw = result.stdout.trim()
  const [windowId, , , widthRaw, heightRaw] = raw.split(/\s+/u)
  const width = Number(widthRaw)
  const height = Number(heightRaw)
  if (!windowId || width < 300 || height < 80) {
    throw new Error(`native update prompt geometry was unavailable: ${raw || result.stderr.trim()}`)
  }
  const x = Math.floor(width * 0.75)
  const y = height - 16
  const click = spawnSync(
    'python3',
    [x11Driver, 'click', 'Podium Update', String(x), String(y), '30'],
    { env: { PATH: '/usr/local/bin:/usr/bin:/bin', DISPLAY: display }, encoding: 'utf8' },
  )
  if (click.status !== 0) throw new Error(click.stderr.trim() || 'native update dismissal failed')
  return { present: true, dismissal: 'Not now', pointer: { x, y, windowId } }
}

function clickPrimary(display: string): { x: number; y: number; windowId: string } {
  const raw = x11(display, 'geometry', 30)
  if (!raw) throw new Error('native window geometry was unavailable')
  const [windowId, , , widthRaw, heightRaw] = raw.split(/\s+/u)
  const width = Number(widthRaw)
  const height = Number(heightRaw)
  if (!windowId || width < 600 || height < 500) throw new Error(`unexpected native geometry ${raw}`)
  // UpdatePanel is fixed right-4/bottom-9; its primary is the rightmost control in a px-4,
  // py-3 footer. This point is the centre of that control at the fixed 1200x800 shell size.
  const x = width - 82
  const y = height - 64
  const result = spawnSync(
    'python3',
    [x11Driver, 'click', nativeTitle, String(x), String(y), '30'],
    { env: { PATH: '/usr/local/bin:/usr/bin:/bin', DISPLAY: display }, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'native primary click failed')
  return { x, y, windowId }
}

function capture(display: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const result = spawnSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'x11grab',
      '-video_size',
      '1280x900',
      '-i',
      `${display}+0,0`,
      '-frames:v',
      '1',
      path,
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'X11 capture failed')
}

async function readPid(state: string, role: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(join(state, 'run', `${role}.pid`), 'utf8')) as {
      pid?: number
    }
    return typeof value.pid === 'number' ? value.pid : undefined
  } catch {
    return undefined
  }
}

async function readMachineId(state: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(join(state, 'daemon.json'), 'utf8')) as {
      machineId?: string
    }
    return value.machineId
  } catch {
    return undefined
  }
}

async function processEnvironment(pid: number): Promise<Record<string, string>> {
  const raw = await readFile(`/proc/${pid}/environ`, 'utf8')
  return Object.fromEntries(
    raw
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const split = entry.indexOf('=')
        return split < 0 ? [entry, ''] : [entry.slice(0, split), entry.slice(split + 1)]
      }),
  )
}

async function processParent(pid: number): Promise<number | undefined> {
  const status = await readFile(`/proc/${pid}/status`, 'utf8')
  const match = status.match(/^PPid:\s+(\d+)$/mu)
  return match ? Number(match[1]) : undefined
}

async function processFailureRecord(pid: number): Promise<Json> {
  const readOptional = async (path: string): Promise<string | null> => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  }
  const [commandLineRaw, executable, parentPid, environment] = await Promise.all([
    readOptional(`/proc/${pid}/cmdline`),
    readlink(`/proc/${pid}/exe`).catch(() => null),
    processParent(pid).catch(() => undefined),
    processEnvironment(pid).catch(() => ({})),
  ])
  const commandLine = commandLineRaw
    ?.split(String.fromCharCode(0))
    .filter(Boolean)
  const environmentKeys = [
    'PODIUM_STATE_DIR',
    'PODIUM_INSTANCE',
    'PODIUM_HOME',
    'PODIUM_PAYLOAD_HOME',
    'PODIUM_DESKTOP_SUPERVISED',
    'PODIUM_UNDER_PARENT',
    'PODIUM_SUPERVISOR_PID',
    'PODIUM_CLI_PATH',
    'PODIUM_PORT',
    'PODIUM_WEB_DIR',
    'PODIUM_MOBILE_WEB_DIR',
  ]
  return {
    pid,
    parentPid: parentPid ?? null,
    executable,
    commandLine: commandLine ?? null,
    environment: Object.fromEntries(
      environmentKeys
        .filter((key) => environment[key] !== undefined)
        .map((key) => [key, environment[key]]),
    ),
  }
}

async function listenerOwnerPids(port: number): Promise<number[]> {
  const inodes = await listenerInodes(port)
  if (inodes.size === 0) return []
  const owners: number[] = []
  for (const entry of await readdir('/proc')) {
    if (!entry || entry.split('').some((char) => char < '0' || char > '9')) continue
    let descriptors: string[]
    try {
      descriptors = await readdir(`/proc/${entry}/fd`)
    } catch {
      continue
    }
    for (const descriptor of descriptors) {
      try {
        const target = await readlink(`/proc/${entry}/fd/${descriptor}`)
        const match = target.startsWith('socket:[') && target.endsWith(']') ? target.slice(8, -1) : undefined
        if (match && inodes.has(match)) {
          owners.push(Number(entry))
          break
        }
      } catch {
        // A process can close a descriptor while the failure snapshot is walking it.
      }
    }
  }
  return owners
}

async function listenerFailureEvidence(value: Fixture): Promise<Json> {
  const configured: Json = {}
  try {
    Object.assign(configured, JSON.parse(readFileSync(join(value.state, 'config.json'), 'utf8')))
  } catch {
    // Keep the snapshot useful even when config was the failure.
  }
  const defaults = defaultInstancePorts(value.instance)
  const ports: Record<string, number> = {
    hook: defaults.hook,
    agentRelay: defaults.agentRelay,
  }
  if (typeof configured.port === 'number' && Number.isInteger(configured.port) && configured.port > 0 && configured.port <= 65_535) ports.server = configured.port
  const configuredUrl =
    typeof configured.serverUrl === 'string'
      ? configured.serverUrl
      : typeof configured.publicUrl === 'string'
        ? configured.publicUrl
        : undefined
  if (configuredUrl) {
    try {
      const parsed = new URL(configuredUrl)
      if (parsed.port) ports.server ??= Number(parsed.port)
    } catch {
      // The config text is retained above; an invalid URL needs no second error here.
    }
  }
  const entries = await Promise.all(
    Object.entries(ports).map(async ([name, port]) => {
      const [reachable, inodes, ownerPids] = await Promise.all([
        tcpReachable(port),
        listenerInodes(port),
        listenerOwnerPids(port),
      ])
      return [
        name,
        {
          port,
          reachable,
          listenerInodes: [...inodes],
          ownerPids,
        },
      ] as const
    }),
  )
  return Object.fromEntries(entries)
}

async function tcpReachable(port: number): Promise<boolean> {
  return new Promise((resolveReachable) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveReachable(value)
    }
    socket.setTimeout(1_000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function listenerInodes(port: number): Promise<Set<string>> {
  const suffix = `:${port.toString(16).toUpperCase().padStart(4, '0')}`
  const inodes = new Set<string>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const rows = (await readFile(table, 'utf8')).split('\n').slice(1)
      for (const row of rows) {
        const fields = row.trim().split(/\s+/u)
        if (fields[1]?.endsWith(suffix) && fields[3] === '0A' && fields[9]) {
          inodes.add(fields[9])
        }
      }
    } catch {
      // A kernel may omit one address-family table.
    }
  }
  return inodes
}

async function pidOwnsListener(pid: number, port: number): Promise<boolean> {
  const inodes = await listenerInodes(port)
  if (inodes.size === 0) return false
  let descriptors: string[]
  try {
    descriptors = await readdir(`/proc/${pid}/fd`)
  } catch {
    return false
  }
  for (const descriptor of descriptors) {
    try {
      const target = await readlink(`/proc/${pid}/fd/${descriptor}`)
      const match = target.match(/^socket:\[(\d+)\]$/u)
      if (match?.[1] && inodes.has(match[1])) return true
    } catch {
      // Descriptors may disappear while inspected.
    }
  }
  return false
}

async function daemonListenerTruth(
  state: string,
  instance: string,
  previousDaemonPid?: number,
): Promise<Json> {
  const ports = defaultInstancePorts(instance)
  if ([ports.hook, ports.agentRelay].some((port) => port === 45_777 || port === 45_778)) {
    throw new Error('native proof resolved the live default daemon ports instead of isolated ports')
  }
  return waitFor(
    async () => {
      const daemonPid = await readPid(state, 'daemon')
      if (!daemonPid || (previousDaemonPid !== undefined && daemonPid === previousDaemonPid)) {
        return undefined
      }
      const [hookReachable, relayReachable, hookOwned, relayOwned] = await Promise.all([
        tcpReachable(ports.hook),
        tcpReachable(ports.agentRelay),
        pidOwnsListener(daemonPid, ports.hook),
        pidOwnsListener(daemonPid, ports.agentRelay),
      ])
      if (!hookReachable || !relayReachable || !hookOwned || !relayOwned) return undefined
      return {
        instance,
        daemonPid,
        previousDaemonPid,
        automaticallyRespawned:
          previousDaemonPid === undefined ? undefined : daemonPid !== previousDaemonPid,
        isolatedFromDefaultPorts: true,
        hook: {
          port: ports.hook,
          listening: true,
          reachable: hookReachable,
          ownedByDaemon: hookOwned,
        },
        agentRelay: {
          port: ports.agentRelay,
          listening: true,
          reachable: relayReachable,
          ownedByDaemon: relayOwned,
        },
      }
    },
    `replacement daemon hook and agent-relay listeners for ${instance}`,
    120_000,
    250,
  )
}

async function retainProcessEvidence(
  value: Fixture,
  label: string,
  managed?: ManagedProcess,
  error?: unknown,
): Promise<void> {
  try {
  const pids = await statePids(value.state).catch(() => [])
  const processes = await Promise.all(pids.map((pid) => processFailureRecord(pid)))
  writeJson(join(value.root, 'failure-snapshot-process.json'), {
    capturedAt: new Date().toISOString(),
    label,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack ?? null }
        : error === undefined
          ? null
          : String(error),
    managed: managed
      ? {
          pid: managed.child.pid ?? null,
          exitCode: managed.child.exitCode,
          signalCode: managed.child.signalCode,
        }
      : null,
    processes,
    listeners: await listenerFailureEvidence(value),
  })
  } catch (snapshotError) {
    console.error(
      `[native failure snapshot unavailable] ${snapshotError instanceof Error ? snapshotError.stack ?? snapshotError.message : String(snapshotError)}`,
    )
  }
}

async function pair(
  api: Api,
  oldPayload: string,
  value: Fixture,
  serverUrl: string,
  name: string,
): Promise<void> {
  writeJson(join(value.state, 'config.json'), {
    configVersion: 2,
    updateChannel: 'dev',
  })
  const pairing = await api.machines.pairingCode.mutate({
    copyAgentCredentials: false,
    podiumManaged: true,
  })
  const token = Buffer.from(
    JSON.stringify({
      v: 1,
      serverUrl,
      pairCode: pairing.code,
      name,
      podiumManaged: true,
    }),
  ).toString('base64url')
  const result = spawnSync(oldPayload, ['join-config', token], {
    cwd: repoRoot,
    env: isolatedEnv(value),
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`join-config failed: ${result.stderr || result.stdout}`)
  const config = readJson(join(value.state, 'config.json'))
  delete config.persistence
  writeJson(join(value.state, 'config.json'), config)
}

function copyPublicationIdentity(from: string, to: string, sha: string, version: string): void {
  mkdirSync(to, { recursive: true })
  for (const name of ['update-signing-key.json', 'update-signing-key.pub', 'dev-artifact-token']) {
    cpSync(join(from, name), join(to, name))
  }
  const state = readDevPublisherState(from)
  if (!state) throw new Error(`cached publication state is missing from ${from}`)
  writeDevPublisherState(
    { ...state, lastSha: sha, lastVersion: version, lastPublishedSha: sha },
    to,
  )
}

async function writeHeadlessManifest(
  built: Awaited<ReturnType<typeof buildDevBundle>>,
  origin: string,
  token: string,
  sha: string,
): Promise<void> {
  const migrations = requireDefinedMigrations(await migrationsAtRevision(repoRoot, sha), sha)
  const target = devTarget(built, {
    artifactUrl: (platform) =>
      `${origin}/updates/feed/dev/artifact/${encodeURIComponent(built.version)}/${encodeURIComponent(platform)}?token=${token}`,
    sourceRoot: repoRoot,
    schemaMigrations: migrations,
  })
  writeJson(devFeedManifestPath(repoRoot), target)
}

function appImagePath(version: string): string {
  return join(tauriDir, 'target/release/bundle/appimage', `Podium_${version}_amd64.AppImage`)
}

const requireFromDesktop = createRequire(join(desktopDir, 'package.json'))

function prepareTauriBundleEnv(buildRoot: string): {
  env: NodeJS.ProcessEnv
  cleanup: string[]
} {
  if (existsSync('/usr/bin/xdg-open') && existsSync('/usr/bin/xdg-mime')) {
    return { env: process.env, cleanup: [] }
  }
  const xdgUtilsDir = process.env.PODIUM_DESKTOP_XDG_UTILS_DIR
  if (!xdgUtilsDir) {
    throw new Error(
      'AppImage bundling requires /usr/bin/xdg-open and /usr/bin/xdg-mime, or PODIUM_DESKTOP_XDG_UTILS_DIR pointing to official xdg-utils scripts',
    )
  }
  const patches = [
    { from: '/usr/bin/xdg-open', to: '/tmp/pod2973-open', name: 'xdg-open' },
    { from: '/usr/bin/xdg-mime', to: '/tmp/pod2973-mime', name: 'xdg-mime' },
  ]
  for (const patch of patches) {
    const source = join(xdgUtilsDir, patch.name)
    if (!existsSync(source)) throw new Error(`missing official xdg-utils script at ${source}`)
    cpSync(source, patch.to)
    chmodSync(patch.to, 0o755)
  }
  const nativeBinding = requireFromDesktop.resolve('@tauri-apps/cli-linux-x64-gnu')
  const patchedBinding = join(buildRoot, 'tauri-cli-linux-patched.node')
  const bytes = Buffer.from(readFileSync(nativeBinding))
  for (const patch of patches) {
    const from = Buffer.from(patch.from)
    const to = Buffer.from(patch.to)
    if (from.length !== to.length) throw new Error('Tauri bundler patch paths must match')
    const index = bytes.indexOf(from)
    if (index < 0 || bytes.indexOf(from, index + 1) >= 0) {
      throw new Error(`Tauri bundler path witness is not unique: ${patch.from}`)
    }
    to.copy(bytes, index)
  }
  writeFileSync(patchedBinding, bytes)
  return {
    env: { ...process.env, NAPI_RS_NATIVE_LIBRARY_PATH: patchedBinding },
    cleanup: patches.map((patch) => patch.to),
  }
}

function buildAppImage(
  version: string,
  rootPackage: Json,
  desktopPackage: Json,
  tauriConf: Json,
  signingPrivateKey: string,
  signingPublicKey: string,
  tauriBuildEnv: NodeJS.ProcessEnv,
): void {
  const nextRoot = { ...rootPackage, version }
  const nextDesktop = { ...desktopPackage, version }
  const nextConf = structuredClone(tauriConf) as Json
  nextConf.version = version
  const plugins = nextConf.plugins as Json | undefined
  const updater = plugins?.updater as Json | undefined
  if (!updater) throw new Error('tauri config has no updater plugin')
  updater.pubkey = signingPublicKey
  writeJson(join(repoRoot, 'package.json'), nextRoot)
  writeJson(join(desktopDir, 'package.json'), nextDesktop)
  writeJson(join(tauriDir, 'tauri.conf.json'), nextConf)
  run('bun', ['scripts/stage-sidecar.ts'], desktopDir)
  run(join(desktopDir, 'node_modules/.bin/tauri'), ['build', '--bundles', 'appimage'], desktopDir, {
    ...tauriBuildEnv,
    TAURI_SIGNING_PRIVATE_KEY: signingPrivateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  })
}

async function prepareCandidate(buildRoot: string): Promise<{
  oldVersion: string
  targetVersion: string
  sha: string
  oldHeadless: string
  oldAppImage: string
  targetAppImage: string
  targetSignature: string
  publicationState: string
  built: Awaited<ReturnType<typeof buildDevBundle>>
  token: string
  artifactSha: string
  harnessSha: string
  integrationBaseSha: string
  cacheAcceptance: {
    reused: boolean
    changedPaths: string[]
    artifactToIntegrationPaths: string[]
  }
}> {
  const metadataPath = join(buildRoot, 'candidate.json')
  const currentSha = await developmentHeadSha(repoRoot)
  const integrationBaseSha = gitText(['rev-parse', 'dev/mw'])
  if (!prepare && existsSync(metadataPath)) {
    const metadata = readJson(metadataPath) as {
      oldVersion: string
      targetVersion: string
      sha: string
      oldHeadless: string
      oldAppImage: string
      targetAppImage: string
      targetSignature: string
      publicationState: string
      token: string
      built: Awaited<ReturnType<typeof buildDevBundle>>
    }
    const changedPaths =
      metadata.sha === currentSha
        ? []
        : (() => {
            const ancestry = spawnSync(
              'git',
              ['merge-base', '--is-ancestor', metadata.sha, currentSha],
              { cwd: repoRoot },
            )
            if (ancestry.status !== 0) {
              throw new Error(
                'cached artifact commit ' +
                  metadata.sha +
                  ' is not an ancestor of harness ' +
                  currentSha +
                  '; preserve the sealed artifact ancestry or use --prepare',
              )
            }
            const baseAncestry = spawnSync(
              'git',
              ['merge-base', '--is-ancestor', integrationBaseSha, currentSha],
              { cwd: repoRoot },
            )
            if (baseAncestry.status !== 0) {
              throw new Error(
                'integration base ' +
                  integrationBaseSha +
                  ' is not an ancestor of harness ' +
                  currentSha,
              )
            }
            const paths = gitText(['diff', '--name-only', metadata.sha + '..' + currentSha])
              .split('\n')
              .filter(Boolean)
            const unexpectedPaths = paths.filter((path) => !harnessOnlyPaths.includes(path))
            if (paths.length === 0 || unexpectedPaths.length > 0) {
              throw new Error(
                'rebased harness path set differs from the fail-closed allowlist: ' +
                  (paths.join(', ') || '(no paths)'),
              )
            }
            return paths
          })()
    const artifactToIntegrationPaths =
      metadata.sha === integrationBaseSha
        ? []
        : gitText(['diff', '--name-only', metadata.sha + '..' + integrationBaseSha])
            .split('\n')
            .filter(Boolean)
    for (const args of [
      ['diff', '--quiet', '--', ...harnessOnlyPaths],
      ['diff', '--cached', '--quiet', '--', ...harnessOnlyPaths],
    ]) {
      const clean = spawnSync('git', args, { cwd: repoRoot })
      if (clean.status !== 0) {
        throw new Error('cached candidate requires a committed, clean verification harness')
      }
    }
    for (const path of [
      metadata.oldHeadless,
      metadata.oldAppImage,
      metadata.targetAppImage,
      metadata.targetSignature,
      metadata.publicationState,
      metadata.built.path,
    ]) {
      if (!existsSync(path))
        throw new Error(`cached candidate is incomplete at ${path}; use --prepare`)
    }
    return {
      ...metadata,
      artifactSha: metadata.sha,
      harnessSha: currentSha,
      integrationBaseSha,
      cacheAcceptance: {
        reused: metadata.sha !== currentSha,
        changedPaths,
        artifactToIntegrationPaths,
      },
    }
  }
  if (!prepare) throw new Error(`no prepared candidate at ${metadataPath}; rerun with --prepare`)

  const rootPackagePath = join(repoRoot, 'package.json')
  const desktopPackagePath = join(desktopDir, 'package.json')
  const tauriConfPath = join(tauriDir, 'tauri.conf.json')
  const rootPackageText = readFileSync(rootPackagePath, 'utf8')
  const desktopPackageText = readFileSync(desktopPackagePath, 'utf8')
  const tauriConfText = readFileSync(tauriConfPath, 'utf8')
  const rootPackage = JSON.parse(rootPackageText) as Json
  const desktopPackage = JSON.parse(desktopPackageText) as Json
  const tauriConf = JSON.parse(tauriConfText) as Json
  const oldVersion = readCheckoutReleaseBase(repoRoot)
  const sha = currentSha
  run('bun', ['scripts/preflight.ts'], desktopDir)
  const publicationState = join(buildRoot, 'publication-state')
  mkdirSync(publicationState, { recursive: true })
  const key = readOrCreateUpdateSigningKey(publicationState)
  const token = readOrCreateDevArtifactToken(publicationState)
  const targetVersion = allocateDevPublishVersion({
    stateDir: publicationState,
    checkoutBase: oldVersion,
    sha,
  }).version
  const oldHeadless = join(buildRoot, 'old-headless')
  const oldAppImage = join(buildRoot, `Podium_${oldVersion}_amd64.AppImage`)
  const targetAppImage = join(buildRoot, `Podium_${targetVersion}_amd64.AppImage`)
  const targetSignature = `${targetAppImage}.sig`
  const tauriBundle = prepareTauriBundleEnv(buildRoot)
  const desktopSigningKey = join(buildRoot, 'desktop-update.key')
  try {
    run(
      join(desktopDir, 'node_modules/.bin/tauri'),
      [
        'signer',
        'generate',
        '--ci',
        '--password',
        '',
        '--write-keys',
        desktopSigningKey,
        '--force',
      ],
      desktopDir,
    )
    const signingPrivateKey = readFileSync(desktopSigningKey, 'utf8')
    const signingPublicKey = readFileSync(`${desktopSigningKey}.pub`, 'utf8').trim()
    buildAppImage(
      oldVersion,
      rootPackage,
      desktopPackage,
      tauriConf,
      signingPrivateKey,
      signingPublicKey,
      tauriBundle.env,
    )
    await rm(oldHeadless, { recursive: true, force: true })
    await cp(join(repoRoot, 'dist-bun/headless'), oldHeadless, { recursive: true })
    cpSync(appImagePath(oldVersion), oldAppImage)
    chmodSync(oldAppImage, 0o755)

    buildAppImage(
      targetVersion,
      rootPackage,
      desktopPackage,
      tauriConf,
      signingPrivateKey,
      signingPublicKey,
      tauriBundle.env,
    )
    cpSync(appImagePath(targetVersion), targetAppImage)
    cpSync(`${appImagePath(targetVersion)}.sig`, targetSignature)
    chmodSync(targetAppImage, 0o755)
  } finally {
    writeFileSync(rootPackagePath, rootPackageText)
    writeFileSync(desktopPackagePath, desktopPackageText)
    writeFileSync(tauriConfPath, tauriConfText)
    for (const path of tauriBundle.cleanup) await rm(path, { force: true })
  }

  const built = await buildDevBundle({
    lock: {
      acquire: async () => true,
      renew: async () => undefined,
      release: async () => undefined,
    },
    root: repoRoot,
    artifactRoot: repoRoot,
    headSha: sha,
    signingKey: key.privateKey,
    publisherStateDir: publicationState,
    releaseVersion: targetVersion,
    checkoutReleaseBase: oldVersion,
    platforms: ['linux-x86_64'],
  })
  const state = readDevPublisherState(publicationState)
  if (!state) throw new Error('candidate build did not persist publisher state')
  writeDevPublisherState({ ...state, lastPublishedSha: sha }, publicationState)
  const metadata = {
    oldVersion,
    targetVersion,
    sha,
    oldHeadless,
    oldAppImage,
    targetAppImage,
    targetSignature,
    publicationState,
    built,
    token,
  }
  writeJson(metadataPath, metadata)
  return {
    ...metadata,
    artifactSha: sha,
    harnessSha: currentSha,
    integrationBaseSha,
    cacheAcceptance: {
      reused: false,
      changedPaths: [],
      artifactToIntegrationPaths: [],
    },
  }
}

function desktopManifest(version: string, signature: string, artifactUrl: string): Json {
  return {
    version,
    notes: 'POD-2973 isolated native update candidate',
    pub_date: new Date().toISOString(),
    platforms: {
      'linux-x86_64': { signature, url: artifactUrl },
    },
  }
}

function strictConvergence(
  label: string,
  target: string,
  fleet: FleetSnapshot,
  version: Json,
  web: Json,
  mobile: Json,
  requiredMachineIds: string[],
): void {
  const failures: string[] = []
  if (version.appVersion !== target) failures.push(`server=${String(version.appVersion)}`)
  if (web.appVersion !== target) failures.push(`web=${String(web.appVersion)}`)
  if (mobile.appVersion !== target) failures.push(`mobile=${String(mobile.appVersion)}`)
  for (const id of requiredMachineIds) {
    const machine = fleet.machines?.find((candidate) => candidate.id === id)
    if (!machine?.online || machine.version !== target) {
      failures.push(`${machine?.name ?? id}=${machine?.online ? machine.version : 'offline'}`)
    }
  }
  if (failures.length > 0) throw new Error(`${label} has not converged: ${failures.join(', ')}`)
}

async function finalTruth(
  api: Api,
  origin: string,
  operationId: string,
  target: string,
  machineIds: string[],
  requireDaemonConnected = false,
): Promise<{
  operation: OperationRow
  fleet: FleetSnapshot
  version: Json
  health: Json
  web: Json
  mobile: Json
}> {
  const operation = await waitFor(
    async () => {
      const row = (await operationHistory(api)).find((candidate) => candidate.id === operationId)
      return row?.state === 'done' ? row : undefined
    },
    `${operationId} durable success`,
    360_000,
    500,
  )
  const version = await waitFor(
    async () => {
      const value = await httpJson(origin, '/version')
      return value.appVersion === target &&
        (!requireDaemonConnected || value.daemonConnected === true)
        ? value
        : undefined
    },
    `${origin} version ${target}${requireDaemonConnected ? ' with daemon connectivity' : ''}`,
    360_000,
    500,
  )
  const ready = await waitFor(() => health(origin), `${origin} readiness`, 120_000, 300)
  const converged = await waitFor(
    async () => {
      const [web, mobile, fleet] = await Promise.all([
        httpJson(origin, '/podium-build.json'),
        httpJson(origin, '/mobile/podium-build.json'),
        api.updates.fleet.query() as Promise<FleetSnapshot>,
      ])
      try {
        strictConvergence(origin, target, fleet, version, web, mobile, machineIds)
        return { fleet, web, mobile }
      } catch {
        return undefined
      }
    },
    `every required component at ${target}`,
    360_000,
    500,
  )
  return { operation, version, health: ready, ...converged }
}

async function shellRestartTruth(
  value: Fixture,
  display: string,
  oldWindowId: string,
  target: string,
): Promise<{ newWindowId: string; runningVersion: string }> {
  const runningVersion = await waitFor(
    async () => {
      try {
        const version = (await readFile(join(value.state, 'running-version'), 'utf8')).trim()
        return version === target ? version : undefined
      } catch {
        return undefined
      }
    },
    `packaged shell restart on ${target}`,
    180_000,
    250,
  )
  const newWindowId = await waitFor(
    () => {
      const id = x11(display, 'id', 2)
      return id && id !== oldWindowId ? id : undefined
    },
    'a replacement native window',
    90_000,
    300,
  )
  await sleep(2_000)
  return { newWindowId, runningVersion }
}

async function shellRestartBegan(
  value: Fixture,
  target: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const running = (await readFile(join(value.state, 'running-version'), 'utf8')).trim()
      if (running === target) return true
    } catch {}
    await sleep(250)
  }
  return false
}

async function driveNativeRestart(
  value: Fixture,
  display: string,
  target: string,
  requests: string[],
  label: string,
  secondScreenshot: string,
  finalScreenshot: string,
): Promise<{
  additionalReloadActions: Array<{
    pointer: { x: number; y: number; windowId: string }
    screenshot: string
  }>
  restartAction: {
    pointer: { x: number; y: number; windowId: string }
    screenshot: string
    stage: 'second-post-payload action' | 'third-post-payload action'
  }
  shellTruth: { newWindowId: string; runningVersion: string }
}> {
  await sleep(3_000)
  const manifestsBeforeSecond = requests.filter((request) =>
    request.includes('/updates/feed/dev/latest.json'),
  ).length
  const downloadsBeforeSecond = requests.filter((request) =>
    request.includes('/desktop.AppImage'),
  ).length
  capture(display, secondScreenshot)
  const secondClick = clickPrimary(display)
  if (await shellRestartBegan(value, target, 12_000)) {
    await waitFor(
      () =>
        requests.filter((request) => request.includes('/desktop.AppImage')).length >
        downloadsBeforeSecond
          ? true
          : undefined,
      `the native ${label} Restart Podium action to request the signed desktop artifact`,
      15_000,
      250,
    )
    return {
      additionalReloadActions: [],
      restartAction: {
        pointer: secondClick,
        screenshot: secondScreenshot,
        stage: 'second-post-payload action',
      },
      shellTruth: await shellRestartTruth(value, display, secondClick.windowId, target),
    }
  }
  await waitFor(
    () =>
      requests.filter((request) => request.includes('/updates/feed/dev/latest.json')).length >
      manifestsBeforeSecond
        ? true
        : undefined,
    `the twice-reloaded ${label} page to offer the native desktop restart`,
    60_000,
    250,
  )
  await sleep(3_000)
  capture(display, finalScreenshot)
  const downloadsBeforeFinal = requests.filter((request) =>
    request.includes('/desktop.AppImage'),
  ).length
  const finalClick = clickPrimary(display)
  await waitFor(
    () =>
      requests.filter((request) => request.includes('/desktop.AppImage')).length >
      downloadsBeforeFinal
        ? true
        : undefined,
    `the native ${label} Restart Podium action to request the signed desktop artifact`,
    15_000,
    250,
  )
  return {
    additionalReloadActions: [{ pointer: secondClick, screenshot: secondScreenshot }],
    restartAction: {
      pointer: finalClick,
      screenshot: finalScreenshot,
      stage: 'third-post-payload action',
    },
    shellTruth: await shellRestartTruth(value, display, finalClick.windowId, target),
  }
}

async function runAllInOne(candidate: Awaited<ReturnType<typeof prepareCandidate>>): Promise<Json> {
  const value = await fixture('podium-native-2973-aio', 'native-2973-all-in-one')
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const tls = await startTlsProxy(value.root, port, readFileSync(candidate.targetAppImage))
  copyPublicationIdentity(
    candidate.publicationState,
    value.state,
    candidate.artifactSha,
    candidate.targetVersion,
  )
  await rm(devFeedManifestPath(repoRoot), { force: true })
  await rm(join(repoRoot, 'dist-bun/latest.json'), { force: true })
  writeJson(join(value.state, 'config.json'), {
    configVersion: 2,
    mode: 'all-in-one',
    port,
    publicUrl: tls.origin,
    updateChannel: 'dev',
  })
  await cp(candidate.oldHeadless, value.payload, { recursive: true })
  chmodSync(join(value.payload, 'podium'), 0o755)
  chmodSync(join(value.payload, 'podium-cli'), 0o755)
  const appPath = join(value.root, `Podium_${candidate.oldVersion}_amd64.AppImage`)
  cpSync(candidate.oldAppImage, appPath)
  chmodSync(appPath, 0o755)
  const display = await startDisplay()
  let shell: ManagedProcess | undefined
  let passed = false
  try {
    shell = spawnManaged(
      'all-in-one-shell',
      'dbus-run-session',
      ['--', appPath],
      isolatedEnv(value, {
        DISPLAY: display.name,
        APPIMAGE: appPath,
        PODIUM_DEV_SOURCE_ROOT: repoRoot,
        PODIUM_DEV_ARTIFACT_BASE_URL: tls.origin,
        ...tlsTrust(tls),
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
        LIBGL_ALWAYS_SOFTWARE: '1',
        GDK_BACKEND: 'x11',
      }),
    )
    await waitFor(() => x11(display.name, 'id', 2), 'all-in-one native window', 90_000)
    const baseline = await waitFor(
      async () => {
        const version = await httpJson(origin, '/version')
        return version.appVersion === candidate.oldVersion && version.daemonConnected === true
          ? version
          : undefined
      },
      'old all-in-one packaged server',
      120_000,
      400,
    )
    const initialDaemonPid = await waitFor(
      () => readPid(value.state, 'daemon'),
      'initial all-in-one supervised daemon',
      30_000,
      250,
    )
    const initialListeners = await daemonListenerTruth(value.state, value.instance)
    const api = trpc(origin)
    await seedWorkspace(api)
    await writeHeadlessManifest(candidate.built, tls.origin, candidate.token, candidate.sha)
    writeJson(
      join(repoRoot, 'dist-bun/latest.json'),
      desktopManifest(
        candidate.targetVersion,
        readFileSync(candidate.targetSignature, 'utf8').trim(),
        `${tls.origin}/desktop.AppImage`,
      ),
    )
    tls.requests.length = 0
    await waitFor(
      async () => {
        const checks = await api.updates.checkNow.mutate()
        const fleet = (await api.updates.fleet.query()) as FleetSnapshot
        if (fleet.targetVersion === candidate.targetVersion) return fleet
        throw new Error(
          `checkNow=${JSON.stringify(checks)} targetVersion=${JSON.stringify(fleet.targetVersion ?? null)}`,
        )
      },
      'all-in-one update offer',
      90_000,
      1_000,
    )
    const nativeFallbackPrompt = settleNativeUpdatePrompt(display.name)
    const beforeIds = new Set((await operationHistory(api)).map((row) => row.id))
    await sleep(2_000)
    capture(display.name, screenshots.allInOneOffer)
    const actionControl = await proveBrokenAction(api, beforeIds)
    const firstClick = clickPrimary(display.name)
    const operation = await waitFor(
      () => newestOperationAfter(api, beforeIds),
      'operation created by the all-in-one native Update action',
      30_000,
      150,
    )
    capture(display.name, screenshots.allInOneApplying)
    const truthBeforeShell = await finalTruth(
      api,
      origin,
      operation.id,
      candidate.targetVersion,
      [
        ...((await api.machines.list.query()) as MachineRow[])
          .filter((machine) => machine.supervised)
          .map((machine) => machine.id),
      ],
      true,
    )
    await waitFor(
      () =>
        tls.requests.some((request) => request.includes('/updates/feed/dev/latest.json'))
          ? true
          : undefined,
      'the reloaded native all-in-one updater to consume the server-produced HTTPS endpoint',
      60_000,
      250,
    )
    const payloadRestart = await daemonListenerTruth(value.state, value.instance, initialDaemonPid)
    const payloadWindowId = x11(display.name, 'id', 2)
    if (payloadWindowId !== firstClick.windowId) {
      throw new Error('native all-in-one window did not stay open across the payload restart')
    }
    const manifestRequestsBeforeReload = tls.requests.filter((request) =>
      request.includes('/updates/feed/dev/latest.json'),
    ).length
    capture(display.name, screenshots.allInOneReload)
    const reloadClick = clickPrimary(display.name)
    await waitFor(
      () =>
        tls.requests.filter((request) => request.includes('/updates/feed/dev/latest.json')).length >
        manifestRequestsBeforeReload
          ? true
          : undefined,
      'the reloaded all-in-one page to check the native desktop update',
      60_000,
      250,
    )
    const nativeRestart = await driveNativeRestart(
      value,
      display.name,
      candidate.targetVersion,
      tls.requests,
      'all-in-one',
      screenshots.allInOneReloadAgain,
      screenshots.allInOneRestart,
    )
    const { shellTruth } = nativeRestart
    const post = await finalTruth(
      api,
      origin,
      operation.id,
      candidate.targetVersion,
      truthBeforeShell.fleet.machines
        ?.filter((machine) => machine.supervised)
        .map((machine) => machine.id) ?? [],
      true,
    )
    const postRestartListeners = await daemonListenerTruth(
      value.state,
      value.instance,
      Number(payloadRestart.daemonPid),
    )
    capture(display.name, screenshots.allInOneCurrent)
    const config = readJson(join(value.state, 'config.json'))
    const daemonPid = await readPid(value.state, 'daemon')
    const serverPid = await readPid(value.state, 'server')
    if (
      config.mode !== 'all-in-one' ||
      config.updateFeedEndpoint !== `${tls.origin}/updates/feed/dev/latest.json` ||
      !daemonPid ||
      !serverPid
    ) {
      throw new Error(
        `all-in-one topology did not survive restart: ${JSON.stringify({ config, daemonPid, serverPid })}`,
      )
    }
    const evidence = {
      topology: 'all-in-one',
      isolatedInstance: value.instance,
      baseline,
      initialListeners,
      nativeFallbackPrompt,
      actionControl: {
        detected: true,
        reason: actionControl,
        screenshot: screenshots.allInOneOffer,
      },
      updateAction: { pointer: firstClick, operationId: operation.id },
      automaticPayloadRespawn: {
        ...payloadRestart,
        shellWindowStayedOpen: payloadWindowId === firstClick.windowId,
      },
      payloadConvergenceBeforeShellRestart: truthBeforeShell,
      reloadActions: [
        { pointer: reloadClick, screenshot: screenshots.allInOneReload },
        ...nativeRestart.additionalReloadActions,
      ],
      restartAction: nativeRestart.restartAction,
      shellReplacement: shellTruth,
      postRestart: {
        ...post,
        topology: config.mode,
        daemonPid,
        serverPid,
        listeners: postRestartListeners,
        windowUsable: x11(display.name, 'id', 2) === shellTruth.newWindowId,
        screenshot: screenshots.allInOneCurrent,
      },
      updaterEndpoint: {
        serverProduced: config.updateFeedEndpoint,
        expected: `${tls.origin}/updates/feed/dev/latest.json`,
        requests: tls.requests,
      },
      logs: shell.output
        .join('')
        .split('\n')
        .filter((line) => /update|restart|spawning|version/iu.test(line))
        .slice(-120),
    }
    passed = true
    return evidence
  } catch (error) {
    console.error(
      `[all-in-one failure evidence] isolatedRoot=${value.root} shellPid=${String(shell?.child.pid ?? 'not-started')} shellExit=${String(shell?.child.exitCode ?? 'running')} shellSignal=${String(shell?.child.signalCode ?? 'none')}`,
    )
    if (shell) console.error(shell.output.join(''))
    retainFailureSnapshot(value, 'all-in-one-shell', shell)
    await retainProcessEvidence(value, 'all-in-one-shell', shell, error)
    throw error
  } finally {
    await stopState(value.state)
    display.child.kill('SIGTERM')
    tls.server.close()
    if (passed) await rm(value.root, { recursive: true, force: true })
  }
}

async function copyOldInstall(source: string, value: Fixture): Promise<string> {
  const install = join(value.root, 'install')
  await cp(source, install, { recursive: true })
  chmodSync(join(install, 'podium'), 0o755)
  chmodSync(join(install, 'podium-cli'), 0o755)
  return join(install, 'podium')
}

async function runDaemonTopology(
  candidate: Awaited<ReturnType<typeof prepareCandidate>>,
): Promise<Json> {
  const primary = await fixture('podium-native-2973-primary', 'native-2973-primary')
  const participant = await fixture('podium-native-2973-fleet', 'native-2973-fleet')
  const desktop = await fixture('podium-native-2973-daemon', 'native-2973-daemon')
  const port = await freePort()
  const origin = `http://${lanAddress()}:${port}`
  const serverUrl = origin.replace(/^http/u, 'ws')
  const tls = await startTlsProxy(primary.root, port, readFileSync(candidate.targetAppImage))
  copyPublicationIdentity(
    candidate.publicationState,
    primary.state,
    candidate.artifactSha,
    candidate.targetVersion,
  )
  await rm(devFeedManifestPath(repoRoot), { force: true })
  await rm(join(repoRoot, 'dist-bun/latest.json'), { force: true })
  writeJson(join(primary.state, 'config.json'), {
    configVersion: 2,
    mode: 'server',
    port,
    publicUrl: tls.origin,
    updateChannel: 'dev',
  })
  const primaryBinary = await copyOldInstall(candidate.oldHeadless, primary)
  const participantBinary = await copyOldInstall(candidate.oldHeadless, participant)
  const primaryProcess = spawnManaged(
    'remote-primary',
    primaryBinary,
    ['parent', '--takeover'],
    isolatedEnv(primary, {
      PODIUM_PORT: String(port),
      PODIUM_HOST: '0.0.0.0',
      PODIUM_DEV_SOURCE_ROOT: repoRoot,
      PODIUM_DEV_ARTIFACT_BASE_URL: tls.origin,
      ...tlsTrust(tls),
    }),
  )
  const display = await startDisplay()
  let participantProcess: ManagedProcess | undefined
  let shell: ManagedProcess | undefined
  let passed = false
  try {
    await waitFor(() => health(origin), 'isolated remote primary', 120_000, 400)
    const api = trpc(origin)
    await pair(api, participantBinary, participant, serverUrl, 'isolated native update fleet')
    await pair(
      api,
      join(candidate.oldHeadless, 'podium'),
      desktop,
      serverUrl,
      'isolated native update desktop',
    )
    participantProcess = spawnManaged(
      'fleet-participant',
      participantBinary,
      ['parent', '--takeover'],
      isolatedEnv(participant, tlsTrust(tls)),
    )
    const participantMachineId = await waitFor(
      () => readMachineId(participant.state),
      'selected fleet participant identity',
      90_000,
      250,
    )
    const participantMachine = await waitFor(
      async () => {
        const rows = (await api.machines.list.query()) as MachineRow[]
        return rows.find(
          (machine) => machine.id === participantMachineId && machine.online && !machine.supervised,
        )
      },
      'selected fleet participant online',
      90_000,
      500,
    )

    const appPath = join(desktop.root, `Podium_${candidate.oldVersion}_amd64.AppImage`)
    cpSync(candidate.oldAppImage, appPath)
    chmodSync(appPath, 0o755)
    shell = spawnManaged(
      'daemon-shell',
      'dbus-run-session',
      ['--', appPath],
      isolatedEnv(desktop, {
        DISPLAY: display.name,
        APPIMAGE: appPath,
        ...tlsTrust(tls),
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
        LIBGL_ALWAYS_SOFTWARE: '1',
        GDK_BACKEND: 'x11',
      }),
    )
    await waitFor(() => x11(display.name, 'id', 2), 'daemon native window', 90_000)
    const desktopMachineId = await waitFor(
      () => readMachineId(desktop.state),
      'desktop supervised daemon identity',
      90_000,
      250,
    )
    const desktopMachine = await waitFor(
      async () => {
        const rows = (await api.machines.list.query()) as MachineRow[]
        return rows.find(
          (machine) => machine.id === desktopMachineId && machine.online && machine.supervised,
        )
      },
      'desktop supervised daemon online',
      90_000,
      500,
    )
    const initialDaemonPid = await waitFor(
      () => readPid(desktop.state, 'daemon'),
      'initial desktop supervised daemon',
      30_000,
      250,
    )
    const initialListeners = await daemonListenerTruth(desktop.state, desktop.instance)
    await seedWorkspace(api, participantMachine.id)
    await writeHeadlessManifest(candidate.built, tls.origin, candidate.token, candidate.sha)
    writeJson(
      join(repoRoot, 'dist-bun/latest.json'),
      desktopManifest(
        candidate.targetVersion,
        readFileSync(candidate.targetSignature, 'utf8').trim(),
        `${tls.origin}/desktop.AppImage`,
      ),
    )
    tls.requests.length = 0
    await waitFor(
      async () => {
        const checks = await api.updates.checkNow.mutate()
        const fleet = (await api.updates.fleet.query()) as FleetSnapshot
        if (fleet.targetVersion === candidate.targetVersion) return fleet
        throw new Error(
          `checkNow=${JSON.stringify(checks)} targetVersion=${JSON.stringify(fleet.targetVersion ?? null)}`,
        )
      },
      'daemon topology update offer',
      90_000,
      1_000,
    )
    const nativeFallbackPrompt = settleNativeUpdatePrompt(display.name)
    const beforeIds = new Set((await operationHistory(api)).map((row) => row.id))
    await sleep(2_000)
    capture(display.name, screenshots.daemonOffer)
    const actionControl = await proveBrokenAction(api, beforeIds)

    await stopState(participant.state)
    await waitFor(
      async () => {
        const rows = (await api.machines.list.query()) as MachineRow[]
        const row = rows.find((machine) => machine.id === participantMachine.id)
        return row && !row.online ? row : undefined
      },
      'selected participant offline for convergence control',
      45_000,
      500,
    )

    const firstClick = clickPrimary(display.name)
    const operation = await waitFor(
      () => newestOperationAfter(api, beforeIds),
      'operation created by daemon native Update action',
      30_000,
      150,
    )
    const partialOperation = await waitFor(
      async () => {
        const row = (await operationHistory(api)).find(
          (candidateRow) => candidateRow.id === operation.id,
        )
        return row?.state === 'done' ? row : undefined
      },
      'daemon update operation durable success with deferred participant',
      360_000,
      500,
    )
    await waitFor(
      async () => {
        const version = await httpJson(origin, '/version')
        return version.appVersion === candidate.targetVersion ? version : undefined
      },
      'remote primary target version',
      360_000,
      500,
    )
    const partialFleet = (await api.updates.fleet.query()) as FleetSnapshot
    const partialVersion = await httpJson(origin, '/version')
    const partialWeb = await httpJson(origin, '/podium-build.json')
    const partialMobile = await httpJson(origin, '/mobile/podium-build.json')
    const componentControl = await proveExpectedFailure(
      'missing component convergence',
      async () => {
        strictConvergence(
          'deliberately incomplete daemon topology',
          candidate.targetVersion,
          partialFleet,
          partialVersion,
          partialWeb,
          partialMobile,
          [desktopMachine.id, participantMachine.id],
        )
      },
    )
    capture(display.name, screenshots.daemonIncomplete)

    participantProcess = spawnManaged(
      'fleet-participant-reconnect',
      participantBinary,
      ['parent', '--takeover'],
      isolatedEnv(participant, tlsTrust(tls)),
    )
    const truthBeforeShell = await finalTruth(
      api,
      origin,
      operation.id,
      candidate.targetVersion,
      [desktopMachine.id, participantMachine.id],
      true,
    )
    await waitFor(
      () =>
        tls.requests.some((request) => request.includes('/updates/feed/dev/latest.json'))
          ? true
          : undefined,
      'the reloaded native daemon updater to consume the server-produced HTTPS endpoint',
      60_000,
      250,
    )
    const payloadRestart = await daemonListenerTruth(
      desktop.state,
      desktop.instance,
      initialDaemonPid,
    )
    const payloadWindowId = x11(display.name, 'id', 2)
    if (payloadWindowId !== firstClick.windowId) {
      throw new Error('native daemon window did not stay open across the payload restart')
    }
    const manifestRequestsBeforeReload = tls.requests.filter((request) =>
      request.includes('/updates/feed/dev/latest.json'),
    ).length
    capture(display.name, screenshots.daemonReload)
    const reloadClick = clickPrimary(display.name)
    await waitFor(
      () =>
        tls.requests.filter((request) => request.includes('/updates/feed/dev/latest.json')).length >
        manifestRequestsBeforeReload
          ? true
          : undefined,
      'the reloaded daemon-only page to check the native desktop update',
      60_000,
      250,
    )
    const nativeRestart = await driveNativeRestart(
      desktop,
      display.name,
      candidate.targetVersion,
      tls.requests,
      'daemon-only',
      screenshots.daemonReloadAgain,
      screenshots.daemonRestart,
    )
    const { shellTruth } = nativeRestart
    const post = await finalTruth(
      api,
      origin,
      operation.id,
      candidate.targetVersion,
      [desktopMachine.id, participantMachine.id],
      true,
    )
    const postRestartListeners = await daemonListenerTruth(
      desktop.state,
      desktop.instance,
      Number(payloadRestart.daemonPid),
    )
    capture(display.name, screenshots.daemonCurrent)
    const desktopConfig = readJson(join(desktop.state, 'config.json'))
    const primaryConfig = readJson(join(primary.state, 'config.json'))
    const connectivity = readJson(join(desktop.state, 'connectivity.json'))
    const daemonPid = await readPid(desktop.state, 'daemon')
    if (!daemonPid) throw new Error('desktop daemon pid missing after shell restart')
    const daemonEnv = await processEnvironment(daemonPid)
    const supervisorPid = Number(daemonEnv.PODIUM_SUPERVISOR_PID)
    const directChild = (await processParent(daemonPid)) === supervisorPid
    if (
      desktopConfig.mode !== 'daemon' ||
      desktopConfig.updateFeedEndpoint !== `${tls.origin}/updates/feed/dev/latest.json` ||
      primaryConfig.mode !== 'server' ||
      connectivity.state !== 'connected' ||
      daemonEnv.PODIUM_DESKTOP_SUPERVISED !== '1' ||
      !directChild
    ) {
      throw new Error(
        `daemon topology did not survive restart: ${JSON.stringify({ desktopConfig, primaryConfig, connectivity, daemonEnv, directChild })}`,
      )
    }
    const localServerPid = await readPid(desktop.state, 'server')
    if (localServerPid)
      throw new Error(`daemon-only desktop unexpectedly owns local server ${localServerPid}`)
    const evidence = {
      topology: 'remote-primary + desktop daemon/shell + selected fleet participant',
      isolatedInstances: [primary.instance, desktop.instance, participant.instance],
      baseline: { appVersion: candidate.oldVersion, remoteOrigin: origin },
      initialListeners,
      nativeFallbackPrompt,
      actionControl: { detected: true, reason: actionControl, screenshot: screenshots.daemonOffer },
      updateAction: { pointer: firstClick, operationId: operation.id },
      componentControl: {
        detected: true,
        actualBreak: `stopped ${participantMachine.id} before the operation snapshot`,
        reason: componentControl,
        operationState: partialOperation.state,
        deferred: partialOperation.deferred,
        screenshot: screenshots.daemonIncomplete,
      },
      automaticPayloadRespawn: {
        ...payloadRestart,
        shellWindowStayedOpen: payloadWindowId === firstClick.windowId,
      },
      payloadConvergenceBeforeShellRestart: truthBeforeShell,
      reloadActions: [
        { pointer: reloadClick, screenshot: screenshots.daemonReload },
        ...nativeRestart.additionalReloadActions,
      ],
      restartAction: nativeRestart.restartAction,
      shellReplacement: shellTruth,
      postRestart: {
        ...post,
        primaryTopology: primaryConfig.mode,
        desktopTopology: desktopConfig.mode,
        daemonConnectivity: connectivity,
        daemonSupervised: daemonEnv.PODIUM_DESKTOP_SUPERVISED === '1',
        daemonIsDirectShellChild: directChild,
        listeners: postRestartListeners,
        localServerAbsent: localServerPid === undefined,
        windowUsable: x11(display.name, 'id', 2) === shellTruth.newWindowId,
        screenshot: screenshots.daemonCurrent,
      },
      updaterEndpoint: {
        serverProduced: desktopConfig.updateFeedEndpoint,
        expected: `${tls.origin}/updates/feed/dev/latest.json`,
        requests: tls.requests,
      },
      logs: {
        primary: primaryProcess.output
          .join('')
          .split('\n')
          .filter((line) => /update|restart|version/iu.test(line))
          .slice(-100),
        participant: participantProcess.output
          .join('')
          .split('\n')
          .filter((line) => /update|grant|version/iu.test(line))
          .slice(-80),
        desktop: shell.output
          .join('')
          .split('\n')
          .filter((line) => /update|restart|daemon|version/iu.test(line))
          .slice(-100),
      },
    }
    passed = true
    return evidence
  } catch (error) {
    console.error(
      `[daemon-only failure evidence] primaryRoot=${primary.root} participantRoot=${participant.root} desktopRoot=${desktop.root}`,
    )
    for (const process of [primaryProcess, participantProcess, shell]) {
      if (!process) continue
      console.error(
        `[${process.label}] pid=${String(process.child.pid ?? 'not-started')} exit=${String(process.child.exitCode ?? 'running')} signal=${String(process.child.signalCode ?? 'none')}`,
      )
      console.error(process.output.join(''))
    }
    retainFailureSnapshot(primary, 'remote-primary', primaryProcess)
    retainFailureSnapshot(participant, 'fleet-participant', participantProcess)
    retainFailureSnapshot(desktop, 'daemon-shell', shell)
    await retainProcessEvidence(primary, 'remote-primary', primaryProcess, error)
    await retainProcessEvidence(participant, 'fleet-participant', participantProcess, error)
    await retainProcessEvidence(desktop, 'daemon-shell', shell, error)
    throw error
  } finally {
    await Promise.all([
      stopState(primary.state),
      stopState(participant.state),
      stopState(desktop.state),
    ])
    display.child.kill('SIGTERM')
    tls.server.close()
    if (passed) {
      await Promise.all([
        rm(primary.root, { recursive: true, force: true }),
        rm(participant.root, { recursive: true, force: true }),
        rm(desktop.root, { recursive: true, force: true }),
      ])
    }
  }
}

await mkdir(evidenceDir, { recursive: true })
const buildRoot = join(evidenceDir, 'pod-2973-build')
await mkdir(buildRoot, { recursive: true })
if (!existsSync(x11Driver)) throw new Error(`missing native X11 driver ${x11Driver}`)

const requiredCommands = ['Xvfb', 'ffmpeg', 'dbus-run-session', 'openssl', 'pkg-config', 'python3']
for (const command of requiredCommands) {
  const found = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' })
  if (found.status !== 0) throw new Error(`missing required native harness command ${command}`)
}
assertX11DriverContract()

const candidate = await prepareCandidate(buildRoot)
const allInOne = topology === 'daemon' ? null : await runAllInOne(candidate)
const daemonOnly = topology === 'all-in-one' ? null : await runDaemonTopology(candidate)
const webkitGtkVersion = spawnSync('pkg-config', ['--modversion', 'webkit2gtk-4.1'], {
  encoding: 'utf8',
}).stdout.trim()
const evidence = {
  issue,
  selectedTopology: topology,
  capturedAt: new Date().toISOString(),
  candidate: {
    artifactSha: candidate.artifactSha,
    harnessSha: candidate.harnessSha,
    integrationBaseSha: candidate.integrationBaseSha,
    cacheAcceptance: candidate.cacheAcceptance,
    fromVersion: candidate.oldVersion,
    targetVersion: candidate.targetVersion,
    headlessArtifact: candidate.built.path.replace(`${repoRoot}/`, ''),
    desktopArtifact: 'signed Linux x86_64 AppImage',
  },
  platform: {
    label: 'Linux x86_64 packaged Tauri shell under dedicated Xvfb',
    nativeEngine: 'WebKitGTK',
    webkitGtkVersion,
    host: hostname(),
    actionDriver: 'X11 XTest pointer events against the packaged native window',
    browserSubstitute: false,
  },
  isolation: {
    state: 'dedicated PODIUM_STATE_DIR per component',
    instance: 'unique PODIUM_INSTANCE per component',
    relay: 'PODIUM_NO_RELAY=1',
    adoption: 'PODIUM_ADOPT_STATE=1',
    notifySocketInherited: false,
    xdgAndHome: 'dedicated HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME',
    displays: 'dedicated Xvfb per topology',
    standingPrimaryTouched: false,
  },
  updaterEndpointDependency: {
    issue: 'POD-2860',
    proofUsesPersistedEndpoint: true,
    endpointShape: '<isolated-primary>/updates/feed/dev/latest.json',
    duplicatedFix: false,
  },
  controls: {
    action: 'withholding the XTest click causes the operation assertion to fail',
    component: 'an actually stopped selected participant causes strict convergence to fail',
  },
  allInOne,
  daemonOnly,
}
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`native packaged update proof passed: ${evidencePath}`)
