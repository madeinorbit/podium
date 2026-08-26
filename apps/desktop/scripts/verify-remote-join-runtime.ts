#!/usr/bin/env bun
/**
 * Join a standing Podium with the real Linux Tauri shell, then prove its supervised daemon is
 * ONLINE while the WebKitGTK window signs in and renders the remote app. The optional reset mode
 * reuses a consumed join token from a fresh client state and records the resulting rejection.
 *
 * The app owns a dedicated X server, state, payload, HOME and XDG directories. Remote daemon
 * mode starts no local HTTP backend; the launch log, server observation and before/after window
 * captures prove the requested remote flow even when Podium is reachable on the default port.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AppRouter } from '../../server/src/router'

interface MachineListing {
  id: string
  name: string
  hostname: string
  online: boolean
  lastSeenAt: string
  appVersion?: string
  installKind?: string
  supervised?: boolean
  components?: string[]
}

const repoRoot = resolve(import.meta.dirname, '../../..')
const desktopDir = join(repoRoot, 'apps/desktop')
const tauriDir = join(desktopDir, 'src-tauri')
const binary = join(tauriDir, 'target/debug/Podium')
const payload = join(tauriDir, 'resources/payload/podium')
const x11Driver = join(desktopDir, 'scripts/x11-window-drive.py')
const args = new Set(process.argv.slice(2))
const prepare = args.has('--prepare')
const expectUnauthorized = args.has('--expect-unauthorized')
const outputArg = process.argv.find((arg) => arg.startsWith('--out='))
const saveJoinArg = process.argv.find((arg) => arg.startsWith('--save-join-token='))
const reuseJoinArg = process.argv.find((arg) => arg.startsWith('--reuse-join-token='))
const previousEvidenceArg = process.argv.find((arg) => arg.startsWith('--previous-evidence='))
const evidencePath = resolve(
  outputArg?.slice('--out='.length) ?? '.tmp/pod-2855-linux-remote-join.json',
)
const remoteUrl = process.env.PODIUM_REMOTE_URL
const remotePassword = process.env.PODIUM_REMOTE_PASSWORD
const nativeTitle = 'Podium ADE'
const beforeScreenshot = evidencePath.replace(/\.json$/u, '-before-login.png')
const afterScreenshot = evidencePath.replace(/\.json$/u, '-after-login.png')
const saveJoinPath = saveJoinArg
  ? resolve(saveJoinArg.slice('--save-join-token='.length))
  : undefined
const reuseJoinPath = reuseJoinArg
  ? resolve(reuseJoinArg.slice('--reuse-join-token='.length))
  : undefined
const previousEvidencePath = previousEvidenceArg
  ? resolve(previousEvidenceArg.slice('--previous-evidence='.length))
  : undefined

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs = 45_000,
  pollMs = 150,
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

function run(command: string, commandArgs: string[], cwd = repoRoot): void {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed with ${result.status ?? result.signal}`,
    )
  }
}

async function hostRelayReachable(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:18787/health', {
      signal: AbortSignal.timeout(800),
    })
    return response.ok
  } catch {
    return false
  }
}

function prepareRuntime(): void {
  if (!remoteUrl || !remotePassword) {
    throw new Error('set PODIUM_REMOTE_URL and PODIUM_REMOTE_PASSWORD')
  }
  if (prepare) {
    run('bun', ['scripts/preflight.ts'], desktopDir)
    run('bun', ['scripts/stage-sidecar.ts'], desktopDir)
    run('cargo', ['build'], tauriDir)
  }
  for (const required of [binary, payload, x11Driver]) {
    if (!existsSync(required)) throw new Error(`missing ${required}; rerun with --prepare`)
  }
  if (expectUnauthorized && (!reuseJoinPath || !previousEvidencePath)) {
    throw new Error('--expect-unauthorized requires --reuse-join-token and --previous-evidence')
  }
}

prepareRuntime()

if (!remoteUrl || !remotePassword) throw new Error('remote credentials were not forwarded')
const remoteOrigin = new URL(remoteUrl).origin

async function loginCookie(): Promise<string> {
  const response = await fetch(new URL('/auth/login', remoteOrigin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: remotePassword }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`remote login failed with HTTP ${response.status}`)
  const setCookie = response.headers.get('set-cookie')
  const cookie = setCookie?.match(/(?:^|,\s*)(podium_session=[^;]+)/)?.[1]
  if (!cookie) throw new Error('remote login returned no podium_session cookie')
  return cookie
}

function trpc(cookie: string): ReturnType<typeof createTRPCClient<AppRouter>> {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${remoteOrigin}/trpc`, headers: { cookie } })],
  })
}

function joinToken(command: string | null): string {
  const token = command?.match(/(?:^|\s)--join\s+([^\s'";]+)\s*$/u)?.[1]
  if (!token) throw new Error('pairing response did not contain one terminal --join token')
  return token
}

async function readPid(stateDir: string, role: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(join(stateDir, 'run', `${role}.pid`), 'utf8')) as {
      pid?: number
    }
    return typeof value.pid === 'number' ? value.pid : undefined
  } catch {
    return undefined
  }
}

async function procEnvironment(pid: number): Promise<Record<string, string>> {
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
  const match = status.match(/^PPid:\s+(\d+)$/m)
  return match ? Number(match[1]) : undefined
}

function freeDisplay(): number {
  for (let display = 90; display < 140; display += 1) {
    if (!existsSync(`/tmp/.X${display}-lock`)) return display
  }
  throw new Error('no free Xvfb display in :90..:139')
}

function x11Title(display: string, needle = nativeTitle): string | undefined {
  const result = spawnSync('python3', [x11Driver, 'title', needle, '1'], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', DISPLAY: display },
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function typePassword(display: string, password: string): void {
  const result = spawnSync('python3', [x11Driver, 'type', nativeTitle, '10'], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', DISPLAY: display },
    input: password,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'X11 password entry failed')
}

function captureDisplay(display: string, path: string): void {
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopTree(child: ChildProcess, stateDir: string): Promise<void> {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
  for (const role of ['parent', 'server', 'daemon', 'janitor']) {
    const pid = await readPid(stateDir, role)
    if (pid && alive(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
  }
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    sleep(4_000),
  ])
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
}

const root = await mkdtemp('/tmp/podium-native-2855-')
const stateDir = join(root, 'state')
const payloadDir = join(root, 'payload')
const home = join(root, 'home')
const xdg = join(root, 'xdg')
const agentHome = join(root, 'agent-home')
await Promise.all([
  mkdir(stateDir, { recursive: true }),
  mkdir(home, { recursive: true }),
  mkdir(join(xdg, 'config'), { recursive: true }),
  mkdir(join(xdg, 'cache'), { recursive: true }),
  mkdir(join(xdg, 'data'), { recursive: true }),
  mkdir(agentHome, { recursive: true }),
])

let reportCount = 0
let lastProbeBodyText = ''
const receiver = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    if (request.method === 'POST') {
      reportCount += 1
      try {
        const report = JSON.parse(await request.text()) as { bodyText?: string }
        lastProbeBodyText = report.bodyText ?? ''
      } catch {}
    }
    return new Response('ok')
  },
})

let xvfb: ChildProcess | undefined
let desktop: ChildProcess | undefined
let output = ''
let display: string | undefined
try {
  const hostLoopbackWasReachable = await hostRelayReachable()

  const cookie = await loginCookie()
  const api = trpc(cookie)
  const before = (await api.machines.list.query()) as MachineListing[]
  const beforeIds = new Set(before.map((machine) => machine.id))
  let token: string
  if (reuseJoinPath) {
    token = (await readFile(reuseJoinPath, 'utf8')).trim()
  } else {
    const pairing = await api.machines.pairingCode.mutate({
      copyAgentCredentials: false,
      podiumManaged: true,
    })
    token = pairing.joinCommand
      ? joinToken(pairing.joinCommand)
      : Buffer.from(
          JSON.stringify({
            v: 1,
            serverUrl: remoteOrigin.replace(/^http/u, 'ws'),
            pairCode: pairing.code,
            podiumManaged: true,
          }),
        ).toString('base64url')
  }
  if (saveJoinPath) {
    await mkdir(dirname(saveJoinPath), { recursive: true })
    await writeFile(saveJoinPath, token, { mode: 0o600 })
  }

  const baseEnv: NodeJS.ProcessEnv = {
    HOME: home,
    USER: process.env.USER ?? 'podium-runtime',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    XDG_CONFIG_HOME: join(xdg, 'config'),
    XDG_CACHE_HOME: join(xdg, 'cache'),
    XDG_DATA_HOME: join(xdg, 'data'),
    PODIUM_STATE_DIR: stateDir,
    PODIUM_ADOPT_STATE: '1',
    PODIUM_AGENT_HOME: agentHome,
    PODIUM_PAYLOAD_HOME: payloadDir,
    PODIUM_INSTANCE: 'native-2855-remote',
    PODIUM_NO_RELAY: '1',
    PODIUM_LOG_LEVEL: 'info',
    NO_AT_BRIDGE: '1',
  }
  const configured = spawnSync(payload, ['join-config', token], {
    cwd: repoRoot,
    env: baseEnv,
    encoding: 'utf8',
  })
  if (configured.status !== 0) {
    throw new Error(`join-config failed: ${configured.stderr || configured.stdout}`)
  }
  const config = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8')) as {
    mode?: string
    persistence?: string
    pairCode?: string
  }
  if (config.mode !== 'daemon' || config.persistence !== 'systemd') {
    throw new Error(
      `join wrote mode=${String(config.mode)} persistence=${String(config.persistence)}`,
    )
  }

  display = `:${freeDisplay()}`
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await sleep(350)
  if (xvfb.exitCode !== null || xvfb.signalCode !== null) throw new Error('Xvfb exited early')

  desktop = spawn('dbus-run-session', ['--', binary], {
    cwd: repoRoot,
    env: {
      ...baseEnv,
      DISPLAY: display,
      PODIUM_DESKTOP_RUNTIME_PROBE: '1',
      PODIUM_DESKTOP_RUNTIME_TRACE_URL: `http://127.0.0.1:${receiver.port}/window`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  desktop.stdout?.on('data', (chunk) => {
    output += chunk.toString()
    process.stdout.write(chunk)
  })
  desktop.stderr?.on('data', (chunk) => {
    output += chunk.toString()
    process.stderr.write(chunk)
  })

  const signedOutTitle = await waitFor(
    () => x11Title(display),
    'the native WebKitGTK window',
    60_000,
  )
  // The GTK window exists before its remote document has painted. Give WebKit time to reach the
  // autofocus password field so the XTest events exercise the page rather than the loading frame.
  await sleep(12_000)
  await mkdir(dirname(evidencePath), { recursive: true })
  captureDisplay(display, beforeScreenshot)

  typePassword(display, remotePassword)
  await sleep(12_000)
  if (expectUnauthorized) {
    await waitFor(
      () =>
        lastProbeBodyText.trim().length > 50 &&
        !/enter your password|sign in to/iu.test(lastProbeBodyText)
          ? lastProbeBodyText
          : undefined,
      'authenticated non-login UI after the daemon rejection',
      60_000,
      250,
    )
  }
  const renderedTitle = await waitFor(() => x11Title(display), 'the native window after login')
  captureDisplay(display, afterScreenshot)

  if (expectUnauthorized) {
    const previous = JSON.parse(await readFile(previousEvidencePath as string, 'utf8')) as {
      join?: { serverMachine?: { id?: string } }
    }
    const previousMachineId = previous.join?.serverMachine?.id
    if (!previousMachineId) throw new Error('previous evidence has no joined server machine id')
    const rejectedIdentity = await waitFor(async () => {
      const value = JSON.parse(await readFile(join(stateDir, 'daemon.json'), 'utf8')) as {
        machineId?: string
        token?: string
      }
      return value.machineId ? value : undefined
    }, 'the reset daemon identity')
    if (rejectedIdentity.machineId === previousMachineId) {
      throw new Error('the reset did not create a different machine identity')
    }
    const connectivity = await waitFor(
      async () => {
        const value = JSON.parse(await readFile(join(stateDir, 'connectivity.json'), 'utf8')) as {
          state?: string
          authorizationReason?: string
          updatedAt?: string
        }
        return value.state === 'unauthorized' ? value : undefined
      },
      'the reused pair code to be rejected as unauthorized',
      30_000,
      200,
    )
    if (!connectivity.authorizationReason?.includes('invalid or expired code')) {
      throw new Error(`unexpected authorization refusal: ${connectivity.authorizationReason}`)
    }
    if (!config.pairCode) throw new Error('the rejected pair code did not remain in config')

    const previousMachine = await waitFor(
      async () => {
        const machines = (await api.machines.list.query()) as MachineListing[]
        const old = machines.find((candidate) => candidate.id === previousMachineId)
        return old && !old.online ? old : undefined
      },
      'the first machine record to become an offline stale row',
      30_000,
      300,
    )
    const machinesAfter = (await api.machines.list.query()) as MachineListing[]
    if (machinesAfter.some((candidate) => candidate.id === rejectedIdentity.machineId)) {
      throw new Error('the rejected reset identity unexpectedly gained a server machine row')
    }

    const remoteVersion = (await (
      await fetch(new URL('/version', remoteOrigin), { signal: AbortSignal.timeout(5_000) })
    ).json()) as Record<string, unknown>
    const commit = spawnSync('git', ['rev-parse', '--short=9', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).stdout.trim()
    const evidence = {
      issue: 'POD-2859 reproduced from POD-2855',
      date: new Date().toISOString().slice(0, 10),
      source: { commit },
      platform: 'Linux native Tauri/WebKitGTK under dedicated Xvfb',
      remote: {
        origin: remoteOrigin,
        instanceId: remoteVersion.instanceId,
        appVersion: remoteVersion.appVersion,
        sourceDigest: remoteVersion.sourceDigest,
      },
      resetRepair: {
        reusedExactFirstJoinToken: true,
        firstMachine: {
          id: previousMachine.id,
          hostname: previousMachine.hostname,
          onlineAfterReset: previousMachine.online,
          supervised: previousMachine.supervised === true,
        },
        resetIdentity: {
          id: rejectedIdentity.machineId,
          differsFromFirstMachine: rejectedIdentity.machineId !== previousMachine.id,
          hasServerRow: false,
          issuedToken: rejectedIdentity.token !== undefined,
        },
        refusal: {
          state: connectivity.state,
          authorizationReason: connectivity.authorizationReason,
          pairCodeRemainsInConfig: config.pairCode !== undefined,
          retriedByDaemon: false,
          desktopSupervisorRespawns: output.match(/respawning in 500ms \(daemon\)/gu)?.length ?? 0,
          desktopSupervisorIgnoredBlockedExitCode: output.includes('unix_wait_status(19968)'),
        },
        appSurface: {
          webClientStayedAuthenticated: true,
          visiblePage: 'authenticated non-login surface',
          probeReportsReceived: reportCount,
          visibleTextCharacters: lastProbeBodyText.length,
          visibleTextMentionsAuthorizationFailure: /unauthor|invalid or expired|re-pair/iu.test(
            lastProbeBodyText,
          ),
          screenshot: afterScreenshot.replace(`${repoRoot}/`, ''),
        },
      },
      observedDesktopLog: output
        .split('\n')
        .filter((line) =>
          /launch action|spawning daemon|server rejected|invalid or expired|Authorization will not be retried|backend exited|respawning/.test(
            line,
          ),
        )
        .map((line) => line.replaceAll(root, '<isolated-root>')),
    }
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`native reset/re-pair rejection reproduced; evidence: ${evidencePath}`)
  } else {
    const machine = await waitFor(
      async () => {
        const machines = (await api.machines.list.query()) as MachineListing[]
        return machines.find(
          (candidate) =>
            !beforeIds.has(candidate.id) && candidate.hostname === hostname() && candidate.online,
        )
      },
      'the newly joined native machine to be ONLINE on the standing server',
      60_000,
      500,
    )
    const daemonPid = await waitFor(() => readPid(stateDir, 'daemon'), 'the supervised daemon pid')
    const daemonEnv = await procEnvironment(daemonPid)
    const supervisorPid = Number(daemonEnv.PODIUM_SUPERVISOR_PID)
    const daemonParentPid = await processParent(daemonPid)
    if (daemonEnv.PODIUM_DESKTOP_SUPERVISED !== '1' || !Number.isInteger(supervisorPid)) {
      throw new Error('daemon is online but lacks the desktop supervision markers')
    }
    if (daemonParentPid !== supervisorPid) {
      throw new Error('the online daemon is not the desktop supervisor process direct child')
    }

    const remoteVersion = (await (
      await fetch(new URL('/version', remoteOrigin), { signal: AbortSignal.timeout(5_000) })
    ).json()) as Record<string, unknown>
    const webkitVersion = spawnSync('pkg-config', ['--modversion', 'webkit2gtk-4.1'], {
      encoding: 'utf8',
    }).stdout.trim()
    const commit = spawnSync('git', ['rev-parse', '--short=9', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).stdout.trim()
    const evidence = {
      issue: 'POD-2855',
      date: new Date().toISOString().slice(0, 10),
      source: { commit },
      platform: 'Linux native Tauri WebView under dedicated Xvfb — WebKitGTK, not WKWebView',
      webkitGtkVersion: webkitVersion,
      packaging: {
        form: 'debug Tauri binary with staged packaged payload',
        supervisionDifferenceFromAppImage: 'none',
        excludedBoundary: 'AppImage self-replacement/update packaging',
      },
      isolation: {
        hostname: hostname(),
        display: display.replace(/\d+/, '<isolated>'),
        network: 'host network; remote daemon mode starts no local HTTP backend',
        hostLoopbackPodiumReachable: hostLoopbackWasReachable,
        remoteOriginProvedByConfigAndDaemonLaunch: true,
        environment: 'allowlisted app env; dedicated HOME, XDG dirs, state, agent home and payload',
        inheritedRelayVariables: false,
      },
      remote: {
        origin: remoteOrigin,
        instanceId: remoteVersion.instanceId,
        appVersion: remoteVersion.appVersion,
        sourceDigest: remoteVersion.sourceDigest,
      },
      join: {
        configMode: config.mode,
        persistedPersistence: config.persistence,
        windowBeforeLogin: {
          nativeTitle: signedOutTitle,
          screenshot: beforeScreenshot.replace(`${repoRoot}/`, ''),
        },
        windowAfterLogin: {
          nativeTitle: renderedTitle,
          screenshot: afterScreenshot.replace(`${repoRoot}/`, ''),
        },
        serverMachine: {
          id: machine.id,
          name: machine.name,
          hostname: machine.hostname,
          online: machine.online,
          supervised: machine.supervised === true,
          installKind: machine.installKind,
          appVersion: machine.appVersion,
          components: machine.components,
        },
        localSupervision: {
          desktopSupervisedEnvironment: daemonEnv.PODIUM_DESKTOP_SUPERVISED === '1',
          supervisorPidEnvironment: Number.isInteger(supervisorPid),
          daemonIsDirectDesktopChild: daemonParentPid === supervisorPid,
          systemdPersistenceBypassed: config.persistence === 'systemd',
        },
      },
      runtimeProbeReportsReceived: reportCount,
      observedDesktopLog: output
        .split('\n')
        .filter((line) => /launch action|spawning daemon|backend exited|respawning/.test(line))
        .map((line) => line.replaceAll(root, '<isolated-root>')),
    }
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    console.log(`native remote-join runtime exercise passed; evidence: ${evidencePath}`)
  }
} catch (error) {
  const currentWindowTitle = display ? x11Title(display, 'Podium') : undefined
  console.error(`native window at failure: ${currentWindowTitle ?? '<not found>'}`)
  throw error
} finally {
  receiver.stop(true)
  if (desktop) await stopTree(desktop, stateDir)
  if (xvfb?.pid && xvfb.exitCode === null && xvfb.signalCode === null) xvfb.kill('SIGTERM')
  await rm(root, { recursive: true, force: true })
}
