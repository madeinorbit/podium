/** Shared cold-row marker: the answer of a read whose data is on its way.
 * Keep this entry free of runtime dependencies so legacy screens can
 * recognize pending rows without loading the pool. `@podium/client-graph`
 * re-exports it (`@podium/client-graph/loading`); it lives here so the shared
 * value types (`IssueBodyFields`) can name it (POD-7545). */
export const LOADING = Symbol('loading')
export type Loaded<T> = T | typeof LOADING | undefined
