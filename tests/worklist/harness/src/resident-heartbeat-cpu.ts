/** Bounded apply-only CPU replay. Run with checkout-local Bun on flatblock:
 * bun --conditions=@podium/source tests/worklist/harness/src/resident-heartbeat-cpu.ts
 * Optional --cpu-prof captures the same 3,000-heartbeat workload; no operator data. */
import { autorun } from 'mobx'
import { MobxPool } from '../../../../packages/client-graph/src/pool'
import type { RowRecord } from '../../../../packages/client-graph/src/shared/source'

const old = '2026-10-01T00:00:00.000Z'
const pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(old) })
const sessions = Array.from({ length: 512 }, (_, i) => ({
  sessionId: `session-${i}`, cwd: `/repo/worktree-${i % 32}/nested`, issueId: `issue-${i % 128}`,
  agentKind: 'codex', status: 'live', archived: false, headless: false,
  machineId: 'machine', refRepoId: 'repo', refSeq: i + 1, refLetter: 'a',
  createdAt: old, lastActiveAt: old,
}))
pool.apply({ type: 'replace', rows: sessions.map(value => ({ kind: 'session', id: value.sessionId, value })) as RowRecord[] })
const stops = [
  autorun(() => { void pool.queries.ids({ kind: 'inboxSessions' }) }),
  autorun(() => { void pool.queries.ids({ kind: 'headerRecentSession' }) }),
  autorun(() => { void pool.queries.activity({ kind: 'commandRootActivity', roots: ['/repo'] }) }),
  autorun(() => { void pool.queries.latestMachineSession(['machine']) }),
  autorun(() => { void pool.queries.setupDefaultAgent() }),
]
const heartbeats = Array.from({ length: 3000 }, (_, i) => ({ type: 'update' as const,
  rows: [{ kind: 'session', id: 'session-0', value: { ...sessions[0],
    lastActiveAt: new Date(Date.parse(old) + (i + 1) * 1000).toISOString(),
  } } as RowRecord],
}))
try {
  const before = pool.queries.residentUpdates
  const cpu = process.cpuUsage(), start = performance.now()
  for (const event of heartbeats) pool.apply(event)
  const wallMs = performance.now() - start, used = process.cpuUsage(cpu)
  const delta = Object.fromEntries(Object.entries(pool.queries.residentUpdates)
    .map(([key, count]) => [key, count - before[key as keyof typeof before]]))
  const latest = Date.parse(old) + heartbeats.length * 1000
  if (pool.queries.activity({ kind: 'commandRootActivity', roots: ['/repo'] }) !== latest)
    throw new Error('Heartbeat activity became stale')
  if (pool.queries.ids({ kind: 'headerRecentSession' })[0] !== 'session-0')
    throw new Error('Heartbeat recency became stale')
  console.log(JSON.stringify({ sessions: sessions.length, heartbeats: heartbeats.length,
    wallMs, cpuMs: (used.user + used.system) / 1000, userMs: used.user / 1000,
    systemMs: used.system / 1000, residentUpdates: delta }))
} finally { for (const stop of stops) stop(); pool.dispose() }
