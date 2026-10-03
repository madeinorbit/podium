import type { PoolScreen } from '@podium/client-graph/host'
import { WORKFLOW_SUMMARIES } from '@podium/client-graph/workflow-schema'
import { initializeWorkflowsDataLayer, workflowsCheckRequested, workflowsDataLayer } from './data-layer'

/** Reuses the provider's existing pool and machine service. Workflow wires
 * remain RPC inputs supplied by the sole useWorkflows hook. */
export const workflowPoolScreen: PoolScreen = {
  initialize: initializeWorkflowsDataLayer,
  enabled: () => workflowsDataLayer() === 'pool',
  options: () => ({ settings: true, summaries: WORKFLOW_SUMMARIES }),
  async attach(runtime, pool) {
    if (!workflowsCheckRequested() || typeof window === 'undefined') return
    const { checkWorkflows } = await import('@podium/client-graph/diagnostics/workflow-check')
    const check = (inputs: Parameters<typeof checkWorkflows>[2]) => checkWorkflows(pool, runtime.getSnapshot(), inputs)
    Object.assign(window, { __workflowCheck: check })
    return () => { if (Reflect.get(window, '__workflowCheck') === check) Reflect.deleteProperty(window, '__workflowCheck') }
  },
}
