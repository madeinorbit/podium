/**
 * A miniature Podium stack for real-process parent tests [POD-2505].
 *
 * WHY A FIXTURE AND NOT THE REAL BINARY: the behaviours under test are process
 * LIFECYCLE — a crash restarting on a backoff ladder, a refusal staying parked,
 * a successor being watched over HTTP and then killed when it never arrives.
 * Each needs several real spawns and several real deaths, and the full stack
 * takes tens of seconds to reach `daemonConnected` once. So this file plays the
 * three roles the parent knows (`server`, `daemon`, `parent`) with the same
 * INVOCATION SHAPE the real CLI has, and the parent under test is the real
 * `ParentProcess`, spawning real OS processes, dying for real.
 *
 * The full-stack proof — that this shape matches the real one — is
 * scripts/parent-supervised-stack.integration.test.ts, which drives
 * scripts/cli.ts itself.
 *
 * Invoked as `bun --conditions=@podium/source parent-stack-fixture.ts <role> …`,
 * which is exactly what `installInvocation` builds when PODIUM_PARENT_CLI is set.
 *
 * Env knobs (all optional):
 *   FIXTURE_EXIT_AFTER_MS / FIXTURE_EXIT_CODE   — die on cue: crash (1) or refuse (78)
 *   FIXTURE_SERVER_NEVER_HEALTHY=1              — bind, but never report the daemon connected
 *   FIXTURE_SERVER_REFUSE_START=1               — exit before binding
 *   FIXTURE_HANDOVER_TIMEOUT_MS                 — shorten the 90s successor gate
 *   FIXTURE_RELEASE_HAD_MIGRATIONS=1|0          — what the swap would have reported
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const role = process.argv[2]
const stateDir = process.env.PODIUM_STATE_DIR ?? process.env.PODIUM_HOME ?? process.cwd()
/**
 * The INSTALL directory, which a rollback RENAMES. Usually the same directory as
 * the state dir in these tests; the rollback case points them at siblings,
 * because `run/` (pidfiles, the request channel, these logs) has to survive the
 * rename that swaps `.old` back into place.
 */
const installDir = process.env.PODIUM_HOME ?? stateDir
const runDir = join(stateDir, 'run')
const port = Number(process.env.PODIUM_PORT ?? 0)
const daemonMarker = join(runDir, 'fixture-daemon.alive')
const serverMarker = join(runDir, 'fixture-server.pid')

mkdirSync(runDir, { recursive: true })

/**
 * Append-only ledger of every fixture process that ever started, so a test can
 * count SPAWNS rather than sample "is something running now" — the difference
 * between "the parent restarted it" and "it never died".
 */
const spawnLog = join(runDir, 'fixture-spawns.log')
function recordSpawn(): void {
  appendFileSync(spawnLog, `${role} ${process.pid} ${Date.now()}\n`)
}

/** Role-scoped first, so one env can crash the daemon and leave the server up. */
function envForRole(suffix: string): string | undefined {
  return process.env[`FIXTURE_${role?.toUpperCase()}_${suffix}`] ?? process.env[`FIXTURE_${suffix}`]
}

