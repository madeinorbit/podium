/**
 * `podium` CLI — the mode-driven launcher (compiled via `bun build --compile`). Reads
 * ~/.podium/config.json + argv and starts the processes the deployment mode calls for.
 * With no config and no subcommand it runs `all-in-one` immediately AND serves the setup
 * UI (printed URL), so the box is usable at once; switching modes in the UI writes config
 * and asks for a restart.
 */

import { LOCAL_MACHINE_ID } from '../apps/server/src/local-machine'
import {
  loadConfig,
  needsSetup,
  type PodiumConfig,
  type PodiumMode,
} from '../packages/core/src/config'

export interface LaunchPlan {
  mode: PodiumMode
  serverUrl?: string
  pairCode?: string
  name?: string
  showSetupHint: boolean
}

const SUBCOMMANDS: PodiumMode[] = ['all-in-one', 'daemon', 'client', 'server']

/** Pure resolver: explicit subcommand > config.mode > default all-in-one (+setup hint). */
export function resolvePlan(argv: string[], config: PodiumConfig): LaunchPlan {
  const sub = argv.find((a) => (SUBCOMMANDS as string[]).includes(a)) as PodiumMode | undefined
  // `all` is a friendly alias for all-in-one.
  const aliased = argv.includes('all') ? 'all-in-one' : undefined
  const flagIdx = argv.indexOf('--server')
  const serverFlag = flagIdx >= 0 ? argv[flagIdx + 1] : undefined
  const pairIdx = argv.indexOf('--pair')
  // --pair flag wins; else fall back to config.pairCode so a desktop-spawned daemon pairs.
  const pairCode = (pairIdx >= 0 ? argv[pairIdx + 1] : undefined) ?? config.pairCode
  const nameIdx = argv.indexOf('--name')
  const name = nameIdx >= 0 ? argv[nameIdx + 1] : undefined
  const mode = sub ?? aliased ?? config.mode ?? 'all-in-one'
  const showSetupHint = !sub && !aliased && needsSetup(config)
  const serverUrl = serverFlag ?? config.serverUrl
  return {
    mode,
    showSetupHint,
    ...(serverUrl ? { serverUrl } : {}),
    ...(pairCode ? { pairCode } : {}),
    ...(name ? { name } : {}),
  }
}

export interface DaemonStartOptions {
  serverUrl: string
  bootstrapToken?: string
  machineId?: string
  pairCode?: string
  name?: string
  /** Production daemons install the global codex hook instrumentation at boot. */
  installCodexHooks?: boolean
}

/** Build the daemon auth/options for modes that actually run a daemon. */
export function daemonOptionsForPlan(
  plan: LaunchPlan,
  serverPort: number,
  localBootstrapToken?: string,
): DaemonStartOptions {
  const serverUrl = plan.mode === 'daemon' ? plan.serverUrl : `ws://localhost:${serverPort}`
  if (!serverUrl)
    throw new Error('podium daemon mode needs a serverUrl (config.serverUrl or --server)')

  const localAuth = (() => {
    if (plan.mode !== 'all-in-one') return {}
    if (!localBootstrapToken)
      throw new Error('podium all-in-one daemon needs local bootstrap token')
    return { bootstrapToken: localBootstrapToken, machineId: LOCAL_MACHINE_ID }
  })()

  return {
    serverUrl,
    ...localAuth,
    installCodexHooks: true,
    ...(plan.mode === 'daemon' && plan.pairCode ? { pairCode: plan.pairCode } : {}),
    ...(plan.mode === 'daemon' && plan.name ? { name: plan.name } : {}),
  }
}

/**
 * Friendly guidance when the server port is already held — almost always because a
 * podium server is already running here (e.g. the systemd podium-server on :18787).
 * Printed instead of the raw EADDRINUSE stack trace that used to crash the CLI (issue #8).
 */
