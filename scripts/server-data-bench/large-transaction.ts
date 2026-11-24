/**
 * POD-7587: captured writes in one large Postgres transaction, before and after the
 * driver re-plans as the transaction grows. Generated data on disposable stores, for an
 * agent VM only:
 * PODIUM_TEST_STORE_ENGINE=pg bun --conditions=@podium/source scripts/server-data-bench/large-transaction.ts
 * (it runs on SQLite too, where only the after and batches arms mean anything).
 *
 * Each arm seeds LARGE_TX_SESSIONS sessions (default 800), each with an observation lease
 * and an 11 KiB checkpoint as in the POD-7575 bench, on a fresh store, and times every
 * statement through the statement probe. Reported per arm: the whole seed; the time of
 * each successive 100 sessions (flat when the per-statement cost is); and per statement
 * family the mean time of its first and last fifth of executions.
 *
 * Arms, in one process:
 *  - before: every session in one `transact`, the driver never re-planning
 *    (`replanRowsWritten: null`, the driver before this issue);
 *  - after: the same with the driver's default re-planning;
 *  - batches: LARGE_TX_BATCH (250) sessions per `transact`, the POD-7575 workaround, with
 *    the default driver;
 *  - for diagnosis, named in LARGE_TX_ARMS (comma separated; `only,<arms>` runs just
 *    those), each one transaction without re-planning: `custom-plans` under
 *    `plan_cache_mode = force_custom_plan`, every execution planned for its parameters;
 *    `auto-explain` logging the executed plan of every statement slower than
 *    LARGE_TX_EXPLAIN_MS (default 50) to the server's log; `auto-explain-after` the
 *    same with the default re-planning.
 */
import '../../test-hermetic-env'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, firstAdminMemberId, type SessionId } from '@podium/model'
import type { SessionObservationCheckpointV1 } from '@podium/protocol'
import { fixtureWriteScope } from '@podium/sync/testing'
import type { SessionStore } from '../../apps/server/src/store'
import {
  probeStatements,
  type StatementProbeHolder,
} from '../../apps/server/src/store/executor/statement-probe'
import { TEST_MACHINE_ID } from '../../apps/server/src/test-support/machine-id'
import {
  openTestStore,
  testStoreLocation,
} from '../../apps/server/src/test-support/open-test-store'
import {
  connectPgTest,
  PG_TEST_URL_ENV,
  quotePgIdentifier,
  testStoreEngine,
} from '../../apps/server/src/test-support/pg-test-database'
import { pgBunTestRun } from '../../apps/server/src/test-support/pg-test-host'

const SESSIONS = Number(process.env.LARGE_TX_SESSIONS ?? 800)
const BATCH = Number(process.env.LARGE_TX_BATCH ?? 250)
const EXTRA_ARMS = (process.env.LARGE_TX_ARMS ?? '').split(',').filter((arm) => arm !== '')
const AT = '2026-11-24T00:00:00.000Z'

type Arm = 'before' | 'after' | 'batches' | 'custom-plans' | 'auto-explain' | 'auto-explain-after'

/** The arms that run on the driver's default re-planning; the others never re-plan. */
const REPLANNING: ReadonlySet<Arm> = new Set(['after', 'batches', 'auto-explain-after'])

const AUTO_EXPLAIN = [
  "session_preload_libraries = 'auto_explain'",
  `auto_explain.log_min_duration = ${Number(process.env.LARGE_TX_EXPLAIN_MS ?? 50)}`,
  'auto_explain.log_analyze = on',
  'auto_explain.log_buffers = on',
  'auto_explain.log_nested_statements = on',
]

/** Database settings an arm runs under, for diagnosis. */
const ARM_SETTINGS: Partial<Record<Arm, readonly string[]>> = {
  'custom-plans': ['plan_cache_mode = force_custom_plan'],
  // The executed plan of every statement slower than LARGE_TX_EXPLAIN_MS, in the server's log.
  'auto-explain': AUTO_EXPLAIN,
  'auto-explain-after': AUTO_EXPLAIN,
}

