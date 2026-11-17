// workspace-scoped (POD-6959)
/**
 * THE CHECKOUTS ON EACH MACHINE AT REST (POD-6644): the `checkouts` table, one
 * row per registered repository root and per worktree of one, keyed
 * `(machine_id, path)`. The synced `checkout` record is the row.
 *
 * The server writes these from its machines' scans and writes only what moved:
 * a checkout that appeared or went, or a branch that was checked out. The
 * reconcile that decides that (`modules/checkouts/service.ts`) reads one
 * machine's rows, compares them with the scan, and hands the differences back
 * here in one transaction.
 */

import type { CheckoutKind, CheckoutWire, MachineId, RepoId } from '@podium/model'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import type { CheckoutReach } from '../checkout-reach'
import type {
  StoreTables,
  TransactionRunner,
  WorkspaceDb,
  WorkspaceQueries,
} from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  inWorkspace,
  param,
  prepared,
  preparedFamily,
  WORKSPACE,
} from './executor/sync-drizzle'

/** One stored checkout. */
export interface CheckoutRow {
  readonly machineId: MachineId
  readonly path: string
  readonly root: string
  readonly kind: CheckoutKind
  readonly repoId: RepoId | null
  readonly branch: string | null
  readonly originUrl: string | null
  readonly locked: boolean
  readonly prunable: boolean
}

const COLUMNS = (t: StoreTables) => ({
  machineId: t.checkouts.machineId,
  path: t.checkouts.path,
  root: t.checkouts.root,
  kind: t.checkouts.kind,
  repoId: t.checkouts.repoId,
  branch: t.checkouts.branch,
  originUrl: t.checkouts.originUrl,
  locked: t.checkouts.locked,
  prunable: t.checkouts.prunable,
})

// Every query this repository runs, prepared once per store [POD-6147].

const checkoutsOfMachine = prepared((db, t) =>
  db
    .select(COLUMNS(t))
    .from(t.checkouts)
    .where(
      inWorkspace(
        t.checkouts,
        eq(t.checkouts.machineId, param(t.checkouts.machineId, 'machineId')),
        isNull(t.checkouts.removedAt),
      ),
    )
    .orderBy(asc(t.checkouts.path))
    .prepare(),
)

/** Every row: the `checkout` kind's full truth for the boot reconcile. */
const allCheckouts = prepared((db, t) =>
  db
    .select(COLUMNS(t))
    .from(t.checkouts)
    .where(inWorkspace(t.checkouts, isNull(t.checkouts.removedAt)))
    .orderBy(asc(t.checkouts.machineId), asc(t.checkouts.path))
    .prepare(),
)

/** The live checkouts of several machines, whole rows, for building `checkout`
 *  records by id (POD-6763). */
const checkoutsOfMachines = preparedFamily((db, t, size: number) =>
  db
    .select(COLUMNS(t))
    .from(t.checkouts)
    .where(
      inWorkspace(
        t.checkouts,
        inListOf(t.checkouts.machineId, size),
        isNull(t.checkouts.removedAt),
      ),
    )
    .prepare(),
)

/** The live checkout paths of several machines, each marked root or not: the
 *  feed's re-send when a member's reach on a machine moves. */
const pathsOfMachines = preparedFamily((db, t, size: number) =>
  db
    .select({ machineId: t.checkouts.machineId, path: t.checkouts.path, root: t.checkouts.root })
    .from(t.checkouts)
    .where(
      inWorkspace(
        t.checkouts,
        inListOf(t.checkouts.machineId, size),
        isNull(t.checkouts.removedAt),
      ),
    )
    .prepare(),
)

/** The registered roots of several machines (a root's row has `root = path`):
 *  how the feed tells a root, which managers may read, from a worktree.
 *  Removed roots too, through their tombstones: a root's removal goes to the
 *  same readers the root had. */
const rootPathsOfMachines = preparedFamily((db, t, size: number) =>
  db
    .select({ machineId: t.checkouts.machineId, path: t.checkouts.path })
    .from(t.checkouts)
    .where(
      inWorkspace(
        t.checkouts,
        inListOf(t.checkouts.machineId, size),
        eq(t.checkouts.root, t.checkouts.path),
      ),
    )
    .prepare(),
)

