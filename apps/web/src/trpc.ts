import type { AppRouter } from '@podium/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

export type Trpc = ReturnType<typeof createTRPCClient<AppRouter>>

/** Parse `?server=ws://host:port` into the ws client URL + the http origin for tRPC. */
export function parseServer(search: string): { wsClientUrl: string; httpOrigin: string } | null {
  const server = new URLSearchParams(search).get('server')
  if (!server) return null
  return { wsClientUrl: `${server}/client`, httpOrigin: server.replace(/^ws/, 'http') }
}

export function makeTrpc(httpOrigin: string): Trpc {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${httpOrigin}/trpc` })] })
}
