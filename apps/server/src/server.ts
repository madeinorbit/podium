import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { startLoopMetrics } from '@podium/core'
import { WIRE_VERSION } from '@podium/protocol'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { registerAssetRoute } from './file-asset-route'
import { readOrCreateDaemonSecret } from './local-machine'
import { registerMcpRoute } from './mcp-route'
import { registerSetupRoute } from './setup-route'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { registerWebStatic } from './static-web'
import { SessionStore } from './store'
import { SuperagentService } from './superagent'
import { attachWebSockets } from './wsServer'

export interface ServerHandle {
  port: number
  registry: SessionRegistry
  /**
   * The persistent same-host shared secret the bundled local daemon presents (as its
   * `hello` token) to authenticate as the local machine. Exposed so the in-process
   * daemon (host.ts) can pass it straight through without re-reading the file.
   */
  bootstrapToken: string
  close(): Promise<void>
}

/** Machine-readable version probe — distinct from /health (which stays plaintext "ok"). */
export function registerVersionRoute(app: Hono): void {
  app.get('/version', (c) =>
    c.json({
      wireVersion: WIRE_VERSION,
      appVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
    }),
  )
}

export async function startServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const store = new SessionStore()
  const registry = new SessionRegistry(store)
  // The persistent same-host shared secret, read (or created 0600) from the state dir.
  // The server hashes it into the local machine's stored credential below; the bundled
  // local daemon reads the SAME file (or, in-process, gets this value via ServerHandle)
  // and presents it as its `hello` token — so the local daemon authenticates with no
  // pairing step and no per-boot token race.
  const bootstrapToken = readOrCreateDaemonSecret()
  // Provision the local machine NOW, at startup: register it with the server-owned
  // credential (sha256 of the shared secret) and adopt any pre-existing `'__local__'`
  // rows onto it — so a single-machine install's sessions/repos are attributed and
  // visible regardless of whether/when the daemon connects. This is the structural guard
  // against the regression where data vanished because no daemon ever registered. The
  // same-host daemon then authenticates through the normal hello path (wsServer).
  registry.ensureLocalMachine(hostname(), bootstrapToken)
  const repos = new RepoRegistry(registry, store)
  const superagent = new SuperagentService(registry, repos, store)
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  registerVersionRoute(app)
  registerSetupRoute(app)
  registerAssetRoute(app, registry)
  // In-process MCP server exposing the superagent's orchestrator tools to a
  // harness-backed superagent (Claude via --mcp-config). Token-gated.
  const mcpToken = randomUUID()
  registerMcpRoute(app, superagent, mcpToken)
  app.use('/trpc/*', cors())
  app.use(
    '/trpc/*',
    trpcServer({ router: appRouter, createContext: () => ({ registry, repos, superagent }) }),
  )

  // Serve the built web UI for external clients (browser/phone/other desktop). The
  // packaged headless bundle sets PODIUM_WEB_DIR; a source run defaults to apps/web/dist.
  // In a `bun build --compile` binary import.meta.url is not a file:// URL, so guard the
  // default — an unset PODIUM_WEB_DIR there simply means "API only", never a crash.
  let webDir = process.env.PODIUM_WEB_DIR
  if (!webDir) {
    try {
      webDir = fileURLToPath(new URL('../../web/dist', import.meta.url))
    } catch {
      webDir = ''
    }
  }
  if (webDir) registerWebStatic(app, webDir)

  return new Promise<ServerHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0 }, (info) => {
      // The harness agent runs on the same host (single-machine), so loopback
      // reaches this MCP route. Now that the port is known, point it there.
      superagent.setMcpEndpoint(`http://127.0.0.1:${info.port}/mcp`, mcpToken)
      const ws = attachWebSockets(server as unknown as Server, registry)
      if (process.env.PODIUM_LOOP_PROFILE) startLoopMetrics({ label: 'server' })
      resolve({
        port: info.port,
        registry,
        bootstrapToken,
        close: () =>
          ws.close().then(
            () =>
              new Promise<void>((res) => {
                ;(server as unknown as Server).close(() => {
                  store.close()
                  res()
                })
              }),
          ),
      })
    })
  })
}
