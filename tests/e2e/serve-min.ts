/**
 * Minimal launcher: server + passive daemon, no starter session (cf. serve.ts, which
 * also creates one). The daemon spawns a real `claude`/`codex` only when a session is
 * created from the UI, so this is the lightest way to dogfood the Live UI by hand.
 *
 * Run: PODIUM_STATE_DIR=/tmp/podium-dogfood bunx tsx tests/e2e/serve-min.ts   (Ctrl-C to stop)
 */
import { startDaemon } from '../../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'

const server = await startServer({ port: Number(process.env.PORT ?? 8787) })
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: LOCAL_MACHINE_ID,
  hooks: { port: 0 },
  agentRelay: { port: 0 },
})
console.log(`RELAY_READY ws://localhost:${server.port}`)

const shutdown = async (): Promise<void> => {
  await daemon.close()
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
await new Promise(() => {})
