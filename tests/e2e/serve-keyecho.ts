/**
 * Manual browser testing of keystroke/mouse fidelity through the full Podium pipeline.
 * Same as serve.ts, but the daemon's `launch` is overridden so every session spawns the
 * keyecho echo jig (a fake agent) instead of the real `claude`/`codex`. Open the Live UI,
 * type / use the mobile key toolbar / scroll, and watch each input echo back with its bytes
 * and label — proving browser -> server -> daemon -> PTY -> agent.
 *
 * Run: node --conditions=@podium/source --import tsx tests/e2e/serve-keyecho.ts   (Ctrl-C to stop)
 *      (the @podium/source condition resolves workspace packages to TS source, so no build is needed)
 * Pair with: bun run --filter @podium/web build && bun run --filter @podium/web preview -- --host --port 4318
 */
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { LaunchOptions, LaunchSpec } from '@podium/agent-bridge'
import type { AgentKind } from '@podium/protocol'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { LOCAL_MACHINE_ID } from '../../apps/server/src/local-machine'
import { startServer } from '../../apps/server/src/server'

const PORT = Number(process.env.PORT ?? 8787)
const WEB_PORT = Number(process.env.WEB_PORT ?? 4318)
const MODE = process.env.KEYECHO_MODE ?? 'both'
const KEYECHO_CLI = fileURLToPath(new URL('../keyecho/src/cli.tsx', import.meta.url))
const KEYECHO_PKG = fileURLToPath(new URL('../keyecho', import.meta.url))

// Spawn keyecho as the far-end agent for any requested kind. Run it from the keyecho
// package dir, NOT opts.cwd: tsx resolves tsconfig from the working directory, and only
// keyecho's tsconfig sets jsx:react-jsx. Launched from a project dir the root tsconfig
// (no jsx) makes tsx emit the classic runtime and keyecho dies with "React is not
// defined". keyecho is a stateless echo jig, so its working directory is irrelevant.
const launch = (_kind: AgentKind, _opts: LaunchOptions): LaunchSpec => ({
  cmd: process.execPath,
  args: ['--import', 'tsx', KEYECHO_CLI, '--mode', MODE],
  cwd: KEYECHO_PKG,
})

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
  launch,
})

const { sessionId } = server.registry.createSession({
  agentKind: 'claude-code',
  cwd: process.cwd(),
})

const ip = lanIp()
console.log(
  `\nkeyecho relay up on ws port ${server.port} (mode=${MODE}). Starter session: ${sessionId}`,
)
console.log('Serve the web app in another shell:')
console.log(
  `  bun run --filter @podium/web build && bun run --filter @podium/web preview -- --host --port ${WEB_PORT}`,
)
console.log(
  `Desktop:            http://localhost:${WEB_PORT}/?server=ws://localhost:${server.port}`,
)
console.log(`Phone (same Wi-Fi):  http://${ip}:${WEB_PORT}/?server=ws://${ip}:${server.port}`)
console.log('Attach to the session and type — every key/mouse event echoes back. Ctrl-C to stop.\n')

const shutdown = async (): Promise<void> => {
  await daemon.close()
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
await new Promise(() => {})
