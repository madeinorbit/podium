/**
 * ATTRIBUTION AT THE EXECUTION SEAM [POD-3281, spec §6 rule 8].
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT DARK, AND WHY IT IS NOT WHAT THE ISSUE ASSUMED
 * ---------------------------------------------------------------------------
 *
 * This issue was written expecting drizzle to run on the raw `bun:sqlite`
 * Database, so that a converted repository would bypass the `SqlDatabase`
 * wrapper the profiler and the three query-count probes sit on. That is not
 * what landed. POD-3248/POD-3321 built the query layer on a ROUTER — one async
 * callback per statement, the shape drizzle's `sqlite-proxy` driver takes — and
 * the bun driver turns each callback into `prepare`/`run` on an ordinary
 * `SqlDatabase`. So the handle is still in the path.
 *
 * The measurement still goes dark, for a sharper reason: the driver keeps ONE
 * PREPARED STATEMENT PER SQL TEXT PER CONNECTION (`bun-driver.ts`). Every probe
 * in the tree hooks `SqlDatabase.prepare`:
 *
 *   - `store-issues-frame-cache.test.ts` and `store-users-frame-cache.test.ts`
 *     COUNT PREPARATIONS. Under the cache the second read of the same text
 *     never prepares, so "reads go back up on the next turn" reads as zero.
 *   - `scripts/measure-hot-paths.ts` counts EXECUTIONS but installs its patch
 *     AFTER boot. Any text the boot heals already cached is held as an
 *     UNPATCHED statement, and every later execution of it counts as zero —
 *     a silent undercount, which is the failure mode the gate cannot survive.
 *
 * And the handle is bun-only. On the libsql driver (E.5) there is no
 * `SqlDatabase` at all, so every one of these probes reports nothing.
 *
 * ---------------------------------------------------------------------------
 * SO THE SEAM IS THE DRIVER SESSION, NOT THE HANDLE
 * ---------------------------------------------------------------------------
 *
 * {@link instrumentDriver} wraps `DriverSession.execute` and `executeBatch` —
 * DOWNSTREAM of any statement cache and UPSTREAM of any engine, on every lane
 * including the detached reader. It names nothing bun-specific: E.5's libsql
 * driver wraps `execute`/`batch` under the same call and gets the same
 * observations, which is what "design the probe as driver-neutral" asked for.
 *
 * ONE INJECTABLE PROBE FUNCTION is the whole interface ({@link StatementProbe}).
 * The profiler is a probe ({@link queryAttributionProbe}), the measurement
 * script installs a probe, and the three probe tests install a probe. Nothing
 * downstream knows which driver produced the observation.
 */

import { createLogger } from '@podium/logger'
import {
  claimQueryAttribution,
  queryCallerStacksEnabled,
  queryKey,
  readBytesSince,
  recordQuery,
  sampleBatchRead,
  sampleStatementRead,
} from '@podium/runtime/query-attribution'
import { currentStoreContext } from './context'
import type {
  DriverSession,
  Lane,
  Statement,
  StatementIntent,
  StatementMethod,
  StatementResult,
  StoreDriver,
} from './driver'

const log = createLogger('server:store')

/**
 * One statement, as it completed.
 *
 * ON COMPLETION, INCLUDING FAILURES — the same contract the old wrapper had. A
 * statement that threw contributes its wall time and zero rows, because a
 * failure that costs 200 ms is exactly the thing a profile must not hide.
 */
