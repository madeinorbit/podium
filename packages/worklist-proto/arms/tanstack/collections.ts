/**
 * POD-4448 — entity collections fed through the sync interface
 * (methodology §5.4). One collection per entity type, keyed by id, seeded
 * from the RowSource snapshot and driven by RowSourceEvents: an update is
 * one begin/commit per touched collection with a write per row (upsert or
 * delete-by-key); a replace is truncate + writes in one transaction per
 * collection. Borrowed row objects are stored by reference, never spread.
 * The kernel owns optimism — no transactions/mutations here (the write-path
 * spike in J3 is the only exception).
 *
 * Explicit indexes back the query compiler (parentId, issueId, worktree
 * path, discovered-from edge). `locals` is the 1-row time/version carrier
 * that time- and prefix-dependent queries join on the marker: coarseNow and
 * the prefix-index version are data, never Date.now(), never untracked.
 */

import { BasicIndex, createCollection, type SyncConfig } from '@tanstack/db'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../shared/src/slice-types'
import type { RowRecord } from '../../shared/src/stats'
import { spinOffOriginId } from './rules'

/** gcTime for every collection: derived state lives as long as the arm;
 *  after dispose + cleanup the entries may go immediately. Explicit per the
 *  arm contract (methodology §5.4). */
export const GC_TIME_MS = 60_000

type SyncParams<T extends object> = Parameters<SyncConfig<T, string>['sync']>[0]

/** One entity collection with a captured sync handle. */
export class EntitySync<T extends object> {
  private params: SyncParams<T> | null = null
  private readonly known = new Set<string>()
  /** Keys removed since the last drain. Sync deletes apply silently (no
   *  subscriber event), so removals are driven explicitly from here. */
  private readonly removedKeys = new Set<string>()
  readonly collection

  constructor(
    id: string,
    seed: T[],
    readonly getKey: (row: T) => string,
  ) {
    const self = this
    this.collection = createCollection<T, string>({
      id,
      getKey,
      gcTime: GC_TIME_MS,
      startSync: true,
      autoIndex: 'eager',
      defaultIndexType: BasicIndex,
      sync: {
        rowUpdateMode: 'full',
        sync(params) {
          self.params = params
          params.begin()
          for (const value of seed) {
            params.write({ type: 'insert', value })
            self.known.add(self.getKey(value))
          }
          params.commit()
          params.markReady()
        },
      },
    })
  }

  private tx(): SyncParams<T> {
    const params = this.params
    if (params === null) throw new Error('[tanstack] entity sync not started')
    return params
  }

  /** Upsert one row; returns true when the stored value moved. */
  upsert(key: string, value: T): boolean {
    return this.write([{ op: 'upsert', key, value }])
  }

  /** Delete one row; returns true when a row left scope. */
  remove(key: string): boolean {
    return this.write([{ op: 'remove', key }])
  }

  /** One transaction for a whole event's rows of this collection. */
  write(
    ops: Array<{ op: 'upsert'; key: string; value: T } | { op: 'remove'; key: string }>,
  ): boolean {
    const tx = this.tx()
    let moved = false
    tx.begin()
    for (const op of ops) {
      if (op.op === 'remove') {
        if (!this.known.has(op.key)) continue
        tx.write({ type: 'delete', key: op.key })
        this.known.delete(op.key)
        this.removedKeys.add(op.key)
        moved = true
        continue
      }
      const current = this.collection.get(op.key) as T | undefined
      if (current === op.value) continue
      if (current === undefined && !this.known.has(op.key)) {
        tx.write({ type: 'insert', value: op.value })
        this.known.add(op.key)
      } else {
        tx.write({ type: 'update', value: op.value })
        this.known.add(op.key)
      }
      moved = true
    }
    tx.commit()
    return moved
  }

  /** Atomic reseed: truncate + writes in one transaction. */
  replace(rows: Array<{ key: string; value: T }>): void {
    const tx = this.tx()
    tx.begin()
    tx.truncate()
    this.known.clear()
    this.removedKeys.clear()
    for (const row of rows) {
      tx.write({ type: 'insert', value: row.value })
      this.known.add(row.key)
    }
    tx.commit()
  }

  /** Drain keys removed since the last call (explicit removal driving). */
  takeRemoved(): string[] {
    if (this.removedKeys.size === 0) return []
    const out = [...this.removedKeys]
    this.removedKeys.clear()
    return out
  }

