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
 * {@link executionSeamQueryProbe} is that seam and NOTHING ELSE IN THIS FILE
 * KNOWS ABOUT IT — every measurement takes a {@link QueryProbeFactory}.
 *
 * IT MOVED IN POD-3281, and the reason is worth keeping. It used to patch
 * `store.db.prepare` in place. The executor's driver keeps ONE PREPARED
 * STATEMENT PER SQL TEXT, so a patch installed after boot never sees the texts
 * the boot heals already cached, and every later execution of one of them counts
 * as zero — a SILENT UNDERCOUNT, which reads as a free win at exactly the moment
 * the gate matters. The probe now attaches at the executor's statement seam
 * (`store/executor/statement-probe.ts`), downstream of any cache and neutral
 * about which driver ran the statement, so E.5's libsql backend measures with
 * the same call.
 *
 * ---------------------------------------------------------------------------
 * IT COUNTS EXECUTIONS, NOT PREPARATIONS
 * ---------------------------------------------------------------------------
 *
 * `prepare()` is where the statement text is visible, but the round trip is
 * `run`/`get`/`all`. There is no prepared-statement cache in the repositories
 * (spec §2.2: every site is `this.db.prepare(sql).get(...)`), so today the two
 * counts coincide — and after the conversion they do not, because the driver
 * caches one statement per SQL text. Counting executions keeps the baseline
 * meaningful across that change.
 *
 * ---------------------------------------------------------------------------
 * AND IT RECORDS WHAT THAT CACHE COSTS
 * ---------------------------------------------------------------------------
 *
 * `observations` carries two numbers that are RECORDED, NOT GATED:
 * `distinctStatementTexts` — one cached prepared statement per distinct SQL
 * text, including one per `IN (...)` ARITY, which is the case that defeats the
 * cache and the case the Stage A checklist asks about — and `rssBytesAfterBootstrap`.
 * They are not gate criteria because RSS moves with the machine and the text
 * count moves with any honest rewrite; they are here so that whoever reads two
 * baselines can see the cache growing rather than infer it.
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
 * ---------------------------------------------------------------------------
 * THE POSTGRES MODE: ROUND TRIPS AT HOSTED LATENCY [POD-6992, POD-6958 design 2.11]
 * ---------------------------------------------------------------------------
 *
 * `--suite round-trips` measures what hosted Postgres would cost the hot operations: per
 * operation its statements, its ROUND TRIPS (the driver calls that wait for the server,
 * counted by the Postgres driver's pipelining: `RoundTripObservation` in
 * `apps/server/src/store/executor/statement-probe.ts`), and its wall time twice, as the
 * store runs it and with `--latency-ms` (default 2.6, hosted Postgres from the app region)
 * held before every round trip. The difference is the database time a hosted user waits.
 *
 * The store under it is the SQLite one: a whole `SessionStore` does not boot on Postgres
 * until POD-6994. Round trips are a property of the executor's calls, which are the same on
 * both engines, and `round-trip-probe.pg.test.ts` holds the count equal to what crosses the
 * wire on a real Postgres. Not gated: a report for the round-trip budget (operator decision
 * OD2) and its reductions (POD-7030).
 *
 * Usage:
 *   bun scripts/measure-hot-paths.ts --suite queries --out baseline-queries.json
 *   bun scripts/measure-hot-paths.ts --suite frames  --out baseline-frames.json
 *   bun scripts/measure-hot-paths.ts --suite queries --baseline baseline-queries.json
 *   bun scripts/measure-hot-paths.ts --suite round-trips [--latency-ms 2.6] [--repeat 5]
 *
 * Run it with `bun --conditions=@podium/source`: the workspace packages export their
 * source only under that condition, and nothing here is built.
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
import type { IssueId, SessionId, UserId } from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
// TYPE-ONLY, and erased at runtime — the values are imported dynamically inside
// {@link buildFixture} and {@link executionSeamQueryProbe} so `--baseline` can
// read a report on a checkout whose server does not construct.
import type { SessionRegistry } from '../apps/server/src/relay'
import type { SessionStore } from '../apps/server/src/store'
import type { StatementProbeHolder } from '../apps/server/src/store/executor'

/**
 * `@podium/model`, resolved as the server resolves it: from `scripts/` the workspace
 * package does not resolve, and a copy loaded by another path would be a second module
 * (its primed first admin among it). Values only; its types are imported above.
 */
async function model(): Promise<typeof import('@podium/model')> {
  const { join } = await import('node:path')
  return await import(Bun.resolveSync('@podium/model', join(import.meta.dir, '../apps/server/src')))
}

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
  /**
   * Distinct SQL texts seen since the probe was installed, NOT since the last
   * {@link reset}: it is the size of the driver's prepared-statement cache, one
   * entry per text and therefore one per `IN (...)` arity. Recorded, not gated.
   */
  distinctStatementTexts(): number
  reset(): void
  stop(): void
}

