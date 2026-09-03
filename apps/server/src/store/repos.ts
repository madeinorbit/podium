/**
 * Repos aggregate — owns the `repos` table (registered repo roots per machine,
 * origin URLs and the stable repo_id identity, #74).
 *
 * Cross-aggregate note: upgrading a repo's identity dual-writes the new
 * repo_id onto issues bucketed under it. That write is owned by the issues
 * repository and injected here as `assignRepoIdToIssuesUnder`.
 */

import { asMachineId, type MachineId, type RepoId } from '@podium/model'
import { derivePrefix, isValidPrefix } from '@podium/protocol'
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { deriveRepoId, isPathFallbackRepoId, readLocalOriginUrl } from '../repo-id'
import type { TableWrites } from './table-writes'

export function normalizeRepoPath(path: string): string {
  const trimmed = path.trim()
  if (/^\/+$/u.test(trimmed)) return '/'
  return trimmed.replace(/\/+$/u, '')
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
   * constructor subscribes to both tables.
   *
   * THAT SECOND HALF HAS NO CALLER IN THE TREE TODAY, AND IS NOT DEAD CODE. It had
   * one until POD-3246: `SessionStore.migrateLegacyMachineIdentity` rewrote
   * `repos.machine_id` on the raw handle with SQL built from `sqlite_master`, so
   * the proxy — which recognised writes by reading the text of statements prepared
   * on ITS handle — never saw it, and `listRepos()` served the pre-upgrade machine
   * id on a live instance until POD-1638 caught it. That upgrade is now retired,
   * which removes the writer and not the shape: every statement the async query
   * layer runs through an executor is a writer this class never sees, and the
   * announcement is what makes that harmless rather than the same bug again.
   * `store/repos-read-cost.test.ts` drives it with no repository involved.
   */
  private cached: {
    rows: Record<string, unknown>[]
    prefixes: Map<string, string>
  } | null = null

  private readonly db: SqlDatabase

  constructor(
    db: SqlDatabase,
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
    // The RAW handle, and no second one. The wrapper this replaces forced a second
    // field: `transaction()` keys nesting depth on the database OBJECT IDENTITY, so
    // a boundary opened on the wrapper read depth 0 inside an already-open
    // transaction and issued `BEGIN IMMEDIATE` within one. With no wrapper there is
    // one object, and it is the one every other repository and the store facade use.
    this.db = db
    for (const table of ['repos', 'repo_prefixes'])
      tableWrites.subscribe(table, () => this.invalidateRegistry())
  }

  /**
   * Drop the held registry read.
   *
   * Called by every write method of this class BEFORE its write — the order is the
   * rule, not decoration, because invalidating afterwards leaves the window between
   * the write and the drop, and a read taken in that window caches rows that the
   * write has already made wrong. It is also what the store's write announcement
   * runs, so the two halves of the invariant end in the same line.
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
  private registry(): { rows: Record<string, unknown>[]; prefixes: Map<string, string> } {
    if (this.cached) return this.cached
    const rows = this.db
      .prepare('SELECT machine_id, path, origin_url, repo_id FROM repos ORDER BY rowid ASC')
      .all() as Record<string, unknown>[]
    const prefixes = new Map(
      (
        this.db.prepare('SELECT repo_id, prefix FROM repo_prefixes').all() as {
          repo_id: RepoId
          prefix: string
        }[]
      ).map((r) => [r.repo_id, r.prefix] as const),
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
    const rows = machineId ? allRows.filter((r) => r.machine_id === machineId) : allRows
    return rows.map((r) => {
      // SERIALIZATION EDGE: an untyped column re-entering the repo id space.
      const repoId = (r.repo_id as RepoId | null) ?? null
      return {
        machineId: asMachineId(r.machine_id as string),
        path: r.path as string,
        originUrl: (r.origin_url as string | null) ?? null,
        repoId,
        prefix: (repoId ? prefixes.get(repoId) : undefined) ?? null,
      }
    })
  }

  // ---- human-facing prefixes (#474) ----
  //
  // Prefixes live in `repo_prefixes`, keyed by the STABLE repo_id (one prefix per
  // logical repo, unique server-wide). Not a repos.prefix column: repos has one
  // row per (machine, path), so sibling checkouts would need to share a prefix,
  // which a column-level unique index cannot express.

  /** All prefixes currently in use server-wide (for collision-free derivation). */
  private takenPrefixes(): Set<string> {
    const rows = this.db.prepare('SELECT prefix FROM repo_prefixes').all() as { prefix: string }[]
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
    const row = this.db.prepare('SELECT repo_id FROM repo_prefixes WHERE prefix = ?').get(prefix) as
      | { repo_id: RepoId }
      | undefined
    if (!row) return null
    const pathRow = this.db
      .prepare('SELECT path FROM repos WHERE repo_id = ? LIMIT 1')
      .get(row.repo_id) as { path: string } | undefined
    // SERIALIZATION EDGE: an untyped column re-entering the repo id space.
    return { repoId: row.repo_id as RepoId, path: pathRow?.path ?? '' }
  }

  /** Ensure the logical repo `repoId` has a prefix; derive+persist one if not.
   *  Idempotent. Returns the effective prefix. */
  ensurePrefixForRepoId(repoId: RepoId, repoName: string): string {
    const existing = this.prefixForRepoId(repoId)
    if (existing) return existing
    const prefix = this.derivePrefixFor(repoName)
    this.invalidateRegistry()
    this.db
      .prepare('INSERT OR IGNORE INTO repo_prefixes (repo_id, prefix) VALUES (?, ?)')
      .run(repoId, prefix)
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
      .prepare('SELECT repo_id FROM repo_prefixes WHERE prefix = ?')
      .get(prefix) as { repo_id: RepoId } | undefined
    if (owner && owner.repo_id !== repoId) {
      throw new Error(`prefix ${prefix} is already used by another repo`)
    }
    this.invalidateRegistry()
    this.db
      .prepare(
        `INSERT INTO repo_prefixes (repo_id, prefix) VALUES (?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET prefix = excluded.prefix`,
      )
      .run(repoId, prefix)
  }

  /**
   * Next per-repo DRAFT ordinal for a truly issueless session (`POD-DRAFT-3`).
   * Backed by a high-water counter so an ordinal is never reused even if the
   * session is later deleted. read-modify-write runs in its own transaction
   * (mirrors allocateSessionLetter) so concurrent callers can't mint the same
   * ordinal.
   */
  nextDraftSeq(repoId: RepoId): number {
    return transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT next_seq FROM repo_draft_seq WHERE repo_id = ?')
        .get(repoId) as { next_seq: number } | undefined
      const next = row?.next_seq ?? 1
      this.db
        .prepare(
          `INSERT INTO repo_draft_seq (repo_id, next_seq) VALUES (?, ?)
           ON CONFLICT(repo_id) DO UPDATE SET next_seq = ?`,
        )
        .run(repoId, next + 1, next + 1)
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
    this.db
      .prepare(
        'INSERT OR IGNORE INTO repos (machine_id, path, origin_url, repo_name, repo_id, added_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(machineId, normalizedPath, origin ?? null, repoName, repoId, new Date().toISOString())
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
        this.db
          .prepare('INSERT OR IGNORE INTO repo_prefixes (repo_id, prefix) VALUES (?, ?)')
          .run(repoId, prefix)
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
      .prepare('SELECT path, repo_id FROM repos WHERE machine_id = ?')
      // SERIALIZATION EDGE: untyped columns; repo_id re-enters its id space.
      .all(machineId) as { path: string; repo_id: RepoId | null }[]
    const row = rows.find((r) => normalizeRepoPath(r.path) === normalizedPath)
    if (!row) return
    // Ahead of the branches rather than in each: this method writes `repos` on
    // every path below it, and the read it invalidates is one this method's own
    // `prefixForRepoId` call takes back afterwards.
    this.invalidateRegistry()

    const newId = deriveRepoId({ originUrl, machineId, path: normalizedPath })
    const upgrade =
      isPathFallbackRepoId(row.repo_id, machineId, row.path) ||
      isPathFallbackRepoId(row.repo_id, machineId, normalizedPath)
    const repoId = upgrade ? newId : row.repo_id

    let targetPath = row.path
    if (row.path !== normalizedPath) {
      const result = this.db
        .prepare('UPDATE OR IGNORE repos SET path = ? WHERE machine_id = ? AND path = ?')
        .run(normalizedPath, machineId, row.path) as { changes?: number }
      if ((result.changes ?? 0) > 0) {
        targetPath = normalizedPath
      } else {
        this.db
          .prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?')
          .run(machineId, row.path)
        targetPath = normalizedPath
      }
    }

    this.db
      .prepare('UPDATE repos SET origin_url = ?, repo_id = ? WHERE machine_id = ? AND path = ?')
      .run(originUrl, repoId, machineId, targetPath)
    for (const duplicate of rows) {
      if (duplicate.path !== targetPath && normalizeRepoPath(duplicate.path) === normalizedPath) {
        this.db
          .prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?')
          .run(machineId, duplicate.path)
      }
    }
    if (upgrade) {
      for (const repoPath of new Set([row.path, normalizedPath]))
        this.assignRepoIdToIssuesUnder(newId, repoPath)
      // Re-key the human-facing prefix from the path-fallback id onto the stable
      // origin-derived id (#474), unless the target already owns one.
      if (row.repo_id && row.repo_id !== newId && this.prefixForRepoId(newId) === null) {
        // Again, because the condition above READ the prefix map and so re-held it:
        // the drop at the top of this method is already spent by the time this
        // statement runs. Invalidating before every write is not enough on its own —
        // it has to be before every write with no cached read taken since.
        this.invalidateRegistry()
        this.db
          .prepare('UPDATE OR IGNORE repo_prefixes SET repo_id = ? WHERE repo_id = ?')
          .run(newId, row.repo_id)
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
    const rows = this.db.prepare('SELECT path FROM repos WHERE machine_id = ?').all(machineId) as {
      path: string
    }[]
    this.invalidateRegistry()
    const remove = this.db.prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?')
    for (const row of rows) {
      if (normalizeRepoPath(row.path) === normalizedPath) remove.run(machineId, row.path)
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
    const count = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c
    return {
      repoIdsMissing: count('SELECT COUNT(*) AS c FROM repos WHERE repo_id IS NULL'),
      prefixesMissing: count(
        `SELECT COUNT(DISTINCT repo_id) AS c FROM repos
          WHERE repo_id IS NOT NULL AND repo_id NOT IN (SELECT repo_id FROM repo_prefixes)`,
      ),
    }
  }
}