  get size(): number {
    return this.collection.size
  }

  keys(): Iterable<string> {
    return this.known
  }
}

export interface LocalsRow {
  id: string
  /** Constant join marker: time/prefix queries join on eq(marker, marker). */
  marker: 1
  /** SliceLocals.coarseNow — the only clock any derivation reads. */
  now: number
  /** Bumped whenever prefix seats move, so R3 re-resolves. */
  wtVersion: number
}

function normalizeRoot(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * R3 prefix ownership index (spec §2 R3). The query language cannot express
 * longest-prefix containment (joins are cross-source eq only), so this
 * maintained index IS the prefix derivation: lane paths + issue worktree
 * paths form the roots, the repo prefix map feeds displayRef, and every seat
 * move bumps the version the membership query joins — so no prefix change
 * is ever invisible downstream. Seat writes count `indexUpdates`.
 */
export class PrefixIndex {
  private lanePaths = new Set<string>()
  private readonly issuesByWorktree = new Map<string, Set<string>>()
  private readonly issuesByRepo = new Map<string, Set<string>>()
  readonly prefixByRepoId = new Map<string, string | null>()
  private roots = new Set<string>()

  constructor(private readonly countIndex: () => void) {}

  prefixForRepo(repoId: string | null | undefined): string | null {
    if (repoId == null) return null
    return this.prefixByRepoId.get(repoId) ?? null
  }

  /** Longest-prefix containment of a cwd against the roots. */
  resolveCwd(cwd: string): string | null {
    const probe = normalizeRoot(cwd)
    let best: string | null = null
    for (const root of this.roots) {
      if (probe === root || probe.startsWith(`${root}/`)) {
        if (best === null || root.length > best.length) best = root
      }
    }
    return best
  }

  issuesAtWorktree(path: string): Set<string> {
    return this.issuesByWorktree.get(path) ?? PrefixIndex.EMPTY
  }

  private static readonly EMPTY: Set<string> = new Set()

  private moveSeat(map: Map<string, Set<string>>, id: string, seat: string | null): boolean {
    let changed = false
    for (const [key, bucket] of map) {
      if (key !== seat && bucket.delete(id)) {
        changed = true
        if (bucket.size === 0) map.delete(key)
      }
    }
    if (seat !== null) {
      let bucket = map.get(seat)
      if (bucket === undefined) {
        bucket = new Set()
        map.set(seat, bucket)
      }
      if (!bucket.has(id)) {
        bucket.add(id)
        changed = true
      }
    }
    if (changed) this.countIndex()
    return changed
  }

  private rebuildRoots(): void {
    this.roots = new Set<string>([...this.lanePaths, ...this.issuesByWorktree.keys()])
  }

  private static liveIssue(issue: SliceIssue): boolean {
    return issue.archived !== true && issue.deletedAt == null
  }

  /** Ingest one issue row (or its removal). Returns true when seats moved. */
  ingestIssue(id: string, issue: SliceIssue | undefined): boolean {
    let changed = false
    const seat =
      issue !== undefined && PrefixIndex.liveIssue(issue) && issue.worktreePath != null
        ? issue.worktreePath
        : null
    if (this.moveSeat(this.issuesByWorktree, id, seat)) changed = true
    if (this.moveSeat(this.issuesByRepo, id, issue?.repoId ?? null)) changed = true
    if (changed) this.rebuildRoots()
    return changed
  }

  /** Ingest one worktree lane (or its removal). Returns true when roots moved. */
  ingestWorktree(path: string, lane: SliceWorktree | undefined): boolean {
    let changed = false
    if (lane === undefined) {
      if (this.lanePaths.delete(path)) changed = true
    } else if (!this.lanePaths.has(path)) {
      this.lanePaths.add(path)
      changed = true
    }
    const repoId = lane?.repoId ?? null
    if (repoId !== null) {
      const prefix = lane?.prefix ?? null
      if ((this.prefixByRepoId.get(repoId) ?? null) !== prefix) {
        this.prefixByRepoId.set(repoId, prefix)
        changed = true
      }
    }
    if (changed) {
      this.countIndex()
      this.rebuildRoots()
    }
    return changed
  }

  seed(
    issues: Iterable<[string, SliceIssue]>,
    lanes: Iterable<[string, SliceWorktree]>,
  ): void {
    this.lanePaths.clear()
    this.issuesByWorktree.clear()
    this.issuesByRepo.clear()
    this.prefixByRepoId.clear()
    for (const [path, lane] of lanes) {
      this.lanePaths.add(path)
      if (lane.repoId != null) this.prefixByRepoId.set(lane.repoId, lane.prefix ?? null)
    }
    for (const [id, issue] of issues) {
      if (PrefixIndex.liveIssue(issue) && issue.worktreePath != null) {
        let bucket = this.issuesByWorktree.get(issue.worktreePath)
        if (bucket === undefined) {
          bucket = new Set()
          this.issuesByWorktree.set(issue.worktreePath, bucket)
        }
        bucket.add(id)
      }
      if (issue.repoId != null) {
        let bucket = this.issuesByRepo.get(issue.repoId)
        if (bucket === undefined) {
          bucket = new Set()
          this.issuesByRepo.set(issue.repoId, bucket)
        }
        bucket.add(id)
      }
    }
    this.rebuildRoots()
  }
}

export interface EntityCollections {
  issues: EntitySync<SliceIssue>
  sessions: EntitySync<SliceSession>
  worktrees: EntitySync<SliceWorktree>
  locals: EntitySync<LocalsRow>
}

/** Build the four entity collections seeded from stream snapshots. */
export function createEntityCollections(seed: {
  issues: SliceIssue[]
  sessions: SliceSession[]
  worktrees: SliceWorktree[]
  now: number
}): EntityCollections {
  const issues = new EntitySync<SliceIssue>('tanstack-arm.issues', seed.issues, (row) => row.id)
  const sessions = new EntitySync<SliceSession>(
    'tanstack-arm.sessions',
    seed.sessions,
    (row) => row.sessionId,
  )
  const worktrees = new EntitySync<SliceWorktree>(
    'tanstack-arm.worktrees',
    seed.worktrees,
    (row) => row.path,
  )
  const locals = new EntitySync<LocalsRow>(
    'tanstack-arm.locals',
    [{ id: 'locals', marker: 1, now: seed.now, wtVersion: 0 }],
    (row) => row.id,
  )
  // Explicit indexes for the query compiler (methodology §5.4).
  issues.collection.createIndex((row) => row.parentId ?? '\0')
  issues.collection.createIndex((row) => spinOffOriginId(row as unknown as SliceIssue) ?? '\0')
  issues.collection.createIndex((row) => row.repoId ?? '\0')
  sessions.collection.createIndex((row) => row.issueId ?? '\0')
  worktrees.collection.createIndex((row) => row.path)
  return { issues, sessions, worktrees, locals }
}

/** Apply one RowSourceEvent's rows to the entity collections. */
export function applyEventRows(
  collections: EntityCollections,
  rows: RowRecord[],
  prefix: PrefixIndex,
): { prefixMoved: boolean } {
  let prefixMoved = false
  const issueWrites: RowRecord[] = []
  const sessionWrites: RowRecord[] = []
  const worktreeWrites: RowRecord[] = []
  for (const row of rows) {
    if (row.kind === 'issue') issueWrites.push(row)
    else if (row.kind === 'session') sessionWrites.push(row)
    else worktreeWrites.push(row)
  }
  if (issueWrites.length > 0) {
    collections.issues.write(
      issueWrites.map((row) =>
        row.value === undefined
          ? { op: 'remove' as const, key: row.id }
          : { op: 'upsert' as const, key: row.id, value: row.value as SliceIssue },
      ),
    )
    for (const row of issueWrites) {
      const value = row.value as SliceIssue | undefined
      if (prefix.ingestIssue(row.id, value)) prefixMoved = true
    }
  }
  if (sessionWrites.length > 0) {
    collections.sessions.write(
      sessionWrites.map((row) =>
        row.value === undefined
          ? { op: 'remove' as const, key: row.id }
          : { op: 'upsert' as const, key: row.id, value: row.value as SliceSession },
      ),
    )
  }
  if (worktreeWrites.length > 0) {
    collections.worktrees.write(
      worktreeWrites.map((row) =>
        row.value === undefined
          ? { op: 'remove' as const, key: row.id }
          : { op: 'upsert' as const, key: row.id, value: row.value as SliceWorktree },
      ),
    )
    for (const row of worktreeWrites) {
      const value = row.value as SliceWorktree | undefined
      if (prefix.ingestWorktree(row.id, value)) prefixMoved = true
    }
  }
  return { prefixMoved }
}
