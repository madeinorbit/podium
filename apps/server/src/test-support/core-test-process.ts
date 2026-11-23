/** Bun child of the Core test cluster. The listener and server workers use production wiring. */
import { setTimeout } from 'node:timers/promises'
import { startServer } from '../server'
import type { CoreTestCommand, CoreTestReply } from './core-test-cluster'
import { cookieOf } from './test-identity'

if (!process.send) throw new Error('Core test process requires an IPC parent')
process.once('disconnect', () => process.exit(1))

// Exercise hosted authentication on loopback using the normal trusted proxy path.
const server = await startServer({ port: 0, hostMachine: false, trustedProxyHops: 1 })
const store = server.registry.sessionStore
let dropWakeUps = false
let dropped = 0
// The store's idle signal is today's fast path for feed delivery. The fallback
// timer and durable writes stay live. Move this gate to the workspace wake-up
// transport when that replaces the local signal.
const onIdle = store.onPublicationIdle.bind(store)
store.onPublicationIdle = (listener) =>
  onIdle(() => {
    if (dropWakeUps) dropped++
    else listener()
  })

process.on('message', (command: CoreTestCommand) => {
  if (command.type === 'setWakeUpsDropped') {
    dropWakeUps = command.dropped
    process.send?.({
      type: 'wakeUpsDropped',
      id: command.id,
      count: dropped,
    } satisfies CoreTestReply)
    dropped = 0
  }
})
process.once('SIGTERM', () => {
  void server.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    },
  )
})

const firstAdmin = await store.users.earliestAdmin()
if (!firstAdmin?.accountId) throw new Error('Core fixture administrator has no account')
const cookie = cookieOf(
  await server.identity.core.deviceSignIns.create(
    firstAdmin.accountId,
    { kind: 'browser' },
    'cookie',
    { scheme: 'https', sameMachine: false, clientAddress: '127.0.0.1' },
  ),
)

// Server boot schedules its real threads off the listen path. Expose the route
// only after both workers are running so tests can immediately exercise them.
while (server.syncWorker()?.state() !== 'running') await setTimeout(25)
while (true) {
  const response = await fetch(`http://127.0.0.1:${server.port}/version`)
  const version = (await response.json()) as { components?: { janitor?: { state: string } } }
  if (version.components?.janitor?.state === 'running') break
  await setTimeout(25)
}
process.send({ type: 'ready', port: server.port, cookie } satisfies CoreTestReply)
