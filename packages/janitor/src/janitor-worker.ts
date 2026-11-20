import { parentPort, workerData } from 'node:worker_threads'
import {
  type JanitorDatabase,
  type JanitorHandle,
  MaintenanceCompatibilityError,
  startJanitor,
} from './janitor'
import type { JanitorWorkerStartOptions } from './worker-client'

type ControlMessage =
  | { type: 'stop' }
  | { type: 'testCrash' }
  | { type: 'testBlock'; id: string; durationMs: number }

/**
 * THE JANITOR WORKER'S LOOP, run by the thread entry its host provides [POD-6993].
 *
 * The janitor reads the store through query definitions on the store's binding, which
 * live with the store in `apps/server`, so the thread's entry is the server's
 * (`apps/server/src/janitor-worker.ts`): it passes the opener of the database on the
 * store's engine, and this runs everything else, as before: the control messages, the
 * heartbeat, and the compatibility refusal that parks the worker degraded instead of
 * crash-looping.
 */
export async function serveJanitorWorker(
  openDatabase: (options: JanitorWorkerStartOptions) => JanitorDatabase,
): Promise<void> {
  if (!parentPort) return
  const port = parentPort
  const options = workerData as JanitorWorkerStartOptions
  let handle: JanitorHandle | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const refuse = (error: Error): void => {
    void handle?.close()
    handle = undefined
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
    port.postMessage({ type: 'compatibilityRefusal', reason: error.message })
  }

  port.on('message', (message: ControlMessage) => {
    if (message.type === 'stop') {
      void handle?.close()
      if (heartbeat) clearInterval(heartbeat)
      port.close()
      return
    }
    if (message.type === 'testCrash') {
      throw new Error('deliberate janitor worker crash')
    }
    port.postMessage({ type: 'testBlockStarted', id: message.id })
    const waitArray = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(waitArray, 0, 0, Math.max(0, message.durationMs))
    port.postMessage({ type: 'testBlockFinished', id: message.id })
  })

  try {
    handle = await startJanitor({
      serverUrl: options.serverUrl,
      token: options.token,
      database: openDatabase(options),
      localMachineId: options.localMachineId,
      ...(options.tickMs !== undefined ? { tickMs: options.tickMs } : {}),
      onCompatibilityRefusal: refuse,
    })
    port.postMessage({
      type: 'ready',
      progressVersion: handle.service.progressVersion(),
    })
    heartbeat = setInterval(() => {
      if (!handle) return
      port.postMessage({
        type: 'progress',
        progressVersion: handle.service.progressVersion(),
      })
    }, 1_000)
  } catch (error) {
    if (error instanceof MaintenanceCompatibilityError) {
      refuse(error)
    } else {
      throw error
    }
  }
}
