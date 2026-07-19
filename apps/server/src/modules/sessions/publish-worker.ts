import { parentPort } from 'node:worker_threads'
import { SessionPublicationActor } from './publish-worker-actor.js'
import type { PublishWorkerCommand, PublishWorkerResult } from './publish-worker-protocol.js'

/** Constructed separately in tests; the production worker keeps one actor for its lifetime. */
export function createPublishWorkerHandler(
  postMessage: (result: PublishWorkerResult) => void,
): (command: PublishWorkerCommand) => void {
  const actor = new SessionPublicationActor()
  return (command) => {
    try {
      if (command.type === 'reset') {
        actor.reset(command.state)
        return
      }
      if (command.type === 'patch') {
        actor.applyPatch(command.event)
        return
      }
      const started = performance.now()
      const publication = actor.prepare(command.input)
      postMessage({
        id: command.id,
        ok: true,
        publication,
        durationMs: performance.now() - started,
      })
    } catch (error) {
      postMessage({
        id: command.type === 'prepare' ? command.id : null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

if (parentPort) {
  const port = parentPort
  const handle = createPublishWorkerHandler((result) => port.postMessage(result))
  port.on('message', handle)
}
