import type { PodiumClientApi } from '../api'
import type { Store } from './types'

export * from '../ui/state'

/**
 * The engine's own state: nothing since POD-6644. Machines, their access and
 * the registered repositories with their worktrees are synced records (the
 * replica holds them, the pool models them); device screen state belongs only
 * to UiStore. The name stays for the store types built on it.
 */
export type EngineState = Record<never, never>
export type EngineStatics<TApi extends PodiumClientApi> = Omit<Store<TApi>, keyof RuntimeState>
export const initialEngineState = (): EngineState => ({})

export type RuntimeState = EngineState & import('../ui/state').ScreenState
