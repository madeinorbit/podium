/** Shared cold-row marker. Keep this entry free of runtime dependencies so
 * legacy screens can recognize pending rows without loading the pool. */
export const LOADING = Symbol('loading')
export type Loaded<T> = T | typeof LOADING | undefined
