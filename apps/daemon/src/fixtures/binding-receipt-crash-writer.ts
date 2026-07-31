import { asSessionId } from '@podium/model'
import { BindingStore } from '../binding-store'

const dir = process.argv[2]
if (!dir) throw new Error('binding store directory is required')

const store = await BindingStore.open({ dir })
const recorded = await store.recordPendingCodexReceipt(
  asSessionId('crash-pane'),
  'crash-thread',
  'process',
  '2026-07-31T20:00:00.000Z',
)
if (!recorded) throw new Error('crash fixture binding did not exist')

process.stdout.write('receipt-durable\n')
setInterval(() => undefined, 60_000)
