/**
 * THE IMMUTABILITY CENSUS: NO POSTGRES WRITE BREAKS A SHIPPING GUARD (POD-6986, POD-6958
 * design 2.5).
 *
 * SQLite refuses a forbidden write on the shipping and receipt tables in its triggers.
 * Postgres has none, so the rules are declared in `store/append-only.ts` and kept in the
 * write path. This census is what makes the write path complete: every registered query
 * definition (the store's and every other server file's, as the write census reaches
 * them) is built, at each family shape, on a Postgres drizzle instance over the Postgres
 * tables, and each write its SQL makes on a guarded table is held to the rules:
 *
 *  - no UPDATE or DELETE of an append-only table (`APPEND_ONLY`);
 *  - an UPDATE assigns no frozen column and carries its rule's fence (`UPDATE_RULES`): an
 *    order update names a live state, an attempt's needs `finished_at IS NULL`, a hold's
 *    `resolved_at IS NULL`, a manifest's sets only its release on an open manifest;
 *  - a DELETE of an active claim carries its released-manifest fence (`DELETE_RULES`).
 *
 * It also holds the declarations to the SQLite triggers themselves: the tables they
 * guard and the texts they raise are exactly the module's, so a new trigger, or a
 * changed text, fails here until Postgres guards it too.
 *
 * Database-free on Postgres: it opens a SQLite store in memory only to reach the
 * definitions made inside methods and to read the triggers.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { pgSyncTables } from '@podium/sync/adapters/pg/schema'
import { and, eq, notInArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as pgSchema from '../migrations/pg/schema'
import type { SessionStore } from '../store'
import { captureWrite, renderedWrites } from '../sync/capture-pg'
import {
  FAMILY_SHAPES,
  isFragment,
  type KeyedDefinition,
  keyedDefinitions,
  REPO_ROOT,
  reachMethodDefinitions,
  type SourceTree,
  trackedSources,
} from '../test-support/definition-census'
import { openTestStore } from '../test-support/open-test-store'
import { queryDefinitionSites } from '../test-support/prepared-census'
import {
  APPEND_ONLY,
  GUARD_TEXT,
  GUARDED_TABLES,
  guardRefusalOf,
  immutabilityViolations,
  ShippingGuardError,
} from './append-only'
import type { bindingFor } from './executor/binding'
import type { QueryClient } from './executor/driver'
import { buildPgStoreDrizzle } from './executor/pg-drizzle'
import { translatePgError } from './executor/pg-types'
import type { StoreDrizzle } from './executor/sync-drizzle'

const PG_TABLES = Object.freeze({ ...pgSchema, ...pgSyncTables })
type Tables = ReturnType<typeof bindingFor>

/** A Postgres drizzle instance over the twins whose client refuses to run anything. */
function pgRecordingDrizzle(): StoreDrizzle {
  const refuse = (): never => {
    throw new Error('the immutability census builds queries; it never runs them')
  }
  const client: QueryClient = {
    run: refuse,
    get: refuse,
    all: refuse,
    writeGet: refuse,
    writeAll: refuse,
    batch: refuse,
  }
  return buildPgStoreDrizzle(client, PG_TABLES)
}

/**
 * The SQL of every statement in what a definition built, with each literal string
 * parameter written into its place: drizzle binds `notInArray(state, ['shipped', …])` as
 * parameters, and a fence is read from the values it names.
 */
function statementsOf(built: unknown, depth = 0): string[] {
  if (built === null || typeof built !== 'object') return []
  const query = built as {
    getQuery?: () => { sql: string; params: unknown[] }
    toSQL?: () => { sql: string; params: unknown[] }
  }
  const render = (q: { sql: string; params: unknown[] }) =>
    q.sql.replace(/\$(\d+)/g, (whole, n: string) => {
      const value = q.params[Number(n) - 1]
      return typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : whole
    })
  if (typeof query.getQuery === 'function') return [render(query.getQuery())]
  if (typeof query.toSQL === 'function' && !isFragment(built)) return [render(query.toSQL())]
  if (depth < 2) return Object.values(built).flatMap((value) => statementsOf(value, depth + 1))
  return []
}

/** What the census found: each definition's broken rules, and the guarded writes it read. */
interface Census {
  readonly violations: Map<string, string[]>
  readonly guarded: Map<string, string[]>
}

