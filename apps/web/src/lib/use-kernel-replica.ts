/**
 * THE BOOT GATE FOR THE KERNEL REPLICA (POD-1223).
 *
 * Two things must settle before the store mounts, and both are asynchronous:
 * WHICH path this client runs (flags + the server's scoping grade) and, on the
 * kernel path, the IndexedDB open. The store cannot mount meanwhile — the engine
 * reads rows synchronously at construction, so mounting early would paint an
 * empty shell and then jump, which is precisely the cold-start-paint regression
 * this cutover is not allowed to cause.
 *
 * THE FAILURE POSTURE IS THE LEGACY PATH, and it is chosen rather than defaulted
 * into. If the assembly cannot be built — no IndexedDB (private mode in some
 * browsers), a blocked upgrade, a rejected open — the app runs the shipped path
 * instead of showing an error. The kernel replica is behind a hidden flag; a
 * flag that can brick the app when its storage is unavailable is a worse
 * property than a flag that quietly does not take effect, and the resolved mode
 * carries the reason so Settings can say so.
 */

import type { ClientPrincipal } from '@podium/client-core/principal'
import { inspectPrincipalNamespaces, type ReplicaMode } from '@podium/client-core/replica'
import type { LegacyIdentityEvidence } from '@podium/sync/adapters/legacy-replica'
import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import {
  KERNEL_SIDE_CACHE_PREFIX,
  type KernelAssembly,
  openKernelAssembly,
  resolveWebReplicaMode,
} from './kernelReplica'

export type KernelReplicaGate =
  /** Still deciding. The caller must render its loading screen. */
  | { readonly status: 'resolving' }
  /** Run the shipped TanStack path. `assembly` is absent, not empty. */
  | { readonly status: 'failed'; readonly mode: ReplicaMode | null; readonly failure: string }
  | {
      readonly status: 'kernel'
      readonly mode: ReplicaMode
      /** The authenticated principal this gate resolved and opened for — the
       *  value `StoreProvider` binds its whole runtime to (POD-404). It comes
       *  from `/auth/status` (or, offline, from an unambiguous single retained
       *  namespace marker); never from the URL and never from a raw storage
       *  "last user" key. */
      readonly principal: ClientPrincipal
      readonly assembly: KernelAssembly
      /** True when the shadow comparison should also run (POD-1223). */
      readonly shadow: boolean
      /** `/version`'s grade, handed to the shadow harness. */
      readonly authorityScoped: boolean
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
  /**
   * WHICH READ PATH THIS TAB RESOLVED TO — a diagnostic, and the only way a
   * browser test can tell the two paths apart.
   *
   * Without it a runtime spec asserting "the app works with the flag on" is
   * indistinguishable from one asserting "the app works", because both paths
   * render the same UI when they are both correct. That is the whole hazard: a
   * green cutover spec that silently ran the legacy path proves nothing. It is
   * written by the gate and read by nobody in the product.
   */
  var __podiumReplicaPath: 'legacy' | 'kernel' | 'kernel-with-shadow' | undefined
}

export function useKernelReplica(args: { httpOrigin: string; trpc: Trpc }): KernelReplicaGate {
  const { httpOrigin, trpc } = args
  const [gate, setGate] = useState<KernelReplicaGate>({ status: 'resolving' })

  useEffect(() => {
    let alive = true
    let opened: KernelAssembly | undefined
    void (async () => {
      const { mode, serverGrade } = await resolveWebReplicaMode({ httpOrigin, trpc })
      if (!alive) return
      if (mode.path === 'legacy') {
        globalThis.__podiumReplicaPath = undefined
        setGate({
          status: 'failed',
          mode,
          failure: 'This server cannot provide the principal-scoped kernel replica.',
        })
        return
      }
      try {
        const principal = await resolveReplicaPrincipal()
        const assembly = await openKernelAssembly({
          trpc,
          principal,
          evidence: recordIdentityEvidence(principal),
        })
        if (!alive) {
          void assembly.dispose()
          return
        }
        opened = assembly
        globalThis.__podiumReplicaPath = mode.path
        setGate({
          status: 'kernel',
          mode,
          principal: assembly.principal,
          assembly,
          shadow: mode.path === 'kernel-with-shadow',
          authorityScoped: serverGrade === 'per-principal',
        })
      } catch (error) {
        // Reported, not swallowed: a flag that silently did nothing would be
        // indistinguishable from a flag that worked.
        console.warn('[podium] kernel replica unavailable', error)
        if (alive) {
          globalThis.__podiumReplicaPath = undefined
          setGate({
            status: 'failed',
            mode,
            failure: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()
    return () => {
      alive = false
      if (opened) void opened.dispose()
    }
  }, [httpOrigin, trpc])

  return gate
}
