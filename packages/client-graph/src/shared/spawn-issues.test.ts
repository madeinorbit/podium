import { expect, it } from 'vitest'
import { createReaderIndex } from './reader-questions'
import type { RowRecord } from './source'

const issue = (id: string, repoPath: string, repoId?: string, extra: object = {}): RowRecord => ({
  kind: 'issue', id, value: { id, repoPath, repoId, archived: false, ...extra } as RowRecord['value'],
})

it('keeps archived ordering candidates and matches stable repo identity across machine paths', () => {
  const index = createReaderIndex()
  index.apply({ type: 'replace', rows: [
    issue('remote', '/other-machine', 'repo', { archived: true }),
    issue('path-only', '/local'),
    issue('different-repo', '/local', 'elsewhere'),
    issue('deleted', '/local', 'repo', { deletedAt: '2026-10-04T00:00:00Z' }),
    issue('outside', '/outside'),
  ] })
  expect(index.ids({ kind: 'spawnIssues', repoPath: '/local', repoId: 'repo' }).sort()).toEqual(['path-only', 'remote'])
  expect(index.ids({ kind: 'spawnIssues', repoPath: '/local' })).toEqual(['path-only'])
  index.apply({ type: 'update', rows: [issue('remote', '/other-machine', 'elsewhere')] })
  expect(index.ids({ kind: 'spawnIssues', repoPath: '/local', repoId: 'repo' })).toEqual(['path-only'])
})
