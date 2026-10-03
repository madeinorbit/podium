import {
  DEFAULT_RECOVERY_DELAYS_MS,
  type ReportingFetchOptions,
  restartRecoveryLink,
  reportingFetch as sharedReportingFetch,
} from '@podium/client-core/replica-assembly/server-calls'
import {
  parseServer,
  parseServerOrigin,
  resolveServerConfig,
  type ServerConfig,
  type ServerOrigin,
} from '@podium/client-core/transport'
import { createLogger } from '@podium/logger'
import type { AppRouter } from '@podium/api-types'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import { workspaceRequestInit, workspaceSocketUrl } from '@/lib/workspace-request'

export type { ReportingFetchOptions } from '@podium/client-core/replica-assembly/server-calls'
export {
  isServerUnavailable,
  SERVER_UNAVAILABLE_MESSAGE,
  ServerUnavailableError,
  trpcProcedurePath,
} from '@podium/client-core/replica-assembly/server-calls'
export type { ServerConfig, ServerOrigin }
export { parseServer, parseServerOrigin }
export type Trpc = ReturnType<typeof createTRPCClient<AppRouter>>
const log = createLogger('web:trpc')

function cookieFetch(base: typeof fetch): typeof fetch {
  return (input, init) =>
    base(input, workspaceRequestInit(input, { ...init, credentials: 'include' }))
}
export function reportingFetch(
  base: typeof fetch = fetch,
  options: ReportingFetchOptions = {},
): typeof fetch {
  return sharedReportingFetch(cookieFetch(base), { ...options, logger: log })
}

/**
 * Resolve relay endpoints. Honors injected or explicit backend overrides;
 * otherwise derives same-origin URLs from window.location.
 */
export function serverConfig(loc: Location): ServerConfig {
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__
  const config = resolveServerConfig(loc, injected)
  return { ...config, wsClientUrl: workspaceSocketUrl(config.wsClientUrl, loc.pathname) }
}

export interface MakeTrpcOptions extends ReportingFetchOptions {
  /** Fetch implementation; injectable for the restart recovery test. */
  fetch?: typeof fetch
  /** Readiness retry schedule. Overridden with zero-delay entries by focused tests. */
  recoveryDelaysMs?: readonly number[]
}

export function makeTrpc(httpOrigin: string, options: MakeTrpcOptions = {}): Trpc {
  const {
    fetch: base = fetch,
    recoveryDelaysMs = DEFAULT_RECOVERY_DELAYS_MS,
    report = true,
  } = options
  // The login session (podium_session cookie) is the operator's authentication; the tracker
  // grants full authority to any authenticated /trpc caller (no separate issue credential).
  return createTRPCClient<AppRouter>({
    links: [
      restartRecoveryLink<AppRouter>({
        base: cookieFetch(base),
        httpOrigin,
        report,
        recoveryDelaysMs,
        logger: log,
        errorType: TRPCClientError,
      }),
      httpBatchLink({
        url: `${httpOrigin}/trpc`,
        fetch: reportingFetch(base, { report }),
      }),
    ],
  })
}
