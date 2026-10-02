import { asIssueId, asUserId, issueUserStateRowId } from '@podium/model'
import { createSidebarFixture } from './sidebar-fixture'

// Canonical projections do not carry the compatibility/per-user fields below.
// Command echoes update the dedicated marker/git records alongside projections.
const compatibilityFields = new Set([
  'readAt',
  'pinned',
  'tuckedAt',
  'gitState',
  'repoPath',
  'commentCount',
  'unread',
  'deps',
  'dependents',
  'sessions',
  'sessionSummary',
  'comments',
  'childCount',
  'childDoneCount',
  'ready',
  'blocked',
  'deferred',
  'origin',
  'draft',
])

export function createSidebarActionsFixture(count = 12, now = Date.now(), simple = false) {
  const fixture = createSidebarFixture(count, now, simple, 'sidebar-pool-actions')
  for (const [key, record] of fixture.records) {
    if (record.entity !== 'issueProjection') continue
    const value = { ...(record.value as Record<string, unknown>) }
    for (const field of compatibilityFields) delete value[field]
    const normalized = { ...record, value }
    fixture.records.set(key, normalized)
    fixture.replica.onKernelEvent({ type: 'upserted', record: normalized, readmitted: false })
  }
  return Object.assign(fixture, {
    patchIssue(id: string, patch: Record<string, unknown>) {
      const markers = Object.fromEntries(Object.entries(patch).filter(([field]) => ['readAt', 'tuckedAt', 'pinned'].includes(field)))
      if (Object.keys(markers).length) fixture.patch('issueUserState', issueUserStateRowId(asUserId('sidebar-pool-actions'), asIssueId(id)), markers)
      if (patch.gitState && typeof patch.gitState === 'object') fixture.patch('issueGitState', id, patch.gitState as Record<string, unknown>)
      fixture.patch(
        'issueProjection',
        id,
        Object.fromEntries(
          Object.entries(patch).filter(([field]) => !compatibilityFields.has(field)),
        ),
      )
    },
  })
}
