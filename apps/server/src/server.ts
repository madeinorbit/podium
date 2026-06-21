import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { registerAssetRoute } from './file-asset-route'
import { registerMcpRoute } from './mcp-route'
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
  close(): Promise<void>
}

export async function startServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const store = new SessionStore()
  const registry = new SessionRegistry(store)
  const repos = new RepoRegistry(store)
  const superagent = new SuperagentService(registry, repos, store)
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
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
      resolve({
        port: info.port,
        registry,
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
