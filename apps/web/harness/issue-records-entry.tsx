/**
 * AN ISSUE PAGE WHOSE BRIEF AND DESCRIPTION COME FROM THEIR OWN RECORDS (POD-6921).
 *
 * The replica holds the slim issue record, which carries no body fields, and
 * the issue's `issueBrief` and `issueDescription` records beside it, as the
 * start-up load delivers them. Nothing paints a text on the row and there is no
 * fetch: the shipping `IssuePage` reads the pool's `IssueModel`, whose `brief`
 * and `description` follow those two records. A third issue with no body
 * records shows the empty description placeholder.
 *
 * `?issue=empty` opens the issue without bodies.
 */
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import type { PodiumClientApi } from '@podium/client-core/api'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { ClientRuntime } from '@podium/client-core/runtime-root'
import { createReplicaFixture } from '@podium/client-core/test-support/replica'
import { asIssueId, asUserId, withoutIssueBodies } from '@podium/model/browser'
import { createRoot } from 'react-dom/client'
import { OperatorFocusProvider } from '@/app/operator-focus'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IssuePage } from '@/features/issues/IssuePage'
import { ConfirmProvider } from '@/lib/hooks/use-confirm'
import { makeIssue } from '@/lib/test-issue'
import '@/index.css'
import '@/styles.css'

const userId = asUserId('records-viewer')
const now = new Date().toISOString()
const withBodies = asIssueId('records-issue')
const withoutBodies = asIssueId('records-empty')
const slim = (id: string, seq: number, title: string): IssueViewModel =>
  // The synced issue record: no brief, description, panel or notes on it.
  withoutIssueBodies(
    makeIssue({
      id,
      seq,
      title,
      stage: 'in_progress',
      repoId: 'fixture-repo',
      repoPath: '/workspace',
      worktreePath: '/workspace',
      branch: `issue/${seq}`,
      parentBranch: 'integrate/6253-sync-log',
      owner: userId,
      createdAt: now,
      updatedAt: now,
    }),
  ) as IssueViewModel

const replica = createReplicaFixture()
replica.applySnapshot('repos', [
  { id: 'fixture-repo', repoPath: '/workspace', prefix: 'POD' } as never,
])
replica.applySnapshot('issueProjections', [
  slim(withBodies, 6921, 'Issue bodies as records') as never,
  slim(withoutBodies, 6922, 'An issue with no bodies') as never,
])
replica.applySnapshot('issueDescriptions', [
  {
    id: withBodies,
    text: "This description is the issue's own synced record, issueDescription, loaded at start with everything else. The issue record beside it carries no body fields.",
  },
])
replica.applySnapshot('issueBriefs', [
  {
    id: withBodies,
    text: 'BRIEF FROM ITS OWN RECORD (issueBrief).\n\nKeyed by the issue id, holding the whole text. No header, no fetch by id, no client body store.',
  },
])

const api = {
  settings: { get: { query: async () => ({}) } },
  quota: { summary: { query: async () => [] } },
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
  return attachWorklistPool(runtime, (error) => {
    throw error
  })
}

const shown =
  new URLSearchParams(location.search).get('issue') === 'empty' ? withoutBodies : withBodies
const root = document.getElementById('root')
if (!root) throw new Error('Missing harness root')
createRoot(root).render(
  <StoreProvider
    principal={asClientPrincipal(userId)}
    config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
    api={api}
    createReplicaFn={() => replica}
    routerWindow={createMemoryRouterWindow()}
    networkEnabled={false}
    attachRuntime={attach}
    onFatalError={(error) => {
      throw error
    }}
  >
    <ConfirmProvider>
      <TooltipProvider>
        <OperatorFocusProvider missionId={null}>
          <main style={{ padding: 24, height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <section style={{ flex: 1, minHeight: 0, border: '1px solid var(--border)' }}>
              <IssuePage
                issue={{ id: shown } as unknown as IssueViewModel}
                orderedIds={[withBodies, withoutBodies]}
                onBack={() => {}}
                onNavigate={() => {}}
              />
            </section>
          </main>
        </OperatorFocusProvider>
      </TooltipProvider>
    </ConfirmProvider>
  </StoreProvider>,
)
