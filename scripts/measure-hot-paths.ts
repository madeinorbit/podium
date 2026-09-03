/**
 * HOT-PATH BASELINE — the four numbers every POD-3221 gate compares against
 * [POD-3243].
 *
 * ---------------------------------------------------------------------------
 * WHAT IT MEASURES, AND WHY THESE TWO QUANTITIES
 * ---------------------------------------------------------------------------
 *
 * The definition of done (spec §5.1, "Hot paths do not regress") gates the async
 * store conversion on two conserved quantities, measured before and after, with
 * a budget of "no increase":
 *
 *   1. QUERY COUNT PER REQUEST — on feed bootstrap and on issue frame reads.
 *      On Turso this is ROUND TRIPS PER REQUEST, which is why it is the number
 *      that sizes the batching and prefetch work rather than a duration. A
 *      duration moves with the machine and with load; the count is the defect.
 *   2. FRAMES PER BURST — on the boot reconcile and on a bind-storm fixture.
 *      `modules/funnel.ts` coalesces a synchronous burst of appends into ONE
 *      certified frame per connection. Awaits between those appends are exactly
 *      what would break the coalescing, and this conversion introduces awaits
 *      everywhere. Spec §5.1 requires this to equal one.
 *
 * ---------------------------------------------------------------------------
 * THE PROBE IS ONE INJECTABLE FUNCTION
 * ---------------------------------------------------------------------------
 *
 * Today the persistence seam is the synchronous `SqlDatabase` wrapper, and both
 * existing probes in the tree reach it the same way: `store-issues-frame-cache.test.ts`
 * patches `store.db.prepare`, `store/repos-read-cost.test.ts` wraps the handle in
 * a counting `SqlDatabase`. {@link sqlDatabaseQueryProbe} is that seam and
 * NOTHING ELSE IN THIS FILE KNOWS ABOUT IT — every measurement takes a
 * {@link QueryProbeFactory}. POD-3255 [0.13] moves the probe onto the client
 * drizzle runs on and re-captures the baseline there by passing a different
 * factory, with the drivers below unchanged.
 *
 * ---------------------------------------------------------------------------
 * IT COUNTS EXECUTIONS, NOT PREPARATIONS
 * ---------------------------------------------------------------------------
 *
 * `prepare()` is where the statement text is visible, but the round trip is
 * `run`/`get`/`all`. There is no prepared-statement cache in the repositories
 * (spec §2.2: every site is `this.db.prepare(sql).get(...)`), so today the two
 * counts coincide — and after the conversion they will not, because a cache is
 * one of the things being considered. Counting executions keeps the baseline
 * meaningful across that change.
 *
 * ---------------------------------------------------------------------------
 * THE GATE REFUSES RATHER THAN GUESSES
 * ---------------------------------------------------------------------------
 *
 * `--baseline` exits non-zero when a count goes UP. It also exits non-zero when
 * a metric the baseline names is MISSING from this run (a probe that went dead
 * reads as a free win otherwise), and when a CONTROL is zero — every measurement
 * carries a control proving the driver actually drove something, because "0
 * queries" and "0 frames" are what a harness that measured nothing reports.
 * It refuses outright to compare two runs measured at different FIXTURE SCALE:
 * a smaller fixture is a smaller number and is not a win.
 *
 * Usage:
 *   bun scripts/measure-hot-paths.ts --suite queries --out baseline-queries.json
 *   bun scripts/measure-hot-paths.ts --suite frames  --out baseline-frames.json
 *   bun scripts/measure-hot-paths.ts --suite queries --baseline baseline-queries.json
 *
 * With no --out it prints the report as JSON on stdout.
 *
 * Env: HOTPATH_SESSIONS (50), HOTPATH_ISSUES (30) — the bind-storm fixture's
 * scale, matching `apps/server/src/relay.bind-storm.test.ts`.
 *
 * Baselines are ISSUE ARTIFACTS on POD-3221, never committed: a committed number
 * is a number a rebase can silently move.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import {
  asMachineId,
  asUserId,
  FIRST_ADMIN_USER_ID,
  type IssueId,
  type SessionId,
} from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { SqlDatabase, SqlParam } from '@podium/runtime/sqlite'
// TYPE-ONLY, and erased at runtime — the values are imported dynamically inside
// {@link buildFixture} so `--baseline` can read a report on a checkout whose
// server does not construct.
import type { SessionRegistry } from '../apps/server/src/relay'
import type { SessionStore } from '../apps/server/src/store'

const SESSION_COUNT = Number(process.env.HOTPATH_SESSIONS ?? 50)
const ISSUE_COUNT = Number(process.env.HOTPATH_ISSUES ?? 30)

// ---------------------------------------------------------------------------
// The probe seam
// ---------------------------------------------------------------------------

/** One measurement window's worth of counting. `stop()` restores the seam so a
 *  later window in the same process is not counted twice. */
