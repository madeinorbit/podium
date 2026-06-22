/**
 * Long-running launcher for manual / on-device testing of the multi-session Live UI.
 * Brings up the server + a passive daemon (real `claude`/`codex` via agentLaunchCommand),
 * creates one starter session, and prints the URLs to open (desktop + phone). The web Live
 * section (opened by `?server=`) lists sessions; create / resume / kill more from the UI.
 *
 * Run: bunx tsx tests/e2e/serve.ts   (Ctrl-C to stop)
 * Pair with: bun run --filter @podium/web build && bun run --filter @podium/web preview -- --host --port 4318
 */
import { networkInterfaces } from 'node:os'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'

const PORT = Number(process.env.PORT ?? 8787)
const WEB_PORT = Number(process.env.WEB_PORT ?? 4318)

function lanIp(): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return 'localhost'
}

const server = await startServer({ port: PORT })
const daemon = await startDaemon({
  serverUrl: `ws://localhost:${server.port}`,
  bootstrapToken: server.bootstrapToken,
  machineId: LOCAL_MACHINE_ID,
})

// A starter session so there's something to attach to immediately. The daemon spawns the
// real agent (claude) in this cwd via agentLaunchCommand.
const { sessionId } = server.registry.createSession({
  agentKind: 'claude-code',
  cwd: process.cwd(),
})

const ip = lanIp()
console.log(
  `\nPodium multi-session relay up on ws port ${server.port}. Starter session: ${sessionId}`,
)
console.log('Serve the web app in another shell:')
console.log(
  `  bun run --filter @podium/web build && bun run --filter @podium/web preview -- --host --port ${WEB_PORT}`,
)
console.log(
  `Desktop:            http://localhost:${WEB_PORT}/?server=ws://localhost:${server.port}`,
)
console.log(`Phone (same Wi-Fi):  http://${ip}:${WEB_PORT}/?server=ws://${ip}:${server.port}`)
console.log(
  'The Live section lists sessions; create / resume / kill from the UI. Ctrl-C to stop.\n',
)

const shutdown = async (): Promise<void> => {
  await daemon.close()
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
await new Promise(() => {})