/**
 * THE ONE SEAM. Everything else in this file is driver code.
 *
 * Async because installing it imports the server's executor, which is a value
 * import and therefore has to stay dynamic — see the import block above.
 */
export type QueryProbeFactory = (store: unknown) => Promise<QueryProbe>

/**
 * The executor's statement seam. Observation is driver-only; the connection is
 * merely the stable key used to attach this probe after the store has booted.
 * That keeps the measurement immune to the prepared-statement cache and lets a
 * later driver expose the same attachment without adding another execution feed.
 */
export const executionSeamQueryProbe: QueryProbeFactory = async (store) => {
  const { probeStatements } = await import('../apps/server/src/store/executor')
  let counts = new Map<string, number>()
  /** Never reset: the cache is a property of the CONNECTION, not of a window. */
  const everSeen = new Set<string>()
  const detach = probeStatements(store as StatementProbeHolder, (observation) => {
    counts.set(observation.sql, (counts.get(observation.sql) ?? 0) + 1)
    everSeen.add(observation.sql)
  })
  return {
    count: () => [...counts.values()].reduce((total, n) => total + n, 0),
    byStatement: () => Object.fromEntries(counts),
    distinctStatementTexts: () => everSeen.size,
    reset: () => {
      counts = new Map()
    },
    stop: detach,
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
  /** RECORDED, NOT GATED. See the header: the statement-cache consequence. */
  observations?: {
    /** One cached prepared statement per entry, `IN (...)` arities included. */
    distinctStatementTexts: number
    /** Resident set size right after the feed bootstrap window. */
    rssBytesAfterBootstrap: number
  }
}

// ---------------------------------------------------------------------------
// The fixture — the bind-storm shape, which is a real incident
// ---------------------------------------------------------------------------

interface Fixture {
  registry: SessionRegistry
  store: SessionStore
  ownerUserId: UserId
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
  const { asMachineId, asUserId, firstAdminMemberId } = await model()
  const { SessionRegistry } = await import('../apps/server/src/relay')
  const { SessionStore } = await import('../apps/server/src/store')
  // No change capture until the registry attaches its change log, as the test fixtures
  // open a store (`test-support/open-test-store.ts`): the machines below are written first.
  const store = await SessionStore.open(':memory:', undefined, { changeCapture: 'whenLogAttaches' })
  for (const [id, name] of [
    ['m1', 'one'],
    ['m2', 'two'],
  ] as const) {
    await store.machines.upsertMachine({
      id,
      name,
      hostname: name,
      tokenHash: `token-${id}`,
      ownerUserId: asUserId('user:sole'),
    })
  }
  const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  // The host's daemon reports `/repo`, as the pin fixtures attach it: an issue is created
  // only in a repository a machine reports. It answers the connect scan; the Shipping
  // scheduler is stopped, so its tick never lands inside a measured window.
  const { attachHostDaemon } = await import('../apps/server/src/test-support/host-daemon')
  const { quietShipping } = await import('../apps/server/src/test-support/statement-count')
  await attachHostDaemon(
    registry,
    (message) => {
      if (message.type !== 'scanReposRequest') return
      void registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
        type: 'scanReposResult',
        requestId: message.requestId,
        repositories: message.roots.map((path) => ({ path, kind: 'repository', worktrees: [] })),
        diagnostics: [],
      })
    },
    { repos: ['/repo'] },
  )
  await quietShipping(registry)
  registry.gateway.attachDaemon('m1', () => {})
  registry.gateway.attachDaemon('m2', () => {})
  const issueIds: IssueId[] = []
  for (let index = 0; index < ISSUE_COUNT; index += 1) {
    issueIds.push(
      (
        await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
          repoPath: '/repo',
          title: `issue ${index}`,
          startNow: false,
          // An explicit parent: create would otherwise ask the daemon for the base branch.
          parentBranch: 'main',
        })
      ).id,
    )
  }
  const bound: { sessionId: SessionId; cwd: string; machineId: string }[] = []
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    // On the host, whose daemon is attached: a bare attach of m1/m2 no longer counts as a
    // daemon that can run an agent. The two machines stay in the fleet the reads walk.
    const machineId = store.hostMachineId
    const cwd = `/repo/w${index}`
    const { sessionId } = await registry.modules.sessions.createSession({
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
    ownerUserId: await firstAdminMemberId(store),
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
    userId: fixture.ownerUserId,
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
    const probe = await probeFactory(fixture.store)
    try {
      // (1) FEED BOOTSTRAP. The window is the whole request a fresh connection
      // makes — attach plus `hello` — because that is what one client costs the
      // database. After the HTTP cutover this measures live-feed admission only;
      // HTTP snapshot work runs separately in sync-worker/producer.ts. The
      // historical bootstrap metric label below is not an HTTP transfer measurement.
      const bootstrapInbox: ServerMessage[] = []
      probe.reset()
      attachClient(fixture, (message) => bootstrapInbox.push(message))
      const bootstrapQueries = probe.count()
      breakdown['feedBootstrap.queriesPerRequest'] = probe.byStatement()
      // Right here, before anything else runs: the question the statement cache
      // raises is what ONE bootstrap costs in cached statements and resident
      // memory, not what the whole script does.
      const rssBytesAfterBootstrap = process.memoryUsage().rss
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
      resolvedRows += (await fixture.registry.issues.reports.readyList('/repo')).length
      for (let index = 0; index < SESSION_COUNT; index += 1) {
        const owner = fixture.issueIds[index % fixture.issueIds.length]
        if (owner === undefined) throw new Error('issue fixture is empty')
        if ((await fixture.registry.issues.reports.get(owner)) !== null) resolvedRows += 1
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
        observations: {
          distinctStatementTexts: probe.distinctStatementTexts(),
          rssBytesAfterBootstrap,
        },
      }
    } finally {
      probe.stop()
    }
  } finally {
    await fixture.registry.dispose()
    await fixture.store.close()
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
        'bindStorm.framesPerBurst': {
          value: stormFrames,
          control: stormChanges,
          controlOf: 'entity changes the bind storm published',
          unit: 'frames-per-burst',
        },
      },
    }
  } finally {
    await fixture.registry.dispose()
    await fixture.store.close()
  }
}

