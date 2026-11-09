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
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { CheckoutReach, LostCheckoutReach } from '../checkout-reach'
import { checkoutReach, checkouts } from '../migrations/schema'
import type { StoreDrizzle, StoreQueries, TransactionRunner } from './executor/sync-drizzle'
import {
  inListOf,
  inListSize,
  inListValues,
  param,
  prepared,
  preparedFamily,
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

const COLUMNS = {
  machineId: checkouts.machineId,
  path: checkouts.path,
  root: checkouts.root,
  kind: checkouts.kind,
  repoId: checkouts.repoId,
  branch: checkouts.branch,
  originUrl: checkouts.originUrl,
  locked: checkouts.locked,
  prunable: checkouts.prunable,
}

// Every query this repository runs, prepared once per store [POD-6147].

const checkoutsOfMachine = prepared((db: StoreDrizzle) =>
  db
    .select(COLUMNS)
    .from(checkouts)
    .where(
      and(
        eq(checkouts.machineId, param(checkouts.machineId, 'machineId')),
        isNull(checkouts.removedAt),
      ),
    )
    .orderBy(asc(checkouts.path))
    .prepare(),
)

/** Every row: the `checkout` kind's full truth for the boot reconcile. */
const allCheckouts = prepared((db: StoreDrizzle) =>
  db
    .select(COLUMNS)
    .from(checkouts)
    .where(isNull(checkouts.removedAt))
    .orderBy(asc(checkouts.machineId), asc(checkouts.path))
    .prepare(),
)

/** The live checkout paths of several machines, each marked root or not: the
 *  feed's re-send when a member's reach on a machine moves. */
const pathsOfMachines = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ machineId: checkouts.machineId, path: checkouts.path, root: checkouts.root })
    .from(checkouts)
    .where(and(inListOf(checkouts.machineId, size), isNull(checkouts.removedAt)))
    .prepare(),
)

/** The registered roots of several machines (a root's row has `root = path`):
 *  how the feed tells a root, which managers may read, from a worktree.
 *  Removed roots too, through their tombstones: a root's removal goes to the
 *  same readers the root had. */
const rootPathsOfMachines = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({ machineId: checkouts.machineId, path: checkouts.path })
    .from(checkouts)
    .where(and(inListOf(checkouts.machineId, size), eq(checkouts.root, checkouts.path)))
    .prepare(),
)

/** The recorded checkout reach of every member on several machines. */
const reachOfMachines = preparedFamily((db: StoreDrizzle, size: number) =>
  db
    .select({
      userId: checkoutReach.userId,
      machineId: checkoutReach.machineId,
      reach: checkoutReach.reach,
      lost: checkoutReach.lost,
    })
    .from(checkoutReach)
    .where(inListOf(checkoutReach.machineId, size))
    .prepare(),
)

const upsertReach = prepared((db: StoreDrizzle) =>
  db
    .insert(checkoutReach)
    .values({
      userId: sql.placeholder('userId'),
      machineId: sql.placeholder('machineId'),
      reach: sql.placeholder('reach'),
      lost: sql.placeholder('lost'),
      updatedAt: sql.placeholder('updatedAt'),
    })
    .onConflictDoUpdate({
      target: [checkoutReach.userId, checkoutReach.machineId],
      set: {
        reach: sql.placeholder('reach'),
        lost: sql.placeholder('lost'),
        updatedAt: sql.placeholder('updatedAt'),
      },
    })
    .prepare(),
)

const deleteReach = prepared((db: StoreDrizzle) =>
  db
    .delete(checkoutReach)
    .where(
      and(
        eq(checkoutReach.userId, param(checkoutReach.userId, 'userId')),
        eq(checkoutReach.machineId, param(checkoutReach.machineId, 'machineId')),
      ),
    )
    .prepare(),
)

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

const upsertCheckout = prepared((db: StoreDrizzle) =>
  db
    .insert(checkouts)
    .values(checkoutPlaceholders)
    .onConflictDoUpdate({
      target: [checkouts.machineId, checkouts.path],
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
const tombstoneRoot = prepared((db: StoreDrizzle) =>
  db
    .update(checkouts)
    .set({ removedAt: sql.placeholder('removedAt'), updatedAt: sql.placeholder('removedAt') })
    .where(
      and(
        eq(checkouts.machineId, param(checkouts.machineId, 'machineId')),
        eq(checkouts.path, param(checkouts.path, 'path')),
      ),
    )
    .prepare(),
)

const deleteCheckout = prepared((db: StoreDrizzle) =>
  db
    .delete(checkouts)
    .where(
      and(
        eq(checkouts.machineId, param(checkouts.machineId, 'machineId')),
        eq(checkouts.path, param(checkouts.path, 'path')),
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
  private readonly rootDb: StoreDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(queries: StoreQueries) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
  }

  protected get db() {
    return this.rootDb
  }

  /** One machine's live checkouts, by path. */
  async ofMachine(machineId: MachineId): Promise<CheckoutRow[]> {
    return (await checkoutsOfMachine(this.db).all({ machineId })) as CheckoutRow[]
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
  ): Promise<Map<MachineId, Map<string, { reach: CheckoutReach; lost: LostCheckoutReach | null }>>> {
    const out = new Map<MachineId, Map<string, { reach: CheckoutReach; lost: LostCheckoutReach | null }>>()
    for (let at = 0; at < machineIds.length; at += 500) {
      const chunk = machineIds.slice(at, at + 500)
      const size = inListSize(chunk.length)
      for (const row of await reachOfMachines(this.db, size).all(inListValues(chunk, size))) {
        const members = out.get(row.machineId) ?? new Map()
        members.set(row.userId, { reach: row.reach, lost: row.lost })
        out.set(row.machineId, members)
      }
    }
    return out
  }

  /** Record these reaches. A member with no reach and nothing lost has no row. */
  async applyReach(
    rows: readonly {
      userId: string
      machineId: MachineId
      reach: CheckoutReach
      lost: LostCheckoutReach | null
    }[],
    at: string,
  ): Promise<void> {
    if (rows.length === 0) return
    await this.createOrJoinTransaction(async () => {
      for (const row of rows) {
        const key = { userId: row.userId, machineId: row.machineId }
        if (row.reach === 'none' && row.lost === null) await deleteReach(this.db).run(key)
        else await upsertReach(this.db).run({ ...key, reach: row.reach, lost: row.lost, updatedAt: at })
      }
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
