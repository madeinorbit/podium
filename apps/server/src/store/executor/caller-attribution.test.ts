/**
 * WHO ISSUED IT, ACROSS THE EXECUTOR'S AWAITS [POD-3851].
 *
 * A `full` dump on the live host reported, for all six of its hottest
 * statements, caller stacks made only of `bun-driver.ts`, `scheduler.ts`,
 * `executor.ts` and `processTicksAndRejections` — no module frame anywhere, so
 * the one question the stacks exist to answer went unanswered. The cause is
 * WHERE the stack was built, not what was done with it: the profiler built it
 * from the probe, which runs one await past the driver call.
 *
 * The fixture reproduces exactly that gap. `route` awaits before reaching the
 * session, the way the real router does through admission and the in-flight
 * tracker, and the query goes through drizzle so the call arrives the way a
 * converted repository's does.
 *
 * WHY THIS IS ITS OWN FILE, and not another describe in `statement-probe.test.ts`:
 * the recorder drops frames whose path contains `statement-probe`, so a caller
 * stand-in living in that file would be filtered out as plumbing and the test
 * would fail for a reason that has nothing to do with the code under test.
 */

import { callerFrames } from '@podium/runtime/query-attribution'
import { openDatabase, type SqlDatabase } from '@podium/runtime/sqlite'
import { eq } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBunSqliteDriver } from './bun-driver'
import { queryClientOver } from './driver'
import {
  installQueryAttributionProbe,
  instrumentDriver,
  type StatementObservation,
  StatementProbeHub,
} from './statement-probe'
import { storeQueriesOver } from './sync-drizzle'

const open: SqlDatabase[] = []

afterEach(() => {
  for (const handle of open.splice(0)) {
    try {
      handle.close()
    } catch {
      // Already closed by the driver under test; closing twice is not the point.
    }
  }
})

function fresh(): SqlDatabase {
  const handle = openDatabase(':memory:')
  open.push(handle)
  return handle
}

