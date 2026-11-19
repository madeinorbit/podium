/** Operator-sized SQLite search, using the same service and fixtures as POD-7089. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { firstAdminMemberId } from '@podium/model'
import { IssueStore } from '../../server/src/modules/issues/service/core'
import { type IssueReader, IssueReportsModule } from '../../server/src/modules/issues/service/reads'
import type { IssueDeps } from '../../server/src/modules/issues/service/types'
import { foldedDeps, rawSql, seededStore } from '../../server/src/test-support/issue-corpus'
import { sessionReadPorts } from '../../server/src/test-support/session-facts'

const out = process.argv[2]
if (!out || existsSync(out)) throw new Error('Give a fresh output JSON filename')
const corpus = JSON.parse(readFileSync('.artifacts/old-vs-new/corpus-operator.json', 'utf8'))
const issues = corpus.issues.map((issue: Record<string, unknown>) => ({
  ...issue,
  description:
    typeof issue['description'] === 'string'
      ? issue['description']
      : ((issue['description'] as { value?: string } | null)?.value ?? ''),
  worktreePath: issue['worktreePath'] ?? null,
}))
const store = await seededStore(
  issues,
  corpus.repos.map((repo: { path: string }) => repo.path),
  foldedDeps(corpus.issueDeps, new Set(issues.map((issue: { id: string }) => issue.id))),
)
try {
  rawSql(
    store,
    'UPDATE issues SET brief = ? || id',
    'Synthetic search brief. '.repeat(90) + 'unique-brief-token:',
  )
  const target = issues.find(
    (issue: { deletedAt?: string; archived?: boolean }) => !issue.deletedAt && !issue.archived,
  )!
  const reports = new IssueReportsModule(
    new IssueStore({ store, ...sessionReadPorts(() => []) } as unknown as IssueDeps),
  )
  const viewer = await firstAdminMemberId(store)
  const reader: IssueReader = { viewer: () => viewer, mayRead: async (id) => await reports.has(id) }
  const cases = [
    { name: 'no-match', text: 'no-such-search-token-7089' },
    { name: 'specific-title', text: target.title },
    { name: 'description', text: 'Body 71' },
    { name: 'brief', text: `unique-brief-token:${target.id}` },
    { name: 'broad-title', text: 're' },
  ]
  const results = []
  for (const query of cases) {
    // One page, as the clients ask for it (POD-7108); `more` says another follows.
    const input = { text: query.text, limit: 50 }
    const expected = await reports.searchNormalized(input, reader)
    const start = performance.now()
    const page = await reports.searchNormalized(input, reader)
    const elapsedMs = performance.now() - start
    if (page.hits.length !== expected.hits.length) throw new Error('Search population changed')
    results.push({ ...query, hits: page.hits.length, more: page.next !== null, elapsedMs })
  }
  mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true })
  const result = {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    cell: 'operator',
    issues: issues.length,
    engine: 'SQLite',
    results,
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  console.log('OPERATOR_SEARCH ' + JSON.stringify(result))
} finally {
  await store.close()
}