/** The recorded checkout reach of every member on several machines. */
const reachOfMachines = preparedFamily((db, t, size: number) =>
  db
    .select({
      userId: t.checkoutReach.userId,
      machineId: t.checkoutReach.machineId,
      reach: t.checkoutReach.reach,
    })
    .from(t.checkoutReach)
    .where(inWorkspace(t.checkoutReach, inListOf(t.checkoutReach.machineId, size)))
    .prepare(),
)

const upsertReach = preparedFamily((db, t, size: number) =>
  db
    .insert(t.checkoutReach)
    .values(
      Array.from({ length: size }, (_, i) => ({
        workspaceId: WORKSPACE,
        userId: sql.placeholder(`userId${i}`),
        machineId: sql.placeholder(`machineId${i}`),
        reach: sql.placeholder(`reach${i}`),
        updatedAt: sql.placeholder('at'),
      })),
    )
    .onConflictDoUpdate({
      target: [t.checkoutReach.userId, t.checkoutReach.machineId],
      set: { reach: sql`excluded.reach`, updatedAt: sql`excluded.updated_at` },
    })
    .prepare(),
)

const deleteReach = preparedFamily((db, t, size: number) =>
  db
    .delete(t.checkoutReach)
    .where(
      inWorkspace(
        t.checkoutReach,
        or(
          ...Array.from({ length: size }, (_, i) =>
            and(
              eq(t.checkoutReach.userId, param(t.checkoutReach.userId, `userId${i}`)),
              eq(t.checkoutReach.machineId, param(t.checkoutReach.machineId, `machineId${i}`)),
            ),
          ),
        ),
      ),
    )
    .prepare(),
)

/** The lost checkouts of every member on several machines. */
const lostOfMachines = preparedFamily((db, t, size: number) =>
  db
    .select({
      userId: t.checkoutLost.userId,
      machineId: t.checkoutLost.machineId,
      path: t.checkoutLost.path,
      root: t.checkoutLost.root,
    })
    .from(t.checkoutLost)
    .where(inWorkspace(t.checkoutLost, inListOf(t.checkoutLost.machineId, size)))
    .prepare(),
)

const insertLost = preparedFamily((db, t, size: number) =>
  db
    .insert(t.checkoutLost)
    .values(
      Array.from({ length: size }, (_, i) => ({
        workspaceId: WORKSPACE,
        userId: sql.placeholder(`userId${i}`),
        machineId: sql.placeholder(`machineId${i}`),
        path: sql.placeholder(`path${i}`),
        root: sql.placeholder(`root${i}`),
        lostAt: sql.placeholder('at'),
      })),
    )
    .onConflictDoNothing()
    .prepare(),
)

const deleteLost = preparedFamily((db, t, size: number) =>
  db
    .delete(t.checkoutLost)
    .where(
      inWorkspace(
        t.checkoutLost,
        or(
          ...Array.from({ length: size }, (_, i) =>
            and(
              eq(t.checkoutLost.userId, param(t.checkoutLost.userId, `userId${i}`)),
              eq(t.checkoutLost.machineId, param(t.checkoutLost.machineId, `machineId${i}`)),
              eq(t.checkoutLost.path, param(t.checkoutLost.path, `path${i}`)),
            ),
          ),
        ),
      ),
    )
    .prepare(),
)

/** At most 500 rows per write, with ten prepared shapes (1 through 512).
 *  Repeating the final row pads a shape without changing an upsert, an
 *  insert-on-conflict-do-nothing or a composite-key deletion. */
function* reachBatches(rows: readonly object[], at: string) {
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500)
    const size = inListSize(chunk.length)
    const values: Record<string, unknown> = { at }
    for (let i = 0; i < size; i++) {
      const row = chunk[Math.min(i, chunk.length - 1)] as object
      for (const [key, value] of Object.entries(row)) values[`${key}${i}`] = value
    }
    yield { size, values }
  }
}

const checkoutPlaceholders = {
  machineId: sql.placeholder('machineId'),
  path: sql.placeholder('path'),
  root: sql.placeholder('root'),
  kind: sql.placeholder('kind'),
  repoId: sql.placeholder('repoId'),
  branch: sql.placeholder('branch'),
  originUrl: sql.placeholder('originUrl'),
  locked: sql.placeholder('locked'),
  prunable: sql.placeholder('prunable'),
  updatedAt: sql.placeholder('updatedAt'),
}