export interface StatementObservation {
  /** The statement text, verbatim, as the caller wrote it. */
  readonly sql: string
  /** Whitespace-folded and truncated — the stable key costs aggregate under. */
  readonly key: string
  /** RESULT DECODING ONLY, never write intent (spec §6 rule 2). */
  readonly method: StatementMethod
  /**
   * Write intent as DECLARED by the caller (spec §6 rule 16), or `undeclared`
   * for the legacy raw-handle seam, which has no caller to declare it. It is
   * never inferred from the SQL text: that is the banned move.
   */
  readonly intent: StatementIntent | 'undeclared'
  /** Rows handed back. `run` is 0; `get` is 0 or 1; `all` is the row count. */
  readonly rows: number
  /**
   * The rows themselves, BY REFERENCE (the driver's own array, never a copy), for
   * a probe that weighs what a read carried (`countResultBytes`, POD-7575: a
   * byte budget sees a whole column read in one statement, which a statement
   * count cannot). Absent for `run` and for a failed statement. A probe must not
   * change them, and should not keep them past the observation.
   */
  readonly resultRows?: readonly unknown[]
  /**
   * Wall time of the DRIVER CALL this statement rode in, in ms.
   *
   * For a batch that is the whole batch's time, repeated on every member —
   * which is honest, because a batch is ONE round trip and there is no
   * per-statement time to report. Divide by {@link batchSize} to attribute, or
   * count only `batchIndex === 0` to count round trips. Summing it raw over a
   * batch multiplies the truth by the batch size.
   */
  readonly durationMs: number
  /** True when the statement threw. Rows are 0 and the time is still recorded. */
  readonly failed: boolean
  /** 1 for a lone statement; n for a member of an n-statement batch. */
  readonly batchSize: number
  /** 0 for a lone statement; the position within the batch otherwise. */
  readonly batchIndex: number
  /** Which execution seam saw it. */
  readonly seam: 'driver'
  /**
   * Bytes SQLite read from the database file during the DRIVER CALL, present
   * only when the profiler sampled it (`sampleStatementRead`, POD-7037). Like
   * {@link durationMs} it is the whole batch's figure on every member.
   */
  readonly readBytes?: number
  /**
   * The RAW stack of the call site, present only while a probe asked for it
   * ({@link StatementProbeHub.captureIssueSites}) or the statement arrived
   * carrying one.
   *
   * WHY IT IS NOT CAPTURED IN THE PROBE. A probe runs in the `finally` AFTER the
   * driver call was awaited, and by then the caller's frames are gone: an audit
   * that builds its own stack sees the executor and nothing above it.
   *
   * TWO CAPTURE POINTS, NEAREST WINS [POD-3851]. The entry to `execute` is
   * synchronous with respect to whoever called the driver, but for a repository
   * that is the SCHEDULER, not the repository: admission and the in-flight
   * tracker are awaited in between, so a door capture reconstructs to
   * `driver.ts`/`scheduler.ts`/`executor.ts` and stops. So the query client
   * captures first ({@link Statement.issueStack}), in the caller's own turn, and
   * that stack is preferred whenever it exists. The door capture stays for the
   * statements that reach the driver without a query client — migrations,
   * pragmas, the frame flusher — where it is the best stack that exists.
   *
   * IT IS RAW AND UNPARSED on purpose. Which frame is "the call site" is the
   * consumer's question — the intent audit wants the first frame outside
   * `store/executor/`, the profiler wants the frames above the plumbing — and
   * this module has no business deciding it for them.
   */
  readonly issueStack?: string
}

/** The one injectable seam. Everything else in this module is plumbing. */
export type StatementProbe = (observation: StatementObservation) => void

/**
 * ROUND TRIPS [POD-6992, POD-6958 design 2.11].
 *
 * A statement costs microseconds on SQLite and one network round trip on hosted
 * Postgres (about 2.6 ms), unless it rides in a pipeline with others. So a pinned
 * operation has two numbers: its statements (above) and its round trips: the driver
 * calls that wait for the server.
 *
 * COUNTED FROM THE SESSION CALLS, BY THE POSTGRES DRIVER'S RULES. The probe sees
 * every call a lease makes (`begin`, `execute`, `executeBatch`, `commit`, savepoints)
 * on either engine, and the executor makes the same calls on both: repositories,
 * transactions and the scheduler are engine-neutral. Which of those calls wait for
 * the server is the Postgres driver's pipelining (`pg-driver.ts`):
 *
 *  - `begin('read')`, and `begin('write')` outside a workspace, send nothing: the
 *    BEGIN goes out with the body's first statement. A body that runs nothing costs
 *    nothing, its COMMIT included.
 *  - `begin('write')` in a workspace is one round trip: BEGIN, `SET LOCAL
 *    lock_timeout` and the workspace lock, pipelined.
 *  - every statement and every batch is one round trip, inside a transaction (a
 *    batch with its savepoint) or at the root (wrapped `BEGIN … COMMIT` when it needs
 *    it); a failed batch inside a transaction one more, to roll its savepoint back.
 *  - COMMIT, ROLLBACK and each savepoint command of an open transaction are one.
 *  - `exclusive` opens nothing; its statements run at the root.
 *
 * So the same count is read off a SQLite store, where it is what the operation WOULD
 * cost on Postgres (the full `SessionStore` pins, until a store boots on Postgres,
 * POD-6994), and off a Postgres store, where `round-trip-probe.pg.test.ts` holds it
 * equal to what crosses the wire. A change to the driver's pipelining that this
 * model does not follow fails there.
 *
 * WHAT IT DOES NOT COUNT. A connection's first use of a statement with parameters
 * costs postgres.js one more round trip (Parse and Describe, before the Bind), once
 * per statement per pooled connection; a new pooled connection costs its startup.
 * Both are warm-up, not per-operation cost, and the wire test measures warm.
 */
