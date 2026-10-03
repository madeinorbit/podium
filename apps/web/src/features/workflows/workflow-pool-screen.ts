import type { PoolScreen } from '@podium/client-graph/host'
import { WORKFLOW_SUMMARIES } from '@podium/client-graph/workflow-schema'

/** Reuses the provider's existing pool and machine service. Workflow wires
 * remain RPC inputs supplied by the sole useWorkflows hook. */
export const workflowPoolScreen: PoolScreen = {
  id: 'workflows',
  initialize() {},
  enabled: () => true,
  options: () => ({ settings: true, summaries: WORKFLOW_SUMMARIES }),
}
