/** Flatblock planted production faults, one per new check. Every original is
 * restored in finally. A red must collect a failing test, not fail to import. */

import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'

if (hostname() !== 'flatblock') throw new Error('Controls belong on flatblock')
const views = 'packages/client-graph/src/mobile-inbox-views.ts',
  hooks = 'apps/mobile/src/client/use-inbox-data.ts',
  source = 'packages/client-graph/src/mobile-inbox-source.ts',
  links = 'apps/mobile/src/lib/podium-link.ts'
const controls = [
  [
    'rendered phone',
    views,
    'outboxSize: window?.outboxSize ?? 0',
    'outboxSize: (window?.outboxSize ?? 0) + 7',
  ],
  [
    'zero legacy selectors',
    hooks,
    'export function useInboxData(): InboxData {',
    'export function useInboxData(): InboxData { useIssues()',
  ],
  [
    'compares every card',
    'packages/client-graph/diagnostics/mobile-inbox-check.ts',
    'differences: result.differences',
    'differences: 0',
  ],
  [
    'compares every card',
    views,
    'pending: prefixes === LOADING || model === LOADING',
    'pending: true',
  ],
  ['decided deck order', hooks, 'decided = order.slice(0, index)', 'decided = order.slice(0, 0)'],
  ['reads cold refs', views, 'pool.references.read(token)', 'null'],
  [
    'routes issue and permanent',
    views,
    '`/session/${encodeURIComponent(row.sessionId)}`',
    '`/wrong-session/${encodeURIComponent(row.sessionId)}`',
  ],
  [
    'updates pulse machines',
    hooks,
    'const readHosts = (pool: Pool) => pool.headerViews.metrics()',
    'const readHosts = (pool: Pool) => []',
  ],
  [
    'coalesces readiness',
    source,
    'if (this.scheduled || this.disposed) return',
    'if (this.disposed) return',
  ],
  ['original outbox pending', views, 'outboxSize: window?.outboxSize ?? 0', 'outboxSize: 0'],
  [
    'switch-off link activator',
    links,
    'const answer = activator?.(link.target)',
    'const answer = Promise.resolve(activator?.(link.target))',
  ],
  [
    'cold not-found OS fallback',
    links,
    'if (answer instanceof Promise) {',
    'if (answer instanceof Promise) { fallback()',
  ],
  ['early reference tap', hooks, 'waiting.current.add({ target: next, resolve })', 'resolve(null)'],
  [
    'first replica owner',
    'packages/client-graph/src/issue-reference.ts',
    'this.resident.get(key)?.[0]',
    'this.resident.get(key)?.at(-1)',
  ],
  [
    'earlier cold alias owner',
    'packages/client-graph/src/runtime-pool.ts',
    'rows.source.issueIdsByRef!(ref)[0]',
    'rows.source.issueIdsByRef!(ref).at(-1)',
  ],
  [
    'kernel alias claimants',
    'packages/client-core/src/replica/kernel/issue-ref-index.ts',
    '.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)',
    '.sort((a, b) => a > b ? -1 : a < b ? 1 : 0)',
    'packages/client-core/src/replica/kernel/issue-ref-index.test.ts',
  ],
  [
    'triage bucket',
    views,
    'summary.archived || summary.headless || summary.agentKind',
    'summary.archived || false || summary.agentKind',
  ],
  ['screening ancestor', views, '!underProposal(issue)', 'true'],
  [
    'card, triage',
    views,
    'a.priority - b.priority || b.seq - a.seq',
    'b.priority - a.priority || b.seq - a.seq',
  ],
  ['shares prefix work', views, 'prefixes.prefixes.includes(prefix)', 'true'],
  [
    'existing cursor subscription',
    source,
    'hasCursor = this.runtime.replica.getCursor() !== null',
    'hasCursor = false',
  ],
] as const
const fromArg = process.argv.indexOf('--from')
const from = fromArg < 0 ? 0 : controls.findIndex(([name]) => name === process.argv[fromArg + 1])
if (from < 0) throw new Error('Unknown starting control')
for (const control of controls.slice(from)) {
  const [name, path, needle, fault] = control
  const original = await readFile(path, 'utf8')
  if (!original.includes(needle) || original.indexOf(needle) !== original.lastIndexOf(needle))
    throw new Error(`Ambiguous control ${name}`)
  try {
    await writeFile(path, original.replace(needle, fault))
    const run = spawnSync(
      'bun',
      [
        'run',
        'test:file',
        '--',
        control[4] ?? 'apps/mobile/src/client/use-inbox-data.pool.test.tsx',
        '-t',
        name,
      ],
      { encoding: 'utf8', timeout: 120000, env: { ...process.env, NO_COLOR: '1' } },
    )
    const output = `${run.stdout}\n${run.stderr}`
    if (
      run.error ||
      run.status === 0 ||
      !/Tests\s+1 failed/.test(output) ||
      /Failed Suites/.test(output)
    ) {
      console.error(output)
      throw new Error(`Planted control failed to demonstrate a collected red: ${name}`)
    }
    console.log(JSON.stringify({ control: name, collectedRed: true }))
  } finally {
    await writeFile(path, original)
  }
}
