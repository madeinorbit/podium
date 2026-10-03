/** Foreground, focused planted failures; private flatblock checkout only. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'

if (hostname() !== 'flatblock' || !process.cwd().endsWith('/podium-test-5080')) throw new Error('Private flatblock checkout required')
const root = resolve('.artifacts/issue-board/controls')
mkdirSync(root, { recursive: true })
const source = 'packages/client-graph/src/issue-board-source.ts'
const test = 'packages/client-graph/src/issue-board-source.test.ts'
const cases = [
  { name: 'virtual-window', file: source, test, title: 'keeps rich card', from: 'options.windowed ? options.addressed ?? [] :', to: 'false ? options.addressed ?? [] :' },
  { name: 'virtual-child-summary', file: source, test, title: 'derives a virtual card', from: 'if (!row.archived && !row.deletedAt && scoped(row, options.agents ?? false, true))', to: 'if (false)' },
  { name: 'addressed-close-roster', file: 'apps/web/src/features/issues/use-issue-status-apply.tsx', test: 'apps/web/src/features/issues/board-pool-hooks.test.tsx', title: 'uses addressed pool', from: 'const addressed = sessionsForIssue?.(issue)', to: 'const addressed = []' },
  { name: 'initial-projection', file: 'packages/client-graph/src/issue-board-projection.ts', test: 'packages/client-graph/src/issue-board-projection.test.ts', title: 'derives once', from: 'getSnapshot() { start(); return snapshot }', to: 'getSnapshot() { start(); const value = snapshot; clear(); return value }' },
  { name: 'abandoned-projection', file: 'packages/client-graph/src/issue-board-projection.ts', test: 'packages/client-graph/src/issue-board-projection.test.ts', title: 'releases an abandoned', from: 'queueMicrotask(() => { if (!listeners.size) clear() })', to: 'queueMicrotask(() => {})' },
  { name: 'projection-release', file: 'packages/client-graph/src/issue-board-projection.ts', test: 'packages/client-graph/src/issue-board-projection.test.ts', title: 'derives once', from: 'stop?.(); stop = undefined; snapshot = undefined', to: 'stop = undefined; snapshot = undefined' },
  { name: 'epic-progress', file: source, test: 'apps/web/src/features/issues/board-pool-parity.test.ts', title: 'matches legacy', from: "if (pool.graph.many('issue', id, 'treeChildren')[Symbol.iterator]().next().done) return null", to: 'if (true) return null' },
  { name: 'unmount-release', file: source, test, title: 'releases demanded', from: 'onBecomeUnobserved(value, () => cache.delete(key))', to: 'onBecomeUnobserved(value, () => {})' },
  { name: 'summary-only', file: source, test, title: 'uses declared cold', from: "const row = pool.row('issue', id, 'summary')", to: "const row = pool.row('issue', id)" },
  { name: 'passive-membership', file: source, test, title: 'uses declared cold', from: 'pool.tables.issue.has(id) ? memo', to: "pool.resident('issue', id) === 'resident' ? memo" },
  { name: 'agent-default', file: 'packages/client-graph/src/issue-board-schema.ts', test, title: 'uses declared cold', from: ", 'defaultAgent'", to: '' },
  { name: 'loading-boundary', file: source, test, title: 'answers a missing summary', from: 'if (!value || value === LOADING) return value', to: 'if (!value || value === LOADING) return undefined' },
  { name: 'resident-scaling', file: source, test, title: 'stage changes examine', from: 'const result = intersection(filters)', to: "const result = new Set(bucket('all')); countIssueBoard('residentCandidates', result.size)" },
  { name: 'pending-overlay', file: source, test, title: 'updates overlays', from: "const row = pool.row('issue', id, 'summary')", to: "const row = pool.tables.issue.get(id) ?? pool.row('issue', id, 'summary')" },
  { name: 'resident-release', file: source, test, title: 'updates overlays', from: "if (change.type === 'delete')", to: 'if (false)' },
  { name: 'vacated-review', file: source, test, title: 'keeps an empty review', from: 'issueIsActionable(attention,', to: 'issueIsActionable(row,' },
  { name: 'opaque-parent', file: source, test, title: 'preserves an opaque parent', from: "pool.graph.one('issue', id, 'treeParent') ?? raw.parentId", to: "pool.graph.one('issue', id, 'treeParent') ?? undefined" },
  { name: 'row-values', file: source, test: 'apps/web/src/features/issues/board-pool-parity.test.ts', title: 'matches legacy', from: 'return { ...fields, id: asIssueId(id), description:', to: 'return { ...fields, priority: 99, id: asIssueId(id), description:' },
  { name: 'mismatch-detector', file: 'packages/client-graph/diagnostics/issue-board-check.ts', test: 'packages/client-graph/diagnostics/issue-board-check.test.ts', title: 'detects a planted', from: 'const field = issuePageFirstDifference(expected, actual)', to: 'const field = null' },
  { name: 'legacy-read-fence', file: 'apps/web/src/features/issues/board-pool-data.ts', test: 'apps/web/src/features/issues/board-pool-hooks.test.tsx', title: 'keeps board-only', from: "boardDataLayer() === 'pool' ? usePoolBase : useLegacyBase", to: "boardDataLayer() === 'pool' ? useLegacyBase : useLegacyBase" },
  { name: 'legacy-positive-counter', file: 'packages/client-core/src/perf/issue-board-perf.ts', test: 'apps/web/src/features/issues/board-pool-hooks.test.tsx', title: 'records actual legacy', from: 'countIssueBoard(`legacy.${name}`)', to: '// planted: omit the counter' },
  { name: 'bulk-session-fence', file: 'apps/web/src/features/issues/issue-lifecycle.tsx', test: 'apps/web/src/features/issues/board-pool-hooks.test.tsx', title: 'keeps the pool bulk-close', from: 'const sessions = useBulkCloseSessions(suppliedSessions)', to: 'const sessions = useLegacyBulkCloseSessions(suppliedSessions)' },
  { name: 'default-off', file: 'apps/web/src/features/issues/board-pool-screen.ts', test: 'apps/web/src/features/issues/board-pool-screen.test.ts', title: 'latches the independent', from: "enabled: () => issueBoardSwitch.layer() === 'pool'", to: 'enabled: () => true' },
]
const git = (...args: string[]) => execFileSync('git', ['-c', 'gc.auto=0', ...args], { stdio: 'pipe' })
const reports: { name: string; status: number | null; assertion: boolean; restored: boolean }[] = []
for (const control of cases) {
  const path = resolve(control.file), original = readFileSync(path, 'utf8'), aside = resolve(root, `${control.name}.aside`)
  if (!original.includes(control.from)) throw new Error(`Control target missing: ${control.name}`)
  git('commit', '--allow-empty', '-m', `wip(board): before ${control.name} plant`)
  copyFileSync(path, aside)
  try {
    writeFileSync(path, original.replace(control.from, control.to))
    git('add', control.file); git('commit', '-m', `wip(board): planted ${control.name} run`)
    const run = spawnSync(process.execPath, ['run', 'test:file', '--', control.test, '-t', control.title], { encoding: 'utf8', timeout: 120_000, maxBuffer: 12_000_000 })
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    const assertion = /AssertionError/.test(output) && /[1-9]\d* failed/.test(output)
    reports.push({ name: control.name, status: run.status, assertion, restored: false })
    if (run.status !== 1 || !assertion) { writeFileSync(resolve(root, `${control.name}.log`), output); throw new Error(`Control did not fail an assertion: ${control.name}`) }
  } finally {
    copyFileSync(aside, path); rmSync(aside)
    git('add', control.file); git('commit', '-m', `wip(board): restored ${control.name}`)
    if (reports.at(-1)?.name === control.name) reports.at(-1)!.restored = readFileSync(path, 'utf8') === original
    writeFileSync(resolve(root, 'report.json'), JSON.stringify(reports, null, 2))
  }
  console.log(JSON.stringify(reports.at(-1)))
}
if (reports.some(report => !report.restored)) throw new Error('Restoration failed')
