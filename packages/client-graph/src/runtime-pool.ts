import { createWorklistPool, type WorklistPoolHandle } from './create'
import { createEngineLocals, type LocalsEngine } from './shared/engine-locals'
import { createRowSource, type RowSourceReplica, type RowSourceRuntime } from './shared/row-source'

/** Structural seam satisfied by the app's StoreProvider runtime. */
export type WorklistRuntime = RowSourceRuntime & LocalsEngine & { readonly replica: RowSourceReplica }

/** A read-only attachment: optimism and every write still belong to the runtime. */
export function createRuntimeWorklistPool(runtime: WorklistRuntime): WorklistPoolHandle {
  const rows = createRowSource(runtime, runtime.replica, { mode: 'overlaid' })
  let locals: ReturnType<typeof createEngineLocals> | undefined
  let handle: WorklistPoolHandle
  try {
    locals = createEngineLocals(runtime)
    handle = createWorklistPool(rows.source, locals.source)
  } catch (error) {
    locals?.dispose()
    rows.dispose()
    throw error
  }
  let disposed = false
  return {
    pool: handle.pool,
    dispose(): void {
      if (disposed) return
      disposed = true
      try {
        handle.dispose()
      } finally {
        locals?.dispose()
        rows.dispose()
      }
    },
  }
}
