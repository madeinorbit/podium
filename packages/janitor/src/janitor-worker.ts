import { parentPort, workerData } from 'node:worker_threads'
import { type JanitorHandle, MaintenanceCompatibilityError, startJanitor } from './janitor'
import type { JanitorWorkerStartOptions } from './worker-client'

type ControlMessage =
  | { type: 'stop' }
  | { type: 'testCrash' }
  | { type: 'testBlock'; id: string; durationMs: number }

if (parentPort) {
  const port = parentPort
  const options = workerData as JanitorWorkerStartOptions
  let handle: JanitorHandle | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const refuse = (error: Error): void => {
    handle?.close()
    handle = undefined
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
    port.postMessage({ type: 'compatibilityRefusal', reason: error.message })
  }

  port.on('message', (message: ControlMessage) => {
    if (message.type === 'stop') {
      handle?.close()
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
      ...options,
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
