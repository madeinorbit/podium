#!/usr/bin/env bun
/**
 * Native WebKitGTK runtime exercise for the desktop server-down path.
 *
 * The outer process prepares the real bundled payload and debug Tauri shell. The inner process
 * runs in a systemd PrivateNetwork unit (loopback only) under Xvfb, so neither inherited relay
 * variables nor host-loopback services can be reached. A debug-only initialization script reports
 * the DOM rendered by the real webview to this harness.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

interface WindowReport {
  at: number
  href: string
  launchMode?: string
  readyState: string
  bodyText: string
}

interface Milestone {
  at: string
  elapsedMs: number
  event: string
  observed: Record<string, unknown>
}

const repoRoot = resolve(import.meta.dirname, '../../..')
const desktopDir = join(repoRoot, 'apps/desktop')
const tauriDir = join(desktopDir, 'src-tauri')
const binary = join(tauriDir, 'target/debug/Podium')
const evidenceDefault = join(
  tauriDir,
  'tests/evidence/pod-2522-linux-webkitgtk-native-runtime.json',
)
const args = new Set(process.argv.slice(2))
const inside = args.has('--inside-net')
const prepare = args.has('--prepare')
const outputArg = process.argv.find((arg) => arg.startsWith('--out='))
const evidencePath = outputArg ? resolve(outputArg.slice('--out='.length)) : evidenceDefault

function run(command: string, commandArgs: string[], cwd = repoRoot): void {
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} failed with ${result.status ?? result.signal}`,
    )
  }
}

if (!inside) {
  if (prepare) {
    run('bun', ['scripts/preflight.ts'], desktopDir)
    run('bun', ['scripts/stage-sidecar.ts'], desktopDir)
    run('cargo', ['build'], tauriDir)
  }
  const innerArgs = process.argv
    .slice(2)
    .filter((arg) => arg !== '--prepare')
    .concat('--inside-net')
  const forwardedEnv = ['PATH', 'HOME', 'USER'].flatMap((key) => {
    const value = process.env[key]
    return value ? [`--setenv=${key}=${value}`] : []
  })
  const result = spawnSync(
    'systemd-run',
    [
      '--user',
      '--wait',
      '--pipe',
      '--collect',
      '--property=PrivateNetwork=yes',
      `--working-directory=${repoRoot}`,
      ...forwardedEnv,
      process.execPath,
      import.meta.filename,
      ...innerArgs,
    ],
    { cwd: repoRoot, stdio: 'inherit', env: process.env },
  )
  process.exit(result.status ?? 1)
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('could not allocate a loopback port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

async function waitFor<T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs = 30_000,
  pollMs = 100,
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

async function health(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(750),
    })
    return response.ok && (await response.text()).includes('ok')
  } catch {
    return false
  }
}

async function version(port: number): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok) return undefined
    return (await response.json()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function compact(report: WindowReport): Record<string, unknown> {
  return {
    href: report.href.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>'),
    launchMode: report.launchMode,
    readyState: report.readyState,
    bodyIncludes: ['The backend went quiet.', 'Retry connection'].filter((needle) =>
      report.bodyText.includes(needle),
    ),
  }
}

async function runWindowScenario(options: {
  mode: 'server-down' | 'server-down-disabled'
  negativeControl?: boolean
}): Promise<{
  milestones: Milestone[]
  desktopLog: string[]
  reports: WindowReport[]
  detectedFailure?: string
}> {
  const root = await mkdtemp(join(tmpdir(), `podium-2522-${options.mode}-`))
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
  const port = await freePort()
  await writeFile(
    join(stateDir, 'config.json'),
    `${JSON.stringify({ mode: 'all-in-one', port }, null, 2)}\n`,
  )

  const reports: WindowReport[] = []
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'POST') {
        try {
          const report = JSON.parse(await request.text()) as WindowReport
          if (typeof report.href === 'string' && typeof report.bodyText === 'string') {
            reports.push(report)
          }
        } catch {}
      }
      return new Response('ok')
    },
  })

  const started = Date.now()
  const milestones: Milestone[] = []
  const mark = (event: string, observed: Record<string, unknown>): void => {
    milestones.push({
      at: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      event,
      observed,
    })
  }
  let output = ''
  const cleanEnv: NodeJS.ProcessEnv = {
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
    PODIUM_INSTANCE: `native-2522-${options.mode}`,
    PODIUM_NO_RELAY: '1',
    PODIUM_LOG_LEVEL: 'info',
    PODIUM_DESKTOP_RUNTIME_PROBE: options.mode,
    PODIUM_DESKTOP_RUNTIME_TRACE_URL: `http://127.0.0.1:${receiver.port}/window`,
    NO_AT_BRIDGE: '1',
  }
  const child = spawn('dbus-run-session', ['--', 'xvfb-run', '-a', binary], {
    cwd: repoRoot,
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString()
  })

  try {
    const initial = await waitFor(
      () =>
        reports.find(
          (report) =>
            report.href.startsWith(`http://127.0.0.1:${port}`) &&
            report.launchMode === 'all-in-one' &&
            report.readyState === 'complete' &&
            report.bodyText.trim().length > 0,
        ),
      'the served Podium document in the native window',
      60_000,
    )
    const initialVersion = await waitFor(
      () => version(port),
      'the live local sidecar identity',
      30_000,
    )
    mark('served-origin-loaded', {
      window: compact(initial),
      versionIdentity: {
        appVersion: initialVersion.appVersion,
        wireVersion: initialVersion.wireVersion,
        wireSchemaDigest: initialVersion.wireSchemaDigest,
        instanceId: initialVersion.instanceId,
      },
    })

    if (options.negativeControl) {
      const serverPid = await waitFor(
        () => readPid(stateDir, 'server'),
        'server pid for the negative control',
      )
      process.kill(serverPid, 'SIGSTOP')
      const cutoff = Date.now()
      let failure = ''
      try {
        await waitFor(
          () => reports.find((report) => report.at >= cutoff && report.href.startsWith('tauri:')),
          'baked fallback with the watchdog deliberately disabled',
          12_000,
        )
      } catch (error) {
        failure = String(error)
      } finally {
        if (alive(serverPid)) process.kill(serverPid, 'SIGCONT')
      }
      if (!failure) {
        throw new Error('negative control unexpectedly passed with the watchdog disabled')
      }
      mark('deliberate-break-detected', {
        break: 'local document watchdog disabled',
        exerciseResult: 'FAIL',
        reason: 'no baked navigation was observed after the local server stopped answering',
      })
      return {
        milestones,
        reports,
        desktopLog: output
          .split('\n')
          .filter((line) => /watchdog|loading UI|launch action/.test(line)),
        detectedFailure: failure.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>'),
      }
    }

    const payloadBinary = join(payloadDir, 'podium')
    const heldBinary = join(payloadDir, 'podium.runtime-held')
    await waitFor(async () => {
      try {
        await chmod(payloadBinary, 0o755)
        return true
      } catch {
        return undefined
      }
    }, 'the seeded payload executable')
    await rename(payloadBinary, heldBinary)
    const parentPid = await waitFor(() => readPid(stateDir, 'parent'), 'the sidecar parent pid')
    const serverPid = await waitFor(() => readPid(stateDir, 'server'), 'the sidecar server pid')
    process.kill(parentPid, 'SIGKILL')
    if (alive(serverPid)) process.kill(serverPid, 'SIGKILL')
    await waitFor(async () => (!(await health(port)) ? true : undefined), 'the sidecar outage')
    mark('sidecar-killed', {
      pid: '<redacted>',
      killedRoles: ['parent', 'server'],
      executableHeldForRespawnFailure: true,
    })

    const baked = await waitFor(
      () =>
        reports.find(
          (report) =>
            report.href.startsWith('tauri:') &&
            report.readyState === 'complete' &&
            report.bodyText.includes('The backend went quiet.') &&
            report.bodyText.includes('Retry connection'),
        ),
      'the baked reconnect UX after the supervised restart budget and six failed polls',
      65_000,
      200,
    )
    mark('baked-reconnect-rendered', {
      window: compact(baked),
      engineNetworkErrorPage: false,
      restartPauseBudgetMs: 30_000,
      failedPollThreshold: 6,
    })

    const squatter = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch() {
        return new Response('plain 200 from a non-Podium squatter')
      },
    })
    const squatterStarted = Date.now()
    await sleep(4_000)
    const acceptedSquatter = reports.find(
      (report) =>
        report.at >= squatterStarted && report.href.startsWith(`http://127.0.0.1:${port}`),
    )
    if (acceptedSquatter) {
      throw new Error('identity probe navigated the window to the non-Podium squatter')
    }
    const stillBaked = reports.filter((report) => report.at >= squatterStarted).at(-1)
    if (!stillBaked?.href.startsWith('tauri:')) {
      throw new Error('window did not remain on baked dist while the squatter owned the port')
    }
    mark('non-podium-squatter-refused', {
      response: 'HTTP 200 with non-Podium body',
      window: compact(stillBaked),
    })
    squatter.stop(true)

    await rename(heldBinary, payloadBinary)
    await chmod(payloadBinary, 0o755)
    const recoveryStarted = Date.now()
    const recovered = await waitFor(
      () =>
        reports.find(
          (report) =>
            report.at >= recoveryStarted &&
            report.href.startsWith(`http://127.0.0.1:${port}`) &&
            report.launchMode === 'all-in-one',
        ),
      'identity-checked return to the served origin',
      45_000,
    )
    await waitFor(() => version(port), 'the restarted Podium identity', 30_000)
    await sleep(8_000)
    const flapped = reports.find(
      (report) => report.at > recovered.at && report.href.startsWith('tauri:'),
    )
    if (flapped) throw new Error('the recovered window flapped back to baked dist')
    mark('identity-checked-recovery-stable', {
      window: compact(recovered),
      observedStableMs: 8_000,
      bakedNavigationsAfterRecovery: 0,
    })

    const oldParentPid = await waitFor(() => readPid(stateDir, 'parent'), 'parent before handover')
    const oldServerPid = await waitFor(() => readPid(stateDir, 'server'), 'server before handover')
    const runningVersion = await waitFor(() => version(port), 'version before handover')
    const expectedVersion = String(runningVersion.appVersion)
    const request = {
      requestId: 'pod-2522-runtime-update-handover',
      kind: 'handover',
      expectedVersion,
      requestedAt: new Date().toISOString(),
    }
    await writeFile(
      join(stateDir, 'run', 'parent-request.json'),
      `${JSON.stringify(request, null, 2)}\n`,
    )
    process.kill(oldParentPid, 'SIGUSR1')
    const successorFile = join(payloadDir, '.desktop-successor-pid')
    const successorPid = await waitFor(
      async () => {
        try {
          const pid = Number((await readFile(successorFile, 'utf8')).trim())
          return pid > 1 && alive(pid) ? pid : undefined
        } catch {
          return undefined
        }
      },
      'the update handover successor marker',
      20_000,
      20,
    )
    process.kill(successorPid, 'SIGSTOP')
    if (alive(oldServerPid)) process.kill(oldServerPid, 'SIGKILL')
    await waitFor(async () => (!(await health(port)) ? true : undefined), 'handover server outage')
    const slowBootStarted = Date.now()
    await sleep(8_000)
    const bouncedDuringUpdate = reports.find(
      (report) => report.at >= slowBootStarted && report.href.startsWith('tauri:'),
    )
    if (bouncedDuringUpdate) {
      throw new Error('window bounced to baked dist during the slow update handover')
    }
    const duringUpdate = reports.filter((report) => report.at >= slowBootStarted).at(-1)
    if (!duringUpdate?.href.startsWith(`http://127.0.0.1:${port}`)) {
      throw new Error('served document did not remain loaded during the slow update handover')
    }
    process.kill(successorPid, 'SIGCONT')
    const newParentPid = await waitFor(
      async () => {
        const pid = await readPid(stateDir, 'parent')
        return pid && pid !== oldParentPid && alive(pid) ? pid : undefined
      },
      'the update successor to own the parent role',
      60_000,
    )
    await waitFor(() => version(port), 'the update successor server identity', 45_000)
    await sleep(4_000)
    const postHandoverBounce = reports.find(
      (report) => report.at >= slowBootStarted && report.href.startsWith('tauri:'),
    )
    if (postHandoverBounce) {
      throw new Error('window flapped through baked dist during or after update handover')
    }
    mark('slow-update-respawn-stayed-served', {
      handoverRequest: 'real parent control handover',
      inducedSuccessorPauseMs: 8_000,
      oldParentPid: '<redacted>',
      successorPid: '<redacted>',
      newParentPid: newParentPid ? '<redacted>' : undefined,
      window: compact(duringUpdate),
      bakedNavigations: 0,
    })

    return {
      milestones,
      reports,
      desktopLog: output
        .split('\n')
        .filter((line) =>
          /launch action|loading UI|watchdog|backend exited|respawning|handover|local server is/.test(
            line,
          ),
        )
        .map((line) =>
          line
            .replaceAll(root, '<isolated-root>')
            .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
            .replace(/pid \d+/g, 'pid <redacted>'),
        ),
    }
  } catch (error) {
    console.error(
      output.replaceAll(root, '<isolated-root>').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>'),
    )
    throw error
  } finally {
    receiver.stop(true)
    await stopTree(child, stateDir)
    await rm(root, { recursive: true, force: true })
  }
}

if (!(await Bun.file(binary).exists())) {
  throw new Error(`missing ${binary}; rerun with --prepare`)
}

const webkitVersion = spawnSync('pkg-config', ['--modversion', 'webkit2gtk-4.1'], {
  encoding: 'utf8',
}).stdout.trim()
const positive = await runWindowScenario({ mode: 'server-down' })
const negative = await runWindowScenario({
  mode: 'server-down-disabled',
  negativeControl: true,
})

const evidence = {
  issue: 'POD-2522',
  date: new Date().toISOString().slice(0, 10),
  platform: 'Linux native Tauri WebView under isolated Xvfb — WebKitGTK, not WKWebView',
  webkitGtkVersion: webkitVersion,
  isolation: {
    display: 'issue-scoped Xvfb',
    network: 'systemd user unit with PrivateNetwork=yes (loopback only)',
    environment: 'allowlisted env; isolated HOME, XDG dirs, state, agent home, instance, payload',
    inheritedRelayVariables: false,
  },
  exercise: positive.milestones,
  observedDesktopLog: positive.desktopLog,
  deliberateBreak: {
    change: 'debug runtime control disabled spawn_local_document_watchdog',
    detected: true,
    harnessOutcome: 'the same baked-navigation assertion timed out',
    milestone: negative.milestones.find((item) => item.event === 'deliberate-break-detected'),
    capturedFailure: negative.detectedFailure,
    observedDesktopLog: negative.desktopLog,
  },
}

await mkdir(dirname(evidencePath), { recursive: true })
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`native server-down runtime exercise passed; evidence: ${evidencePath}`)
