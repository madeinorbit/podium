/**
 * Long-running launcher for manual / on-device testing: starts the server + a daemon
 * spawning real `claude`, then stays up and prints the URLs to open (desktop + phone).
 * Pair with the web app: `bun run --filter @podium/web preview -- --host --port 4318`.
 *
 * Run: bunx tsx e2e/serve.ts   (Ctrl-C to stop)
 */
import { networkInterfaces } from 'node:os'
import { startDaemon } from '../apps/daemon/src/daemon'
import { startServer } from '../apps/server/src/server'

const PORT = Number(process.env.PORT ?? 8787)
const CMD = process.env.AGENT_CMD ?? 'claude'

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
  sessionId: 'podium',
  cmd: CMD,
  args: [],
  cols: 100,
  rows: 30,
})

const ip = lanIp()
console.log(`\nPodium relay up — agent "${CMD}" on ws port ${server.port}.`)
console.log('Serve the web app in another shell:')
console.log(
  '  bun run --filter @podium/web build && bun run --filter @podium/web preview -- --host --port 4318',
)
console.log(`Desktop:           http://localhost:4318/?server=ws://localhost:${server.port}`)
console.log(`Phone (same Wi-Fi): http://${ip}:4318/?server=ws://${ip}:${server.port}`)
console.log('Open the same URL in two tabs to try takeover. Ctrl-C to stop.\n')

const shutdown = async (): Promise<void> => {
  await daemon.close()
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
await new Promise(() => {})
