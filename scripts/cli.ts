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

async function main(): Promise<void> {
  const { startServer } = await import('../apps/server/src/server')
  const { startDaemon } = await import('../apps/daemon/src/daemon')

  const plan = resolvePlan(process.argv.slice(2), loadConfig())
  const port = Number(process.env.PODIUM_PORT ?? 18787)

  if (plan.mode === 'client') {
    const url = plan.serverUrl ?? '(no serverUrl configured)'
    console.log(`podium client mode — open the web UI pointed at ${url}`)
    return
  }

  const runServer = plan.mode === 'all-in-one' || plan.mode === 'server'
  const runDaemon = plan.mode === 'all-in-one' || plan.mode === 'daemon'

  let serverPort = port
  if (runServer) {
    const server = await startServer({ port })
    serverPort = server.port
    console.log(`podium server up on http://localhost:${serverPort}`)
    if (plan.showSetupHint) {
      console.log(`\n  → Open setup:  http://localhost:${serverPort}/\n`)
    }
  }
  if (runDaemon) {
    const serverUrl = plan.mode === 'daemon' ? plan.serverUrl : `ws://localhost:${serverPort}`
    if (!serverUrl) {
      console.error('podium daemon mode needs a serverUrl (config.serverUrl or --server)')
      process.exit(2)
    }
    await startDaemon({ serverUrl })
    console.log(`podium daemon up → ${serverUrl}`)
  }

  // Stay alive until a signal.
  await new Promise(() => {})
}

// Only run main() when executed (not when imported by the unit test).
if (import.meta.main) {
  void main()
}