export interface RoundTripObservation {
  /** The session call that waits. */
  readonly call:
    | 'begin'
    | 'statement'
    | 'batch'
    | 'batch-undo'
    | 'commit'
    | 'rollback'
    | 'savepoint'
    | 'release-savepoint'
    | 'rollback-to-savepoint'
    | 'close-rollback'
  /** The lane of the lease's transaction; undefined at the root. */
  readonly lane: Lane | undefined
  /** True when the call runs outside any transaction (a root statement or batch). */
  readonly root: boolean
  /** Repository statements the round trip carries (a pipelined BEGIN or COMMIT is not one). */
  readonly statements: number
  /** The first carried statement's folded key, for a breakdown. */
  readonly key?: string
}

/**
 * Sees each round trip BEFORE the call is made. A probe that returns a promise
 * delays the call until it settles: that is how a measurement injects hosted
 * latency per round trip ({@link injectRoundTripLatency}).
 */
export type RoundTripProbe = (trip: RoundTripObservation) => void | Promise<void>

/**
 * Fan-out with a cheap disabled path.
 *
 * The old wrapper's cost model was "hands the database back unchanged when the
 * flag is off". A hub cannot do that, because a probe attaches LATE — that is
 * what the three probe tests do, and what the measurement script needs after
 * the store is already built. So the cost of being off is one array-length
 * check per statement instead of nothing, and the wrapper only exists at all
 * when a caller asked for one.
 */
export class StatementProbeHub {
  private probes: StatementProbe[] = []
  private siteRequests = 0
  private attributors = 0

  /**
   * Where a throwing probe is reported. Injectable rather than rethrown,
   * because rethrowing on a later turn makes an unhandled rejection out of a
   * diagnostic and takes a test run down with it — and swallowing it silently
   * is how a probe that stopped counting goes unnoticed. So: it is reported,
   * once, somewhere a caller chose.
   */
  constructor(
    private readonly onProbeError: (error: unknown) => void = (error) => {
      log.warn('a statement probe threw and was isolated', { err: error })
    },
  ) {}

  /** True while anyone is listening. Checked before any timing work happens. */
  get active(): boolean {
    return this.probes.length > 0
  }

  /**
   * True while {@link queryAttributionProbe} is attached — i.e. while THIS seam
   * is the profiler's instrument for the statements it sees [POD-3852].
   *
   * It gates the claim in {@link observeSession}, and the gate has to be this
   * narrow in BOTH directions. Too wide (any probe at all) and a hub carrying
   * only the lane-intent audit would silence the `SqlDatabase` wrapper without
   * recording anything in its place — a silent UNDERCOUNT, which is the failure
   * mode this whole module exists to avoid. Too narrow (only what
   * {@link installQueryAttributionProbe} registered) and a caller that attached
   * the probe directly, as the parity test does, would still be counted twice.
   * Probe IDENTITY answers both: whoever holds it, the profiler is at this seam.
   */
  get attributing(): boolean {
    return this.attributors > 0
  }

  /**
   * True while some probe asked for {@link StatementObservation.issueStack}.
   *
   * OPT-IN BECAUSE IT IS NOT FREE: building a stack costs far more than the
   * statement's own bookkeeping, so a profiler counting round trips must not pay
   * for an attribution it never reads. The audit that does read it asks, and the
   * cost lands only where somebody wanted the answer.
   */
  get captureIssueSites(): boolean {
    return this.siteRequests > 0
  }