/** Die on cue, so a test can drive a crash or a refusal at a known moment. */
function armScheduledExit(): void {
  const afterMs = Number(envForRole('EXIT_AFTER_MS') ?? 0)
  if (!afterMs) return
  const code = Number(envForRole('EXIT_CODE') ?? 1)
  setTimeout(() => {
    console.error(`[fixture:${role}] scheduled exit ${code}`)
    process.exit(code)
  }, afterMs).unref?.()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** The fixture's stand-in for `--takeover`: evict whoever holds the port. */
async function takeoverPort(): Promise<void> {
  if (!existsSync(serverMarker)) return
  const held = Number(readFileSync(serverMarker, 'utf8').trim())
  if (!held || held === process.pid || !alive(held)) return
  try {
    process.kill(held, 'SIGTERM')
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && alive(held); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (alive(held)) {
    try {
      process.kill(held, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

function installedVersion(): string {
  try {
    return readFileSync(join(installDir, 'VERSION'), 'utf8').trim()
  } catch {
    return process.env.PODIUM_APP_VERSION ?? 'dev'
  }
}

async function runServer(): Promise<void> {
  recordSpawn()
  if (process.env.FIXTURE_SERVER_REFUSE_START === '1') {
    console.error('[fixture:server] refusing to start')
    process.exit(78)
  }
  await takeoverPort()
  // The version is read ONCE, at boot, exactly like a real binary's baked
  // version: a test "swaps the bundle" by writing VERSION and handing over.
  const version = installedVersion()
  let janitorProgress = 0
  const janitorState = process.env.FIXTURE_JANITOR_STATE ?? 'running'
  if (process.env.FIXTURE_JANITOR_WEDGED !== '1') {
    setInterval(() => (janitorProgress += 1), 200).unref?.()
  }
  const daemonConnected = (): boolean => {
    if (process.env.FIXTURE_SERVER_NEVER_HEALTHY === '1') return false
    if (!existsSync(daemonMarker)) return false
    const pid = Number(readFileSync(daemonMarker, 'utf8').trim())
    return Boolean(pid) && alive(pid)
  }
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/health') return new Response('ok')
      if (url.pathname === '/version') {
        return Response.json({
          appVersion: version,
          daemonConnected: daemonConnected(),
          components: {
            daemon: { state: daemonConnected() ? 'connected' : 'disconnected' },
            janitor: { state: janitorState, progressVersion: janitorProgress },
          },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  writeFileSync(serverMarker, String(process.pid))
  console.error(`[fixture:server] pid ${process.pid} version ${version} port ${server.port}`)
  const bye = (): void => {
    try {
      if (readFileSync(serverMarker, 'utf8').trim() === String(process.pid)) rmSync(serverMarker)
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.on('SIGTERM', bye)
  process.on('SIGINT', bye)
  armScheduledExit()
}

function runDaemon(): void {
  recordSpawn()
  writeFileSync(daemonMarker, String(process.pid))
  console.error(`[fixture:daemon] pid ${process.pid}`)
  const bye = (): void => {
    try {
      if (readFileSync(daemonMarker, 'utf8').trim() === String(process.pid)) rmSync(daemonMarker)
    } catch {
      /* ignore */
    }
    process.exit(0)
  }
  process.on('SIGTERM', bye)
  process.on('SIGINT', bye)
  setInterval(() => {}, 1_000)
  armScheduledExit()
}

/**
 * A successor parent, wired the way apps/cli/src/cli.ts wires the real one:
 * handlers first, then (because it is a successor) NO reclaim of the pidfile
 * until its own health gate passes.
 */
async function runParent(): Promise<void> {
  recordSpawn()
  const { ParentProcess, PARENT_SUCCESSOR_ENV } = await import(
    '../../packages/runtime/src/parent-process'
  )
  const { registerProcess } = await import('../../packages/runtime/src/run-registry')
  const { sdNotify } = await import('../../packages/runtime/src/sd-notify')
  const isSuccessor = process.env[PARENT_SUCCESSOR_ENV] === '1'
  const children = (process.env.FIXTURE_PARENT_CHILDREN?.split(',') ?? [
    'server',
    'daemon',
  ]) as Array<'server' | 'daemon'>
  const notifyLog = join(runDir, 'fixture-notify.log')
  const parent = new ParentProcess({
    port,
    installDir,
    stateDir,
    installBinary: process.execPath,
    children,
    env: { ...process.env, PODIUM_PARENT_CLI: import.meta.filename },
    // MIRRORED, NOT REPLACED: the real `sdNotify` still runs (so the fake
    // NOTIFY_SOCKET path is genuinely exercised), and the file gives the test an
    // ORDERED record — which is what finding 4 is about: MAINPID must come after
    // the health gate, never before, and never at all when handover fails.
    notify: (state) => {
      appendFileSync(notifyLog, `${state}\n`)
      sdNotify(state)
    },
    ...(process.env.FIXTURE_WEDGED_AFTER_MS
      ? { componentWedgedMs: Number(process.env.FIXTURE_WEDGED_AFTER_MS) }
      : {}),
    ...(process.env.FIXTURE_PET_EVERY_MS
      ? { watchdogPetMs: Number(process.env.FIXTURE_PET_EVERY_MS) }
      : {}),
    // The real gate is 90s. A test that has to watch the ABORT path — kill the
    // successor, decide about `.old`, come back serving — cannot wait that out.
    ...(process.env.FIXTURE_HANDOVER_TIMEOUT_MS
      ? { handoverTimeoutMs: Number(process.env.FIXTURE_HANDOVER_TIMEOUT_MS) }
      : {}),
    ...(process.env.FIXTURE_RELEASE_HAD_MIGRATIONS
      ? { releaseHadMigrations: process.env.FIXTURE_RELEASE_HAD_MIGRATIONS === '1' }
      : {}),
    claimRole: isSuccessor
      ? () => registerProcess('parent', { reclaimExisting: false, port }).then(() => undefined)
      : undefined,
  })
  parent.installSignalHandlers()
  if (!isSuccessor) await registerProcess('parent', { port })
  console.error(`[fixture:parent] pid ${process.pid} successor=${isSuccessor}`)
  await parent.start()
  console.error('[fixture:parent] READY')
}

if (role === 'server') await runServer()
else if (role === 'daemon') runDaemon()
else if (role === 'parent') await runParent()
else {
  console.error(`parent-stack-fixture: unknown role ${role}`)
  process.exit(2)
}