export interface QueryProbe {
  /** Statement executions since the last {@link reset}. */
  count(): number
  /** Executions per statement text, for the report's breakdown. */
  byStatement(): Record<string, number>
  reset(): void
  stop(): void
}

/** THE ONE SEAM [0.13] REPLACES. Everything else in this file is driver code. */
export type QueryProbeFactory = (store: unknown) => QueryProbe

/**
 * Today's seam: the synchronous `SqlDatabase` handle the store holds, patched in
 * place. In place rather than wrapped-at-construction because every repository
 * captured `this.db` when `SessionStore` was built, and they all captured the
 * SAME object — which is precisely what `store-issues-frame-cache.test.ts`
 * relies on.
 */
export const sqlDatabaseQueryProbe: QueryProbeFactory = (store) => {
  const handle = (store as { db: SqlDatabase }).db
  const original = handle.prepare.bind(handle)
  let counts = new Map<string, number>()
  const bump = (sql: string): void => {
    counts.set(sql, (counts.get(sql) ?? 0) + 1)
  }
  const patched = (sql: string): ReturnType<SqlDatabase['prepare']> => {
    const statement = original(sql)
    return {
      run: (...p: SqlParam[]) => {
        bump(sql)
        return statement.run(...p)
      },
      get: (...p: SqlParam[]) => {
        bump(sql)
        return statement.get(...p)
      },
      all: (...p: SqlParam[]) => {
        bump(sql)
        return statement.all(...p)
      },
    }
  }
  ;(handle as { prepare: SqlDatabase['prepare'] }).prepare =
    patched as unknown as SqlDatabase['prepare']
  return {
    count: () => [...counts.values()].reduce((total, n) => total + n, 0),
    byStatement: () => Object.fromEntries(counts),
    reset: () => {
      counts = new Map()
    },
    stop: () => {
      ;(handle as { prepare: SqlDatabase['prepare'] }).prepare = original
    },
  }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** A gated number, with the control that proves its driver ran. A metric whose
 *  control is 0 is not a low number, it is no measurement. */
interface Metric {
  /** The gated count. Lower is better; the gate fails when it rises. */
  value: number
  /** What the driver observably did. Zero means the harness measured nothing. */
  control: number
  /** What `control` counts, in words, for whoever reads the artifact later. */
  controlOf: string
  /** What `value` counts. */
  unit: 'queries-per-request' | 'frames-per-burst'
}

interface Report {
  suite: 'queries' | 'frames'
  at: string
  /** Refuses a cross-scale comparison: a smaller fixture is not a smaller cost. */
  scale: { sessions: number; issues: number }
  metrics: Record<string, Metric>
  /** Executions per statement text for the query suite — not gated, but it is
   *  what tells the reader WHICH query multiplied when the gate fires. */
  breakdown?: Record<string, Record<string, number>>
}

// ---------------------------------------------------------------------------
// The fixture — the bind-storm shape, which is a real incident
// ---------------------------------------------------------------------------

interface Fixture {
  registry: SessionRegistry
  store: SessionStore
  /** The seeded issues, so a driver can age the change-log baseline out from
   *  under them the way retention does. */
  issueIds: IssueId[]
  bound: { sessionId: SessionId; cwd: string; machineId: string }[]
  inbox: ServerMessage[]
  /** Empties the inbox and returns what was in it. */
  drain(): ServerMessage[]
}

const GEOMETRY = { cols: 80, rows: 24 }

const bindFrame = (sessionId: SessionId, cwd: string) => ({
  type: 'bind' as const,
  sessionId,
  cmd: 'sh',
  cwd,
  agentKind: 'shell' as const,
  geometry: GEOMETRY,
})

/**
 * The composition the product runs: a real `SessionStore`, a real
 * `SessionRegistry`, a real client connection through the real gateway. A fake
 * store cannot be wrong about how many statements it issues, which is the whole
 * reason `repos-read-cost.test.ts` wraps a real migrated database instead.
 *
 * Imported dynamically for the same reason `switch-latency-ab.ts` does it: a
 * later checkout must be able to READ an old baseline with `--baseline` without
 * necessarily being able to construct the tree that produced it.
 */
async function buildFixture(): Promise<Fixture> {
  const { SessionRegistry } = await import('../apps/server/src/relay')
  const { SessionStore } = await import('../apps/server/src/store')
  const store = new SessionStore(':memory:')
  for (const [id, name] of [
    ['m1', 'one'],
    ['m2', 'two'],
  ] as const) {
    store.machines.upsertMachine({
      id,
      name,
      hostname: name,
      tokenHash: `token-${id}`,
      ownerUserId: asUserId('user:sole'),
    })
  }
  const registry = new SessionRegistry(store, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon('m1', () => {})
  registry.gateway.attachDaemon('m2', () => {})
  const issueIds: IssueId[] = []
  for (let index = 0; index < ISSUE_COUNT; index += 1) {
    issueIds.push(
      registry.issues.create({ repoPath: '/repo', title: `issue ${index}`, startNow: false }).id,
    )
  }
  const bound: { sessionId: SessionId; cwd: string; machineId: string }[] = []
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const machineId = index % 2 ? 'm2' : 'm1'
    const cwd = `/repo/w${index}`
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd,
      machineId: asMachineId(machineId),
    })
    bound.push({ sessionId, cwd, machineId })
  }
  // Settle the fixture's own broadcasts BEFORE any window opens. Letting setup
  // into the window is how a bench reports its own construction as hot-path cost.
  registry.modules.sessions.flushBroadcasts()
  const inbox: ServerMessage[] = []
  return {
    registry,
    store,
    issueIds,
    bound,
    inbox,
    drain: () => inbox.splice(0, inbox.length),
  }
}

