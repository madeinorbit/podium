import type { GitDiscoveryDiagnosticWire, GitRepositoryWire, MachineWire } from '@podium/model'
import type { PodiumClientApi } from '../api'
import type { Store } from './types'

export * from '../ui/state'

/** Legacy discovery data. Device screen state belongs only to UiStore. */
export interface EngineState {
  repos: GitRepositoryWire[]
  reposLoading: boolean
  reposLoaded: boolean
  repoDiagnostics: GitDiscoveryDiagnosticWire[]
  machines: MachineWire[]
}
export type EngineStatics<TApi extends PodiumClientApi> = Omit<Store<TApi>, keyof RuntimeState>
export const initialEngineState = (): EngineState => ({
  repos: [],
  reposLoading: false,
  reposLoaded: false,
  repoDiagnostics: [],
  machines: [],
})

export type RuntimeState = EngineState & import('../ui/state').ScreenState