function census(keyed: readonly Pick<KeyedDefinition, 'key' | 'definition'>[]): Census {
  const db = pgRecordingDrizzle()
  const violations = new Map<string, string[]>()
  const guarded = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, key: string, lines: readonly string[]) => {
    if (lines.length > 0) map.set(key, [...new Set([...(map.get(key) ?? []), ...lines])])
  }
  for (const { key, definition } of keyed) {
    const shapes: readonly (string | number | undefined)[] =
      definition.kind === 'family' ? (FAMILY_SHAPES.get(key) ?? []) : [undefined]
    for (const shape of shapes) {
      let built: unknown
      try {
        built = (definition.build as (db: unknown, key: unknown) => unknown)(db, shape)
      } catch {
        continue // the dialect census reports a definition that does not build on Postgres
      }
      for (const text of statementsOf(built)) {
        const writes = renderedWrites(text).filter((write) => GUARDED_TABLES.has(write.table))
        add(
          guarded,
          key,
          writes.map((write) => `${write.op} ${write.table}`),
        )
        add(violations, key, immutabilityViolations(text, writes))
      }
    }
  }
  return { violations, guarded }
}

const SOURCE: SourceTree = {
  list: (dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true }).map((entry) =>
      relative(REPO_ROOT, join(REPO_ROOT, dir, String(entry)))
        .split('\\')
        .join('/'),
    ),
  read: (file) => readFileSync(join(REPO_ROOT, file), 'utf8'),
}

/** The files the census reads: the definition census's, and every other server file defining a query. */
function censusSources(tree: SourceTree): string[] {
  const shared = trackedSources(tree)
  const elsewhere = tree
    .list('apps/server/src')
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.startsWith('apps/server/src/store/') &&
        !path.startsWith('apps/server/src/test-support/') &&
        !path.includes('.test.') &&
        !path.includes('.type-test.') &&
        queryDefinitionSites(path, tree.read(path)).length > 0,
    )
  return [...shared, ...elsewhere]
}

/** A planted definition building `build` on the census's Postgres instance. */
const planted = (
  name: string,
  build: (db: StoreDrizzle, t: Tables) => unknown,
): Pick<KeyedDefinition, 'key' | 'definition'> => ({
  key: `apps/server/src/planted.ts:${name}`,
  definition: {
    kind: 'prepared',
    scope: 'workspace',
    site: new Error(),
    build: ((db: StoreDrizzle) => build(db, PG_TABLES as unknown as Tables)) as never,
  },
})

const violationsOf = (definition: Pick<KeyedDefinition, 'key' | 'definition'>): string[] =>
  census([definition]).violations.get(definition.key) ?? []

