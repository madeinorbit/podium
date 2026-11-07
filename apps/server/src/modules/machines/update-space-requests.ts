import { randomUUID } from 'node:crypto'
import {
  type MachineSupervisorControlMessage,
  UPDATE_SPACE_TIMEOUT_MS,
  type UpdateSpaceEstimate,
  type UpdateSpaceResultMessage,
  type UpdateTarget,
  unknownUpdateSpace,
} from '@podium/protocol'

type Send = (message: MachineSupervisorControlMessage) => void

/** Only live request correlations, not a cache or update state. Entries die in 5s. */
export class UpdateSpaceRequests {
  private readonly pending = new Map<
    string,
    {
      machineId: string
      send: Send
      fingerprint: string
      finish: (result: UpdateSpaceEstimate) => void
    }
  >()

  request(
    machineId: string,
    send: Send,
    target: UpdateTarget,
    fingerprint: string,
  ): Promise<UpdateSpaceEstimate> {
    if (this.pending.size >= 64)
      return Promise.resolve(unknownUpdateSpace('Space preview is busy.'))
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const finish = (result: UpdateSpaceEstimate): void => {
        if (!this.pending.delete(requestId)) return
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(
        () => finish(unknownUpdateSpace('The machine did not answer the space preview.')),
        UPDATE_SPACE_TIMEOUT_MS,
      )
      timer.unref?.()
      this.pending.set(requestId, { machineId, send, fingerprint, finish })
      try {
        send({ type: 'updateSpaceCheck', requestId, targetFingerprint: fingerprint, target })
      } catch {
        finish(unknownUpdateSpace('The machine is disconnected.'))
      }
    })
  }

  receive(machineId: string, send: Send, message: UpdateSpaceResultMessage): void {
    const pending = this.pending.get(message.requestId)
    if (
      !pending ||
      pending.machineId !== machineId ||
      pending.send !== send ||
      pending.fingerprint !== message.targetFingerprint
    )
      return
    pending.finish({
      status: message.status,
      checkedAt: message.checkedAt,
      volumes: message.volumes,
      ...(message.reason ? { reason: message.reason } : {}),
    })
  }

  close(): void {
    for (const pending of this.pending.values())
      pending.finish(unknownUpdateSpace('The server closed the space preview.'))
  }
}
