import type { AppRouter } from '@podium/server'
import {
  parseServer,
  parseServerOrigin,
  resolveServerConfig,
  type ServerConfig,
  type ServerOrigin,
} from '@podium/client-core/transport'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

export type { ServerConfig, ServerOrigin }
export { parseServer, parseServerOrigin }
export type Trpc = ReturnType<typeof createTRPCClient<AppRouter>>

/**
 * Resolve relay endpoints. Honors injected or explicit backend overrides;
 * otherwise derives same-origin URLs from window.location.
 */
export function serverConfig(loc: Location): ServerConfig {
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  return resolveServerConfig(loc, injected)
}

export function makeTrpc(httpOrigin: string): Trpc {
  // The login session (podium_session cookie) is the operator's authentication; the tracker
  // grants full authority to any authenticated /trpc caller (no separate issue credential).
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${httpOrigin}/trpc`,
        // Send the login session cookie with every tRPC call. Same-origin already does this
        // by default; being explicit keeps it working if the client is ever cross-origin.
        fetch: (url, opts) => fetch(url, { ...opts, credentials: 'include' }),
      }),
    ],
  })
}