/** Attach one client and speak `hello`, which is what makes the server serve a
 *  world. Returns its peer id. */
function attachClient(fixture: Fixture, sink: (message: ServerMessage) => void): string {
  const clientId = fixture.registry.clientGateway.attachClient({
    send: sink,
    // The fixture's issues and sessions are the admin's. A connection for any
    // OTHER principal is scoped out of every change and receives frames carrying
    // no rows — which reads as a beautifully low number and measures nothing.
    userId: FIRST_ADMIN_USER_ID,
    userRole: 'admin',
  })
  fixture.registry.clientGateway.routeClientFrame(clientId, {
    type: 'hello',
    wireVersion: 2,
    clientId: '',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    caps: ['metadataDelta'],
  })
  return clientId
}

/** Let the microtask coalescing run exactly as it does in production, then run
 *  the deterministic flush seam so nothing is left pending in the report. */
async function settle(fixture: Fixture): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  fixture.registry.modules.sessions.flushBroadcasts()
  fixture.registry.modules.funnel.flushDeltas()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const feedFrames = (messages: ServerMessage[], type: 'feedDelta' | 'feedBootstrap'): number =>
  messages.filter((message) => message.type === type).length

const changeCount = (messages: ServerMessage[]): number =>
  messages.reduce(
    (total, message) => total + (message.type === 'feedDelta' ? message.changes.length : 0),
    0,
  )

// ---------------------------------------------------------------------------
// Suite 1 — query count per request
// ---------------------------------------------------------------------------

