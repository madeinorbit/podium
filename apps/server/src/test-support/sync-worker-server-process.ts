/** Standalone Bun fixture: real worker_threads never run inside Vitest's fork. */
import { firstAdminMemberId } from '@podium/model'
import { saveConfig } from '@podium/runtime/config'
import { memberCredentials } from '../identity/member-credentials'
import { startServer } from '../server'
import { attachHostDaemon } from './host-daemon'
import { cookieOf } from './test-identity'

const input = JSON.parse(process.env.PODIUM_SYNC_SERVER_FIXTURE ?? '{}') as {
  repos?: string[]
  member?: { email: string; password: string }
}
saveConfig({ mode: 'all-in-one' })
const server = await startServer({ port: 0 })
await attachHostDaemon(server.registry, () => {}, { repos: input.repos ?? [] })
const store = server.registry.sessionStore
const owner = await firstAdminMemberId(store)
const account = await store.users.get(owner)
if (!account?.accountId) throw new Error('fixture owner has no account')
if (input.member) {
  const credentials = memberCredentials(store.users, () => server.identity.core.accounts)
  await credentials.setEmail(owner, input.member.email)
  await credentials.setPassword(owner, input.member.password)
}
const cookie = cookieOf(
  await server.identity.core.deviceSignIns.create(
    account.accountId,
    { kind: 'browser' },
    'cookie',
    { scheme: 'http', sameMachine: true, clientAddress: '127.0.0.1' },
  ),
)
while (!server.syncWorker()) await Bun.sleep(10)
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  try {
    await server.close()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
process.on('message', (message) => {
  if (message === 'close') void close()
})
process.on('SIGTERM', () => {
  void close()
})
process.send?.({ port: server.port, owner, cookie, machineId: store.hostMachineId })
