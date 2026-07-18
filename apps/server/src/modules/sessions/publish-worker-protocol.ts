import type {
  PreparedPublication,
  PreparePublicationInput,
  SessionProjectionState,
} from './publish-worker-actor.js'
import type { SessionProjectionEvent } from './service.js'

export type PublishWorkerCommand =
  | { type: 'reset'; state: SessionProjectionState }
  | { type: 'patch'; event: SessionProjectionEvent }
  | { type: 'prepare'; id: string; input: PreparePublicationInput }

export type PublishWorkerResult =
  | {
      id: string
      ok: true
      publication: PreparedPublication
      /** CPU wall time observed inside the worker, for acceptance instrumentation. */
      durationMs: number
    }
  | { id: string; ok: false; error: string }
  | { id: null; ok: false; error: string }