describe('caller attribution across the executor’s awaits', () => {
  const notes = sqliteTable('probe_notes', {
    id: integer('id').primaryKey(),
    body: text('note_body').notNull(),
  })

  interface Seam {
    readonly db: ReturnType<typeof storeQueriesOver>['rootDb']
    readonly client: ReturnType<typeof queryClientOver>
    readonly seen: StatementObservation[]
    /** What the profiler would have recorded by building its own stack. */
    readonly probeBuilt: string[]
  }

  const seam = async (captureIssueSites: boolean): Promise<Seam> => {
    const handle = fresh()
    handle.exec('CREATE TABLE probe_notes (id INTEGER PRIMARY KEY, note_body TEXT NOT NULL)')
    handle.prepare("INSERT INTO probe_notes (id, note_body) VALUES (1, 'first')").run()
    const seen: StatementObservation[] = []
    const probeBuilt: string[] = []
    const hub = new StatementProbeHub()
    hub.attach(
      (observation) => {
        seen.push(observation)
        probeBuilt.push(new Error('probe').stack ?? '')
      },
      { wantsIssueSite: true },
    )
    const driver = instrumentDriver(createBunSqliteDriver({ database: handle }), hub)
    const session = await driver.open('write')
    const client = queryClientOver(
      async (statement) => {
        // The gap the real router has: admission and the in-flight tracker are
        // awaited between the caller and the driver's door.
        await Promise.resolve()
        return await session.execute(statement)
      },
      async (statements) => {
        await Promise.resolve()
        return await session.executeBatch(statements)
      },
      captureIssueSites,
    )
    const queries = storeQueriesOver(client, async (fn) => await fn(client))
    return { db: queries.rootDb, client, seen, probeBuilt }
  }

  /**
   * Stand-ins for a repository module. Function DECLARATIONS, so the frame
   * carries the name the assertions look for — the same reason a dump reader
   * can tell one caller from another.
   */
  async function readTheNoteLikeARepositoryWould(db: Seam['db']): Promise<unknown> {
    return await db.select().from(notes).where(eq(notes.id, 1)).get()
  }

  async function issueTheBatchLikeARepositoryWould(client: Seam['client']): Promise<unknown> {
    return await client.batch([
      { sql: 'SELECT 1', params: [], method: 'get', intent: 'read' },
      { sql: 'SELECT 2', params: [], method: 'get', intent: 'read' },
    ])
  }

  it('names the module that issued the statement, where a probe-built stack cannot', async () => {
    const { db, seen, probeBuilt } = await seam(true)
    expect(await readTheNoteLikeARepositoryWould(db)).toEqual({ id: 1, body: 'first' })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.issueStack).toContain('readTheNoteLikeARepositoryWould')
    // NON-VACUOUS, and the regression itself: the stack the profiler used to
    // build is taken one await later and reaches no module frame at all. If
    // this ever starts naming the caller the capture below has stopped being
    // the thing under test.
    expect(probeBuilt[0]).not.toContain('readTheNoteLikeARepositoryWould')
  })

  /**
   * THE WHOLE PATH, AT THE LEVEL THAT READS IT.
   *
   * A test run resolves to `off` (config.ts), so the modules are re-imported
   * with the level stated in the environment — the profiler probe and the
   * recorder together, from one fresh registry, so the probe is bound to the
   * recorder that is actually gated on. Without that, the one line that forwards
   * the captured stack could be deleted and every other test here would stay
   * green while a dump went back to naming the executor.
   */
  it('reaches the dump: a full-level recorder shows the caller for that statement', async () => {
    const { db, seen } = await seam(true)
    await readTheNoteLikeARepositoryWould(db)
    const observation = seen[0]
    expect(observation?.issueStack).toContain('readTheNoteLikeARepositoryWould')
    if (!observation) return

    vi.resetModules()
    vi.stubEnv('PODIUM_LOOP_PROFILE', 'full')
    try {
      const attribution = await import('@podium/runtime/query-attribution')
      const probed = await import('./statement-probe')
      expect(attribution.queryCallerStacksEnabled).toBe(true)
      probed.queryAttributionProbe(observation)
      const samples = attribution.queryCallerStacks().get(attribution.queryKey(observation.sql))
      expect(samples?.[0]?.count).toBe(1)
      expect(samples?.[0]?.stack).toContain('readTheNoteLikeARepositoryWould')
      // The plumbing it was captured through is dropped, so the TOP frame is
      // the caller — which is what a reader of the dump actually looks at.
      expect(samples?.[0]?.stack.split('\n')[0]).toContain('readTheNoteLikeARepositoryWould')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('gives a batch one stack, taken where the batch was issued', async () => {
    const { client, seen } = await seam(true)
    await issueTheBatchLikeARepositoryWould(client)

    expect(seen).toHaveLength(2)
    for (const observation of seen) {
      // The TOP frame, not merely a frame somewhere in it: a stack taken at the
      // router would still MENTION the issuer through async reconstruction and
      // start at the router, which is the difference that matters to a reader.
      expect(callerFrames(observation.issueStack ?? '').split('\n')[0]).toContain(
        'issueTheBatchLikeARepositoryWould',
      )
    }
    // ONE capture for the round trip, not one per member: a batch has one call
    // site, and pricing the capture by batch size is what the cap exists against.
    expect(seen[0]?.issueStack).toBe(seen[1]?.issueStack)
  })

  /**
   * The FALLBACK, and the one thing that decides whether it exists.
   *
   * Not every statement comes from a query client: migrations, pragmas and the
   * frame flusher reach the driver directly, and for those the door is the only
   * capture point there is. It is refcounted on the hub, so the profiler has to
   * ask — and it must ask exactly at the level that reads stacks, or a `full`
   * dump silently loses every statement no repository issued.
   */
  it('has the profiler ask for door captures exactly at the level that reads them', async () => {
    const off = new StatementProbeHub()
    installQueryAttributionProbe(off)
    expect(off.captureIssueSites).toBe(false)

    vi.resetModules()
    vi.stubEnv('PODIUM_LOOP_PROFILE', 'full')
    try {
      const probed = await import('./statement-probe')
      const on = new probed.StatementProbeHub()
      expect(on.captureIssueSites).toBe(false)
      probed.installQueryAttributionProbe(on)
      expect(on.captureIssueSites).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('captures nothing while caller stacks are off — the door still answers', async () => {
    const { db, seen } = await seam(false)
    await readTheNoteLikeARepositoryWould(db)

    expect(seen).toHaveLength(1)
    // The hub was asked for issue sites, so the door captured; that stack is
    // the fallback for statements no query client issued, and it names the
    // executor rather than the caller — which is precisely the old behaviour.
    expect(seen[0]?.issueStack).toBeDefined()
    expect(seen[0]?.issueStack).not.toContain('readTheNoteLikeARepositoryWould')
  })
})
