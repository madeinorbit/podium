/** Publication scheduling and process-local read scopes. These capabilities
 * expose no database handle or repository operation, so gateway code keeps
 * its scheduling boundaries without importing the store.
 */
export { runAtRoot } from './store/executor/context'
export { createFrameFlusher } from './store/executor/frame-flusher'
export { withReadScope } from './store/executor/read-scope'
