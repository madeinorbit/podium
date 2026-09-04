/**
 * Repos aggregate — owns the `repos` table (registered repo roots per machine,
 * origin URLs and the stable repo_id identity, #74).
 *
 * Cross-aggregate note: upgrading a repo's identity dual-writes the new
 * repo_id onto issues bucketed under it. That write is owned by the issues
 * repository and injected here as `assignRepoIdToIssuesUnder`.
 */

import type { MachineId, RepoId } from '@podium/model'
import { derivePrefix, isValidPrefix } from '@podium/protocol'
import { and, count, countDistinct, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm'
import { repoDraftSeq, repoPrefixes, repos } from '../migrations/schema'
import { deriveRepoId, isPathFallbackRepoId, readLocalOriginUrl } from '../repo-id'
import type { StoreQueries, SyncDrizzle, TransactionRunner } from './executor/sync-drizzle'
import type { TableWrites } from './table-writes'

export function normalizeRepoPath(path: string): string {
  const trimmed = path.trim()
  if (/^\/+$/u.test(trimmed)) return '/'
  return trimmed.replace(/\/+$/u, '')
}

/** The four columns the held registry read materializes, as drizzle returns them. */
interface RegistryRow {
  machineId: MachineId
  path: string
  originUrl: string | null
  repoId: RepoId | null
}

export class ReposRepository {
  /**
   * The registry read, held for the duration of a pass (POD-1638).
   *
   * `listRepos` is not a list operation in practice — it is the lookup table
   * behind `resolveRepoIdForPath`, which the session projection calls once per
   * SESSION. Live attribution caught the unbounded `SELECT ... FROM repos ORDER
   * BY rowid ASC` running 24206 times in one second for 314678 rows, against a
   * table holding 13. Those reads block the server's single event loop and their
   * row materialization is the off-heap churn behind RSS swinging 350MB -> 1.2GB.
   *
   * INVALIDATION HAS TWO HALVES, AND NEITHER IS THE SQL-TEXT PROXY THIS REPLACED
   * (POD-3247). Inside this class, every method that writes `repos` or
   * `repo_prefixes` calls {@link invalidateRegistry} before the write, and
   * `store-repos-registry-cache-writers.test.ts` reads this file and fails a write
   * path that does not — the same guard shape POD-1939 put on the issues row
   * cache, and the reason a mutator added here still cannot forget.
   *
   * Outside it, the store announces writes per table ({@link TableWrites}) and this
   * constructor subscribes to both tables. THAT HALF IS COOPERATIVE, AND SAYING SO
   * IS THE POINT (POD-3362, correcting this comment): `tableWrites.wrote()` is a
   * call an outside writer makes or does not make. The seam works when it is
   * called — replacing the callback with a no-op fails both tests in
   * `store/repos-read-cost.test.ts` — but nothing in the LANGUAGE obliges the
   * call, so the two halves are not symmetric and this comment used to read as
   * though they were. What holds the outside half up is a check, not a
   * construction: `scripts/check-boundaries.ts`'s `cache-table-announcement` rule
   * reads every file under `apps/` and `packages/` and refuses a write to either
   * table, in SQL text or through drizzle's builder, that is not followed by an
   * announcement naming it. A check can be evaded — a table name assembled from a
   * variable is invisible to it — so the honest statement is "guarded", never
   * "cannot happen".
   *
   * THAT SECOND HALF HAS NO CALLER IN THE TREE TODAY, AND IS NOT DEAD CODE. It had
   * one until POD-3246: `SessionStore.migrateLegacyMachineIdentity` rewrote
   * `repos.machine_id` on the raw handle with SQL built from `sqlite_master`, so
   * the proxy — which recognised writes by reading the text of statements prepared
   * on ITS handle — never saw it, and `listRepos()` served the pre-upgrade machine
   * id on a live instance until POD-1638 caught it. That upgrade is now retired,
   * which removes the writer and not the shape: every statement the async query
   * layer runs through an executor is a writer this class never sees, and the
   * announcement is what makes that harmless WHEN IT IS RAISED.
   * `store/repos-read-cost.test.ts` drives it with no repository involved — and
   * asserts, before the announcement, that the bypassing write has left the read
   * STALE, which is the same file recording that the mechanism is a seam rather
   * than a guarantee.
   */
  private cached: {
    rows: RegistryRow[]
    prefixes: Map<string, string>
  } | null = null
  private readonly rootDb: SyncDrizzle
  protected readonly createOrJoinTransaction: TransactionRunner

  constructor(
    queries: StoreQueries,
    /** Issues-aggregate dual-write: stamp repoId onto issues under repoPath. */
    private readonly assignRepoIdToIssuesUnder: (repoId: RepoId, repoPath: string) => void,
    /** This host's minted machine id (`SessionStore.hostMachineId`) — the machine
     *  half of a path-fallback repo id for a path no repo row claims, and the owner
     *  stamped on rows imported from the legacy `repos.json`. */
    private readonly hostMachineId: MachineId,
    /** The store's per-table write announcement, for the writers that never reach
     *  this class. */
    tableWrites: TableWrites,
  ) {
    this.rootDb = queries.rootDb
    this.createOrJoinTransaction = queries.createOrJoinTransaction
    for (const table of ['repos', 'repo_prefixes'])
      tableWrites.subscribe(table, () => this.invalidateRegistry())
  }

  /**
   * ONE query capability and no second one, for the reason the wrapper this
   * replaced taught: a span keys nesting depth on the connection, so a boundary
   * opened on a second object read depth 0 inside an already-open transaction
   * issued `BEGIN IMMEDIATE` within one. The pair arrives together, so there is
   * one [spec rule 27b].
   *
   * READ THROUGH A GETTER, never frozen into a field [rule 34a]: ambient routing
   * (rule 35) resolves the enclosing transaction on every access, and a field
   * assigned once in a constructor cannot. B1 changes the line inside this getter
   * and nothing below it.
   */
  private get db(): SyncDrizzle {
    return this.rootDb
  }

  /**
   * Drop the held registry read.
   *
   * Called by every write method of this class BEFORE its write — the order is the
   * rule, not decoration, because invalidating afterwards leaves the window between
   * the write and the drop, and a read taken in that window caches rows that the
   * write has already made wrong. It is also what the store's write announcement
   * runs, so the two halves end in the same line — by two different routes, and
   * from opposite sides of the same window. Inside this class the drop goes
   * BEFORE the write, because the write is what makes the held read wrong.
   * Outside it the announcement goes AFTER, because the announcement is the only
   * thing that can drop a read the writer cannot see. Both orderings are checked:
   * the first by `store-repos-registry-cache-writers.test.ts`, the second by the
   * `cache-table-announcement` rule (POD-3362).
   */
  invalidateRegistry(): void {
    this.cached = null
  }

  /** Back-compat: flat list of paths across all machines. RepoRegistry.list() uses this. */
  listRepoPaths(machineId?: MachineId): string[] {
    return this.listRepos(machineId).map((r) => r.path)
  }

  /**
   * The whole registry, read once and reused until a write invalidates it.
   *
   * Held as the RAW rows plus the prefix map — the two reads `listRepos` used to
   * issue per call — rather than as finished objects, so the machine-scoped
   * variant filters the same materialization instead of forcing a second query.
   */
  private registry(): { rows: RegistryRow[]; prefixes: Map<string, string> } {
    if (this.cached) return this.cached
    const rows = this.db
      .select({
        machineId: repos.machineId,
        path: repos.path,
        originUrl: repos.originUrl,
        repoId: repos.repoId,
      })
      .from(repos)
      // ROWID ORDER IS THE CONTRACT, not an incidental ordering: repo discovery
      // documents that it depends on the insertion order this gives.
      .orderBy(sql`rowid ASC`)
      .all()
    const prefixes = new Map(
      this.db
        .select({ repoId: repoPrefixes.repoId, prefix: repoPrefixes.prefix })
        .from(repoPrefixes)
        .all()
        .map((r) => [r.repoId, r.prefix] as const),
    )
    this.cached = { rows, prefixes }
    return this.cached
  }

  /** Full repo rows including machineId, originUrl, repoId and prefix (#474). */
  listRepos(machineId?: MachineId): {
    machineId: MachineId
    path: string
    originUrl: string | null
    repoId: RepoId | null
    prefix: string | null
  }[] {
    const { rows: allRows, prefixes } = this.registry()
    // Same rows, same `ORDER BY rowid ASC` order, filtered in memory: the
    // machine-scoped statement this replaces read the same table with the same
    // ordering, and repo-discovery documents that it depends on that order.
    const rows = machineId ? allRows.filter((r) => r.machineId === machineId) : allRows
    return rows.map((r) => ({
      machineId: r.machineId,
      path: r.path,
      originUrl: r.originUrl,
      repoId: r.repoId,
      prefix: (r.repoId ? prefixes.get(r.repoId) : undefined) ?? null,
    }))
  }

  // ---- human-facing prefixes (#474) ----
  //
  // Prefixes live in `repo_prefixes`, keyed by the STABLE repo_id (one prefix per
  // logical repo, unique server-wide). Not a repos.prefix column: repos has one
  // row per (machine, path), so sibling checkouts would need to share a prefix,
  // which a column-level unique index cannot express.

  /** All prefixes currently in use server-wide (for collision-free derivation). */
  private takenPrefixes(): Set<string> {
    const rows = this.db.select({ prefix: repoPrefixes.prefix }).from(repoPrefixes).all()
    return new Set(rows.map((r) => r.prefix))
  }

  /** True when `prefix` is already claimed by some repo. */
  isPrefixTaken(prefix: string): boolean {
    return this.takenPrefixes().has(prefix)
  }

  /** Derive a unique, server-wide prefix for a repo name (does not persist). */
  derivePrefixFor(repoName: string): string {
    return derivePrefix(repoName, (p) => this.isPrefixTaken(p))
  }

  /** The prefix chosen for the logical repo `repoId` (or null). */
  prefixForRepoId(repoId: RepoId): string | null {
    // From the same held read as `listRepos` — this is the other half of the
    // per-session projection cost (21902 point-reads of a 13-row table in the
    // POD-1638 window), and a second statement for a map already in hand is the
    // same defect one row narrower.
    return this.registry().prefixes.get(repoId) ?? null
  }

  /** The prefix chosen for the logical repo containing `repoPath` (or null). */
  prefixForPath(repoPath: string): string | null {
    return this.prefixForRepoId(this.resolveRepoIdForPath(repoPath))
  }

  /** The registered repo owning `prefix` (its repoId + a representative path). */
  repoForPrefix(prefix: string): { repoId: RepoId; path: string } | null {
    const row = this.db
      .select({ repoId: repoPrefixes.repoId })
      .from(repoPrefixes)
      .where(eq(repoPrefixes.prefix, prefix))
      .get()
    if (!row) return null
    const pathRow = this.db
      .select({ path: repos.path })
      .from(repos)
      .where(eq(repos.repoId, row.repoId))
      .limit(1)
      .get()
    return { repoId: row.repoId, path: pathRow?.path ?? '' }
  }

  /** Ensure the logical repo `repoId` has a prefix; derive+persist one if not.
   *  Idempotent. Returns the effective prefix. */
  ensurePrefixForRepoId(repoId: RepoId, repoName: string): string {
    const existing = this.prefixForRepoId(repoId)
    if (existing) return existing
    const prefix = this.derivePrefixFor(repoName)
    this.invalidateRegistry()
    // CONVERTED under rule 31a, and the constraint COUNT is what turned out not
    // to matter. A bare `onConflictDoNothing()` emits `on conflict do nothing`,
    // which SQLite applies to ANY uniqueness conflict — measured on this exact
    // shape, primary key AND separate UNIQUE, both suppressed either way. So the
    // test is rule 31's and nothing else: no NOT NULL and no CHECK reachable.
    //   NOT NULL: repo_id and prefix, both supplied non-null — `prefix` is
    //     derived by `derivePrefixFor` here and validated by `isValidPrefix` on
    //     the other path, so neither can be null by the time it arrives.
    //   CHECK: none on this table. Foreign keys: none, and they would not count.
    this.db.insert(repoPrefixes).values({ repoId, prefix }).onConflictDoNothing().run()
    return this.prefixForRepoId(repoId) ?? prefix
  }

  /**
   * Set (or change) a repo's prefix. Validated (`^[A-Z]{2,5}$`) and enforced
   * unique server-wide by the table's UNIQUE(prefix). Keyed by the logical
   * repo_id, so it applies to every checkout at once and internal ids never
   * change (previously written refs stop resolving — the UI warns on change).
   */
  setRepoPrefix(machineId: MachineId, path: string, prefix: string): void {
    if (!isValidPrefix(prefix)) {
      throw new Error(`invalid repo prefix ${JSON.stringify(prefix)} — must match ^[A-Z]{2,5}$`)
    }
    const repoId = this.resolveRepoIdForPath(normalizeRepoPath(path))
    const owner = this.db
      .select({ repoId: repoPrefixes.repoId })
      .from(repoPrefixes)
      .where(eq(repoPrefixes.prefix, prefix))
      .get()
    if (owner && owner.repoId !== repoId) {
      throw new Error(`prefix ${prefix} is already used by another repo`)
    }
    this.invalidateRegistry()
    this.db
      .insert(repoPrefixes)
      .values({ repoId, prefix })
      .onConflictDoUpdate({ target: repoPrefixes.repoId, set: { prefix: sql`excluded.prefix` } })
      .run()
  }

  /**
   * Next per-repo DRAFT ordinal for a truly issueless session (`POD-DRAFT-3`).
   * Backed by a high-water counter so an ordinal is never reused even if the
   * session is later deleted. read-modify-write runs in its own transaction
   * (mirrors allocateSessionLetter) so concurrent callers can't mint the same
   * ordinal.
   */
  nextDraftSeq(repoId: RepoId): number {
    return this.createOrJoinTransaction(() => {
      const row = this.db
        .select({ nextSeq: repoDraftSeq.nextSeq })
        .from(repoDraftSeq)
        .where(eq(repoDraftSeq.repoId, repoId))
        .get()
      const next = row?.nextSeq ?? 1
      this.db
        .insert(repoDraftSeq)
        .values({ repoId, nextSeq: next + 1 })
        .onConflictDoUpdate({ target: repoDraftSeq.repoId, set: { nextSeq: next + 1 } })
        .run()
      return next
    })
  }

  // No path validation here by design — RepoRegistry (the caller) rejects empty/non-absolute paths.
  // readLocalOriginUrl is a no-op (null) for paths that don't exist on this host, so remote-machine
  // repos simply get the path-fallback id until a scan reports their origin (updateRepoOrigin then
  // upgrades it). An explicit `prefix` overrides derivation (validated + uniqueness-checked, #474).
  addRepo(path: string, machineId: MachineId, originUrl?: string, prefix?: string): void {
    const normalizedPath = normalizeRepoPath(path)
    const origin = originUrl ?? readLocalOriginUrl(normalizedPath) ?? undefined
    const repoName = normalizedPath.split('/').pop() ?? null
    const repoId = deriveRepoId({ originUrl: origin, machineId, path: normalizedPath })
    this.invalidateRegistry()
    // CONVERTED, and the enumeration is why [POD-3403 rule 31]. The two forms
    // agree exactly when no NOT NULL and no CHECK violation is reachable here,
    // and neither is. Enumerated against the live DDL, which is the table as
    // 20260802035017_drop-local-machine-defaults rebuilt it:
    //   NOT NULL columns: machine_id, path and added_at — all three supplied
    //     non-null below. origin_url, repo_name and repo_id are NULLABLE, so the
    //     nulls this passes are legal values rather than violations.
    //   CHECK constraints: none on this table anywhere in the migration chain.
    //   Foreign keys: none, and they would not count in any case.
    // What stays reachable is the (machine_id, path) primary-key conflict, which
    // is the reason the statement is OR IGNORE and which both forms swallow.
    this.db
      .insert(repos)
      .values({
        machineId,
        path: normalizedPath,
        originUrl: origin ?? null,
        repoName,
        repoId,
        addedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run()
    // Assign the human-facing prefix for this logical repo (#474). An explicit,
    // validated override wins over derivation; a sibling checkout already sharing
    // this repo_id keeps its prefix.
    if (this.prefixForRepoId(repoId) === null) {
      if (prefix !== undefined) {
        if (!isValidPrefix(prefix)) {
          throw new Error(`invalid repo prefix ${JSON.stringify(prefix)} — must match ^[A-Z]{2,5}$`)
        }
        if (this.isPrefixTaken(prefix)) throw new Error(`prefix ${prefix} is already in use`)
        this.invalidateRegistry()
        // Same statement and the same enumeration as `ensurePrefixForRepoId`;
        // `prefix` reached here through `isValidPrefix` above.
        this.db.insert(repoPrefixes).values({ repoId, prefix }).onConflictDoNothing().run()
      } else {
        this.ensurePrefixForRepoId(repoId, repoName ?? normalizedPath)
      }
    }
  }

  /**
   * Record a scan-reported origin URL for a registered repo. Upgrades a
   * path-fallback repo_id to the origin-derived id (and dual-writes the new id
   * onto issues bucketed under that repo) — but never rewrites an id that was
   * already origin-derived, so identities stay stable if the remote moves.
   */
  updateRepoOrigin(machineId: MachineId, path: string, originUrl: string): void {
    const normalizedPath = normalizeRepoPath(path)
    const rows = this.db
      .select({ path: repos.path, repoId: repos.repoId })
      .from(repos)
      .where(eq(repos.machineId, machineId))
      .all()
    const row = rows.find((r) => normalizeRepoPath(r.path) === normalizedPath)
    if (!row) return
    // Ahead of the branches rather than in each: this method writes `repos` on
    // every path below it, and the read it invalidates is one this method's own
    // `prefixForRepoId` call takes back afterwards.
    this.invalidateRegistry()

    const newId = deriveRepoId({ originUrl, machineId, path: normalizedPath })
    const upgrade =
      isPathFallbackRepoId(row.repoId, machineId, row.path) ||
      isPathFallbackRepoId(row.repoId, machineId, normalizedPath)
    const repoId = upgrade ? newId : row.repoId

    let targetPath = row.path
    if (row.path !== normalizedPath) {
      // OR IGNORE, because the destination path may already have a row: the
      // rename then does nothing and the duplicate is deleted below instead —
      // the `changes === 0` branch under this one is that case. drizzle's UPDATE
      // builder carries no conflict clause (only INSERT does), so this is the
      // most literal form available. Rule 1 keeps it as one atomic statement;
      // a pre-read would become a race when the query layer turns async.
      const result = this.db.run(
        // UPDATE-CONFLICT STATEMENT POD-3406
        sql`UPDATE OR IGNORE repos SET path = ${normalizedPath} WHERE machine_id = ${machineId} AND path = ${row.path}`,
      )
      if (Number(result.changes ?? 0) > 0) {
        targetPath = normalizedPath
      } else {
        this.db.delete(repos).where(this.at(machineId, row.path)).run()
        targetPath = normalizedPath
      }
    }

    this.db.update(repos).set({ originUrl, repoId }).where(this.at(machineId, targetPath)).run()
    for (const duplicate of rows) {
      if (duplicate.path !== targetPath && normalizeRepoPath(duplicate.path) === normalizedPath) {
        this.db.delete(repos).where(this.at(machineId, duplicate.path)).run()
      }
    }
    if (upgrade) {
      for (const repoPath of new Set([row.path, normalizedPath]))
        this.assignRepoIdToIssuesUnder(newId, repoPath)
      // Re-key the human-facing prefix from the path-fallback id onto the stable
      // origin-derived id (#474), unless the target already owns one.
      if (row.repoId && row.repoId !== newId && this.prefixForRepoId(newId) === null) {
        // Again, because the condition above READ the prefix map and so re-held it:
        // the drop at the top of this method is already spent by the time this
        // statement runs. Invalidating before every write is not enough on its own —
        // it has to be before every write with no cached read taken since.
        this.invalidateRegistry()
        // Same OR IGNORE as above and the same settled rule: the target may already
        // own a prefix row, and then this re-key must do nothing rather than
        // throw. Rule 1's UPDATE-conflict exception preserves that behavior.
        this.db.run(
          // UPDATE-CONFLICT STATEMENT POD-3406
          sql`UPDATE OR IGNORE repo_prefixes SET repo_id = ${newId} WHERE repo_id = ${row.repoId}`,
        )
      }
    }
  }

  /**
   * repo_id for an issue's repoPath: the longest registered repo root that contains it
   * (any machine), else the deterministic (machine, path) fallback for THIS host.
   *
   * The stored id always wins, which is the property that made POD-318 safe to land
   * without rewriting a single `repo_id`: a repo that has a row keeps whatever id it
   * was minted with, opaque and untouched, no matter what machine the row now names.
   * Only a path NO repo row claims reaches the derivation, and it derives under this
   * host's real id because that is the machine the caller is talking about.
   */
  resolveRepoIdForPath(repoPath: string): RepoId {
    return this.repoIdResolver()(repoPath)
  }

  /**
   * {@link resolveRepoIdForPath} for a WHOLE SET: the registry is read once and the
   * returned function is pure, so a caller resolving N paths pays one read instead
   * of N store calls (POD-3257).
   *
   * The per-call form is the one-path case of this one, so there is no second
   * resolution rule to keep in step — the ordering below IS the rule, and both
   * entry points get it.
   *
   * Why a caller cannot just memoize `resolveRepoIdForPath` instead: a memo still
   * calls the store on a miss, and a store call is what a predicate handed to
   * `.filter` may not contain once the store is async (spec section 2.5). The
   * resolution has to be OUT of the callback, not merely cheaper inside it.
   *
   * Sorted longest-first ONCE rather than per path: `Array.prototype.sort` is
   * stable, so among roots of equal length the `listRepos` order still decides,
   * exactly as it did when only the matching subset was sorted.
   *
   * THE RETURNED FUNCTION HOLDS A SNAPSHOT, so do not keep one across a write to
   * `repos` or `repo_prefixes`: the registry cache invalidates on such a write and
   * `resolveRepoIdForPath` would re-read, while a resolver taken earlier would keep
   * answering from the pre-write registry. Take it inside the pass that uses it —
   * which is every caller today, all of them read-only loops.
   */
  repoIdResolver(): (repoPath: string) => RepoId {
    const roots = this.listRepos()
      .map((r) => ({ repoId: r.repoId, path: normalizeRepoPath(r.path) }))
      .sort((a, b) => b.path.length - a.path.length)
    const hostMachineId = this.hostMachineId
    return (repoPath: string): RepoId => {
      const normalizedRepoPath = normalizeRepoPath(repoPath)
      const match = roots.find(
        (r) =>
          normalizedRepoPath === r.path ||
          normalizedRepoPath.startsWith(r.path === '/' ? r.path : `${r.path}/`),
      )
      return match?.repoId ?? deriveRepoId({ machineId: hostMachineId, path: normalizedRepoPath })
    }
  }

  removeRepo(path: string, machineId: MachineId): void {
    const normalizedPath = normalizeRepoPath(path)
    const rows = this.db
      .select({ path: repos.path })
      .from(repos)
      .where(eq(repos.machineId, machineId))
      .all()
    this.invalidateRegistry()
    for (const row of rows) {
      if (normalizeRepoPath(row.path) === normalizedPath) {
        this.db.delete(repos).where(this.at(machineId, row.path)).run()
      }
    }
  }

  // ---- what the retired repo-identity upgrade left behind (POD-1360) ----

  /**
   * Rows still carrying no repo_id, and logical repos still carrying no prefix.
   *
   * The rewrite these two numbers used to audit was retired at POD-3246 — no
   * released binary could ever have written a row without a repo_id, so the work
   * is provably done. The READ stays: it is what the facade's boot refusal asks,
   * and the facade decides what each number means (a missing repo_id refuses the
   * boot, a missing prefix warns). ORIGINS ARE ABSENT ON PURPOSE, because
   * originless is a legitimate resting state and a check that can never reach
   * zero would only reintroduce the heal this replaced.
   */
  legacyRepoResidue(): { repoIdsMissing: number; prefixesMissing: number } {
    const repoIdsMissing = this.db
      .select({ c: count() })
      .from(repos)
      .where(isNull(repos.repoId))
      .get()
    const prefixesMissing = this.db
      .select({ c: countDistinct(repos.repoId) })
      .from(repos)
      .where(
        and(
          isNotNull(repos.repoId),
          notInArray(
            repos.repoId,
            this.db.select({ repoId: repoPrefixes.repoId }).from(repoPrefixes),
          ),
        ),
      )
      .get()
    return { repoIdsMissing: repoIdsMissing?.c ?? 0, prefixesMissing: prefixesMissing?.c ?? 0 }
  }

  /** One repo row, by its primary key. */
  private at(machineId: MachineId, path: string) {
    return and(eq(repos.machineId, machineId), eq(repos.path, path))
  }
}
