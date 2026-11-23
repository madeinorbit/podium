/**
 * Child for runtime-event-ack-crash.integration.bun.test.ts: seeds a backlog,
 * then drains it the way a reconnect replay does (a batch of ACKs per
 * macrotask) while new events keep arriving, until the parent kills it.
 * Each progress line is appended only after the calls it reports returned.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { createRuntimeEventOutbox, type DurableRuntimeEvent } from '../runtime-event-outbox'

const [dir, totalArg] = process.argv.slice(2)
const total = Number(totalArg)
if (!dir || !Number.isInteger(total))
  throw new Error('ack drain fixture requires directory and backlog size')
const progress = join(dir, 'progress.log')
const batch = 8

const event = (deliveryId: string, seq: number): DurableRuntimeEvent => ({
  type: 'runtimeEvent',
  deliveryId,
  sessionId: 'drain-session' as SessionId,
  event: {
    t: 'state',
    change: { kind: 'activity' },
    at: '2026-11-23T00:00:00.000Z',
    provenance: 'live',
    observerGeneration: 1,
    turnEpoch: 1,
    cursor: { segmentId: 'drain', components: { seq } },
  },
})

const outbox = createRuntimeEventOutbox(dir)
for (let i = 0; i < total; i++) outbox.enqueue(event(`backlog-${i}`, i))
appendFileSync(progress, `seeded ${total}\n`)
process.stdout.write('seeded\n')

let next = 0
const step = (): void => {
  const end = Math.min(total, next + batch)
  for (; next < end; next++) outbox.acknowledge(`backlog-${next}`)
  appendFileSync(progress, `acked ${next}\n`)
  outbox.enqueue(event(`live-${next}`, total + next))
  appendFileSync(progress, `added live-${next}\n`)
  if (next < total) setImmediate(step)
  else process.stdout.write('drained\n')
}
setImmediate(step)