function checkpointOf(id: SessionId, n: number): SessionObservationCheckpointV1 {
  const segment = (tag: string) => `${tag}-${'0123456789abcdef'.repeat(256)}`
  return {
    schemaVersion: 1,
    podiumSessionId: id,
    provider: 'codex',
    providerSessionId: `thread-${id}`,
    bindingVersion: 1,
    lifecycleObservationGeneration: 1,
    providerCursor: { segmentId: segment('provider'), components: { file: n, line: n * 7 } },
    bootstrapCursor: { segmentId: segment('bootstrap'), components: { file: n } },
    lastAcceptedLiveCursor: { segmentId: `live-${n}`, components: { file: n } },
    turnEpoch: n % 17,
    providerTurnId: `turn-${n}`,
    providerPromptId: null,
    turnState: {
      phase: n % 3 === 0 ? 'working' : 'idle',
      since: AT,
      workingMsTotal: 60_000 + n,
      nativeSubagentCount: 0,
    },
    terminalFence: null,
    providerAt: AT,
    acceptedAt: AT,
    lastLiveReceiptAt: AT,
    lastTransitionId: `transition-${n}-31`,
    acceptedTransitionIds: Array.from(
      { length: 32 },
      (_, k) => `transition-${n}-${k}-${'x'.repeat(48)}`,
    ),
  }
}

async function writeSession(store: SessionStore, n: number, owner: string, machineId: string) {
  const id = asSessionId(`bench-${String(n).padStart(5, '0')}`)
  await store.sessions.upsertSession(fixtureWriteScope(), {
    id,
    ownerUserId: owner,
    agentKind: n % 2 ? 'codex' : 'claude-code',
    cwd: `/repo/.worktrees/issue-${n % 400}`,
    title: `Session ${n}`,
    name: null,
    nameSource: null,
    originKind: 'spawn',
    conversationId: null,
    resumeKind: null,
    resumeValue: null,
    status: n % 9 === 0 ? 'hibernated' : 'exited',
    exitCode: 0,
    spawnFailure: null,
    durableLabel: `label-${id}`,
    createdAt: new Date(Date.parse(AT) - (SESSIONS - n) * 60_000).toISOString(),
    lastActiveAt: AT,
    geometry: { cols: 120, rows: 40 },
    archived: n % 4 === 0,
    workState: null,
    machineId,
    lastOutputAt: null,
    lastInputAt: null,
    lastResumedAt: null,
    spawnedBy: null,
  } as never)
  await store.observationCheckpoints.advanceGeneration(id, 'codex', `thread-${id}`)
  await store.observationCheckpoints.save(checkpointOf(id, n))
}

/** Seed the store; returns the time of each successive 100 sessions. */
async function seed(store: SessionStore, perTransaction: number): Promise<number[]> {
  const per100: number[] = []
  let last = performance.now()
  const progress = (written: number) => {
    const now = performance.now()
    per100.push(Math.round(now - last))
    console.error(`  ${written} sessions, last 100 in ${Math.round(now - last)} ms`)
    last = now
  }
  const owner = await firstAdminMemberId(store)
  const machineId = store.hostMachine?.id ?? TEST_MACHINE_ID
  for (let from = 0; from < SESSIONS; from += perTransaction) {
    await store.transact(async () => {
      for (let n = from; n < Math.min(SESSIONS, from + perTransaction); n++) {
        await writeSession(store, n, owner, machineId)
        if ((n + 1) % 100 === 0) progress(n + 1)
      }
    })
  }
  return per100
}

interface Family {
  sql: string
  durations: number[]
}

