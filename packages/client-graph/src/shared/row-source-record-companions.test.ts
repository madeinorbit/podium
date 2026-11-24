import '../workflow-models'
import { createReplicaFixture } from '@podium/client-core/test-support/replica'
import { subscriptionRowId, workflowBindingRowId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createWorklistPool } from '../create'
import { fullDevice } from '../full-device-fixture'
import { requireHere } from '../lookup'
import { requireLoaded } from '../mission-view'
import { fixedLocals } from './locals-source'
import { createRowSource } from './row-source'

const stamp = '2026-11-10T00:00:00Z'
const examples = [
  {
    entity: 'issuePanelTodo',
    kind: 'issuePanelTodos',
    id: 'todo',
    row: { id: 'todo', issueId: 'issue', position: 0, text: 'Check reload', done: false },
  },
  {
    entity: 'issuePanelArtifact',
    kind: 'issuePanelArtifacts',
    id: 'artifact',
    row: { id: 'artifact', issueId: 'issue', position: 0, path: 'proof.png', addedAt: stamp },
  },
  {
    entity: 'issuePanelDeferred',
    kind: 'issuePanelDeferreds',
    id: 'deferred',
    row: { id: 'deferred', issueId: 'issue', position: 0, text: 'Later work' },
  },
  {
    entity: 'issuePanelState',
    kind: 'issuePanelStates',
    id: 'issue',
    row: { id: 'issue', text: 'Ready to review', updatedAt: stamp },
  },
  {
    entity: 'agentProfile',
    kind: 'agentProfiles',
    id: 'profile',
    row: { id: 'profile', name: 'Review agent' },
  },
  {
    entity: 'workflow',
    kind: 'workflows',
    id: 'workflow',
    row: { id: 'workflow', name: 'Review workflow', archivedAt: null },
  },
  {
    entity: 'workflowRevision',
    kind: 'workflowRevisions',
    id: 'revision',
    row: { id: 'revision', workflowId: 'workflow', publishedAt: stamp },
  },
  {
    entity: 'workflowBinding',
    kind: 'workflowBindings',
    id: workflowBindingRowId('issue', 'issue'),
    row: { targetKind: 'issue', targetId: 'issue', revisionId: 'revision' },
  },
  {
    entity: 'workflowRun',
    kind: 'workflowRuns',
    id: 'run',
    row: { id: 'run', revisionId: 'revision', status: 'active', steps: [] },
  },
  {
    entity: 'subscription',
    kind: 'subscriptions',
    id: subscriptionRowId('session', 'session', 'subscription'),
    row: { id: 'subscription', subscriberKind: 'session', subscriberId: 'session', enabled: true },
  },
] as const

function fixture(replace: boolean) {
  const replica = createReplicaFixture()
  replica.applySnapshot('issueProjections', [
    {
      id: 'issue',
      title: 'Snapshot evidence',
      stage: 'in_progress',
      createdAt: stamp,
      updatedAt: stamp,
    } as never,
  ])
  for (const example of examples) replica.applySnapshot(example.kind, [example.row as never])
  const feed = createRowSource({ principal: { userId: 'viewer' } }, replica, {
    pending: { byRow: () => new Map() },
  })
  const handle = createWorklistPool(
    feed.source,
    fixedLocals({ selectedIssueId: null, coarseNow: 0 }).source,
  )
  if (replace) {
    // First make every record known through the ordinary update path. A later
    // full snapshot must preserve them without waiting for another item edit.
    for (const example of examples) replica.applyChanges(example.kind, [example.row as never], [])
    feed.flush()
    replica.applySnapshot('issuePanelArtifacts', [examples[1].row as never])
    feed.flush()
  }
  return {
    pool: fullDevice(handle.pool),
    dispose() {
      handle.dispose()
      feed.dispose()
    },
  }
}

describe.each([false, true])('record companions after a snapshot (replacement=%s)', (replace) => {
  it.each(examples)('$entity remains in the source-backed model population', (example) => {
    const f = fixture(replace)
    try {
      const model = requireHere(f.pool.model(example.entity, example.id))
      const { id: _wireId, ...fields } = example.row as Record<string, unknown>
      expect(model.row).toMatchObject({ ...fields, id: example.id })
    } finally {
      f.dispose()
    }
  })

  it('the issue model exposes its attachment, todo, deferral and state immediately', () => {
    const f = fixture(replace)
    try {
      const issue = f.pool.issueObject('issue')
      expect(requireLoaded(issue.panelArtifacts).map((artifact) => artifact.path)).toEqual([
        'proof.png',
      ])
      expect(requireLoaded(issue.panelTodos).map((todo) => [todo.text, todo.done])).toEqual([
        ['Check reload', false],
      ])
      expect(requireLoaded(issue.panelDeferred).map((item) => item.text)).toEqual(['Later work'])
      expect(issue.activityNotes).toBe('Ready to review')
    } finally {
      f.dispose()
    }
  })
})
