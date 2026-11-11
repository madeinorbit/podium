import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import type { PodiumClientApi } from '@podium/client-core/api'
import { knownReading } from '@podium/client-core/live'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { ClientRuntime } from '@podium/client-core/runtime-root'
import { machineRecords } from '@podium/client-core/test-support/machine-records'
import { createReplicaFixture } from '@podium/client-core/test-support/replica'
import { asIssueId, asSessionId, asUserId, type SessionMeta } from '@podium/model/browser'
import { runInAction } from 'mobx'
import { createRoot } from 'react-dom/client'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IssuePage } from '@/features/issues/IssuePage'
import { AgentPanel } from '@/features/terminal/AgentPanel'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import '@/index.css'
import '@/styles.css'

// A stored session without live fields. No server, terminal attach, or geometry
// response can repair the constructor's first grid in this layout fixture.
const sessionId = asSessionId('first-frame')
const userId = asUserId('first-frame-viewer')
const issueId = asIssueId('reload-issue')
const showIssue = new URLSearchParams(location.search).get('view') === 'issue'
const replica = createReplicaFixture()
const issue = makeIssue({
  id: issueId,
  seq: 6842,
  title: 'Saved review evidence',
  stage: 'review',
  repoId: 'fixture-repo',
  repoPath: '/workspace',
  worktreePath: '/workspace',
  owner: userId,
  description: 'This attachment was present in the snapshot before the page opened.',
})
replica.applySnapshot('repos', [
  { id: 'fixture-repo', repoPath: '/workspace', prefix: 'POD' } as never,
])
replica.applySnapshot('issueProjections', [issue as never])
replica.applySnapshot('issuePanelArtifacts', [
  {
    id: 'snapshot-artifact',
    issueId,
    position: 0,
    path: 'proof.md',
    title: 'Snapshot attachment',
    addedAt: new Date().toISOString(),
  } as never,
])
replica.applySnapshot('issuePanelTodos', [
  { id: 'snapshot-todo', issueId, position: 0, text: 'Reload evidence', done: true } as never,
])
replica.applySnapshot('issuePanelDeferreds', [
  {
    id: 'snapshot-deferred',
    issueId,
    position: 0,
    text: 'Later work stays visible after reload',
  } as never,
])
replica.applySnapshot('issuePanelStates', [
  {
    id: issueId,
    text: 'Review evidence survived the snapshot.',
    updatedAt: new Date().toISOString(),
  } as never,
])
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
  issues: {
    get: { query: async () => null },
    collaborators: { query: async () => [] },
    comments: { query: async () => [] },
    events: { query: async () => [] },
    mailInbox: { mutate: async () => [] },
  },
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
      <TooltipProvider>
        <OperatorFocusProvider missionId={null}>
          <main
            style={{
              padding: 24,
              height: '100vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <header>
              <h1 style={{ fontSize: 20 }}>
                {showIssue ? 'Reloaded issue page' : 'Terminal first frame'}
              </h1>
              <p id="first-frame-reading">
                {showIssue
                  ? 'Evidence loaded from the initial snapshot.'
                  : 'Waiting for the terminal constructor…'}
              </p>
              <p style={{ color: 'var(--text-dim)' }}>
                {showIssue
                  ? 'No incremental record update is sent. Reload must retain the attachment and deferred item.'
                  : 'Stored session has no geometry. Live session model: 132 × 43. Attach is disabled.'}
              </p>
            </header>
            <section style={{ flex: 1, minHeight: 0, border: '1px solid var(--border)' }}>
              {showIssue ? (
                <IssuePage
                  issue={issue as IssueViewModel}
                  orderedIds={[issueId]}
                  onBack={() => {}}
                  onNavigate={() => {}}
                />
              ) : (
                <AgentPanel sessionId={sessionId} />
              )}
            </section>
          </main>
        </OperatorFocusProvider>
      </TooltipProvider>
    </ConfirmProvider>
  </StoreProvider>,
)