  /**
   * Register a probe. Returns its detach; detaching twice is a no-op.
   *
   * `wantsIssueSite` is refcounted rather than a flag, so two probes asking and
   * one detaching does not silently stop attributing for the other.
   */
  attach(probe: StatementProbe, options: { wantsIssueSite?: boolean } = {}): () => void {
    this.probes.push(probe)
    if (options.wantsIssueSite) this.siteRequests += 1
    if (probe === queryAttributionProbe) this.attributors += 1
    let detached = false
    return () => {
      if (detached) return
      detached = true
      if (options.wantsIssueSite) this.siteRequests -= 1
      if (probe === queryAttributionProbe) this.attributors -= 1
      const at = this.probes.indexOf(probe)
      if (at >= 0) this.probes.splice(at, 1)
    }
  }

  /**
   * Deliver to every probe. A throwing probe must not take the statement down
   * with it, and must not stop the probes after it either: this is a
   * diagnostic, and a diagnostic that can fail a write is worse than none.
   */
  emit(observation: StatementObservation): void {
    for (const probe of [...this.probes]) {
      try {
        probe(observation)
      } catch (error) {
        this.onProbeError(error)
      }
    }
  }

  private tripProbes: RoundTripProbe[] = []

  /** True while anyone counts round trips. */
  get countingRoundTrips(): boolean {
    return this.tripProbes.length > 0
  }

  /** Register a round-trip probe. Returns its detach; detaching twice is a no-op. */
  attachRoundTrips(probe: RoundTripProbe): () => void {
    this.tripProbes.push(probe)
    let detached = false
    return () => {
      if (detached) return
      detached = true
      const at = this.tripProbes.indexOf(probe)
      if (at >= 0) this.tripProbes.splice(at, 1)
    }
  }

  /**
   * Deliver one round trip to every round-trip probe and wait for the delays they
   * ask for. Isolated like {@link emit}: a throwing or rejecting probe is reported
   * and the call still runs.
   */
  async emitRoundTrip(trip: RoundTripObservation): Promise<void> {
    const delays: Promise<void>[] = []
    for (const probe of [...this.tripProbes]) {
      try {
        const delay = probe(trip)
        if (delay !== undefined) delays.push(delay.catch((error) => this.onProbeError(error)))
      } catch (error) {
        this.onProbeError(error)
      }
    }
    if (delays.length > 0) await Promise.all(delays)
  }
}

/** Anything that identifies the bun connection an executor was composed over. */
export interface StatementProbeHolder {
  readonly db: object
}

/**
 * One hub per bun connection, retained only as long as that connection is.
 *
 * A probe may attach before or after executor composition: the bare-repository
 * budget tests attach first, while store-level measurements attach after boot.
 * Observation still happens only at the driver session; the connection is a
 * stable lookup key, never an execution seam.
 */
const hubsByConnection = new WeakMap<object, StatementProbeHub>()
const attributionInstalled = new WeakSet<StatementProbeHub>()

export function statementProbeHubFor(connection: object): StatementProbeHub {
  const held = hubsByConnection.get(connection)
  if (held) return held
  const hub = new StatementProbeHub()
  hubsByConnection.set(connection, hub)
  return hub
}

/** Attach a late probe to the driver hub for a bun-backed holder. */
export function probeStatements(holder: StatementProbeHolder, probe: StatementProbe): () => void {
  return statementProbeHubFor(holder.db).attach(probe)
}

/** Attach a late round-trip probe to the driver hub of `holder` (see {@link RoundTripObservation}). */
export function probeRoundTrips(holder: StatementProbeHolder, probe: RoundTripProbe): () => void {
  return statementProbeHubFor(holder.db).attachRoundTrips(probe)
}

/**
 * Hold every round trip on `holder`'s store for `latencyMs` before it is made: the
 * hosted round trip on a store whose own round trips cost nothing (SQLite) or almost
 * nothing (a local Postgres). Returns its detach.
 */
export function injectRoundTripLatency(
  holder: StatementProbeHolder,
  latencyMs: number,
): () => void {
  if (!(latencyMs >= 0)) throw new Error(`latency must be a non-negative number, got ${latencyMs}`)
  return probeRoundTrips(holder, () => sleepFor(latencyMs))
}

/**
 * Wait `ms`, to a tenth of a millisecond: a timer for the whole milliseconds, then a
 * yield loop for the rest, since timers round to whole milliseconds and 2.6 ms is the
 * number being modelled.
 */