export function portInUseMessage(port: number): string {
  return [
    `podium: port ${port} is already in use — a podium server is probably already running here.`,
    `  → Open it:               http://localhost:${port}/`,
    '  → Reconfigure this box:  podium setup',
    `  → Or use another port:   PODIUM_PORT=<port> podium`,
  ].join('\n')
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const config = loadConfig()

  // Crash net BEFORE anything else (mirror scripts/daemon.ts, audit P0-1).
  const { installProcessSafetyNet } = await import('./process-safety')
  installProcessSafetyNet('podium')

  // `podium update`: self-update the headless bundle from the configured feed, then exit.
  if (argv[0] === 'update') {
    const { runUpdate } = await import('./podium-update')
    const channel = (process.env.PODIUM_UPDATE_CHANNEL ?? config.updateChannel ?? 'stable') as
      | 'stable'
      | 'edge'
    const feedOverride = process.env.PODIUM_UPDATE_FEED ?? config.updateFeed
    await runUpdate(feedOverride ? { channel, feedOverride } : { channel })
    return
  }

  // `podium channel [stable|edge]`: show or switch the self-update channel `podium update` reads.
  if (argv[0] === 'channel') {
    const { applyChannel } = await import('./cli-channel')
    try {
      const { channel } = applyChannel(argv[1])
      console.log(`podium update channel: ${channel}`)
    } catch (e) {
      console.error((e as Error).message)
      process.exit(2)
    }
    return
  }

  // `podium join-config <TOKEN>`: non-interactive daemon configuration from a join token
  // (used by `install.sh --join`). Writes config + exits; the daemon is started separately.
  if (argv[0] === 'join-config') {
    const token = argv[1]
    if (!token) {
      console.error('usage: podium join-config <TOKEN>')
      process.exit(2)
    }
    const { applyJoinToken } = await import('./cli-join')
    try {
      const { name } = applyJoinToken(token)
      console.log(`podium configured to join as "${name}"`)
    } catch (e) {
      console.error(`invalid join token: ${(e as Error).message}`)
      process.exit(2)
    }
    return
  }

  // `podium issue <command>`: drive the native issue tracker over the running server's API.
  if (argv[0] === 'issue') {
    const { issueCliMain } = await import('./issue-cli')
    await issueCliMain(argv.slice(1))
    return
  }

  // `podium spec <command>`: read/maintain the living project spec (<repo>/pspec/).
  if (argv[0] === 'spec') {
    const { specCliMain } = await import('./spec-cli')
    await specCliMain(argv.slice(1))
    return
  }

  // `podium worktree [path]`: agent declares the worktree it's working in (defaults
  // to its cwd); the daemon resolves it to the git toplevel and regroups the session.
  if (argv[0] === 'worktree') {
    const { worktreeCliMain } = await import('./worktree-cli')
    await worktreeCliMain(argv.slice(1))
    return
  }

  // `podium status | stop | logs`: lifecycle over the run registry (server + daemon processes).
  if (argv[0] === 'status') {
    const { statusCommand } = await import('./cli-lifecycle')
    statusCommand()
    return
  }
  if (argv[0] === 'stop') {
    const { stopCommand } = await import('./cli-lifecycle')
    await stopCommand()
    return
  }
  if (argv[0] === 'logs') {
    const { logsCommand } = await import('./cli-lifecycle')
    logsCommand(argv.slice(1))
    return
  }

  // `podium setup` (or --reconfigure) re-enters the interactive flow: a mode-first menu that
  // can switch this box into all-in-one / server / daemon and edit the URL/password. It's the
  // interactive command, so the only gate is a TTY (headless falls through to serving the web
  // UI). Runs for any current mode — switching mode after the fact is the whole point.
  const forceSetup = argv.includes('setup') || argv.includes('--reconfigure')
  const plan = resolvePlan(argv, config)
  const port = Number(process.env.PODIUM_PORT) || config.port || 18787

  // A box configured before the persistence step existed (mode set, no `persistence`) — or one
  // written by the web setup — would otherwise fall through to the in-process path. On a TTY, route
  // a bare `podium` back into setup so it completes the split (pick persistence + start). Non-TTY
  // keeps the in-process fallback (the desktop sidecar, which sets no persistence).
  const bareInvocation = !SUBCOMMANDS.some((s) => argv.includes(s)) && !argv.includes('all')
  const incompleteHeadlessConfig =
    bareInvocation && !!config.mode && config.mode !== 'client' && !config.persistence

  const { runCliSetup, shouldRunCliSetup } = await import('./cli-setup')
  if (
    shouldRunCliSetup({
      forceSetup,
      // plan.showSetupHint == bare invocation AND the config still needs setup; also re-run setup
      // for an incompletely-configured headless box so it never silently runs in-process.
      firstRunNeedsSetup: plan.showSetupHint || incompleteHeadlessConfig,
      isTTY: Boolean(process.stdin.isTTY),
    })
  ) {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await runCliSetup({ prompt: (q) => rl.question(q), print: (s) => console.log(s) }, port)
    rl.close()
    return
  }

  if (!forceSetup && plan.mode === 'client') {
    console.log(
      `podium client mode — open the web UI pointed at ${plan.serverUrl ?? '(no serverUrl configured)'}`,
    )
    console.log('(run `podium setup` to reconfigure this install)')
    return
  }

  // Headless-managed install: setup recorded a persistence mode (systemd|detached), which means
  // this box runs the backend as INDEPENDENT processes, never in-process. A bare `podium` (no
  // explicit component subcommand) ensures the split is up and reports status, rather than hosting
  // server+daemon in this PID. The desktop sidecar sets no persistence, so it falls through to the
  // in-process path below; an explicit `podium server`/`daemon` IS a component and runs below too.
  const explicitSub = SUBCOMMANDS.some((s) => argv.includes(s)) || argv.includes('all')
  if (!forceSetup && !explicitSub && config.persistence) {
    if (config.persistence === 'systemd') {
      const units =
        plan.mode === 'daemon'
          ? ['podium-daemon.service']
          : plan.mode === 'server'
            ? ['podium-server.service']
            : ['podium-server.service', 'podium-daemon.service']
      try {
        const { execFileSync } = await import('node:child_process')
        execFileSync('systemctl', ['--user', 'start', ...units], { stdio: 'ignore' })
      } catch (e) {
        console.error(`podium: could not start systemd units — ${(e as Error).message}`)
      }
    } else {
      const { ensureDetachedUp } = await import('./cli-spawn')
      const { started } = await ensureDetachedUp(config, port)
      if (started.length) console.log(`Started: ${started.join(', ')}`)
    }
    const { statusCommand } = await import('./cli-lifecycle')
    statusCommand()
    return
  }

  const runServer = forceSetup || plan.mode === 'all-in-one' || plan.mode === 'server'
  const runDaemon = !forceSetup && (plan.mode === 'all-in-one' || plan.mode === 'daemon')

  // Claim this component's role in the run registry BEFORE binding: reclaim() SIGKILLs a stale
  // holder (a force-killed desktop orphan, a crashed detached process) so we don't collide on the
  // port or run two daemons over the same ~/.podium, then write our pidfile for status/stop. The
  // in-process all-in-one is a single role; the split modes each claim their own.
  const runRole = forceSetup
    ? undefined
    : plan.mode === 'server'
      ? ('server' as const)
      : plan.mode === 'daemon'
        ? ('daemon' as const)
        : plan.mode === 'all-in-one'
          ? ('all-in-one' as const)
          : undefined
  if (runRole) {
    // NOTIFY_SOCKET ⇒ started under a systemd Type=notify unit; PODIUM_RUN_MODE=detached is set by
    // the setup detached-spawn; otherwise it's a plain foreground run (desktop sidecar, dev).
    const runRecordMode = process.env.NOTIFY_SOCKET
      ? ('systemd' as const)
      : process.env.PODIUM_RUN_MODE === 'detached'
        ? ('detached' as const)
        : ('foreground' as const)
    const { registerProcess } = await import('../packages/core/src/run-registry')
    try {
      // Daemon-only mode hosts no local port; server/all-in-one record theirs.
      await registerProcess(runRole, {
        mode: runRecordMode,
        ...(runRole === 'daemon' ? {} : { port }),
      })
    } catch (e) {
      // EPERM: a live, unkillable same-role process exists — refuse to double-run.
      console.error((e as Error).message)
      process.exit(1)
    }
  }

  let serverPort = port
  let localBootstrapToken: string | undefined
  if (runServer) {
    const { startServer, isAddressInUseError } = await import('../apps/server/src/server')
    let server: Awaited<ReturnType<typeof startServer>>
    try {
      server = await startServer({ port })
    } catch (err) {
      // The port is taken (the common case on podium-host: the systemd podium-server already
      // owns :18787). Print actionable guidance and exit cleanly rather than dumping a raw
      // EADDRINUSE stack trace through the crash net (issue #8).
      if (isAddressInUseError(err)) {
        console.error(portInUseMessage(port))
        process.exit(1)
      }
      throw err
    }
    serverPort = server.port
    localBootstrapToken = server.bootstrapToken
    console.log(`podium server up on http://localhost:${serverPort}`)
    if (forceSetup || plan.showSetupHint) {
      console.log(`\n  → Open setup:  http://localhost:${serverPort}/\n`)
      console.log('  → …or run: podium setup   (configure here in the terminal)')
    }
  }
  if (runDaemon) {
    let daemonOptions: DaemonStartOptions
    // `podium daemon --local` is the split daemon on a host box: it is NOT in-process with the
    // server, so it can't be handed the server's in-memory bootstrap token. Instead it
    // authenticates as the LOCAL machine via the shared secret file both sides read (exactly like
    // scripts/daemon.ts), and connects to the local server. Without --local this is a remote/join
    // daemon that auths via the config's pair code / token.
    if (!forceSetup && plan.mode === 'daemon' && argv.includes('--local')) {
      const { readOrCreateDaemonSecret } = await import('../apps/server/src/local-machine')
      daemonOptions = {
        serverUrl: plan.serverUrl ?? `ws://localhost:${port}`,
        bootstrapToken: readOrCreateDaemonSecret(),
        machineId: LOCAL_MACHINE_ID,
        installCodexHooks: true,
      }
    } else {
      try {
        daemonOptions = daemonOptionsForPlan(plan, serverPort, localBootstrapToken)
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
    }
    const { startDaemon } = await import('../apps/daemon/src/daemon')
    await startDaemon(daemonOptions)
    console.log(`podium daemon up → ${daemonOptions.serverUrl}`)
  }

  // Watchdog pet (no-op off a Type=notify unit) — mirror scripts/daemon.ts.
  const { startWatchdog } = await import('./sd-notify')
  const stopWatchdog = startWatchdog()
  const shutdown = (): void => {
    stopWatchdog?.()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise(() => {})
}

if (import.meta.main) void main()
