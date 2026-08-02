/**
 * Minimal launcher: server + passive daemon, no starter session (cf. serve.ts, which
 * also creates one). The daemon spawns a real `claude`/`codex` only when a session is
 * created from the UI, so this is the lightest way to dogfood the Live UI by hand.
 *
 * Run: PODIUM_STATE_DIR=/tmp/podium-dogfood bunx tsx tests/e2e/serve-min.ts   (Ctrl-C to stop)
 */
import { startDaemon } from '../../apps/daemon/src/daemon'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { startServer } from '../../apps/server/src/server'

/** THIS HOST's machine id (POD-318) — read from `<stateDir>/machine.id`, the same
 *  file the server and the split-mode daemon read. There is no `'local'` constant
 *  any more; a machine id is minted material.
 *
 *  A FUNCTION, not a module-level constant: these harnesses point PODIUM_STATE_DIR
 *  at an isolated directory AFTER the imports run, and a constant would have read
 *  (and minted into) the real state dir before that happened. */
const hostMachineId = (): string => readOrCreateLocalMachineId()

const server = await startServer({ port: Number(process.env.PORT ?? 8787) })
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: hostMachineId(),
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
