/** Shared cold-row marker. Keep this entry free of runtime dependencies so
 * legacy screens can recognize pending rows without loading the pool. It is
 * client-core's, so the shared value types can name it (POD-7545). */
export { LOADING, type Loaded } from '@podium/client-core/loading'
