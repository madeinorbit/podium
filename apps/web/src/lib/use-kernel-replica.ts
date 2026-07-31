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

import type { ReplicaMode } from '@podium/client-core/replica'
import { useEffect, useState } from 'react'
import type { Trpc } from '@/app/trpc'
import { type KernelAssembly, openKernelAssembly, resolveWebReplicaMode } from './kernelReplica'

export type KernelReplicaGate =
  /** Still deciding. The caller must render its loading screen. */
  | { readonly status: 'resolving' }
  /** Run the shipped TanStack path. `assembly` is absent, not empty. */
  | { readonly status: 'legacy'; readonly mode: ReplicaMode | null; readonly failure?: string }
  | {
      readonly status: 'kernel'
      readonly mode: ReplicaMode
      readonly assembly: KernelAssembly
      /** True when the shadow comparison should also run (POD-1223). */
      readonly shadow: boolean
      /** `/version`'s grade, handed to the shadow harness. */
      readonly authorityScoped: boolean
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
        globalThis.__podiumReplicaPath = 'legacy'
        setGate({ status: 'legacy', mode })
        return
      }
      try {
        const assembly = await openKernelAssembly({ trpc })
        if (!alive) {
          void assembly.dispose()
          return
        }
        opened = assembly
        globalThis.__podiumReplicaPath = mode.path
        setGate({
          status: 'kernel',
          mode,
          assembly,
          shadow: mode.path === 'kernel-with-shadow',
          authorityScoped: serverGrade === 'per-principal',
        })
      } catch (error) {
        // Reported, not swallowed: a flag that silently did nothing would be
        // indistinguishable from a flag that worked.
        console.warn('[podium] kernel replica unavailable — running the legacy path', error)
        if (alive) {
          globalThis.__podiumReplicaPath = 'legacy'
          setGate({
            status: 'legacy',
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
