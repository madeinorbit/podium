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

import type { ClientPrincipal } from '@podium/client-core/principal'
import { inspectPrincipalNamespaces } from '@podium/client-core/replica'
import { createLogger } from '@podium/logger'
import type { LegacyIdentityEvidence } from '@podium/sync/adapters/legacy-replica'
import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { KERNEL_SIDE_CACHE_PREFIX, type KernelAssembly, openKernelAssembly } from './kernelReplica'
import {
  classifyAuthStatus,
  type ReplicaFailure,
  ReplicaGateError,
  replicaFailureOf,
} from './replica-failure'

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
      /**
       * One sentence the user is OWED, or nothing (POD-1232).
       *
       * Queued offline writes found on this device are moved into the kernel
       * store at open, and some of them cannot be: work this account cannot be
       * shown to have authored is parked, and work naming an action no contract
       * resolves is kept on disk unsent. ADR 6 D4.4 does not allow either to be
       * silent, and the gate is the only thing that sees it happen — the store
       * has not mounted yet.
       */
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

/** LoginGate's auth probe handoff to the private-replica gate. */
export type AuthBootstrap =
  | { readonly kind: 'principal'; readonly principal: string }
  /** The first status request failed without an authoritative auth answer. The
   * replica gate must re-probe before it fails or retained data chooses an owner. */
  | { readonly kind: 'provisional-failure' }
  | {
      readonly kind: 'failure'
      readonly message: string
      readonly failure: ReplicaFailure
    }

function offlineReplicaPrincipal(inspectNamespaces?: () => readonly string[]): string {
  const inspect =
    inspectNamespaces ??
    (() =>
      inspectPrincipalNamespaces({
        storage: globalThis.localStorage,
        enumerateKeys: () => Object.keys(globalThis.localStorage),
        basePrefix: KERNEL_SIDE_CACHE_PREFIX,
      }))
  const identities = [...new Set(inspect())]
  if (identities.length === 1 && identities[0] !== undefined) return identities[0]
  throw identities.length === 0
    ? new ReplicaGateError('offline replica has no authenticated principal namespace', {
        kind: 'offline-unknown',
      })
    : new ReplicaGateError('offline replica principal is ambiguous on this shared device', {
        kind: 'offline-ambiguous',
        count: identities.length,
      })
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
    (() => fetch(`${options.httpOrigin ?? ''}/auth/status`, { credentials: 'include' }))
  let response: Response
  try {
    response = await fetchStatus()
  } catch {
    return offlineReplicaPrincipal(options.inspectNamespaces)
  }

  // A refusal is authoritative, and its SHAPE is information the operator needs:
  // the route emits 400 for exactly one thing — a bearer credential offered over
  // a link that is not secure — and that is a different sentence from a server
  // that simply said no [POD-1304].
  if (!response.ok) {
    throw new ReplicaGateError(
      'authenticated account is unavailable',
      response.status === 400
        ? { kind: 'auth-insecure' }
        : { kind: 'auth-refused', status: response.status },
    )
  }
  // A 200 whose body is not JSON (an SPA fallback or a proxy's HTML page) is a
  // backend that cannot vouch for an account. Same fail-closed answer as a
  // refusal — never a raw parse error, and never a fall back to device data.
  let status: { userId?: unknown; needsAuth?: unknown; readiness?: unknown }
  try {
    status = (await response.json()) as { userId?: unknown }
  } catch {
    throw new ReplicaGateError('authenticated account is unavailable', { kind: 'auth-intercepted' })
  }
  const outcome = classifyAuthStatus(status)
  if ('principal' in outcome) return outcome.principal
  throw new ReplicaGateError('authenticated account is unavailable', outcome)
}

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: authSemantics includes every auth field read below and excludes throwaway object identity.
  useEffect(() => {
    let alive = true
    let opened: KernelAssembly | undefined
    void (async () => {
      if (!alive) return
      try {
        // A successful LoginGate answer remains the one-request fast path. A
        // provisional first answer gets one retry with the cookie before a
        // network failure may authorize retained offline data.
        const principal =
          auth === undefined || auth.kind === 'provisional-failure'
            ? await resolvePrincipal({ httpOrigin })
            : principalFromAuthBootstrap(auth)
        // Captured DURING the open: the migration runs inside `openKernelAssembly`
        // and reports through `onDegraded`, which is the only channel that exists
        // before the store (and its toasts) are mounted.
        let notice: string | undefined
        const assembly = await openAssembly({
          trpc,
          principal,
          evidence: recordIdentityEvidence(principal),
          onDegraded: (detail) => {
            const report = detail as { kind?: unknown; notice?: unknown }
            if (report?.kind === 'legacy-outbox-migrated' && typeof report.notice === 'string') {
              notice = report.notice
            }
          },
        }).catch((error: unknown) => {
          // The principal resolved, so whatever went wrong here is the browser's
          // own store refusing to open — a private window, a full disk, blocked
          // site data. A different sentence from anything upstream of it.
          throw new ReplicaGateError(error instanceof Error ? error.message : String(error), {
            kind: 'replica-blocked',
          })
        })
        if (!alive) {
          void assembly.dispose()
          return
        }
        opened = assembly
        globalThis.__podiumReplicaPath = 'kernel'
        setGate({
          status: 'kernel',
          principal: assembly.principal,
          assembly,
          ...(notice === undefined ? {} : { notice }),
        })
      } catch (error) {
        // Visible, and never silently degraded: there is no compatibility replica
        // to fall back to. What the operator SEES depends on the cause — see
        // `replica-failure.ts` — but the store never mounts either way.
        log.error('private replica unavailable', { err: error })
        if (alive) {
          globalThis.__podiumReplicaPath = undefined
          setGate({
            status: 'failed',
            failure: error instanceof Error ? error.message : String(error),
            cause: replicaFailureOf(error),
          })
        }
      }
    })()
    return () => {
      alive = false
      if (opened) void opened.dispose()
    }
  }, [authSemantics, httpOrigin, openAssembly, resolvePrincipal, trpc])

  return gate
}
