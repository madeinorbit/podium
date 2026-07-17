/**
 * Web binding for the shared client store (arch-v2 P3, issue #192): the
 * provider + optimistic actions moved to @podium/client-core/react, generic
 * over the structural PodiumClientApi seam. This shim binds it to the web's
 * AppRouter-typed tRPC client (built here — the type-only apps/web →
 * @podium/server edge stays in this app), sonner toasts, and formatAppError,
 * and re-exports the typed hooks so existing `./store` imports keep working.
 */

import { setSwitchTraceReporter } from '@podium/client-core/perf'
import {
  type Store as CoreStore,
  StoreProvider as CoreStoreProvider,
  type StoreNotices,
  useStore as useCoreStore,
  useStoreSelector as useCoreStoreSelector,
} from '@podium/client-core/react'
import type { Replica } from '@podium/client-core/replica'
import type { JSX, ReactNode } from 'react'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { formatAppError } from './AppErrorPage'
import { makeTrpc, type ServerOrigin, type Trpc } from './trpc'

/** The web store: the shared store, with `trpc` carrying the full AppRouter type. */
export type Store = CoreStore<Trpc>

export type { UserFocus } from '@podium/client-core/react'
export type { MainView } from '@podium/client-core/router'
export type { FileTab } from '@podium/client-core/viewmodels'

const NOTICES: StoreNotices = {
  error: (message) => toast.error(message),
  info: (message, description) => toast(message, description ? { description } : undefined),
}

export function StoreProvider({
  config,
  onFatalError,
  engineOverrides,
  createReplicaFn,
  children,
}: {
  config: ServerOrigin
  onFatalError: (message: string) => void
  /** Test seam passthrough (see client-core StoreProviderProps.engineOverrides). */
  engineOverrides?: { spawnConfirmGraceMs?: number }
  /** Desktop passthrough (POD-789): the Tauri shell injects an already-hydrated
   *  SQLite-backed replica; browsers leave this unset (localStorage default). */
  createReplicaFn?: () => Replica
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
      config={config}
      api={trpc}
      onFatalError={onFatalError}
      formatError={formatAppError}
      notices={NOTICES}
      engineOverrides={engineOverrides}
      createReplicaFn={createReplicaFn}
    >
      {children}
    </CoreStoreProvider>
  )
}

/** Compatibility hook: the WHOLE store snapshot. Re-renders whenever any store
 *  field changes — prefer `useStoreSelector` for hot components. */
export function useStore(): Store {
  return useCoreStore<Trpc>()
}

/** Slice subscription: re-renders only when `selector(store)` changes. */
export function useStoreSelector<T>(
  selector: (s: Store) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useCoreStoreSelector<T, Trpc>(selector, isEqual)
}