describe('the immutability census (design 2.5)', () => {
  let store: SessionStore
  let keyed: KeyedDefinition[]
  let triggers: { name: string; table: string; sql: string }[]
  beforeAll(async () => {
    store = await openTestStore(':memory:')
    const db = (store as unknown as { db: SqlDatabase }).db
    await reachMethodDefinitions(store, db)
    const sources = censusSources(SOURCE)
    const shared = new Set(trackedSources(SOURCE))
    for (const file of sources.filter((path) => !shared.has(path))) {
      await import(pathToFileURL(join(REPO_ROOT, file)).href)
    }
    keyed = keyedDefinitions(sources, SOURCE).keyed
    triggers = (
      db
        .prepare(
          "SELECT name, tbl_name AS \"table\", sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%RAISE(ABORT%' ORDER BY name",
        )
        .all() as { name: string; table: string; sql: string }[]
    ).filter((trigger) => !trigger.name.startsWith('sync_capture'))
  }, 60_000)
  afterAll(async () => {
    await store?.close()
  })

  it('finds no Postgres write that breaks a guard', () => {
    const { violations, guarded } = census(keyed)
    const lines = [...violations]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, found]) => `${key}: ${found.join('; ')}`)
    console.log(
      `immutability census: ${[...guarded.values()].flat().length} guarded writes in ${guarded.size} definitions, ${lines.length} breaking a rule\n${lines.join('\n')}`,
    )
    expect(lines).toEqual([])
  })

  it("reads the shipping repository's guarded writes", () => {
    const { guarded } = census(keyed)
    const at = (name: string) => guarded.get(`apps/server/src/store/shipping.ts:${name}`)
    expect(at('transitionOrderFenced')).toEqual(['u ship_orders'])
    expect(at('finishAttemptFenced')).toEqual(['u ship_attempts'])
    expect(at('resolveHoldFenced')).toEqual(['u ship_holds'])
    expect(at('releaseTrainFenced')).toEqual(['u ship_train_manifests'])
    expect(at('deleteActiveClaimsOfTrain')).toEqual(['d ship_train_active_claims'])
    expect(at('insertTrainMember')).toEqual(['i ship_train_members'])
    expect(at('insertActiveClaim')).toEqual(['i ship_train_active_claims'])
  })

  it('declares exactly the tables and texts the SQLite triggers guard', () => {
    const raised = (text: string) =>
      [...text.matchAll(/RAISE\(ABORT, '([^']+)'\)/g)].map((m) => m[1])
    expect([...new Set(triggers.map((trigger) => trigger.table))].sort()).toEqual(
      [...GUARDED_TABLES].sort(),
    )
    expect([...new Set(triggers.flatMap((trigger) => raised(trigger.sql)))].sort()).toEqual(
      [...new Set(Object.values(GUARD_TEXT))].sort(),
    )
  })

  it('fails on a planted UPDATE or DELETE of an append-only table', () => {
    expect(
      violationsOf(
        planted('editStep', (db, t) =>
          db
            .update(t.shipSteps)
            .set({ summary: sql.placeholder('summary') as never })
            .where(eq(t.shipSteps.id, sql.placeholder('id') as never))
            .prepare(),
        ),
      ),
    ).toEqual([`update ship_steps: ${GUARD_TEXT.ship_steps_immutable}`])
    expect(
      violationsOf(
        planted('dropReceipt', (db, t) =>
          db
            .delete(t.deliveryReceipts)
            .where(eq(t.deliveryReceipts.id, sql.placeholder('id') as never))
            .prepare(),
        ),
      ),
    ).toEqual([`delete from delivery_receipts: ${APPEND_ONLY.get('delivery_receipts')?.delete}`])
  })

  it('fails on a planted order update that moves a frozen column or skips the terminal fence', () => {
    const live = (t: Tables) =>
      and(
        eq(t.shipOrders.id, sql.placeholder('id') as never),
        notInArray(t.shipOrders.state, ['shipped', 'cancelled']),
      )
    expect(
      violationsOf(
        planted('retarget', (db, t) =>
          db
            .update(t.shipOrders)
            .set({ targetBranch: sql.placeholder('branch') as never })
            .where(live(t))
            .prepare(),
        ),
      ),
    ).toEqual([`update ship_orders sets target_branch: ${GUARD_TEXT.ship_orders_frozen_fields}`])
    expect(
      violationsOf(
        planted('rehome', (db, t) =>
          db
            .update(t.shipOrders)
            .set({ machineId: sql.placeholder('machine') as never })
            .where(live(t))
            .prepare(),
        ),
      ),
    ).toEqual([
      `update ship_orders sets machine_id: ${GUARD_TEXT.ship_orders_lane_custody_immutable}`,
    ])
    expect(
      violationsOf(
        planted('anyState', (db, t) =>
          db
            .update(t.shipOrders)
            .set({ holdCode: null })
            .where(eq(t.shipOrders.id, sql.placeholder('id') as never))
            .prepare(),
        ),
      ),
    ).toEqual([
      `update ship_orders without its fence: ${GUARD_TEXT.ship_orders_terminal_immutable}`,
    ])
    expect(
      violationsOf(
        planted('fenced', (db, t) =>
          db.update(t.shipOrders).set({ holdCode: null }).where(live(t)).prepare(),
        ),
      ),
    ).toEqual([])
  })

  it('fails on a planted claim release that does not wait for the manifest', () => {
    expect(
      violationsOf(
        planted('dropClaims', (db, t) =>
          db
            .delete(t.shipTrainActiveClaims)
            .where(eq(t.shipTrainActiveClaims.trainId, sql.placeholder('trainId') as never))
            .prepare(),
        ),
      ),
    ).toEqual([
      `delete from ship_train_active_claims without its fence: ${GUARD_TEXT.ship_train_active_claims_release_guard}`,
    ])
  })

  it('fails on a planted upsert that may update an append-only row', () => {
    expect(
      violationsOf(
        planted('reReceipt', (db, t) =>
          db
            .insert(t.deliveryReceipts)
            .values({ id: sql.placeholder('id') } as never)
            .onConflictDoUpdate({
              target: t.deliveryReceipts.id,
              set: { destinationSha: sql.placeholder('sha') as never },
            })
            .prepare(),
        ),
      ),
    ).toEqual([`upsert into delivery_receipts: ${GUARD_TEXT.delivery_receipts_immutable}`])
  })
})

