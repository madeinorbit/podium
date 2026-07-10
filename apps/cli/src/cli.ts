/**
 * `podium` CLI — the mode-driven launcher (compiled via `bun build --compile`). Reads
 * ~/.podium/config.json + argv and starts the processes the deployment mode calls for.
 * With no config and no subcommand it runs `all-in-one` immediately AND serves the setup
 * UI (printed URL), so the box is usable at once; switching modes in the UI writes config
 * and asks for a restart.
 *
 * Structure (#251): `main()` is parse → `resolvePlan()` → one total switch. ALL mode /
 * persistence / TTY / migration-debt branching lives in the pure `resolvePlan`, which
 * turns (config, argv, env, tty) into a single typed `LaunchPlan` — so the whole
 * combinatorial matrix is unit-testable without spawning anything.
 */

import { loadConfig, needsSetup, type PodiumConfig, type PodiumMode } from '@podium/runtime/config'
import { LOCAL_MACHINE_ID } from '@podium/runtime/local-machine'

/** Resolved deployment-mode inputs (mode + connection details) — the sub-plan the
 *  daemon options are computed from. Formerly the whole plan, now one field of it. */
export interface ModePlan {
  mode: PodiumMode
  serverUrl?: string
  pairCode?: string
  name?: string
  showSetupHint: boolean
}

const SUBCOMMANDS: PodiumMode[] = ['all-in-one', 'daemon', 'client', 'server']

