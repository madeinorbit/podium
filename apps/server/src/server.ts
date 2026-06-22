import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { hostname } from 'node:os'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { registerAssetRoute } from './file-asset-route'
import { registerMcpRoute } from './mcp-route'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
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
  // Provision the local machine NOW, at startup: register it and adopt any pre-existing
  // `'__local__'` rows onto it — so a single-machine install's sessions/repos are
  // attributed and visible regardless of whether/when the daemon connects. This is the
  // structural guard against the regression where data vanished because no daemon ever
  // registered. (The full same-host secret credential is wired with the launcher task;
  // the same-host daemon attaches as the local machine in wsServer.)
  registry.ensureLocalMachine(hostname())
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
