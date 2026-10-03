/** Flatblock planted production faults, one per new check. Every original is
 * restored in finally. A red must collect a failing test, not fail to import. */
import { hostname } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

if (hostname() !== 'flatblock') throw new Error('Controls belong on flatblock')
const views = 'packages/client-graph/src/mobile-inbox-views.ts', hooks = 'apps/mobile/src/client/use-inbox-data.ts',
  source = 'packages/client-graph/src/mobile-inbox-source.ts', links = 'apps/mobile/src/lib/podium-link.ts'
const controls = [
  ['rendered phone', views, 'outboxSize: window?.outboxSize ?? 0', 'outboxSize: (window?.outboxSize ?? 0) + 7'],
  ['zero legacy selectors', hooks, 'export function useInboxData(): InboxData {', 'export function useInboxData(): InboxData { useIssues()'],
  ['compares every card', 'packages/client-graph/diagnostics/mobile-inbox-check.ts', 'differences: result.differences', 'differences: 0'],
  ['decided deck order', hooks, 'decided = order.slice(0, index)', 'decided = order.slice(0, 0)'],
  ['reads cold refs', views, 'pool.references.read(token)', 'null'],
  ['routes issue and permanent', views, '`/session/${encodeURIComponent(row.sessionId)}`', '`/wrong-session/${encodeURIComponent(row.sessionId)}`'],
  ['updates pulse machines', hooks, 'hosts: pool.headerViews.metrics()', 'hosts: []'],
  ['coalesces readiness', source, 'if (this.scheduled || this.disposed) return', 'if (this.disposed) return'],
  ['original outbox pending', views, 'outboxSize: window?.outboxSize ?? 0', 'outboxSize: 0'],
  ['switch-off link activator', links, 'const answer = activator?.(link.target)', 'const answer = Promise.resolve(activator?.(link.target))'],
  ['cold not-found OS fallback', links, 'if (answer instanceof Promise) {', 'if (answer instanceof Promise) { fallback()'],
] as const
for (const [name, path, needle, fault] of controls) {
  const original = await readFile(path, 'utf8')
  if (!original.includes(needle) || original.indexOf(needle) !== original.lastIndexOf(needle)) throw new Error(`Ambiguous control ${name}`)
  try {
    await writeFile(path, original.replace(needle, fault))
    const run = spawnSync('bun', ['run', 'test:file', '--', 'apps/mobile/src/client/use-inbox-data.pool.test.tsx', '-t', name],
      { encoding: 'utf8', timeout: 120000, env: { ...process.env, NO_COLOR: '1' } })
    const output = `${run.stdout}\n${run.stderr}`
    if (run.error || run.status === 0 || !/Tests\s+1 failed/.test(output) || /Failed Suites/.test(output)) {
      console.error(output); throw new Error(`Planted control failed to demonstrate a collected red: ${name}`)
    }
    console.log(JSON.stringify({ control: name, collectedRed: true }))
  } finally { await writeFile(path, original) }
}