interface ArmResult {
  arm: Arm
  seedMs: number
  /** Ms per successive 100 sessions. */
  per100Ms: number[]
  statements: number
  /** Mean ms of the first and last fifth of the seed's statements, all families together. */
  earlyMeanMs: number
  lateMeanMs: number
  families: {
    sql: string
    count: number
    totalMs: number
    earlyMeanMs: number
    lateMeanMs: number
    ratio: number
  }[]
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits
const fifths = (values: readonly number[]) => {
  const fifth = Math.max(1, Math.floor(values.length / 5))
  return { early: mean(values.slice(0, fifth)), late: mean(values.slice(-fifth)) }
}

async function runArm(arm: Arm, directory: string): Promise<ArmResult> {
  const path = join(directory, `${arm}.db`)
  const options = REPLANNING.has(arm) ? {} : { replanRowsWritten: null }
  let store = await openTestStore(path, TEST_MACHINE_ID, options)
  const settings = ARM_SETTINGS[arm]
  if (settings !== undefined) {
    // A database setting reaches every connection opened after it: reopen the store.
    const url = await testStoreLocation(path)
    const database = new URL(url).pathname.slice(1)
    await store.close()
    const admin = connectPgTest(process.env[PG_TEST_URL_ENV] ?? url)
    try {
      for (const setting of settings)
        await admin.unsafe(`ALTER DATABASE ${quotePgIdentifier(database)} SET ${setting}`)
    } finally {
      await admin.close()
    }
    store = await openTestStore(path, TEST_MACHINE_ID, options)
  }
  try {
    const families = new Map<string, Family>()
    const all: number[] = []
    const detach = probeStatements(store as unknown as StatementProbeHolder, (observation) => {
      let family = families.get(observation.key)
      if (family === undefined) {
        family = { sql: observation.sql, durations: [] }
        families.set(observation.key, family)
      }
      family.durations.push(observation.durationMs)
      all.push(observation.durationMs)
    })
    const started = performance.now()
    let per100Ms: number[]
    try {
      per100Ms = await seed(store, arm === 'batches' ? BATCH : SESSIONS)
    } finally {
      detach()
    }
    const seedMs = performance.now() - started
    const overall = fifths(all)
    return {
      arm,
      seedMs: Math.round(seedMs),
      per100Ms,
      statements: all.length,
      earlyMeanMs: round(overall.early),
      lateMeanMs: round(overall.late),
      families: [...families.values()]
        .filter((family) => family.durations.length >= 10)
        .map((family) => {
          const { early, late } = fifths(family.durations)
          return {
            sql: family.sql.replace(/\s+/g, ' ').slice(0, 240),
            count: family.durations.length,
            totalMs: Math.round(family.durations.reduce((sum, value) => sum + value, 0)),
            earlyMeanMs: round(early),
            lateMeanMs: round(late),
            ratio: round(early === 0 ? 0 : late / early, 2),
          }
        })
        .sort((a, b) => b.totalMs - a.totalMs),
    }
  } finally {
    await store.close()
  }
}

const cleanup = await pgBunTestRun()
const directory = await mkdtemp(join(tmpdir(), 'server-data-bench-large-transaction-'))
try {
  const arms: Arm[] =
    EXTRA_ARMS[0] === 'only'
      ? (EXTRA_ARMS.slice(1) as Arm[])
      : ['before', 'after', 'batches', ...(EXTRA_ARMS as Arm[])]
  const results: ArmResult[] = []
  for (const arm of arms) {
    const result = await runArm(arm, directory)
    results.push(result)
    console.error(`${arm}: ${result.seedMs} ms, ${result.statements} statements`)
  }
  console.log(
    JSON.stringify(
      {
        bench: 'large-transaction',
        // What the checkout under test is, when a run measures more than one (LARGE_TX_VARIANT).
        variant: process.env.LARGE_TX_VARIANT ?? 'head',
        engine: testStoreEngine(),
        sessions: SESSIONS,
        batch: BATCH,
        results,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
  await cleanup()
}
