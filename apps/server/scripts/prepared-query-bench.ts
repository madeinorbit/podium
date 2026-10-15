/**
 * MICRO-BENCHMARK: THE THREE HOT PRIMARY-KEY READS, IN AND OUT OF A TRANSACTION
 * [POD-6147].
 *
 * What it times: one repository call each of `sessions.getSession(id)`,
 * `users.get(id)` and `issues.getIssue(id)` on a store built the way production
 * builds one (`openTestStore`, an in-memory database through the real executor).
 * Every call reads a row that exists, so the row mapper runs too.
 *
 *   - OUTSIDE: each call at the root, the hot path.
 *   - INSIDE: `TX_ROUNDS` transactions of `PER_TX` calls each. Many short
 *     transactions rather than one long one, because before POD-6147 each
 *     transaction carried its own drizzle instance and re-prepared its queries:
 *     a single long transaction would hide that cost.
 *
 * The account read has a per-read-scope cache in front of it; each call asks for
 * a different one of `USERS` seeded accounts, so the cache never answers.
 *
 * It uses only repository APIs that exist on both sides of the change, so the
 * same file runs against the parent commit and the candidate. Output is one JSON
 * line: median and p90 microseconds per call for each (read, place) pair, over
 * `SAMPLES` timed batches after a warm-up.
 *
 *   bun --conditions=@podium/source apps/server/scripts/prepared-query-bench.ts [--label <name>]
 */

import { asSessionId, asUserId } from '@podium/model'
import { users } from '../src/migrations/schema'
import { issueRowFixture } from '../src/test-support/issue-row'
import { openTestStore } from '../src/test-support/open-test-store'

const BATCH = 200
const SAMPLES = 25
const TX_ROUNDS = 20
const PER_TX = 10
const USERS = 64

const label = process.argv.includes('--label')
  ? process.argv[process.argv.indexOf('--label') + 1]
  : undefined

interface Queries {
  rootDb: { insert: (table: typeof users) => { values: (v: object) => { run: () => Promise<unknown> } } }
  createOrJoinTransaction: <T>(fn: () => Promise<T>) => Promise<T>
}

const store = await openTestStore(':memory:')
const queries = (store as unknown as { queries: Queries }).queries

const SESSION = asSessionId('bench-session')
await store.sessions.upsertSession({
  id: SESSION,
  ownerUserId: asUserId('user:bench-0'),
  agentKind: 'claude-code',
  cwd: '/bench',
  title: 'bench',
  name: null,
  nameSource: null,
  originKind: 'spawn',
  conversationId: null,
  resumeKind: null,
  resumeValue: null,
  status: 'live',
  exitCode: null,
  spawnFailure: null,
  durableLabel: 'bench',
  createdAt: '2026-10-15T00:00:00.000Z',
  lastActiveAt: '2026-10-15T00:00:00.000Z',
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: 'machine-bench' as never,
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
})
const userIds = Array.from({ length: USERS }, (_, i) => asUserId(`user:bench-${i}`))
for (const id of userIds) {
  await queries.rootDb
    .insert(users)
    .values({ id, displayName: id, role: 'member', createdAt: '2026-10-15T00:00:00.000Z', disabledAt: null })
    .run()
}
const ISSUE = 'iss_bench'
await store.issues.upsertIssue(
  issueRowFixture({ id: ISSUE, parentId: null, supersededBy: null, duplicateOf: null }),
)
if (!(await store.issues.getIssue(ISSUE))) throw new Error('the seeded issue did not read back')
if (!(await store.sessions.getSession(SESSION))) throw new Error('the seeded session did not read back')
if (!(await store.users.get(userIds[0]!))) throw new Error('the seeded account did not read back')

let u = 0
const reads: Record<string, () => Promise<unknown>> = {
  'sessions-by-id': async () => await store.sessions.getSession(SESSION),
  'users-by-id': async () => await store.users.get(userIds[u++ % USERS]!),
  'issue-by-id': async () => await store.issues.getIssue(ISSUE),
}

const usPerCall = async (place: 'outside' | 'inside', read: () => Promise<unknown>) => {
  const started = performance.now()
  if (place === 'outside') {
    for (let i = 0; i < BATCH; i++) await read()
    return ((performance.now() - started) * 1000) / BATCH
  }
  for (let t = 0; t < TX_ROUNDS; t++) {
    await queries.createOrJoinTransaction(async () => {
      for (let i = 0; i < PER_TX; i++) await read()
    })
  }
  return ((performance.now() - started) * 1000) / (TX_ROUNDS * PER_TX)
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

const result: Record<string, { medianUs: number; p90Us: number }> = {}
for (const [name, read] of Object.entries(reads)) {
  for (const place of ['outside', 'inside'] as const) {
    for (let w = 0; w < 3; w++) await usPerCall(place, read) // warm-up
    const samples: number[] = []
    for (let s = 0; s < SAMPLES; s++) samples.push(await usPerCall(place, read))
    result[`${name}/${place}`] = {
      medianUs: Number(quantile(samples, 0.5).toFixed(2)),
      p90Us: Number(quantile(samples, 0.9).toFixed(2)),
    }
  }
}

console.log(JSON.stringify({ label, at: new Date().toISOString(), batch: BATCH, samples: SAMPLES, result }))
await store.close()
process.exit(0)