// ---------------------------------------------------------------------------
// Suite 3 — round trips at hosted latency (the Postgres mode)
// ---------------------------------------------------------------------------

/** One operation at hosted latency. */
interface RoundTripMeasurement {
  /** Statements per run: the statement pins' number. */
  statements: number
  /** Round trips per run, by the Postgres driver's pipelining. */
  roundTrips: number
  /** Round trips by kind of call: begin, statement, batch, commit, savepoint, … */
  byCall: Record<string, number>
  /** Round trips at the root (outside any transaction), within `roundTrips`. */
  rootRoundTrips: number
  /** Median wall time of a run as the store runs it, in ms. */
  wallMs: number
  /** Median wall time of a run with `latencyMs` held before every round trip, in ms. */
  wallAtLatencyMs: number
  /** `roundTrips × latencyMs`: the database time the round trips alone cost. */
  roundTripMs: number
}

interface RoundTripReport {
  suite: 'round-trips'
  at: string
  latencyMs: number
  repeat: number
  scale: { sessions: number; issues: number }
  operations: Record<string, RoundTripMeasurement>
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function measureRoundTrips(latencyMs: number, repeat: number): Promise<RoundTripReport> {
  const { probeRoundTrips, probeStatements, injectRoundTripLatency } = await import(
    '../apps/server/src/store/executor/statement-probe'
  )
  const { appRouter } = await import('../apps/server/src/router')
  const { RepoRegistry } = await import('../apps/server/src/repo-registry')
  const { SuperagentService } = await import('../apps/server/src/modules/superagent')
  const { userCommandPrincipal } = await import('../apps/server/src/command-principal')
  const fixture = await buildFixture()
  const holder = fixture.store as unknown as StatementProbeHolder
  const owner = fixture.ownerUserId
  const repos = new RepoRegistry(fixture.registry, fixture.store)
  const superagent = await SuperagentService.create(fixture.registry.modules, repos, fixture.store)
  const call = appRouter.createCaller({
    registry: fixture.registry,
    repos,
    superagent,
    capability: {
      role: 'admin',
      scope: { kind: 'owned', userId: owner },
      actorUser: owner,
      onBehalfOf: owner,
    },
    principal: userCommandPrincipal(owner, 'admin'),
  } as never)
  // A running session to send mail to: its daemon has bound it.
  const target = fixture.bound[0]
  if (target === undefined) throw new Error('the fixture has no session')
  await fixture.registry.gateway.routeDaemonFrame(
    target.machineId,
    bindFrame(target.sessionId, target.cwd),
  )
  await settle(fixture)
  let made = 0
  const operations: Record<string, () => Promise<unknown>> = {
    'sessions.createSession (in process, a draft in a repo)': async () =>
      await fixture.registry.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: `/repo/new${made++}`,
      }),
    'tRPC sessions.create': async () =>
      await call.sessions.create({ agentKind: 'shell', cwd: `/repo/trpc${made++}` } as never),
    'tRPC messages.send to a running session': async () =>
      await call.messages.send({ to: target.sessionId, body: `measured ${made++}` } as never),
    'issues.crud.create': async () =>
      await fixture.registry.issues.crud.create(
        fixture.registry.issues.reports.store.serverWriter,
        {
          repoPath: '/repo',
          title: `measured ${made++}`,
          startNow: false,
          parentBranch: 'main',
        } as never,
      ),
    'issue frame reads (readyList + one get per session)': async () => {
      await fixture.registry.issues.reports.readyList('/repo')
      for (let index = 0; index < SESSION_COUNT; index += 1) {
        const owner = fixture.issueIds[index % fixture.issueIds.length]
        if (owner !== undefined) await fixture.registry.issues.reports.get(owner)
      }
    },
  }
  const measured: Record<string, RoundTripMeasurement> = {}
  try {
    for (const [name, run] of Object.entries(operations)) {
      // Once to warm every cache the operation fills, then counted and timed.
      await run()
      await settle(fixture)
      const plain: number[] = []
      const held: number[] = []
      let roundTrips = 0
      let rootRoundTrips = 0
      let statements = 0
      const byCall: Record<string, number> = {}
      for (let round = 0; round < repeat; round += 1) {
        const trips: { call: string; root: boolean }[] = []
        let ran = 0
        const detachTrips = probeRoundTrips(holder, (trip) => {
          trips.push({ call: trip.call, root: trip.root })
        })
        const detachStatements = probeStatements(holder, () => {
          ran += 1
        })
        let startedAt = performance.now()
        try {
          await run()
          plain.push(performance.now() - startedAt)
        } finally {
          detachTrips()
          detachStatements()
        }
        await settle(fixture)
        const stopLatency = injectRoundTripLatency(holder, latencyMs)
        startedAt = performance.now()
        try {
          await run()
          held.push(performance.now() - startedAt)
        } finally {
          stopLatency()
        }
        await settle(fixture)
        if (round === 0) {
          roundTrips = trips.length
          rootRoundTrips = trips.filter((trip) => trip.root).length
          statements = ran
          for (const trip of trips) byCall[trip.call] = (byCall[trip.call] ?? 0) + 1
        }
      }
      measured[name] = {
        statements,
        roundTrips,
        byCall,
        rootRoundTrips,
        wallMs: Number(median(plain).toFixed(2)),
        wallAtLatencyMs: Number(median(held).toFixed(2)),
        roundTripMs: Number((roundTrips * latencyMs).toFixed(1)),
      }
      process.stderr.write(
        `round trips: ${name}: ${roundTrips} round trips, ${statements} statements\n`,
      )
    }
  } finally {
    await fixture.registry.dispose()
    await fixture.store.close()
  }
  return {
    suite: 'round-trips',
    at: new Date().toISOString(),
    latencyMs,
    repeat,
    scale: { sessions: SESSION_COUNT, issues: ISSUE_COUNT },
    operations: measured,
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
    // A ZERO WHERE THE BASELINE HAS A NUMBER IS A BLIND INSTRUMENT, NOT A WIN
    // [POD-3407]. The control above cannot catch this: it is measured from the
    // FRAMES AND ROWS the window produced, not from the probe, so a probe that
    // observes nothing still reports a healthy control and a value of 0 — which
    // the budget below reads as the largest possible improvement. POD-3397 is
    // exactly that, and POD-3407 reproduced it by counting the same two windows
    // through a drizzle logger: 0 and 0 against 44 and 253, controls 1 and 80,
    // verdict "budget held". Gated on `before.value > 0` so a metric that is
    // legitimately zero in the baseline stays comparable.
    if (after.value === 0 && before.value > 0) {
      failures.push(
        `${name}: measured 0 against a baseline of ${before.value} (${after.unit}) — ` +
          `the control held (${after.control} ${after.controlOf}), so the window ran and the ` +
          'instrument saw nothing. That is a dead probe, not a win.',
      )
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
  if (suite === 'round-trips') {
    const latencyMs = Number(flag('latency-ms') ?? 2.6)
    const repeat = Math.max(1, Math.floor(Number(flag('repeat') ?? 5)))
    if (!(latencyMs >= 0)) throw new Error('--latency-ms must be a non-negative number')
    const report = await measureRoundTrips(latencyMs, repeat)
    const out = flag('out')
    if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  if (suite !== 'queries' && suite !== 'frames') {
    throw new Error(`--suite must be 'queries', 'frames' or 'round-trips', got '${suite}'`)
  }
  const report =
    suite === 'queries' ? await measureQueries(executionSeamQueryProbe) : await measureFrames()
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
