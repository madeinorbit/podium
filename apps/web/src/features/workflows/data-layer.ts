import type { UiState } from '@podium/client-core/ui-state'
import { webPoolSwitch } from '@/lib/mobx-pilot'

/** TEMPORARY rollout switch: default OFF, latched before the first render.
 * Pool attachment and principal replacement never change the hook choice. */
const workflows = webPoolSwitch('mobxWorkflows', 'mobxWorkflowsCheck')
export const initializeWorkflowsDataLayer = (ui: Pick<UiState, 'get'>): void => { workflows.initialize(ui) }
export const workflowsDataLayer = (): 'legacy' | 'pool' => workflows.layer()
export const workflowsCheckRequested = (): boolean => workflows.checkRequested()
