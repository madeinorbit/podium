import type { AppRouter, RouterOutputs } from '@podium/api-types'
import {
  DEFAULT_RECOVERY_DELAYS_MS,
  reportingFetch,
  restartRecoveryLink,
} from '@podium/client-core/replica-assembly/server-calls'
import {
  parseServer,
  parseServerOrigin,
  resolveServerConfig,
  type ServerConfig,
  type WorkspaceSelector,
  workspaceRequestInit,
} from '@podium/client-core/transport'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import { Platform } from 'react-native'
import { MobileAuthExpiredError } from './auth'

export type MobileTrpc = ReturnType<typeof createTRPCClient<AppRouter>>
export type TranscriptPage = RouterOutputs['sessions']['transcriptRead']

declare const process: { env?: Record<string, string | undefined> } | undefined

let activeRuntimeConfig: ServerConfig | undefined
let activeRuntimeBearer: string | null = null

export function envServer(): string | undefined {
  if (typeof process === 'undefined') return undefined
  return process.env?.EXPO_PUBLIC_PODIUM_SERVER
}

function envSameSite(): boolean {
  if (typeof process === 'undefined') return false
  return process.env?.EXPO_PUBLIC_PODIUM_SAME_SITE === 'true'
}

/**
 * The build-time server origin, but only when the BUILD also declared it
 * same-site with the page it is stamping (PDM-24). `undefined` otherwise, which
 * is every build that says nothing — so web behaviour is unchanged by default.
 *
 * Why a web session may follow it at all, when native injection may not: the
 * session cookie belongs to the API host and is `SameSite=Lax`, and same-site is
 * exactly the condition under which the browser attaches it to what this page
 * asks for, including the socket upgrade. The cookie rationale at `webProfile`
 * is not weakened here; this names the one deployment that satisfies it.
 *
 * A FLAG, NOT A HEURISTIC. Deciding "same site" in the page means deriving the
 * registrable domain from a hostname, which needs the public suffix list to be
 * right; being wrong means sending credentials to a host that merely looks like
 * a neighbour. The build knows, so the build says.
 */
export function sameSiteBuildServer(): string | undefined {
  const declared =
    (globalThis as { __PODIUM_SAME_SITE__?: boolean }).__PODIUM_SAME_SITE__ === true ||
    envSameSite()
  if (!declared) return undefined
  return (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ ?? envServer()
}

export function readServerConfig(): ServerConfig {
  if (activeRuntimeConfig) return activeRuntimeConfig
  const injected = (globalThis as { __PODIUM_SERVER__?: string }).__PODIUM_SERVER__ ?? envServer()
  // A MISSING `location` IS THE NATIVE CASE, not an impossible one (POD-2055 F4).
  // React Native sets `global.window = global`, so `typeof window` is `'object'`
  // on a phone and the old guard fell through to `window.location.search` — a
  // TypeError on the first line of the app's boot, invisible to this repo's
  // mobile lane because it runs react-native-web inside happy-dom. On device the
  // injected global and EXPO_PUBLIC_PODIUM_SERVER are the only config paths
  // there are, which is what the branch below already implements.
  //
  // `typeof` first and always: `window` is an unbound identifier where it does
  // not exist, and optional chaining does not save a ReferenceError.
  const location =
    typeof window === 'undefined'
      ? undefined
      : (window as { location?: Location | undefined }).location
  if (location == null) {
    const parsed = injected ? parseServerOrigin(injected) : null
    if (parsed) return { ...parsed, override: true }
    throw new Error('native server profile has not been selected')
  }
  // Web sessions are page-origin cookie sessions. Two things may redirect them:
  // the page's explicit ?server override, and a build that declared its server
  // same-site with the page (see `sameSiteBuildServer`). Native build-time
  // injection on its own still may not.
  //
  // ?server FIRST, because `resolveServerConfig` prefers what it is handed:
  // passing the build origin unconditionally would make the development
  // override unreachable on exactly the builds that need it most.
  //
  // Through the narrowed `location` above rather than `window.location`: the
  // early return has already established it is present, and reaching for the
  // property a second time is the exact spelling that throws on a device.
  if (parseServer(location.search)) return resolveServerConfig(location)
  return resolveServerConfig(location, sameSiteBuildServer())
}

export function setActiveServerRuntime(
  config: ServerConfig | undefined,
  bearer: string | null,
): void {
  activeRuntimeConfig = config
  activeRuntimeBearer = bearer
}

export function activeServerHttpOrigin(): string | undefined {
  try {
    return readServerConfig().httpOrigin
  } catch {
    return undefined
  }
}

export function activeServerBearer(): string | null {
  return activeRuntimeBearer
}
function configuredWorkspaceSelector(): WorkspaceSelector | undefined {
  if (!activeRuntimeConfig) return undefined
  if (activeRuntimeConfig.workspaceId) return { workspaceId: activeRuntimeConfig.workspaceId }
  if (activeRuntimeConfig.workspaceSlug) return { workspaceSlug: activeRuntimeConfig.workspaceSlug }
  return undefined
}

export function bearerHeaders(
  bearer: string | null,
  headers?: HeadersInit,
  selector?: WorkspaceSelector,
): Headers {
  const result = new Headers(headers)
  if (bearer) result.set('Authorization', `Bearer ${bearer}`)
  const scoped = workspaceRequestInit(
    new URL('https://podium.invalid'),
    { headers: result },
    selector ?? configuredWorkspaceSelector(),
  )
  return new Headers(scoped?.headers ?? result)
}

export async function fetchMobileTransport(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  bearer: string | null,
  onAuthExpired?: (error: MobileAuthExpiredError) => void,
  selector?: WorkspaceSelector,
): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: bearerHeaders(bearer, init?.headers, selector),
  })
  if (bearer && response.status === 401) {
    onAuthExpired?.(new MobileAuthExpiredError())
  }
  return response
}

export function makeMobileTrpc(
  httpOrigin: string,
  bearer: string | null = null,
  onAuthExpired?: (error: MobileAuthExpiredError) => void,
  selector?: WorkspaceSelector,
  options: { fetch?: typeof fetch; recoveryDelaysMs?: readonly number[] } = {},
): MobileTrpc {
  const base: typeof fetch =
    options.fetch ??
    ((url, init) => fetchMobileTransport(url, init, bearer, onAuthExpired, selector))
  return createTRPCClient<AppRouter>({
    links: [
      restartRecoveryLink<AppRouter>({
        base,
        httpOrigin,
        report: true,
        recoveryDelaysMs: options.recoveryDelaysMs ?? DEFAULT_RECOVERY_DELAYS_MS,
        errorType: TRPCClientError,
      }),
      httpBatchLink({
        url: httpOrigin + '/trpc',
        fetch: reportingFetch(base),
      }),
    ],
  })
}