async function sleepFor(ms: number): Promise<void> {
  const until = performance.now() + ms
  // One millisecond short: a timer fires late, never early.
  const whole = Math.floor(ms) - 1
  if (whole > 0) await new Promise((resolve) => setTimeout(resolve, whole))
  while (performance.now() < until) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Install the process profiler exactly once on a connection's hub.
 *
 * It asks for issue sites only while caller stacks are on, which is the level
 * that reads them ({@link queryCallerStacksEnabled}). Below that the hub keeps
 * its cheap disabled path and no stack is built anywhere.
 */
export function installQueryAttributionProbe(hub: StatementProbeHub): void {
  if (attributionInstalled.has(hub)) return
  attributionInstalled.add(hub)
  hub.attach(queryAttributionProbe, { wantsIssueSite: queryCallerStacksEnabled })
}

/**
 * The profiler, as a probe (spec §6 rule 8: observability moves WITH the
 * queries, at the execution seam, not the logger).
 *
 * It records into the same window and lifetime maps the `SqlDatabase` wrapper
 * has always recorded into, so `formatTopQueries`, the stall reporter and the
 * lifetime totals keep reading one set of numbers whichever seam produced them.
 * Caller stacks ride along inside `recordQuery`, still gated at the `full`
 * profile level.
 *
 * A batch member is attributed `durationMs / batchSize` (and its read bytes
 * likewise), which sums to the batch's real cost instead of multiplying it.
 */
export const queryAttributionProbe: StatementProbe = (observation) => {
  recordQuery(
    observation.sql,
    observation.durationMs / observation.batchSize,
    observation.rows,
    observation.issueStack,
    observation.readBytes === undefined ? undefined : observation.readBytes / observation.batchSize,
  )
}

/**
 * Wrap a driver so every statement any lane runs is observed on completion.
 *
 * Returns the driver UNCHANGED when the hub has no probes AND can never gain
 * one — it cannot know that, so it always wraps and lets {@link
 * StatementProbeHub.active} be the per-statement gate. `kind`, `lanes`,
 * `limits`, `classify`, `client` and `close` are forwarded untouched, and
 * `openReader` stays ABSENT when the driver has none: it is a capability the
 * executor tests for, and manufacturing one here would tell `outsideTransaction`
 * that a second connection exists.
 */
export function instrumentDriver<TClient>(
  driver: StoreDriver<TClient>,
  hub: StatementProbeHub,
): StoreDriver<TClient> {
  const reader = driver.openReader?.bind(driver)
  return {
    kind: driver.kind,
    ...(driver.dialect ? { dialect: driver.dialect } : {}),
    lanes: driver.lanes,
    limits: driver.limits,
    ...(driver.classify ? { classify: driver.classify.bind(driver) } : {}),
    async open(lane) {
      return observeSession(await driver.open(lane), hub)
    },
    ...(reader ? { openReader: async () => observeSession(await reader(), hub) } : {}),
    client: (route, routeBatch) => driver.client(route, routeBatch),
    close: async () => await driver.close(),
  }
}

/**
 * Where a lease's transaction stands, as the Postgres driver tracks it: `pending` is
 * a BEGIN that goes out with the next statement. Tracked whether or not anyone counts,
 * so a round-trip probe attached between two leases reads every later one right.
 */
type TripState = 'none' | 'pending' | 'open'

/**
 * The round-trip model of one lease ({@link RoundTripObservation}): which call waits
 * for the server, given where the transaction stands.
 */
class RoundTripLedger {
  private state: TripState = 'none'
  private lane: Lane | undefined

  constructor(private readonly hub: StatementProbeHub) {}

  get counting(): boolean {
    return this.hub.countingRoundTrips
  }

  /**
   * Report one round trip. Undefined, with no await anywhere, while nobody counts: a
   * hop added to every statement would move the microtask timing that frame caches
   * and the delta funnel's coalescing read.
   */
  private trip(
    call: RoundTripObservation['call'],
    statements: readonly Statement[] = [],
    root = false,
  ): Promise<void> | undefined {
    if (!this.hub.countingRoundTrips) return undefined
    const first = statements[0]
    return this.hub.emitRoundTrip({
      call,
      lane: root ? undefined : this.lane,
      root,
      statements: statements.length,
      ...(first === undefined ? {} : { key: queryKey(first.sql) }),
    })
  }

  /** Before `begin(lane)`. */
  beforeBegin(lane: Lane): Promise<void> | undefined {
    this.lane = lane
    if (lane === 'exclusive') return undefined
    // A write in a workspace locks it at once; anything else waits for a statement.
    if (lane === 'write' && currentStoreContext()?.kind === 'workspace') {
      this.state = 'open'
      return this.trip('begin')
    }
    this.state = 'pending'
    return undefined
  }

  /** `begin` failed: the driver ended what it opened. */
  beginFailed(): void {
    this.state = 'none'
    this.lane = undefined
  }

  /** Before a statement or a non-empty batch. */
  beforeStatements(
    call: 'statement' | 'batch',
    statements: readonly Statement[],
  ): Promise<void> | undefined {
    if (statements.length === 0) return undefined
    if (this.state === 'none') return this.trip(call, statements, true)
    this.state = 'open'
    return this.trip(call, statements)
  }

  /** A batch inside a transaction failed: its savepoint is rolled back. */
  batchFailed(): Promise<void> | undefined {
    return this.state === 'none' ? undefined : this.trip('batch-undo')
  }

  /** Before COMMIT or ROLLBACK: one round trip if the transaction was ever sent. */
  beforeEnd(call: 'commit' | 'rollback'): Promise<void> | undefined {
    const sent = this.state === 'open'
    this.state = 'none'
    const wait = sent ? this.trip(call) : undefined
    this.lane = undefined
    return wait
  }

  /** Before SAVEPOINT, which takes a pending BEGIN with it. */
  beforeSavepoint(): Promise<void> | undefined {
    if (this.state === 'pending') this.state = 'open'
    return this.trip('savepoint')
  }

  /** Before RELEASE SAVEPOINT or ROLLBACK TO SAVEPOINT. */
  beforeSavepointEnd(
    call: 'release-savepoint' | 'rollback-to-savepoint',
  ): Promise<void> | undefined {
    return this.trip(call)
  }

  /** Before close: a transaction still open is rolled back. */
  beforeClose(): Promise<void> | undefined {
    const open = this.state === 'open'
    this.state = 'none'
    return open ? this.trip('close-rollback') : undefined
  }
}

/** Wrap one lease. Transaction boundaries are forwarded verbatim: they are the
 *  driver's own DDL, not statements a repository issued. They are seen only by the
 *  round-trip ledger. */
function observeSession(session: DriverSession, hub: StatementProbeHub): DriverSession {
  const trips = new RoundTripLedger(hub)
  return {
    async execute(statement) {
      // BEFORE any await, and only when the statement did not already arrive
      // with a nearer one: see StatementObservation.issueStack.
      const doorStack =
        hub.active && hub.captureIssueSites && statement.issueStack === undefined
          ? new Error('statement issued').stack
          : undefined
      const trip = trips.beforeStatements('statement', [statement])
      if (trip) await trip
      if (!hub.active) return await session.execute(statement)
      // The driver's SQLite work is the SYNCHRONOUS body of `execute`, so the
      // read counter is taken around the call and before its await: that window
      // holds this statement's reads and no one else's.
      const readBefore = hub.attributing ? sampleStatementRead(statement.sql) : undefined
      const startedAt = performance.now()
      let result: StatementResult | undefined
      let readBytes: number | undefined
      try {
        const pending = claim(hub, () => session.execute(statement))
        readBytes = readBytesSince(readBefore)
        result = await pending
        return result
      } finally {
        hub.emit(
          observationOf(
            statement,
            result,
            performance.now() - startedAt,
            1,
            0,
            doorStack,
            readBytes ?? readBytesSince(readBefore),
          ),
        )
      }
    },
    async executeBatch(statements) {
      const doorStack =
        hub.active &&
        hub.captureIssueSites &&
        statements.some((each) => each.issueStack === undefined)
          ? new Error('statement issued').stack
          : undefined
      const trip = trips.beforeStatements('batch', statements)
      if (trip) await trip
      if (!hub.active) return await batchCounted(trips, () => session.executeBatch(statements))
      const readBefore = hub.attributing
        ? sampleBatchRead(statements.map((each) => each.sql))
        : undefined
      const startedAt = performance.now()
      let results: readonly StatementResult[] | undefined
      let readBytes: number | undefined
      try {
        const pending = claim(hub, () =>
          batchCounted(trips, () => session.executeBatch(statements)),
        )
        readBytes = readBytesSince(readBefore)
        results = await pending
        return results
      } finally {
        readBytes ??= readBytesSince(readBefore)
        const durationMs = performance.now() - startedAt
        // Every member is reported even when the batch failed part-way: the
        // batch is atomic, so none of it applied, and a probe counting round
        // trips still needs to see the call that was made.
        statements.forEach((statement, index) => {
          hub.emit(
            observationOf(
              statement,
              results?.[index],
              durationMs,
              statements.length,
              index,
              doorStack,
              readBytes,
            ),
          )
        })
      }
    },
    begin: async (lane) => {
      const trip = trips.beforeBegin(lane)
      if (trip) await trip
      try {
        await session.begin(lane)
      } catch (error) {
        trips.beginFailed()
        throw error
      }
    },
    commit: async () => {
      const trip = trips.beforeEnd('commit')
      if (trip) await trip
      await session.commit()
    },
    rollback: async () => {
      const trip = trips.beforeEnd('rollback')
      if (trip) await trip
      await session.rollback()
    },
    enterSavepoint: async (name) => {
      const trip = trips.beforeSavepoint()
      if (trip) await trip
      await session.enterSavepoint(name)
    },
    releaseSavepoint: async (name) => {
      const trip = trips.beforeSavepointEnd('release-savepoint')
      if (trip) await trip
      await session.releaseSavepoint(name)
    },
    rollbackToSavepoint: async (name) => {
      const trip = trips.beforeSavepointEnd('rollback-to-savepoint')
      if (trip) await trip
      await session.rollbackToSavepoint(name)
    },
    close: async () => {
      const trip = trips.beforeClose()
      if (trip) await trip
      await session.close()
    },
  }
}

/**
 * Run a batch and, when it fails inside a transaction, count the round trip that
 * rolls its savepoint back. Returns the driver's promise itself when nothing counts,
 * so the synchronous part of the call stays inside the caller's claim.
 */
function batchCounted(
  trips: RoundTripLedger,
  run: () => Promise<readonly StatementResult[]>,
): Promise<readonly StatementResult[]> {
  if (!trips.counting) return run()
  return run().catch(async (error: unknown) => {
    const trip = trips.batchFailed()
    if (trip) await trip
    throw error
  })
}

/**
 * Hold the attribution claim over the driver call's SYNCHRONOUS body, so a
 * `SqlDatabase` wrapper underneath this seam does not record the same execution a
 * second time (POD-3852; see `claimQueryAttribution` for why outer wins).
 *
 * The call stays INSIDE the caller's `try` and the claim is released the instant
 * the driver hands its promise back — never across the `await`. Both matter: a
 * driver that throws synchronously must still be observed, and a claim spanning
 * an await would silence unrelated statements that ran in the gap.
 *
 * When no probe here attributes, nothing is claimed and the wrapper keeps
 * recording. One instrument per execution, never two and never none.
 */
function claim<T>(hub: StatementProbeHub, call: () => T): T {
  return hub.attributing ? claimQueryAttribution(call) : call()
}

function observationOf(
  statement: Statement,
  result: StatementResult | undefined,
  durationMs: number,
  batchSize: number,
  batchIndex: number,
  doorStack?: string,
  readBytes?: number,
): StatementObservation {
  // The nearer capture wins: the query client took its stack in the caller's
  // turn, the door took its own one await later. See StatementObservation.
  const issueStack = statement.issueStack ?? doorStack
  return {
    sql: statement.sql,
    key: queryKey(statement.sql),
    method: statement.method,
    intent: statement.intent,
    // `run` returns no rows by contract; counting `result.rows.length` for it
    // would be zero anyway, but saying so here keeps parity with the old
    // wrapper explicit rather than incidental.
    rows: result === undefined ? 0 : statement.method === 'run' ? 0 : result.rows.length,
    ...(result === undefined || statement.method === 'run' ? {} : { resultRows: result.rows }),
    durationMs,
    failed: result === undefined,
    batchSize,
    batchIndex,
    seam: 'driver',
    ...(issueStack === undefined ? {} : { issueStack }),
    ...(readBytes === undefined ? {} : { readBytes }),
  }
}
