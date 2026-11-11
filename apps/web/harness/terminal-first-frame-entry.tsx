import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import type { PodiumClientApi } from '@podium/client-core/api'
import { knownReading } from '@podium/client-core/live'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import type { ClientRuntime } from '@podium/client-core/runtime-root'
import { machineRecords } from '@podium/client-core/test-support/machine-records'
import { createReplicaFixture } from '@podium/client-core/test-support/replica'
import { asSessionId, asUserId, type SessionMeta } from '@podium/model/browser'
import { runInAction } from 'mobx'
import { createRoot } from 'react-dom/client'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import { AgentPanel } from '@/features/terminal/AgentPanel'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import '@/index.css'
import '@/styles.css'

// A stored session without live fields. No server, terminal attach, or geometry
// response can repair the constructor's first grid in this layout fixture.
const sessionId = asSessionId('first-frame')
const userId = asUserId('first-frame-viewer')
const replica = createReplicaFixture()
replica.applySnapshot('sessions', [
  {
    sessionId,
    title: 'Live geometry',
    agentKind: 'codex',
    cwd: '/workspace',
    status: 'live',
    machineId: 'fixture-machine',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    transcriptAvailable: true,
    resumable: true,
  } as unknown as SessionMeta,
])
const records = machineRecords(userId, {
  id: 'fixture-machine',
  name: 'Fixture host',
  online: true,
  loggedOutHarnesses: [],
})
replica.applySnapshot(
  'machines',
  records.filter((row) => row.entity === 'machine').map((row) => row.value) as never,
)
replica.applySnapshot(
  'machineAccess',
  records.filter((row) => row.entity === 'machineAccess').map((row) => row.value) as never,
)

const api = {
  settings: { get: { query: async () => ({}) } },
  quota: { summary: { query: async () => [] } },
  sessions: { transcriptRead: { query: async () => ({ items: [], hasMore: false }) } },
  sync: { load: { query: async () => ({ records: [], gone: [] }) } },
} as unknown as PodiumClientApi
function attach(runtime: ClientRuntime) {
  runtime.ui.setPanelMode(sessionId, 'native')
  runInAction(() => {
    runtime.live.applyTopic(
      'machine.condition',
      'fixture-machine',
      knownReading({ online: true, since: null }, Date.now()),
    )
    runtime.live.applyTopic(
      'session.terminalState',
      sessionId,
      knownReading({ controller: null, geometry: { cols: 132, rows: 43 } }, Date.now()),
    )
  })
  return attachWorklistPool(runtime, (error) => {
    throw error
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
createRoot(root).render(
  <StoreProvider
    principal={asClientPrincipal(userId)}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={api}
    createReplicaFn={() => replica}
    networkEnabled={false}
    attachRuntime={attach}
    onFatalError={(error) => {
      throw error
    }}
  >
    <ConfirmProvider>
      <main
        style={{ padding: 24, height: '100vh', display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <header>
          <h1 style={{ fontSize: 20 }}>Terminal first frame</h1>
          <p id="first-frame-reading">Waiting for the terminal constructor…</p>
          <p style={{ color: 'var(--text-dim)' }}>
            Stored session has no geometry. Live session model: 132 × 43. Attach is disabled.
          </p>
        </header>
        <section style={{ flex: 1, minHeight: 0, border: '1px solid var(--border)' }}>
          <AgentPanel sessionId={sessionId} />
        </section>
      </main>
    </ConfirmProvider>
  </StoreProvider>,
)
