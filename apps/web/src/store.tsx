/**
 * Web binding for the shared client store (arch-v2 P3, issue #192): the
 * provider + optimistic actions moved to @podium/client-core/react, generic
 * over the structural PodiumClientApi seam. This shim binds it to the web's
 * AppRouter-typed tRPC client (built here — the type-only apps/web →
 * @podium/server edge stays in this app), sonner toasts, and formatAppError,
 * and re-exports the typed hooks so existing `./store` imports keep working.
 */

import {
  type Store as CoreStore,
  StoreProvider as CoreStoreProvider,
  type StoreNotices,
  useStore as useCoreStore,
  useStoreSelector as useCoreStoreSelector,
} from '@podium/client-core/react'
import type { JSX, ReactNode } from 'react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { formatAppError } from './AppErrorPage'
import { makeTrpc, type ServerOrigin, type Trpc } from './trpc'

/** The web store: the shared store, with `trpc` carrying the full AppRouter type. */
export type Store = CoreStore<Trpc>

export type { MainView } from '@podium/client-core/router'
export type { FileTab } from '@podium/client-core/viewmodels'
export type { UserFocus } from '@podium/client-core/react'

const NOTICES: StoreNotices = {
  error: (message) => toast.error(message),
  info: (message, description) => toast(message, description ? { description } : undefined),
}

export function StoreProvider({
  config,
  onFatalError,
  children,
}: {
  config: ServerOrigin
  onFatalError: (message: string) => void
  children: ReactNode
}): JSX.Element {
  const trpc = useMemo(() => makeTrpc(config.httpOrigin), [config.httpOrigin])
  return (
    <CoreStoreProvider
      config={config}
      api={trpc}
      onFatalError={onFatalError}
      formatError={formatAppError}
      notices={NOTICES}
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
