/**
 * `podium` CLI — the mode-driven launcher (compiled via `bun build --compile`). Reads
 * ~/.podium/config.json + argv and starts the processes the deployment mode calls for.
 * With no config and no subcommand it runs `all-in-one` immediately AND serves the setup
 * UI (printed URL), so the box is usable at once; switching modes in the UI writes config
 * and asks for a restart.
 */
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

  // `podium setup` (or --reconfigure) re-enters the interactive flow: a mode-first menu that
  // can switch this box into all-in-one / server / daemon and edit the URL/password. It's the
  // interactive command, so the only gate is a TTY (headless falls through to serving the web
  // UI). Runs for any current mode — switching mode after the fact is the whole point.
  const forceSetup = argv.includes('setup') || argv.includes('--reconfigure')
  const plan = resolvePlan(argv, config)
  const port = Number(process.env.PODIUM_PORT) || config.port || 18787

  const { runCliSetup, shouldRunCliSetup } = await import('./cli-setup')
  if (shouldRunCliSetup({ forceSetup, isTTY: Boolean(process.stdin.isTTY) })) {
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

  const runServer = forceSetup || plan.mode === 'all-in-one' || plan.mode === 'server'
  const runDaemon = !forceSetup && (plan.mode === 'all-in-one' || plan.mode === 'daemon')

  let serverPort = port
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
    console.log(`podium server up on http://localhost:${serverPort}`)
    if (forceSetup || plan.showSetupHint) {
      console.log(`\n  → Open setup:  http://localhost:${serverPort}/\n`)
      console.log('  → …or run: podium setup   (configure here in the terminal)')
    }
  }
  if (runDaemon) {
    const serverUrl = plan.mode === 'daemon' ? plan.serverUrl : `ws://localhost:${serverPort}`
    if (!serverUrl) {
      console.error('podium daemon mode needs a serverUrl (config.serverUrl or --server)')
      process.exit(2)
    }
    const { startDaemon } = await import('../apps/daemon/src/daemon')
    await startDaemon({
      serverUrl,
      ...(plan.pairCode ? { pairCode: plan.pairCode } : {}),
      ...(plan.name ? { name: plan.name } : {}),
    })
    console.log(`podium daemon up → ${serverUrl}`)
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
