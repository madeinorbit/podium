import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SessionStore } from './store'
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
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  app.use('/trpc/*', cors())
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: () => ({ registry, repos }) }))

  return new Promise<ServerHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0 }, (info) => {
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
