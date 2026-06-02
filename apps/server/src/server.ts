import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { RelayHub } from './relay'
import { appRouter } from './router'
import { attachWebSockets } from './wsServer'

export interface ServerHandle {
  port: number
  hub: RelayHub
  close(): Promise<void>
}

export function startServer(opts: { port?: number } = {}): Promise<ServerHandle> {
  const hub = new RelayHub()
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  app.use('/trpc/*', trpcServer({ router: appRouter, createContext: () => ({ hub }) }))

  return new Promise<ServerHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0 }, (info) => {
      const ws = attachWebSockets(server as unknown as Server, hub)
      resolve({
        port: info.port,
        hub,
        close: () =>
          ws.close().then(
            () =>
              new Promise<void>((res) => {
                ;(server as unknown as Server).close(() => res())
              }),
          ),
      })
    })
  })
}
