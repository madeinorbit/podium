import type { PoolScreen } from '@podium/client-graph/host'

/** Reuses the provider's existing pool and machine service. Workflow wires
 * remain RPC inputs supplied by the sole useWorkflows hook. */
export const workflowPoolScreen: PoolScreen = {
  id: 'workflows',
  options: () => ({ settings: true }),
}
