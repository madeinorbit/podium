import { asSessionId } from '@podium/model'
import { withDeliveryQueue, type AgentSessionHandle } from '@podium/harness/driver/host'
import { createRuntimeEventOutbox, prepareRuntimeEventDelivery } from '../runtime-event-outbox'

const [dir, mode] = process.argv.slice(2)
if (!dir || !['held', 'typing', 'outcome'].includes(mode!)) throw new Error('delivery crash fixture requires directory and mode')
const sessionId = asSessionId('restart-session')
const outbox = createRuntimeEventOutbox(dir)
const handle = withDeliveryQueue({
  state: async () => ({ phase: mode === 'held' ? 'working' : 'idle' }),
  async send(_input, options) {
    options.onTypingStarted?.()
    if (mode === 'typing') {
      process.stdout.write('typing-durable\n')
      return new Promise(() => {})
    }
    return { outcome: 'accepted', turnEpoch: 1, deliveredAs: 'when-ready',
      provenBy: 'protocol-ack', at: new Date().toISOString(), transcriptItem: { id: 'recorded-entry' } }
  },
} as AgentSessionHandle, (event) => {
  prepareRuntimeEventDelivery(outbox, {
    type: 'runtimeEvent', sessionId,
    event: { ...event, at: new Date().toISOString(), provenance: 'live',
      cursor: { segmentId: 'before-restart', components: { seq: 1 } }, observerGeneration: 1, turnEpoch: 1 },
  })
  process.stdout.write('outcome-durable\n')
}, undefined, undefined, outbox.deliveryJournal(sessionId))

await handle.send({ id: 'held-mail', rowId: 'held-mail', text: 'send after the turn', deliveryRecovery: false }, { origin: 'mail', delivery: 'when-ready' })
if (mode === 'held') process.stdout.write('held-untyped\n')
// The parent SIGKILLs this exact recorded child, without any shutdown flush.
setInterval(() => {}, 60_000)