const upsertCheckout = prepared((db, t) =>
  db
    .insert(t.checkouts)
    .values({ workspaceId: WORKSPACE, ...checkoutPlaceholders })
    .onConflictDoUpdate({
      target: [t.checkouts.machineId, t.checkouts.path],
      set: {
        root: sql.placeholder('root'),
        kind: sql.placeholder('kind'),
        repoId: sql.placeholder('repoId'),
        branch: sql.placeholder('branch'),
        originUrl: sql.placeholder('originUrl'),
        locked: sql.placeholder('locked'),
        prunable: sql.placeholder('prunable'),
        updatedAt: sql.placeholder('updatedAt'),
        // A path registered again is live again.
        removedAt: null,
      },
    })
    .prepare(),
)

/** A removed root keeps its row as a tombstone (see `checkouts.removedAt`). */
const tombstoneRoot = prepared((db, t) =>
  db
    .update(t.checkouts)
    .set({ removedAt: sql.placeholder('removedAt'), updatedAt: sql.placeholder('removedAt') })
    .where(
      inWorkspace(
        t.checkouts,
        eq(t.checkouts.machineId, param(t.checkouts.machineId, 'machineId')),
        eq(t.checkouts.path, param(t.checkouts.path, 'path')),
      ),
    )
    .prepare(),
)

const deleteCheckout = prepared((db, t) =>
  db
    .delete(t.checkouts)
    .where(
      inWorkspace(
        t.checkouts,
        eq(t.checkouts.machineId, param(t.checkouts.machineId, 'machineId')),
        eq(t.checkouts.path, param(t.checkouts.path, 'path')),
      ),
    )
    .prepare(),
)

/** A stored row as the feed's record. */
export function checkoutWireOf(row: CheckoutRow): CheckoutWire {
  return {
    machineId: row.machineId,
    path: row.path,
    root: row.root,
    kind: row.kind,
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.originUrl ? { originUrl: row.originUrl } : {}),
    ...(row.locked ? { locked: true } : {}),
    ...(row.prunable ? { prunable: true } : {}),
  }
}