async function measureQueries(probeFactory: QueryProbeFactory): Promise<Report> {
  const fixture = await buildFixture()
  const breakdown: Record<string, Record<string, number>> = {}
  try {
    const probe = probeFactory(fixture.store)
    try {
      // (1) FEED BOOTSTRAP. The window is the whole request a fresh connection
      // makes — attach plus `hello` — because that is what one client costs the
      // database, and `serveWorld` is only its tail. The FIRST connection for a
      // principal is the one that pays: `worldFor` caches the installed world,
      // so a second attach at the same head is a reuse and would report ~0.
      const bootstrapInbox: ServerMessage[] = []
      probe.reset()
      attachClient(fixture, (message) => bootstrapInbox.push(message))
      const bootstrapQueries = probe.count()
      breakdown['feedBootstrap.queriesPerRequest'] = probe.byStatement()
      await settle(fixture)

      // (2) ISSUE FRAME READS. The publish fan-out resolves the owning issue of
      // every session it admits, and it does so inside ONE event-loop frame:
      // POD-1931 measured a single frame running 242 `getIssues` calls over
      // 94,138 rows plus 5,163 `getIssue` calls, 13 seconds of CPU, most of it
      // re-parsing the same rows. `store/issues.ts` answers the repeat reads from
      // a frame cache invalidated by `queueMicrotask` — so THE FIRST AWAIT
      // ANYWHERE IN THIS PATH DROPS IT, and this conversion is going to put
      // awaits in it. That is the whole reason this number is a gate.
      //
      // The window below is therefore ONE SYNCHRONOUS FRAME with no await in it:
      // the hoisted list read, then the per-session owning-issue resolution.
      fixture.drain()
      const stormInbox: ServerMessage[] = []
      attachClient(fixture, (message) => stormInbox.push(message))
      await settle(fixture)
      stormInbox.length = 0
      let resolvedRows = 0
      probe.reset()
      resolvedRows += fixture.registry.issues.readyList('/repo').length
      for (let index = 0; index < SESSION_COUNT; index += 1) {
        const owner = fixture.issueIds[index % fixture.issueIds.length]
        if (owner === undefined) throw new Error('issue fixture is empty')
        if (fixture.registry.issues.get(owner) !== null) resolvedRows += 1
      }
      const fanoutQueries = probe.count()
      breakdown['issueFrameReads.queriesPerRequest'] = probe.byStatement()

      return {
        suite: 'queries',
        at: new Date().toISOString(),
        scale: { sessions: SESSION_COUNT, issues: ISSUE_COUNT },
        metrics: {
          'feedBootstrap.queriesPerRequest': {
            value: bootstrapQueries,
            control: feedFrames(bootstrapInbox, 'feedBootstrap'),
            controlOf: 'feedBootstrap frames the served connection received',
            unit: 'queries-per-request',
          },
          'issueFrameReads.queriesPerRequest': {
            value: fanoutQueries,
            control: resolvedRows,
            controlOf: 'issue rows the frame actually resolved',
            unit: 'queries-per-request',
          },
        },
        breakdown,
      }
    } finally {
      probe.stop()
    }
  } finally {
    fixture.registry.dispose()
    fixture.store.close()
  }
}

// ---------------------------------------------------------------------------
// Suite 2 — frames per burst
// ---------------------------------------------------------------------------

