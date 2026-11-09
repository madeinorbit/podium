/**
 * THE RUNTIME ROOT IN REACT (POD-6681; detailed design 2.1).
 *
 * `StoreProvider` builds one root per signed-in user and wraps its children in
 * `<RuntimeProvider runtime={root}>`. Components reach the root only through
 * the hooks below, and those hand out models, readings and a person's
 * actions, never a service or the root itself:
 *
 * - `useRuntime()`: the principal and the LiveStore;
 * - `useLive()`: the LiveStore (connection, machine online and load, quota and
 *   usage, unsent writes);
 * - `useOutboxRecovery()`: the answers to a parked write (retry, edit, discard).
 */

import { createContext, type JSX, type ReactNode, useContext } from 'react'
import type { LiveStore } from '../live/live-store'
import type { ClientPrincipal } from '../principal'
import type { OutboxRecovery } from '../runtime-root/outbox/outbox-service'
import type { ClientRuntime } from '../runtime-root/root'

/** What a component may read from its runtime root. */
export interface RuntimeView {
  readonly principal: ClientPrincipal
  readonly live: LiveStore
}

const RootCtx = createContext<ClientRuntime | null>(null)
const views = new WeakMap<ClientRuntime, RuntimeView>()

export function RuntimeProvider({
  runtime,
  children,
}: {
  runtime: ClientRuntime
  children: ReactNode
}): JSX.Element {
  return <RootCtx.Provider value={runtime}>{children}</RootCtx.Provider>
}

export function useClientRuntime<
  TApi extends import('../api').PodiumClientApi = import('../api').PodiumClientApi,
>(): ClientRuntime<TApi> {
  const root = useContext(RootCtx)
  if (!root) throw new Error('useRuntime outside RuntimeProvider')
  return root as unknown as ClientRuntime<TApi>
}

/** This user's runtime, as components see it: no services, no stores wholesale. */
export function useRuntime(): RuntimeView {
  const root = useClientRuntime()
  let view = views.get(root)
  if (!view) {
    view = Object.freeze({ principal: root.principal, live: root.live })
    views.set(root, view)
  }
  return view
}

/** This user's LiveStore (POD-5798): connection, quota and usage, unsent writes. */
export function useLive(): LiveStore {
  return useClientRuntime().live
}

/** A person's answers to a parked write, from the outbox service. */
export function useOutboxRecovery(): OutboxRecovery {
  return useClientRuntime().services.outbox.recovery
}