describe('the guards captureWrite applies on Postgres (design 2.5)', () => {
  const db = pgRecordingDrizzle()
  const t = PG_TABLES as unknown as Tables
  const textOf = (build: () => { getSQL(): unknown }): string =>
    (db as unknown as { dialect: { sqlToQuery(q: unknown): { sql: string } } }).dialect.sqlToQuery(
      build().getSQL(),
    ).sql
  const refusedAtBuild = (build: () => { getSQL(): unknown }): unknown => {
    try {
      build().getSQL()
    } catch (error) {
      return error
    }
    return undefined
  }

  it('refuses an UPDATE, DELETE or upsert of an append-only table when it is built', () => {
    const update = refusedAtBuild(() =>
      captureWrite(
        db
          .update(t.deliveryReceipts)
          .set({ destinationSha: sql.placeholder('sha') as never })
          .where(eq(t.deliveryReceipts.id, sql.placeholder('id') as never)),
      ),
    )
    expect(update).toBeInstanceOf(ShippingGuardError)
    expect((update as Error).message).toBe(GUARD_TEXT.delivery_receipts_immutable)
    const remove = refusedAtBuild(() =>
      captureWrite(
        db
          .delete(t.shipOrderStackEdges)
          .where(eq(t.shipOrderStackEdges.upperOrderId, sql.placeholder('id') as never)),
      ),
    )
    expect((remove as Error).message).toBe(GUARD_TEXT.ship_order_stack_edges_immutable)
    const upsert = refusedAtBuild(() =>
      captureWrite(
        db
          .insert(t.deliveryReceipts)
          .values({ id: sql.placeholder('id') } as never)
          .onConflictDoUpdate({
            target: t.deliveryReceipts.id,
            set: { destinationSha: sql.placeholder('sha') as never },
          }),
      ),
    )
    expect((upsert as Error).message).toBe(GUARD_TEXT.delivery_receipts_immutable)
  })

  it('writes a conditional rule into the statement, over the rows the write touches', () => {
    const order = textOf(() =>
      captureWrite(
        db
          .update(t.shipOrders)
          .set({ targetBranch: sql.placeholder('branch') as never })
          .where(eq(t.shipOrders.id, sql.placeholder('id') as never)),
      ),
    )
    expect(order).toContain(
      `where ("ship_orders"."id" = $1) and CAST(CASE WHEN ("ship_orders"."id" = $2) IS NOT TRUE THEN NULL WHEN "ship_orders"."state" IN ('shipped', 'cancelled') THEN '${GUARD_TEXT.ship_orders_terminal_immutable}' WHEN "ship_orders"."workspace_id" IS NOT NULL THEN '${GUARD_TEXT.ship_orders_frozen_fields}' END AS integer) IS NULL for update`,
    )
    const hold = textOf(() =>
      captureWrite(
        db
          .insert(t.shipHolds)
          .values({ id: sql.placeholder('id') } as never)
          .onConflictDoUpdate({
            target: t.shipHolds.id,
            set: { detail: sql.placeholder('detail') as never },
          }),
      ),
    )
    expect(hold).toContain(
      ` where CAST(CASE WHEN "ship_holds"."resolved_at" IS NOT NULL THEN '${GUARD_TEXT.ship_holds_resolved_immutable}' END AS integer) IS NULL`,
    )
  })

  it("maps a guard's 22P02 to SQLite's trigger error, and passes every other failure through", () => {
    const guard = {
      code: '22P02',
      message: `invalid input syntax for type integer: "${GUARD_TEXT.ship_orders_terminal_immutable}"`,
    }
    const mapped = translatePgError(guard) as ShippingGuardError
    expect(mapped).toBeInstanceOf(ShippingGuardError)
    expect({
      name: mapped.name,
      message: mapped.message,
      code: mapped.code,
      errno: mapped.errno,
      cause: (mapped as { cause?: unknown }).cause,
    }).toEqual({
      name: 'SQLiteError',
      message: GUARD_TEXT.ship_orders_terminal_immutable,
      code: 'SQLITE_CONSTRAINT_TRIGGER',
      errno: 1811,
      cause: undefined,
    })
    // A genuine integer syntax error, another code with a guard text, and a text that only
    // contains one are not refusals.
    const genuine = { code: '22P02', message: 'invalid input syntax for type integer: "abc"' }
    expect(translatePgError(genuine)).toBe(genuine)
    expect(guardRefusalOf({ ...guard, code: '23505' })).toBeUndefined()
    expect(
      guardRefusalOf({
        code: '22P02',
        message: `invalid input syntax for type integer: "x ${GUARD_TEXT.ship_orders_terminal_immutable}"`,
      }),
    ).toBeUndefined()
  })
})
