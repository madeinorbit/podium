/**
 * `podium` CLI — the mode-driven launcher (compiled via `bun build --compile`). Reads
 * ~/.podium/config.json + argv and starts the processes the deployment mode calls for.
 * With no config and no subcommand it runs `all-in-one` immediately AND serves the setup
 * UI (printed URL), so the box is usable at once; switching modes in the UI writes config
 * and asks for a restart.
 */
import { type PodiumConfig, type PodiumMode, loadConfig, needsSetup } from '../packages/core/src/index'

export interface LaunchPlan {
  mode: PodiumMode
  serverUrl?: string
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
  const mode = sub ?? aliased ?? config.mode ?? 'all-in-one'
  const showSetupHint = !sub && !aliased && needsSetup(config)
  const serverUrl = serverFlag ?? config.serverUrl
  return serverUrl ? { mode, serverUrl, showSetupHint } : { mode, showSetupHint }
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const config = loadConfig()

  // Crash net BEFORE anything else (mirror scripts/daemon.ts, audit P0-1).
  const { installProcessSafetyNet } = await import('./process-safety')
  installProcessSafetyNet('podium')

  // Escape hatch: `podium setup` (or --reconfigure) force-serves the setup UI
  // regardless of the saved mode, so a client/daemon install can be reconfigured.
  const forceSetup = argv.includes('setup') || argv.includes('--reconfigure')
  const plan = resolvePlan(argv, config)
  const port = Number(process.env.PODIUM_PORT) || config.port || 18787

  if (!forceSetup && plan.mode === 'client') {
    console.log(`podium client mode — open the web UI pointed at ${plan.serverUrl ?? '(no serverUrl configured)'}`)
    console.log('(run `podium setup` to reconfigure this install)')
    return
  }

  const runServer = forceSetup || plan.mode === 'all-in-one' || plan.mode === 'server'
  const runDaemon = !forceSetup && (plan.mode === 'all-in-one' || plan.mode === 'daemon')

  let serverPort = port
  if (runServer) {
    const { startServer } = await import('../apps/server/src/server')
    const server = await startServer({ port })
    serverPort = server.port
    console.log(`podium server up on http://localhost:${serverPort}`)
    if (forceSetup || plan.showSetupHint) console.log(`\n  → Open setup:  http://localhost:${serverPort}/\n`)
  }
  if (runDaemon) {
    const serverUrl = plan.mode === 'daemon' ? plan.serverUrl : `ws://localhost:${serverPort}`
    if (!serverUrl) {
      console.error('podium daemon mode needs a serverUrl (config.serverUrl or --server)')
      process.exit(2)
    }
    const { startDaemon } = await import('../apps/daemon/src/daemon')
    await startDaemon({ serverUrl })
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