/** Pure mode resolver: explicit subcommand > config.mode > default all-in-one (+setup hint). */
export function resolveModePlan(argv: string[], config: PodiumConfig): ModePlan {
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

/** The env keys `resolvePlan` consults. Pass `process.env` (or a snapshot in tests). */
export type EnvSnapshot = Readonly<Record<string, string | undefined>>

/** How the in-process daemon authenticates to its server (see the launch matrix). */
export type DaemonAuthKind =
  /** all-in-one: same process as the server — handed its in-memory bootstrap token. */
  | 'in-process-local'
  /** `podium daemon --local`: the split daemon on a host box — NOT in-process with the
   *  server, so it can't be handed the in-memory token; it authenticates as the LOCAL
   *  machine via the shared secret file both sides read (exactly like scripts/daemon.ts). */
  | 'local-split'
  /** a remote/join daemon that auths via the config's pair code / token. */
  | 'remote'

/**
 * The one typed launch decision. Every branch `main()` can take is a variant here,
 * computed purely by `resolvePlan(config, argv, env, tty)`:
 *
 *  - utility subcommands (`update`, `issue`, `status`, …) — argv parsing (incl. their
 *    usage errors) is folded in so `main()` needs no other dispatch;
 *  - `reconcile-pending-persistence` — a web setup on a headless box recorded a
 *    persistence INTENT it couldn't fulfill itself (issue #20);
 *  - `interactive-setup` — TTY-gated; `reason: 'incomplete-headless-config'` is the box
 *    configured before the persistence step existed (mode set, no `persistence`), routed
 *    back into setup so it never silently runs in-process;
 *  - `client` — nothing to run locally, just point at the server;
 *  - `systemd-managed` / `detached-managed` — a bare `podium` on a headless-managed
 *    install ensures the split is up and reports status, never hosts in this PID;
 *  - `in-process` — actually host server and/or daemon here (desktop sidecar, explicit
 *    component subcommands, and the headless `podium setup` web-serving fallback, which
 *    is `roles.server` only with no registry claim).
 */
export type LaunchPlan =
  | { kind: 'update'; channel: 'stable' | 'edge'; feedOverride: string | undefined }
  | { kind: 'channel'; target: string | undefined }
  | { kind: 'join-config'; token: string }
  | { kind: 'set-server'; target: string }
  | { kind: 'repair-config' }
  | { kind: 'join-setup'; token: string; persistence: 'systemd' | 'detached'; port: number }
  | { kind: 'issue'; args: string[] }
  | { kind: 'spec'; args: string[] }
  | { kind: 'worktree'; args: string[] }
  | { kind: 'status' }
  | { kind: 'stop' }
  | { kind: 'logs'; args: string[] }
  /** Malformed invocation: print `message` to stderr and exit 2. */
  | { kind: 'usage-error'; message: string }
  | { kind: 'reconcile-pending-persistence'; port: number }
  | {
      kind: 'interactive-setup'
      port: number
      reason: 'explicit' | 'first-run' | 'incomplete-headless-config'
    }
  | { kind: 'client'; serverUrl: string | undefined }
  | { kind: 'systemd-managed'; units: string[] }
  | { kind: 'detached-managed'; port: number }
  | {
      kind: 'in-process'
      port: number
      /** Which components this PID hosts. */
      roles: { server: boolean; daemon: boolean }
      /** Run-registry role to claim before binding; undefined = no claim (the
       *  headless `podium setup` path, which only serves the web setup UI). */
      claimRole: 'server' | 'daemon' | 'all-in-one' | undefined
      /** How the run-registry record is labeled (systemd unit / detached spawn / plain). */
      runRecordMode: 'systemd' | 'detached' | 'foreground'
      /** Present iff roles.daemon. */
      daemonAuth: DaemonAuthKind | undefined
      /** Mode + connection inputs (feeds daemonOptionsForPlan at execute time). */
      modePlan: ModePlan
      /** Print the setup-URL hint after the server comes up. */
      showSetupHint: boolean
    }

/**
 * THE pure launch resolver: (config, argv, env, tty) → LaunchPlan. No I/O, no
 * process access — everything ambient is passed in, so the full mode × persistence ×
 * pendingPersistence × TTY matrix is table-testable (cli.test.ts pins it).
 */
export function resolvePlan(
  config: PodiumConfig,
  argv: string[],
  env: EnvSnapshot,
  tty: boolean,
): LaunchPlan {
  const port = Number(env.PODIUM_PORT) || config.port || 18787

  // ---- utility subcommands (historical dispatch order preserved) ----
  // `podium update`: self-update the headless bundle from the configured feed.
  if (argv[0] === 'update') {
    const channel = (env.PODIUM_UPDATE_CHANNEL ?? config.updateChannel ?? 'stable') as
      | 'stable'
      | 'edge'
    return { kind: 'update', channel, feedOverride: env.PODIUM_UPDATE_FEED ?? config.updateFeed }
  }
  // `podium channel [stable|edge]`: show or switch the self-update channel.
  if (argv[0] === 'channel') return { kind: 'channel', target: argv[1] }
  // `podium join-config <TOKEN>`: non-interactive daemon configuration from a join token
  // (used by `install.sh --join`). Writes config; the daemon is started separately.
  if (argv[0] === 'join-config') {
    return argv[1]
      ? { kind: 'join-config', token: argv[1] }
      : { kind: 'usage-error', message: 'usage: podium join-config <TOKEN>' }
  }
  // `podium set-server <url-or-join-code>`: rotate ONLY the server URL a joined daemon /
  // client dials (issue #19). Preserves machine identity + token, so no re-pair.
  if (argv[0] === 'set-server') {
    return argv[1]
      ? { kind: 'set-server', target: argv[1] }
      : {
          kind: 'usage-error',
          message: 'usage: podium set-server <ws(s)://url | http(s)://url | join-code>',
        }
  }
  // `podium setup --repair` (#21): back up an existing-but-invalid config.json.
  if (argv[0] === 'setup' && argv.includes('--repair')) return { kind: 'repair-config' }
  // `podium setup --join <token> [--persist systemd|detached]`: NON-interactive join
  // through the same engine the interactive flow uses (issue #20).
  if (argv[0] === 'setup' && argv.includes('--join')) {
    const token = argv[argv.indexOf('--join') + 1]
    if (!token) {
      return {
        kind: 'usage-error',
        message: 'usage: podium setup --join <TOKEN> [--persist systemd|detached]',
      }
    }
    const persistIdx = argv.indexOf('--persist')
    const persistence = persistIdx >= 0 ? argv[persistIdx + 1] : 'systemd'
    if (persistence !== 'systemd' && persistence !== 'detached') {
      return {
        kind: 'usage-error',
        message: `podium setup --persist must be systemd or detached (got '${persistence}')`,
      }
    }
    return { kind: 'join-setup', token, persistence, port }
  }
  if (argv[0] === 'issue') return { kind: 'issue', args: argv.slice(1) }
  if (argv[0] === 'spec') return { kind: 'spec', args: argv.slice(1) }
  if (argv[0] === 'worktree') return { kind: 'worktree', args: argv.slice(1) }
  if (argv[0] === 'status') return { kind: 'status' }
  if (argv[0] === 'stop') return { kind: 'stop' }
  if (argv[0] === 'logs') return { kind: 'logs', args: argv.slice(1) }

  // ---- launch resolution ----
  const modePlan = resolveModePlan(argv, config)
  // `podium setup` (or --reconfigure) re-enters the interactive flow — the mode-first menu
  // that can switch this box between modes. TTY-gated below; headless falls through to
  // serving the web setup UI in-process.
  const forceSetup = argv.includes('setup') || argv.includes('--reconfigure')
  const explicitSub = SUBCOMMANDS.some((s) => argv.includes(s)) || argv.includes('all')
  const bareInvocation = !explicitSub
  // MIGRATION DEBT: a box configured before the persistence step existed (mode set, no
  // `persistence`) — or one written by the web setup — would otherwise fall through to the
  // in-process path. On a TTY, route a bare `podium` back into setup so it completes the
  // split (pick persistence + start). Non-TTY keeps the in-process fallback (the desktop
  // sidecar, which sets no persistence).
  const incompleteHeadlessConfig =
    bareInvocation &&
    !!config.mode &&
    config.mode !== 'client' &&
    !config.persistence &&
    !config.pendingPersistence

  // A web setup on a headless box recorded a persistence INTENT it couldn't fulfill itself
  // (the serving process can't self-daemonize — issue #20). Reconcile it here, non-
  // interactively — works over SSH without a TTY. The mode guard mirrors
  // reconcilePendingPersistence's own precondition, so executing the plan can't no-op
  // (a pendingPersistence with mode unset/'client' falls through, as it always did).
  if (
    !forceSetup &&
    bareInvocation &&
    !config.persistence &&
    config.pendingPersistence &&
    (config.mode === 'all-in-one' || config.mode === 'server' || config.mode === 'daemon')
  ) {
    return { kind: 'reconcile-pending-persistence', port }
  }

  // Interactive setup gate (same predicate as cli-setup's shouldRunCliSetup): it's THE
  // interactive command, so the only gate is a TTY — headless/systemd/piped runs must
  // never block on a prompt, and fall through to serving the web UI instead.
  if ((forceSetup || modePlan.showSetupHint || incompleteHeadlessConfig) && tty) {
    return {
      kind: 'interactive-setup',
      port,
      reason: forceSetup
        ? 'explicit'
        : incompleteHeadlessConfig
          ? 'incomplete-headless-config'
          : 'first-run',
    }
  }

  if (!forceSetup && modePlan.mode === 'client') {
    return { kind: 'client', serverUrl: modePlan.serverUrl }
  }

  // Headless-managed install: setup recorded a persistence mode (systemd|detached), which
  // means this box runs the backend as INDEPENDENT processes, never in-process. A bare
  // `podium` ensures the split is up and reports status. The desktop sidecar sets no
  // persistence, so it falls through to the in-process path; an explicit `podium server`/
  // `daemon` IS a component and runs in-process too.
  if (!forceSetup && bareInvocation && config.persistence) {
    if (config.persistence === 'systemd') {
      const units =
        modePlan.mode === 'daemon'
          ? ['podium-daemon.service']
          : modePlan.mode === 'server'
            ? ['podium-server.service']
            : ['podium-server.service', 'podium-daemon.service']
      return { kind: 'systemd-managed', units }
    }
    return { kind: 'detached-managed', port }
  }

  // In-process hosting. `forceSetup` here is the headless `podium setup` fallback: serve
  // the web setup UI (server only), claim no run-registry role.
  const runServer = forceSetup || modePlan.mode === 'all-in-one' || modePlan.mode === 'server'
  const runDaemon = !forceSetup && (modePlan.mode === 'all-in-one' || modePlan.mode === 'daemon')
  const claimRole = forceSetup
    ? undefined
    : modePlan.mode === 'server'
      ? ('server' as const)
      : modePlan.mode === 'daemon'
        ? ('daemon' as const)
        : modePlan.mode === 'all-in-one'
          ? ('all-in-one' as const)
          : undefined
  // NOTIFY_SOCKET ⇒ started under a systemd Type=notify unit; PODIUM_RUN_MODE=detached is
  // set by the setup detached-spawn; otherwise a plain foreground run (desktop sidecar, dev).
  const runRecordMode = env.NOTIFY_SOCKET
    ? ('systemd' as const)
    : env.PODIUM_RUN_MODE === 'detached'
      ? ('detached' as const)
      : ('foreground' as const)
  const daemonAuth = !runDaemon
    ? undefined
    : modePlan.mode === 'daemon'
      ? argv.includes('--local')
        ? ('local-split' as const)
        : ('remote' as const)
      : ('in-process-local' as const)
  return {
    kind: 'in-process',
    port,
    roles: { server: runServer, daemon: runDaemon },
    claimRole,
    runRecordMode,
    daemonAuth,
    modePlan,
    showSetupHint: forceSetup || modePlan.showSetupHint,
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
  plan: ModePlan,
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

/**
 * The in-process host seam: apps/cli owns the launcher logic but must not
 * import apps/server or apps/daemon (boundary rule). The runnable entry
 * (scripts/cli.ts, the composition root that bun-compile bundles) injects the
 * host modules; every other subcommand path never loads them.
 */
export interface HostModules {
  startServer(opts: { port: number }): Promise<{ port: number; bootstrapToken?: string }>
  isAddressInUseError(err: unknown): boolean
  startDaemon(
    opts: DaemonStartOptions & {
      onBlocked?: (info: { type: string; reason: string }) => void | Promise<void>
    },
  ): Promise<unknown>
}

type InProcessPlan = Extract<LaunchPlan, { kind: 'in-process' }>

/** Host server and/or daemon in THIS process, per the plan, then stay alive. */
async function runInProcess(
  plan: InProcessPlan,
  loadHost: () => Promise<HostModules>,
): Promise<void> {
  const { port, roles, modePlan } = plan

  // Claim this component's role in the run registry BEFORE binding: reclaim() SIGKILLs a
  // stale holder (a force-killed desktop orphan, a crashed detached process) so we don't
  // collide on the port or run two daemons over the same ~/.podium, then write our pidfile
  // for status/stop. The in-process all-in-one is a single role; the split modes each
  // claim their own.
  if (plan.claimRole) {
    const { registerProcess } = await import('@podium/runtime/run-registry')
    try {
      // Daemon-only mode hosts no local port; server/all-in-one record theirs.
      await registerProcess(plan.claimRole, {
        mode: plan.runRecordMode,
        ...(plan.claimRole === 'daemon' ? {} : { port }),
      })
    } catch (e) {
      // EPERM: a live, unkillable same-role process exists — refuse to double-run.
      console.error((e as Error).message)
      process.exit(1)
    }
  }

  let serverPort = port
  let localBootstrapToken: string | undefined
  const host = roles.server || roles.daemon ? await loadHost() : undefined
  if (roles.server && host) {
    const { startServer, isAddressInUseError } = host
    let server: Awaited<ReturnType<typeof startServer>>
    try {
      server = await startServer({ port })
    } catch (err) {
      // The port is taken (the common case on podium-host: the systemd podium-server
      // already owns :18787). Print actionable guidance and exit cleanly rather than
      // dumping a raw EADDRINUSE stack trace through the crash net (issue #8).
      if (isAddressInUseError(err)) {
        console.error(portInUseMessage(port))
        process.exit(1)
      }
      throw err
    }
    serverPort = server.port
    localBootstrapToken = server.bootstrapToken
    console.log(`podium server up on http://localhost:${serverPort}`)
    if (plan.showSetupHint) {
      console.log(`\n  → Open setup:  http://localhost:${serverPort}/\n`)
      console.log('  → …or run: podium setup   (configure here in the terminal)')
    }
  }
  if (roles.daemon && host) {
    let daemonOptions: DaemonStartOptions
    if (plan.daemonAuth === 'local-split') {
      // `podium daemon --local` — see DaemonAuthKind: authenticate as the LOCAL machine
      // via the shared secret file, connect to the local server.
      const { readOrCreateDaemonSecret } = await import('@podium/runtime/local-machine')
      daemonOptions = {
        serverUrl: modePlan.serverUrl ?? `ws://localhost:${port}`,
        bootstrapToken: readOrCreateDaemonSecret(),
        machineId: LOCAL_MACHINE_ID,
        installCodexHooks: true,
      }
    } else {
      try {
        daemonOptions = daemonOptionsForPlan(modePlan, serverPort, localBootstrapToken)
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
    }
    const { startDaemon } = host
    // A REMOTE daemon whose handshake is terminally rejected must exit with a distinct
    // code (not crash-loop): the systemd unit's RestartPreventExitStatus matches it and
    // stops restarting; `podium status` then explains the blocked state (#19).
    const remoteDaemon = plan.daemonAuth === 'remote'
    await startDaemon({
      ...daemonOptions,
      ...(remoteDaemon
        ? {
            onBlocked: async ({ type, reason }: { type: string; reason: string }) => {
              const { DAEMON_BLOCKED_EXIT_CODE } = await import('@podium/runtime/connectivity')
              console.error(
                `podium daemon: blocked by the server (${type}: ${reason}) — exiting ${DAEMON_BLOCKED_EXIT_CODE}. Run \`podium status\` for recovery steps.`,
              )
              process.exit(DAEMON_BLOCKED_EXIT_CODE)
            },
          }
        : {}),
    })
    console.log(`podium daemon up → ${daemonOptions.serverUrl}`)
  }

  // Watchdog pet (no-op off a Type=notify unit) — mirror scripts/daemon.ts.
  const { startWatchdog } = await import('@podium/runtime/sd-notify')
  const stopWatchdog = startWatchdog()
  const shutdown = (): void => {
    stopWatchdog?.()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise(() => {})
}

export async function main(loadHost: () => Promise<HostModules>): Promise<void> {
  const argv = process.argv.slice(2)
  const config = loadConfig()

  // Crash net BEFORE anything else (mirror scripts/daemon.ts, audit P0-1).
  const { installProcessSafetyNet } = await import('@podium/runtime/process-safety')
  installProcessSafetyNet('podium')

  const plan = resolvePlan(config, argv, process.env, Boolean(process.stdin.isTTY))

  switch (plan.kind) {
    case 'update': {
      const { runUpdate } = await import('./podium-update')
      await runUpdate(
        plan.feedOverride
          ? { channel: plan.channel, feedOverride: plan.feedOverride }
          : { channel: plan.channel },
      )
      return
    }
    case 'channel': {
      const { applyChannel } = await import('./cli-channel')
      try {
        const { channel } = applyChannel(plan.target)
        console.log(`podium update channel: ${channel}`)
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
      return
    }
    case 'join-config': {
      const { applyJoinToken } = await import('./cli-join')
      try {
        const { name, warning } = applyJoinToken(plan.token)
        console.log(`podium configured to join as "${name}"`)
        if (warning) console.warn(`\nWarning: ${warning}`)
      } catch (e) {
        console.error(`invalid join token: ${(e as Error).message}`)
        process.exit(2)
      }
      return
    }
    case 'set-server': {
      const { applyServerUrl } = await import('@podium/runtime/setup')
      try {
        const res = applyServerUrl(plan.target)
        console.log(`podium server URL set to ${res.serverUrl}`)
        if (res.warning) console.warn(`\nWarning: ${res.warning}`)
        console.log('Restart the daemon to apply (e.g. `podium stop && podium`).')
      } catch (e) {
        console.error((e as Error).message)
        process.exit(2)
      }
      return
    }
    case 'repair-config': {
      // Never destructive — the broken file is renamed, not deleted (#21).
      const { repairConfig } = await import('./cli-setup')
      const r = repairConfig()
      if (r.state === 'ok') {
        console.log('config.json is valid — nothing to repair.')
      } else if (r.state === 'missing') {
        console.log('No config.json yet — run `podium setup` to configure this box.')
      } else {
        console.log(`Backed up the invalid config to ${r.backupPath}`)
        if (r.error) console.log(`(it failed to parse: ${r.error})`)
        console.log('Run `podium setup` to configure this box fresh.')
      }
      return
    }
    case 'join-setup': {
      const { runJoinSetup } = await import('./cli-setup')
      try {
        const { name, warning, result } = await runJoinSetup(
          plan.token,
          plan.persistence,
          plan.port,
        )
        console.log(`podium joined as "${name}".`)
        console.log(result.message)
        if (warning) console.warn(`\nWarning: ${warning}`)
      } catch (e) {
        console.error(`podium setup --join failed: ${(e as Error).message}`)
        process.exit(2)
      }
      return
    }
    // `podium issue <command>`: drive the native issue tracker over the running server's API.
    case 'issue': {
      const { issueCliMain } = await import('./issue-cli')
      await issueCliMain(plan.args)
      return
    }
    // `podium spec <command>`: read/maintain the living project spec (<repo>/pspec/).
    case 'spec': {
      const { specCliMain } = await import('./spec-cli')
      await specCliMain(plan.args)
      return
    }
    // `podium worktree [path]`: agent declares the worktree it's working in.
    case 'worktree': {
      const { worktreeCliMain } = await import('./worktree-cli')
      await worktreeCliMain(plan.args)
      return
    }
    case 'status': {
      const { statusCommand } = await import('./cli-lifecycle')
      statusCommand()
      return
    }
    case 'stop': {
      const { stopCommand } = await import('./cli-lifecycle')
      await stopCommand()
      return
    }
    case 'logs': {
      const { logsCommand } = await import('./cli-lifecycle')
      logsCommand(plan.args)
      return
    }
    case 'usage-error': {
      console.error(plan.message)
      process.exit(2)
      return
    }
    case 'reconcile-pending-persistence': {
      const { reconcilePendingPersistence } = await import('./cli-setup')
      // The plan is only emitted when reconcilePendingPersistence's own precondition
      // holds (resolvePlan mirrors it), so `res` is always defined here in practice.
      const res = await reconcilePendingPersistence(plan.port)
      if (res) console.log(res.message)
      const { statusCommand } = await import('./cli-lifecycle')
      statusCommand()
      return
    }
    case 'interactive-setup': {
      const { runCliSetup } = await import('./cli-setup')
      const { createInterface } = await import('node:readline/promises')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      await runCliSetup({ prompt: (q) => rl.question(q), print: (s) => console.log(s) }, plan.port)
      rl.close()
      return
    }
    case 'client': {
      console.log(
        `podium client mode — open the web UI pointed at ${plan.serverUrl ?? '(no serverUrl configured)'}`,
      )
      console.log('(run `podium setup` to reconfigure this install)')
      return
    }
    case 'systemd-managed': {
      try {
        const { execFileSync } = await import('node:child_process')
        execFileSync('systemctl', ['--user', 'start', ...plan.units], { stdio: 'ignore' })
      } catch (e) {
        console.error(`podium: could not start systemd units — ${(e as Error).message}`)
      }
      const { statusCommand } = await import('./cli-lifecycle')
      statusCommand()
      return
    }
    case 'detached-managed': {
      const { ensureDetachedUp } = await import('./cli-spawn')
      const { started } = await ensureDetachedUp(config, plan.port)
      if (started.length) console.log(`Started: ${started.join(', ')}`)
      const { statusCommand } = await import('./cli-lifecycle')
      statusCommand()
      return
    }
    case 'in-process':
      return runInProcess(plan, loadHost)
  }
}
