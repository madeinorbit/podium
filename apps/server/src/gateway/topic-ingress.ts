/**
 * The daemon end of topics on the server (ADR 7 Amendment 2 D21): one
 * `topicPublish` path for every daemon-produced kind.
 *
 * A frame is refused unless its kind is daemon-produced, the key's id belongs
 * to the machine whose AUTHENTICATED socket sent it (never a payload claim),
 * and the payload parses as the kind's declared publish shape. Then it goes to
 * the kind's sink, which owns what the value means on the server (host metrics
 * also drive the pressure sweep) and hands it on to the topic routing.
 */

import { createLogger } from '@podium/logger'
import type { MachineId } from '@podium/model'
import { isTopicKind, parseTopicKey, TOPIC_KINDS, type TopicKind } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import type { TopicsDaemonPort } from './daemon-ports'
import type { TopicProducers } from './topic-routing'

const log = createLogger('gateway:topics')

type DaemonTopicKind = {
  [K in TopicKind]: (typeof TOPIC_KINDS)[K]['producer'] extends 'daemon' ? K : never
}[TopicKind]

export type DaemonTopicSinks = {
  readonly [K in DaemonTopicKind]: (machineId: MachineId, payload: unknown) => void
}

export function createDaemonTopicIngress(input: {
  readonly producers: TopicProducers
  readonly sinks: DaemonTopicSinks
}): TopicsDaemonPort {
  return {
    onTopicPublish(machineId, msg: Extract<DaemonMessage, { type: 'topicPublish' }>) {
      const ref = parseTopicKey(msg.key)
      if (!ref || !isTopicKind(ref.kind)) return refuse('unknown kind', msg.key)
      const decl = TOPIC_KINDS[ref.kind]
      if (decl.producer !== 'daemon' || !('publish' in decl))
        return refuse('not daemon-produced', msg.key)
      if (input.producers[ref.kind].machineOf?.(ref.id) !== machineId) {
        return refuse('key belongs to another machine', msg.key)
      }
      const parsed = decl.publish.safeParse(msg.payload)
      if (!parsed.success) return refuse('payload does not match the kind', msg.key)
      input.sinks[ref.kind as DaemonTopicKind](machineId, parsed.data)
    },
  }
}

function refuse(reason: string, key: string): void {
  log.warn('dropped a daemon topic publish', { reason, key })
}
