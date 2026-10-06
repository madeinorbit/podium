import { resolveAccountPrincipal, type AuthBootstrap } from '@podium/client-core/accounts'
import { webAccountEraser, webAccounts } from './accounts'

export type { AuthBootstrap } from '@podium/client-core/accounts'
import { workspaceFetch } from '@/lib/workspace-request'
/**
 * THE BOOT GATE FOR THE PRIVATE REPLICA.
 *
 * The authenticated principal and its IndexedDB assembly must settle before the
 * store mounts. The engine reads rows synchronously at construction, so mounting
 * early would paint an empty shell and then jump after hydration.
 *
 * FAILURE IS FATAL. The browser has one supported private replica; if its
 * principal cannot be resolved or IndexedDB cannot open, the shell renders an
 * explicit retryable error and never mounts a different store.
 */

import { STORE_REFRESH_NOTICE, startReplicaBoot } from '@podium/client-core/replica-assembly'

export { STORE_REFRESH_NOTICE } from '@podium/client-core/replica-assembly'

import type { ClientPrincipal } from '@podium/client-core/principal'
import { inspectPrincipalNamespaces } from '@podium/client-core/replica'
import { createLogger } from '@podium/logger'
import type { LegacyIdentityEvidence } from '@podium/client-core/replica-assembly'
import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { KERNEL_SIDE_CACHE_PREFIX, type KernelAssembly, openKernelAssembly } from './kernelReplica'
import { type ReplicaFailure, ReplicaGateError, replicaFailureOf } from './replica-failure'

const log = createLogger('web:replica')

export type KernelReplicaGate =
  /** Still deciding. The caller must render its loading screen. */
  | { readonly status: 'resolving' }
  /** The replica could not be opened. `failure` is the raw fault text, for the
   *  disclosure and the log; `cause` is what the screen is chosen from — and not
   *  every cause is fatal, since "no session" is a sign-in [POD-1304]. */
  | { readonly status: 'failed'; readonly failure: string; readonly cause: ReplicaFailure }
  | {
      readonly status: 'kernel'
      /** The authenticated principal this gate resolved and opened for — the
       *  value `StoreProvider` binds its whole runtime to (POD-404). It comes
       *  from `/auth/status` (or, offline, from an unambiguous single retained
       *  namespace marker); never from the URL and never from a raw storage
       *  "last user" key. */
      readonly principal: ClientPrincipal
      readonly assembly: KernelAssembly
      /** Notice when the privacy gate refreshes a cache it cannot adopt. */
      readonly notice?: string
    }

export interface ResolveReplicaPrincipalOptions {
  /** The server's HTTP origin from `serverConfig`. The status fetch must target
   *  it explicitly when the page is NOT same-origin with the server (baked
   *  tauri-scheme fallback). Served-local all-in-one loads http://127.0.0.1 and
   *  is same-origin; relative /auth/status is fine there. On tauri://, a relative
   *  fetch is answered by the bundled SPA's index.html — a 200 whose HTML body
   *  used to surface as WebKit's bare "The string did not match the expected
   *  pattern." and kill the boot gate. */
  readonly httpOrigin?: string
  readonly fetchStatus?: () => Promise<Response>
  readonly inspectNamespaces?: () => readonly string[]
}

function principalFromAuthBootstrap(
  auth: Exclude<AuthBootstrap, { readonly kind: 'provisional-failure' }>,
): string {
  if (auth.kind === 'principal') return auth.principal
  throw new ReplicaGateError(auth.message, auth.failure)
}

function replicaFailureSemantics(failure: ReplicaFailure): readonly (string | number | null)[] {
  switch (failure.kind) {
    case 'server-starting':
      return [
        failure.kind,
        failure.readiness.state,
        failure.readiness.reason,
        failure.readiness.dataPlane,
      ]
    case 'auth-refused':
      return [failure.kind, failure.status]
    case 'offline-ambiguous':
      return [failure.kind, failure.count]
    case 'signed-out':
    case 'account-missing':
    case 'auth-insecure':
    case 'auth-intercepted':
    case 'offline-unknown':
    case 'replica-blocked':
    case 'unknown':
    case 'boot-stalled':
    case 'sync-invalid':
      return [failure.kind]
  }
}

/** The primitive meaning of the LoginGate handoff, independent of object identity. */
function authBootstrapSemantics(auth: AuthBootstrap | undefined): string {
  if (auth === undefined || auth.kind === 'provisional-failure') return '["resolve"]'
  if (auth.kind === 'principal') return JSON.stringify(['principal', auth.principal])
  return JSON.stringify(['failure', auth.message, ...replicaFailureSemantics(auth.failure)])
}

/**
 * Resolve the slice owner without creating a raw "last user" key.
 *
 * An authenticated HTTP answer is authoritative, including a refusal: a 401 or
 * a body without userId must never fall back to old device data. Only a network
 * failure may use durable namespace markers, and then exactly one marker must
 * exist. Multiple retained principals fail closed because choosing one would be
 * local visibility arbitration.
 */
