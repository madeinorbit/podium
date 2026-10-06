/** POD-5437: private payloads remain on ludovico; emit numeric counts only. */
import { spawn } from 'node:child_process'
import { hostname } from 'node:os'

if (hostname() !== 'ludovico') throw new Error('Counts replay requires ludovico')
const lanes = [
  ['sidebar', 'tests/worklist/harness/src/oracle/sidebar-replay.ts', '--live'],
  ['mission', 'tests/worklist/harness/src/oracle/mission-view-replay.ts'],
  ['issuePage', 'tests/worklist/harness/src/oracle/issue-page-replay.ts'],
  ['session', 'packages/client-graph/diagnostics/session-pane-replay.ts'],
  ['board', 'apps/web/harness/issue-board-replay.ts'],
] as const
const fields = new Set([
  'issues',
  'sessions',
  'rows',
  'sections',
  'positions',
  'selections',
  'roots',
  'comparisons',
  'differences',
  'pending',
  'acceptedDeadlineDifferences',
  'acceptedOwnershipDifferences',
  'residentBefore',
  'residentAfter',
  'cold',
  'multipleMatches',
  'differentTies',
  'failed',
])
function counts(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object') return {}
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      fields.has(key) && typeof value === 'number'
        ? [[key, value]]
        : key === 'normalizedOnly'
          ? Object.entries(counts(value))
          : [],
    ),
  )
}
for (const [screen, script, ...args] of lanes) {
  const report = await new Promise<{ exitCode: number | null; reports: Record<string, number>[] }>(
    (resolve) => {
      const child = spawn(process.execPath, ['--conditions=@podium/source', script, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (bytes) => {
        output += bytes.toString()
      })
      child.stderr.on('data', () => {})
      child.on('exit', (exitCode) => {
        const reports = output.split('\n').flatMap((line) => {
          try {
            const safe = counts(JSON.parse(line))
            return Object.keys(safe).length ? [safe] : []
          } catch {
            return []
          }
        })
        resolve({ exitCode, reports })
      })
    },
  )
  console.log(JSON.stringify({ screen, ...report }))
  if (report.exitCode || !report.reports.length) process.exitCode = 1
}
