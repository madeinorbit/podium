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
import { queryKey, recordQuery } from '@podium/runtime/query-attribution'
import type {
  DriverSession,
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
  /** Which seam saw it. `legacy-handle` disappears with the executor's `legacy` field. */
  readonly seam: 'driver' | 'legacy-handle'
  /**
   * The RAW stack captured where the statement entered the driver, present only
   * while a probe asked for it ({@link StatementProbeHub.captureIssueSites}).
   *
   * WHY IT IS CAPTURED HERE AND NOT IN THE PROBE. A probe runs in the `finally`
   * AFTER the driver call was awaited, and by then the caller's frames are gone:
   * an audit that builds its own stack sees the executor and nothing above it.
   * The entry to `execute` is still on the caller's synchronous frame, so this is
   * the last place the call site exists at all.
   *
   * IT IS RAW AND UNPARSED on purpose. Which frame is "the call site" is the
   * consumer's question — the intent audit wants the first frame outside
   * `store/executor/`, a future profiler may want the repository method — and
   * this module has no business deciding it for them.
   */
  readonly issueStack?: string
}

/** The one injectable seam. Everything else in this module is plumbing. */
export type StatementProbe = (observation: StatementObservation) => void

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

  /**
   * Where a throwing probe is reported. Injectable rather than rethrown,
   * because rethrowing on a later turn makes an unhandled rejection out of a
   * diagnostic and takes a test run down with it — and swallowing it silently
   * is how a probe that stopped counting goes unnoticed. So: it is reported,
   * once, somewhere a caller chose.
   */
  constructor(
    private readonly onProbeError: (error: unknown) => void = (error) => {
      log.warn('a statement probe threw and was isolated', { error })
    },
  ) {}

  /** True while anyone is listening. Checked before any timing work happens. */
  get active(): boolean {
    return this.probes.length > 0
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
    let detached = false
    return () => {
      if (detached) return
      detached = true
      if (options.wantsIssueSite) this.siteRequests -= 1
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
}

/**
 * The profiler, as a probe (spec §6 rule 8: observability moves WITH the
 * queries, at the execution seam, not the logger).
 *
 * It records into the same window and lifetime maps the `SqlDatabase` wrapper
 * has always recorded into, so `formatTopQueries`, the stall reporter and the
 * lifetime totals keep reading one set of numbers whichever seam produced them.
 * Caller stacks ride along inside `recordQuery`, still gated behind
 * `PODIUM_LOOP_PROFILE_STACKS`.
 *
 * A batch member is attributed `durationMs / batchSize`, which sums to the
 * batch's real cost instead of multiplying it.
 */
export const queryAttributionProbe: StatementProbe = (observation) => {
  recordQuery(observation.sql, observation.durationMs / observation.batchSize, observation.rows)
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
    lanes: driver.lanes,
    limits: driver.limits,
    ...(driver.classify ? { classify: driver.classify.bind(driver) } : {}),
    async open(lane) {
      return observeSession(await driver.open(lane), hub)
    },
    ...(reader ? { openReader: async () => observeSession(await reader(), hub) } : {}),
    client: (route, routeBatch) => driver.client(route, routeBatch),
    close: () => driver.close(),
  }
}

/** Wrap one lease. Transaction boundaries are forwarded verbatim: they are the
 *  driver's own DDL, not statements a repository issued. */
function observeSession(session: DriverSession, hub: StatementProbeHub): DriverSession {
  return {
    async execute(statement) {
      if (!hub.active) return session.execute(statement)
      // BEFORE the await: see StatementObservation.issueStack.
      const issueStack = hub.captureIssueSites ? new Error('statement issued').stack : undefined
      const startedAt = performance.now()
      let result: StatementResult | undefined
      try {
        result = await session.execute(statement)
        return result
      } finally {
        hub.emit(observationOf(statement, result, performance.now() - startedAt, 1, 0, issueStack))
      }
    },
    async executeBatch(statements) {
      if (!hub.active) return session.executeBatch(statements)
      const issueStack = hub.captureIssueSites ? new Error('statement issued').stack : undefined
      const startedAt = performance.now()
      let results: readonly StatementResult[] | undefined
      try {
        results = await session.executeBatch(statements)
        return results
      } finally {
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
              issueStack,
            ),
          )
        })
      }
    },
    begin: (lane) => session.begin(lane),
    commit: () => session.commit(),
    rollback: () => session.rollback(),
    enterSavepoint: (name) => session.enterSavepoint(name),
    releaseSavepoint: (name) => session.releaseSavepoint(name),
    rollbackToSavepoint: (name) => session.rollbackToSavepoint(name),
    close: () => session.close(),
  }
}

function observationOf(
  statement: Statement,
  result: StatementResult | undefined,
  durationMs: number,
  batchSize: number,
  batchIndex: number,
  issueStack?: string,
): StatementObservation {
  return {
    sql: statement.sql,
    key: queryKey(statement.sql),
    method: statement.method,
    intent: statement.intent,
    // `run` returns no rows by contract; counting `result.rows.length` for it
    // would be zero anyway, but saying so here keeps parity with the old
    // wrapper explicit rather than incidental.
    rows: result === undefined ? 0 : statement.method === 'run' ? 0 : result.rows.length,
    durationMs,
    failed: result === undefined,
    batchSize,
    batchIndex,
    seam: 'driver',
    ...(issueStack === undefined ? {} : { issueStack }),
  }
}