export async function resolveReplicaPrincipal(
  options: ResolveReplicaPrincipalOptions = {},
): Promise<string> {
  const fetchStatus =
    options.fetchStatus ??
    (() => workspaceFetch(`${options.httpOrigin ?? ''}/auth/status`, { credentials: 'include' }))
  return resolveAccountPrincipal({
    fetchStatus,
    inspectNamespaces:
      options.inspectNamespaces ??
      (() =>
        inspectPrincipalNamespaces({
          storage: globalThis.localStorage,
          enumerateKeys: () => Object.keys(globalThis.localStorage),
          basePrefix: KERNEL_SIDE_CACHE_PREFIX,
        })),
  })
}

/**
 * What the user reads when the entity cache was not adopted and is being
 * re-derived from the server (POD-4002). A bootstrap after an upgrade is
 * expected, not a failure: plain words, no reason code — that stays in the
 * `kernel replica store not adopted` log line beside the decision.
 */

export function recordIdentityEvidence(principal: string): LegacyIdentityEvidence {
  try {
    const identities = [
      ...new Set([
        ...inspectPrincipalNamespaces({
          storage: globalThis.localStorage,
          enumerateKeys: () => Object.keys(globalThis.localStorage),
          basePrefix: KERNEL_SIDE_CACHE_PREFIX,
        }),
        principal,
      ]),
    ]
    return { kind: 'multi-user', signedInAs: principal, identitiesEverSignedIn: identities }
  } catch {
    return { kind: 'unknown' }
  }
}

declare global {
  /** Runtime diagnostic proving the supported private replica opened. */
  var __podiumReplicaPath: 'kernel' | undefined
}

export function useKernelReplica(args: {
  trpc: Trpc
  /** Result of LoginGate's auth-first probe. Supplying it removes the second auth request. */
  auth?: AuthBootstrap
  /** The server origin every gate request targets — see ResolveReplicaPrincipalOptions. */
  httpOrigin: string
  resolvePrincipal?: typeof resolveReplicaPrincipal
  openAssembly?: typeof openKernelAssembly
}): KernelReplicaGate {
  const {
    trpc,
    auth,
    httpOrigin,
    resolvePrincipal = resolveReplicaPrincipal,
    openAssembly = openKernelAssembly,
  } = args
  const [gate, setGate] = useState<KernelReplicaGate>({ status: 'resolving' })
  const authSemantics = authBootstrapSemantics(auth)
  const principalResolver =
    auth === undefined || auth.kind === 'provisional-failure' ? resolvePrincipal : undefined

  // biome-ignore lint/correctness/useExhaustiveDependencies: authSemantics includes every auth field read below and excludes throwaway object identity; principalResolver matters only without an authoritative handoff.
  useEffect(() => {
    return startReplicaBoot({
      open: async () => {
        await webAccounts(httpOrigin).drain()
        const principal =
          auth === undefined || auth.kind === 'provisional-failure'
            ? await (principalResolver ?? resolveReplicaPrincipal)({ httpOrigin })
            : principalFromAuthBootstrap(auth)
        if (auth === undefined || auth.kind === 'provisional-failure')
          await webAccounts(httpOrigin).recordPrincipal(principal)
        let notice: string | undefined
        const assembly = await openAssembly({
          trpc,
          httpOrigin,
          principal,
          evidence: recordIdentityEvidence(principal),
          onDegraded: (detail) => {
            const report = detail as { kind?: unknown; notice?: unknown; reason?: unknown }
            if (report?.kind === 'store-not-adopted' && notice === undefined)
              notice = STORE_REFRESH_NOTICE
          },
        }).catch((error: unknown) => {
          if (replicaFailureOf(error).kind !== 'unknown') throw error
          throw new ReplicaGateError(error instanceof Error ? error.message : String(error), {
            kind: 'replica-blocked',
          })
        })
        const ownership = webAccountEraser.register(principal, assembly)
        return { assembly, notice, ownership }
      },
      dispose: ({ ownership }) => ownership.dispose(),
      onCleanupError: (error) => log.warn('replica cleanup failed', { err: error }),
      // Web has no boot watchdog, and a re-run keeps the current gate until the
      // new open settles: only an outcome changes what the shell renders.
      stallAfterMs: null,
      onState: (state) => {
        if (state.status === 'ready') {
          globalThis.__podiumReplicaPath = 'kernel'
          setGate({
            status: 'kernel',
            principal: state.value.assembly.principal,
            assembly: state.value.assembly,
            ...(state.value.notice === undefined ? {} : { notice: state.value.notice }),
          })
        } else if (state.status === 'failed') {
          log.error('private replica unavailable', { failure: state.failure, cause: state.cause })
          globalThis.__podiumReplicaPath = undefined
          setGate(state)
        }
      },
    })
  }, [authSemantics, httpOrigin, openAssembly, principalResolver, trpc])

  return gate
}