async function measureFrames(): Promise<Report> {
  const fixture = await buildFixture()
  try {
    const inbox: ServerMessage[] = []
    attachClient(fixture, (message) => inbox.push(message))
    await settle(fixture)

    // (3) BOOT RECONCILE. `IssueService.boot` is the real thing, not an
    // imitation: relay.ts calls exactly this at composition. Re-running it with
    // a connection already attached is what puts its burst on the wire where it
    // can be counted. It reconciles issues, projections and dep edges — three
    // full-truth passes in one synchronous burst, which must coalesce to ONE
    // frame.
    //
    // THE BASELINE HAS TO BE STALE OR THIS MEASURES NOTHING. A reconcile against
    // an up-to-date change log diffs to nothing and publishes nothing, and "0
    // frames" would then be reported as the best possible result forever. This
    // is the condition boot exists for (POD-1597: "every issue whose change-log
    // baseline has aged out of retention re-stages here") and it is produced the
    // way retention produces it — writing the rows through the REPOSITORY, which
    // appends no change row, rather than through the service write seam.
    for (const id of fixture.issueIds) {
      const row = fixture.store.issues.getIssue(id)
      if (row === null || row === undefined) throw new Error(`fixture issue ${id} vanished`)
      fixture.store.issues.upsertIssue({ ...row, title: `${row.title} (aged out)` })
    }
    inbox.length = 0
    fixture.registry.issues.boot()
    await settle(fixture)
    const reconcileFrames = feedFrames(inbox, 'feedDelta')
    const reconcileChanges = changeCount(inbox)

    // (4) BIND STORM. The redeploy watchdog-kill incident's shape: a daemon
    // reattach replaying one `bind` per surviving session, each a commit.
    inbox.length = 0
    for (const session of fixture.bound) {
      fixture.registry.gateway.routeDaemonFrame(
        session.machineId,
        bindFrame(session.sessionId, session.cwd),
      )
    }
    await settle(fixture)
    const stormFrames = feedFrames(inbox, 'feedDelta')
    const stormChanges = changeCount(inbox)

    return {
      suite: 'frames',
      at: new Date().toISOString(),
      scale: { sessions: SESSION_COUNT, issues: ISSUE_COUNT },
      metrics: {
        'bootReconcile.framesPerBurst': {
          value: reconcileFrames,
          control: reconcileChanges,
          controlOf: 'entity changes the boot reconcile published',
          unit: 'frames-per-burst',
        },
        'bindStorm.framesPerBurst': {
          value: stormFrames,
          control: stormChanges,
          controlOf: 'entity changes the bind storm published',
          unit: 'frames-per-burst',
        },
      },
    }
  } finally {
    fixture.registry.dispose()
    fixture.store.close()
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Returns the failures, in the order a reader wants them. Empty means pass. */
export function compareAgainstBaseline(baseline: Report, measured: Report): string[] {
  const failures: string[] = []
  if (baseline.suite !== measured.suite) {
    return [`suite mismatch: baseline is '${baseline.suite}', this run is '${measured.suite}'`]
  }
  if (
    baseline.scale.sessions !== measured.scale.sessions ||
    baseline.scale.issues !== measured.scale.issues
  ) {
    // REFUSAL, not a warning. A smaller fixture reports smaller counts and would
    // read as a win at exactly the moment the gate matters most.
    return [
      `fixture scale differs — baseline ${baseline.scale.sessions} sessions / ${baseline.scale.issues} issues, ` +
        `this run ${measured.scale.sessions} / ${measured.scale.issues}. These are not comparable.`,
    ]
  }
  for (const [name, before] of Object.entries(baseline.metrics)) {
    const after = measured.metrics[name]
    if (after === undefined) {
      failures.push(`${name}: the baseline has it, this run did not measure it (dead probe?)`)
      continue
    }
    if (after.control === 0) {
      failures.push(`${name}: control is 0 — ${after.controlOf}. Nothing was measured.`)
      continue
    }
    if (after.value > before.value) {
      failures.push(`${name}: ${before.value} → ${after.value} (${after.unit}) — increased`)
    }
  }
  for (const [name, metric] of Object.entries(measured.metrics)) {
    if (metric.control === 0 && baseline.metrics[name] === undefined) {
      failures.push(`${name}: control is 0 — ${metric.controlOf}. Nothing was measured.`)
    }
  }
  return failures
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} needs a value`)
  }
  return value
}

async function main(): Promise<void> {
  const suite = flag('suite') ?? 'queries'
  if (suite !== 'queries' && suite !== 'frames') {
    throw new Error(`--suite must be 'queries' or 'frames', got '${suite}'`)
  }
  const report =
    suite === 'queries' ? await measureQueries(sqlDatabaseQueryProbe) : await measureFrames()
  const out = flag('out')
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

  const baselinePath = flag('baseline')
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Report
    const failures = compareAgainstBaseline(baseline, report)
    if (failures.length > 0) {
      process.stderr.write(`hot-path budget exceeded (${baselinePath}):\n`)
      for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
      process.exitCode = 1
      return
    }
    process.stderr.write(`hot-path budget held against ${baselinePath}\n`)
  }
}

// `import.meta.main` so the exported probe and gate stay importable by a test
// without the CLI running as a side effect.
if (import.meta.main) {
  await main()
  // The registry's timers are disposed, but bun:sqlite and the janitor host can
  // leave the loop with work; the measurement is written, so leaving is correct.
  process.exit(process.exitCode ?? 0)
}
