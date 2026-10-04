/**
 * Web binding for the shared client store (arch-v2 P3, issue #192): the
 * provider + optimistic actions moved to @podium/client-core/react, generic
 * over the structural PodiumClientApi seam. This shim binds it to the web's
 * AppRouter-typed tRPC client (from @podium/api-types), sonner toasts, and formatAppError,
 * and re-exports the typed hooks so existing `./store` imports keep working.
 */

import type { CreateEngineOutbox, CreateReplicaForPrincipal } from '@podium/client-core/engine'
import { setSwitchTraceReporter } from '@podium/client-core/perf'
import type { ClientPrincipal } from '@podium/client-core/principal'
import {
  type Store as CoreStore,
  StoreProvider as CoreStoreProvider,
  type StoreNotices,
  useRuntimeSelector as useCoreStoreSelector,
} from '@podium/client-core/react'
import type { Replica } from '@podium/client-core/replica'
import type { FeedSinkPort } from '@podium/client-core/socket-transport'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { elidePathHead, looksLikePath } from '@/lib/notice-path'
import { formatAppError } from './AppErrorPage'
import { makeTrpc, type ServerOrigin, type Trpc } from './trpc'
import { attachWorklistPool } from './store-worklist-pool'

/** The web store: the shared store, with `trpc` carrying the full AppRouter type. */
export type Store = CoreStore<Trpc>

export type { UserFocus } from '@podium/client-core/react'
export type { IssueViewModel } from '@podium/client-core/replica'
export type { MainView } from '@podium/client-core/router'
export type { FileTab } from '@podium/client-core/values'


const NOTICES: StoreNotices = {
  error: (message) => toast.error(message),
  info: (message, description) =>
    toast(message, description ? { description: describeNotice(description) } : undefined),
}

/**
 * One notice — a session's worktree move — passes a raw absolute path where
 * every other one passes a sentence. A path gets the mono lane, shortened at a
 * separator with the whole thing on hover; prose is left exactly as it is
 * (POD-1159). `bdi` keeps the string logically LTR inside the lane's RTL
 * ellipsis trick.
 */
function describeNotice(description: string): ReactNode {
  if (!looksLikePath(description)) return description
  return (
    <span className="cn-toast-path" title={description}>
      <bdi>{elidePathHead(description)}</bdi>
    </span>
  )
}

export function StoreProvider({
  principal,
  config,
  onFatalError,
  engineOverrides,
  createReplicaFn,
  feed,
  createOutboxFn,
  onServerRelocation,
  makeSocket,
  children,
}: {
  /** The authenticated principal (from `/auth/status` via the boot gate).
   *  `null` until it settles — the core provider then builds nothing. */
  principal: ClientPrincipal | null
  config: ServerOrigin
  onFatalError: (message: string) => void
  /** Test seam passthrough (see client-core StoreProviderProps.engineOverrides). */
  engineOverrides?: { spawnConfirmGraceMs?: number }
  /** Required private-replica facade. AppShell cannot mount this provider until
   *  its principal-bound kernel assembly has opened successfully. */
  createReplicaFn: CreateReplicaForPrincipal
  /** Kernel feed paired with the private replica facade. */
  feed?: FeedSinkPort
  /** Kernel Outbox factory paired with the kernel replica assembly. */
  createOutboxFn?: CreateEngineOutbox
  onServerRelocation?: (publicUrl: string, transferId: string, claimToken?: string) => void
  makeSocket?: import('@podium/client-core/socket-transport').SocketHubOptions['makeSocket']
  children: ReactNode
}): JSX.Element {
  const trpc = useMemo(() => makeTrpc(config.httpOrigin), [config.httpOrigin])
  // Ship finalized client switch traces [POD-701] to the server: fire-and-forget,
  // never throws into the UI (the collector also swallows reporter errors).
  useEffect(() => {
    setSwitchTraceReporter((trace) => {
      void trpc.perf.report.mutate(trace).catch(() => {})
    })
    return () => setSwitchTraceReporter(null)
  }, [trpc])
  return (
    <CoreStoreProvider
      principal={principal}
      config={config}
      api={trpc}
      onFatalError={onFatalError}
      formatError={formatAppError}
      notices={NOTICES}
      engineOverrides={engineOverrides}
      createReplicaFn={createReplicaFn}
      feed={feed}
      createOutboxFn={createOutboxFn}
      onServerRelocation={onServerRelocation}
      makeSocket={makeSocket}
      attachRuntime={(runtime) =>
        attachWorklistPool(runtime, (error) => onFatalError(error.message))
      }
    >
      {children}
    </CoreStoreProvider>
  )
}

/** Runtime actions and keyed local controls; records are read through the pool. */
export function useRuntimeSelector<T>(selector: (s: Store) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useCoreStoreSelector<T, Trpc>(selector, isEqual)
}
export { useHostMetrics } from '@podium/client-core/react'