export class CheckoutsRepository {
  private readonly scope: WorkspaceDb
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: WorkspaceQueries) {
    this.scope = queries.db
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  protected get db(): WorkspaceDb {
    return this.scope
  }

  /** One machine's live checkouts, by path. */
  async ofMachine(machineId: MachineId): Promise<CheckoutRow[]> {
    return (await checkoutsOfMachine(this.db).all({ machineId })) as CheckoutRow[]
  }

  /** {@link ofMachine} for several machines, one statement per 500. */
  async ofMachines(machineIds: readonly MachineId[]): Promise<CheckoutRow[]> {
    const unique = [...new Set(machineIds)]
    const out: CheckoutRow[] = []
    for (let at = 0; at < unique.length; at += 500) {
      const chunk = unique.slice(at, at + 500)
      const size = inListSize(chunk.length)
      out.push(
        ...((await checkoutsOfMachines(this.db, size).all(
          inListValues(chunk, size),
        )) as CheckoutRow[]),
      )
    }
    return out
  }

  /** The live checkout paths of each of these machines, each marked root or
   *  not, one statement per 500. */
  async pathsOfMachines(
    machineIds: readonly MachineId[],
  ): Promise<Map<MachineId, { path: string; root: boolean }[]>> {
    const out = new Map<MachineId, { path: string; root: boolean }[]>()
    for (let at = 0; at < machineIds.length; at += 500) {
      const chunk = machineIds.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await pathsOfMachines(this.db, size).all(inListValues(chunk, size))) {
        const paths = out.get(row.machineId) ?? []
        paths.push({ path: row.path, root: row.root === row.path })
        out.set(row.machineId, paths)
      }
    }
    return out
  }

  /** Each member's recorded reach on each of these machines (see
   *  `checkout_reach`), keyed machine then member, one statement per 500. */
  async reachOfMachines(
    machineIds: readonly MachineId[],
  ): Promise<Map<MachineId, Map<string, { reach: CheckoutReach }>>> {
    const out = new Map<MachineId, Map<string, { reach: CheckoutReach }>>()
    for (let at = 0; at < machineIds.length; at += 500) {
      const chunk = machineIds.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await reachOfMachines(this.db, size).all(inListValues(chunk, size))) {
        const members = out.get(row.machineId) ?? new Map()
        members.set(row.userId, { reach: row.reach })
        out.set(row.machineId, members)
      }
    }
    return out
  }

  /** Each member's lost checkouts on each of these machines (see
   *  `checkout_lost`), keyed machine then member, one statement per 500. */
  async lostOfMachines(
    machineIds: readonly MachineId[],
  ): Promise<Map<MachineId, Map<string, { path: string; root: boolean }[]>>> {
    const out = new Map<MachineId, Map<string, { path: string; root: boolean }[]>>()
    for (let at = 0; at < machineIds.length; at += 500) {
      const chunk = machineIds.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await lostOfMachines(this.db, size).all(inListValues(chunk, size))) {
        const members =
          out.get(row.machineId) ?? new Map<string, { path: string; root: boolean }[]>()
        const paths = members.get(row.userId) ?? []
        paths.push({ path: row.path, root: row.root })
        members.set(row.userId, paths)
        out.set(row.machineId, members)
      }
    }
    return out
  }

  /** Record these reaches, and add and drop these lost checkouts, in one
   *  transaction, one statement per 500 rows of each write kind. A member
   *  with no reach has no reach row. */
  async applyReach(
    change: {
      readonly reach: readonly { userId: string; machineId: MachineId; reach: CheckoutReach }[]
      readonly lost?: readonly {
        userId: string
        machineId: MachineId
        path: string
        root: boolean
      }[]
      readonly found?: readonly { userId: string; machineId: MachineId; path: string }[]
    },
    at: string,
  ): Promise<void> {
    const lost = change.lost ?? [],
      found = change.found ?? []
    if (change.reach.length === 0 && lost.length === 0 && found.length === 0) return
    await this.createOrJoinTransaction(async () => {
      // Partition only after taking the final reach for each key: a repeated
      // key still follows the row-at-a-time writer's last-write-wins rule.
      const latest = new Map(
        change.reach.map((row) => [JSON.stringify([row.userId, row.machineId]), row]),
      )
      const upserts: (typeof change.reach)[number][] = []
      const removes: (typeof change.reach)[number][] = []
      for (const row of latest.values()) {
        if (row.reach === 'none') removes.push(row)
        else upserts.push(row)
      }
      for (const { size, values } of reachBatches(upserts, at))
        await upsertReach(this.db, size).run(values)
      for (const { size, values } of reachBatches(removes, at))
        await deleteReach(this.db, size).run(values)
      for (const { size, values } of reachBatches(found, at))
        await deleteLost(this.db, size).run(values)
      for (const { size, values } of reachBatches(
        lost.map((row) => ({ ...row, root: row.root ? 1 : 0 })),
        at,
      ))
        await insertLost(this.db, size).run(values)
    })
  }

  /** The registered root paths of each of these machines, one statement per 500. */
  async rootPathsOfMachines(
    machineIds: readonly MachineId[],
  ): Promise<Map<MachineId, Set<string>>> {
    const out = new Map<MachineId, Set<string>>()
    for (let at = 0; at < machineIds.length; at += 500) {
      const chunk = machineIds.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await rootPathsOfMachines(this.db, size).all(inListValues(chunk, size))) {
        const paths = out.get(row.machineId) ?? new Set<string>()
        paths.add(row.path)
        out.set(row.machineId, paths)
      }
    }
    return out
  }

  /** Every live checkout: the boot reconcile's full truth. */
  async all(): Promise<CheckoutRow[]> {
    return (await allCheckouts(this.db).all()) as CheckoutRow[]
  }

  /** Write these rows and remove these, in one transaction. A removed root
   *  keeps a tombstone; a removed worktree's row is deleted. */
  async apply(
    upserts: readonly CheckoutRow[],
    removes: readonly Pick<CheckoutRow, 'machineId' | 'path' | 'root'>[],
    at: string,
  ): Promise<void> {
    if (upserts.length === 0 && removes.length === 0) return
    await this.createOrJoinTransaction(async () => {
      for (const row of upserts) {
        await upsertCheckout(this.db).run({
          ...row,
          // Placeholders bind raw values: SQLite stores the booleans as 0/1.
          locked: row.locked ? 1 : 0,
          prunable: row.prunable ? 1 : 0,
          updatedAt: at,
        })
      }
      for (const row of removes) {
        const key = { machineId: row.machineId, path: row.path }
        if (row.root === row.path) await tombstoneRoot(this.db).run({ ...key, removedAt: at })
        else await deleteCheckout(this.db).run(key)
      }
    })
  }
}
