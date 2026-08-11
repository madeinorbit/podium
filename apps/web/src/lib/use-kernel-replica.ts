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
import type { LegacyIdentityEvidence } from '@podium/sync/adapters/legacy-replica'
import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { KERNEL_SIDE_CACHE_PREFIX, type KernelAssembly, openKernelAssembly } from './kernelReplica'

export type KernelReplicaGate =
  /** Still deciding. The caller must render its loading screen. */
  | { readonly status: 'resolving' }
  /** Fatal: the supported private replica could not be opened. */
  | { readonly status: 'failed'; readonly failure: string }
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
  readonly fetchStatus?: () => Promise<Response>
  readonly inspectNamespaces?: () => readonly string[]
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
  const fetchStatus = options.fetchStatus ?? (() => fetch('/auth/status'))
  let response: Response
  try {
    response = await fetchStatus()
  } catch {
    const inspect =
      options.inspectNamespaces ??
      (() =>
        inspectPrincipalNamespaces({
          storage: globalThis.localStorage,
          enumerateKeys: () => Object.keys(globalThis.localStorage),
          basePrefix: KERNEL_SIDE_CACHE_PREFIX,
        }))
    const identities = [...new Set(inspect())]
    if (identities.length === 1 && identities[0] !== undefined) return identities[0]
    throw new Error(
      identities.length === 0
        ? 'offline replica has no authenticated principal namespace'
        : 'offline replica principal is ambiguous on this shared device',
    )
  }

  if (!response.ok) throw new Error('authenticated account is unavailable')
  const status = (await response.json()) as { userId?: unknown }
  if (typeof status.userId !== 'string' || status.userId.length === 0) {
    throw new Error('authenticated account is unavailable')
  }
  return status.userId
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
  resolvePrincipal?: typeof resolveReplicaPrincipal
  openAssembly?: typeof openKernelAssembly
}): KernelReplicaGate {
  const {
    trpc,
    resolvePrincipal = resolveReplicaPrincipal,
    openAssembly = openKernelAssembly,
  } = args
  const [gate, setGate] = useState<KernelReplicaGate>({ status: 'resolving' })

  useEffect(() => {
    let alive = true
    let opened: KernelAssembly | undefined
    void (async () => {
      if (!alive) return
      try {
        const principal = await resolvePrincipal()
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
        // Fatal and visible: there is no compatibility replica to fall back to.
        console.error('[podium] private replica unavailable', error)
        if (alive) {
          globalThis.__podiumReplicaPath = undefined
          setGate({
            status: 'failed',
            failure: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()
    return () => {
      alive = false
      if (opened) void opened.dispose()
    }
  }, [openAssembly, resolvePrincipal, trpc])

  return gate
}
