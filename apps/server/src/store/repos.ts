/**
 * Repos aggregate — owns the `repos` table (registered repo roots per machine,
 * origin URLs and the stable repo_id identity, #74).
 *
 * Cross-aggregate note: upgrading a repo's identity dual-writes the new
 * repo_id onto issues bucketed under it. That write is owned by the issues
 * repository and injected here as `assignRepoIdToIssuesUnder`.
 */

import { asMachineId, type MachineId, type RepoId } from '@podium/model'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { derivePrefix, isValidPrefix } from '@podium/protocol'
import { type SqlDatabase, type SqlParam, transaction } from '@podium/runtime/sqlite'
import { deriveRepoId, isPathFallbackRepoId, readLocalOriginUrl } from '../repo-id'

export function normalizeRepoPath(path: string): string {
  const trimmed = path.trim()
  if (/^\/+$/u.test(trimmed)) return '/'
  return trimmed.replace(/\/+$/u, '')
}

/** Statements whose execution can change what {@link ReposRepository} caches. */
function writesRepoTables(sql: string): boolean {
  return (
    /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql) && /\brepos\b|\brepo_prefixes\b/iu.test(sql)
  )
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
   * INVALIDATION IS STRUCTURAL FOR EVERY WRITE ISSUED THROUGH THIS CLASS: the
   * `prepare` wrapper below drops the cache whenever a statement writing `repos`
   * or `repo_prefixes` executes, so a mutator added here cannot forget to call an
   * invalidate method.
   *
   * IT IS NOT THE ONLY WRITER, and assuming so is what made the first version of
   * this cache wrong. `SessionStore.migrateLegacyMachineIdentity` rewrites
   * `repos.machine_id` on the store's RAW handle with SQL built from
   * `sqlite_master` — dynamic table names, so neither the wrapper above nor a
   * grep for `UPDATE repos` can see it, which is how it survived review. That
   * path calls {@link invalidate} explicitly; `store.repo-id.test.ts` pins it.
   *
   * Any future writer that bypasses this class owes the same call. If that list
   * ever grows past one, this should become a notification the store owns rather
   * than a courtesy each caller remembers.
   */
  private cached: {
    rows: Record<string, unknown>[]
    prefixes: Map<string, string>
  } | null = null

  private readonly db: SqlDatabase

  /**
   * The UNWRAPPED handle, for transaction boundaries only.
   *
   * `transaction()` tracks nesting depth in a Map keyed by the database OBJECT
   * IDENTITY, so opening a boundary on the wrapper below would read depth 0
   * inside an already-open transaction and issue `BEGIN IMMEDIATE` within one
   * ("cannot start a transaction within a transaction"). The wrapper and this
   * share one underlying connection — statements prepared through either are
   * inside whatever boundary is open — so the only thing that must use the
   * original object is the depth bookkeeping.
   */
  private readonly txDb: SqlDatabase

  constructor(
    db: SqlDatabase,
    /** Issues-aggregate dual-write: stamp repoId onto issues under repoPath. */
    private readonly assignRepoIdToIssuesUnder: (repoId: RepoId, repoPath: string) => void,
    /** This host's minted machine id (`SessionStore.hostMachineId`) — the machine
     *  half of a path-fallback repo id for a path no repo row claims, and the owner
     *  stamped on rows imported from the legacy `repos.json`. */
    private readonly hostMachineId: MachineId,
  ) {
    this.txDb = db
    // Drop the cache from underneath any write issued through this connection,
    // including ones this class does not know about.
    this.db = {
      prepare: (sql: string) => {
        const st = db.prepare(sql)
        if (!writesRepoTables(sql)) return st
        // Delegating explicitly rather than spreading `st`: a spread would carry
        // only OWN properties, so this would break silently against a driver
        // whose statements expose their methods on a prototype.
        return {
          run: (...p: SqlParam[]) => {
            this.cached = null
            return st.run(...p)
          },
          get: (...p: SqlParam[]) => st.get(...p),
          all: (...p: SqlParam[]) => st.all(...p),
        }
      },
      exec: (sql: string) => {
        if (writesRepoTables(sql)) this.cached = null
        return db.exec(sql)
      },
      close: () => db.close(),
    }
  }

  /**
   * Drop the held registry read. For writers that do NOT go through this class —
   * today only the boot machine-identity migration, which builds its UPDATE from
   * `sqlite_master` on the store's raw handle.
   */
  invalidate(): void {
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
    return transaction(this.txDb, () => {
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
    const normalizedRepoPath = normalizeRepoPath(repoPath)
    const match = this.listRepos()
      .map((r) => ({ ...r, path: normalizeRepoPath(r.path) }))
      .filter(
        (r) =>
          normalizedRepoPath === r.path ||
          normalizedRepoPath.startsWith(r.path === '/' ? r.path : `${r.path}/`),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    return (
      match?.repoId ?? deriveRepoId({ machineId: this.hostMachineId, path: normalizedRepoPath })
    )
  }

  removeRepo(path: string, machineId: MachineId): void {
    const normalizedPath = normalizeRepoPath(path)
    const rows = this.db.prepare('SELECT path FROM repos WHERE machine_id = ?').all(machineId) as {
      path: string
    }[]
    const remove = this.db.prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?')
    for (const row of rows) {
      if (normalizeRepoPath(row.path) === normalizedPath) remove.run(machineId, row.path)
    }
  }

  // ---- the repos half of the one-time repo-identity upgrade (POD-1360) ----

  /**
   * THE REPOS HALF OF THE ONE-TIME REPO-IDENTITY UPGRADE — three rewrites that used
   * to be three standing per-boot heals (`backfillRepoIds`, `healLocalOrigins`,
   * `backfillPrefixes`), sequenced with the issues half by the SessionStore facade.
   *
   * NONE OF THEM WAS EVER A HEAL. Each repairs a row shape NO CURRENT WRITER CAN
   * PRODUCE: `addRepo` reads the local origin, derives the repo_id and ensures the
   * prefix, all before it inserts. The one producer left is `importReposJson`, itself
   * a one-shot legacy import that runs immediately before this — so the work is
   * finite, and the facade spends it once per database instead of every boot.
   *
   * THE ORDER IS LOAD-BEARING, and it is not quite the order the heals ran in.
   * Origins are recorded BEFORE prefixes because `updateRepoOrigin` upgrades a
   * path-fallback id to the origin-derived one and re-keys the prefix onto it;
   * deriving a prefix first would mint one against an id about to be replaced. They
   * are recorded before the ISSUES half too (the facade's ordering), so a legacy
   * issue lands on the final id in one write instead of being dual-written twice.
   */
  migrateLegacyRepoRows(): void {
    const withoutRepoId = this.db
      .prepare('SELECT machine_id, path, origin_url FROM repos WHERE repo_id IS NULL')
      .all() as { machine_id: MachineId; path: string; origin_url: string | null }[]
    const setRepo = this.db.prepare(
      'UPDATE repos SET repo_id = ? WHERE machine_id = ? AND path = ?',
    )
    for (const r of withoutRepoId) {
      setRepo.run(
        deriveRepoId({ originUrl: r.origin_url, machineId: r.machine_id, path: r.path }),
        r.machine_id,
        r.path,
      )
    }

    // Pre-v8 rows never recorded origin_url, so without this they sit on path-fallback
    // ids until a daemon scan happens to run. `updateRepoOrigin` upgrades fallback ids
    // only (and dual-writes issues), so recording an origin twice is a no-op.
    //
    // THIS IS THE STEP THAT COULD NOT BOUND ITSELF, and the reason the facade needs a
    // marker rather than idempotence-by-construction: a repo on another machine, or one
    // with no remote at all, is legitimately `origin_url IS NULL` FOREVER. "No originless
    // rows left" is never true, so as a heal this re-read those git configs off disk on
    // every boot, for the life of the install, to find what it found last time.
    const originless = this.db
      .prepare('SELECT machine_id, path FROM repos WHERE origin_url IS NULL')
      .all() as { machine_id: MachineId; path: string }[]
    for (const r of originless) {
      const origin = readLocalOriginUrl(r.path)
      if (origin) this.updateRepoOrigin(r.machine_id, r.path, origin)
    }

    // #474: a human-facing prefix for every logical repo still missing one. Keyed by
    // resolved repo_id, so it reads the ids the two steps above just settled.
    const rows = this.db
      .prepare('SELECT path, repo_name, repo_id FROM repos ORDER BY rowid ASC')
      // SERIALIZATION EDGE: untyped columns; repo_id re-enters its id space.
      .all() as { path: string; repo_name: string | null; repo_id: RepoId | null }[]
    for (const r of rows) {
      const repoId = r.repo_id ?? this.resolveRepoIdForPath(r.path)
      this.ensurePrefixForRepoId(repoId, r.repo_name ?? r.path.split('/').pop() ?? 'REPO')
    }
  }

  /**
   * What the repos half left behind: rows still carrying no repo_id, and logical repos
   * still carrying no prefix.
   *
   * A SECOND READ of the database rather than a restatement of what was just written —
   * the same discipline as `migrateLegacyMachineIdentity`'s residue check. The facade
   * decides what each number means; note that ORIGINS ARE ABSENT ON PURPOSE, because
   * originless is a legitimate resting state and a check that can never reach zero
   * would only reintroduce the heal it replaced.
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

  /**
   * One-time import of a legacy ~/.podium/repos.json sitting next to the db.
   *
   * RETURNS HOW MANY ROWS IT INSERTED, and that number is load-bearing rather than
   * informational: these rows land with a NULL repo_id and no prefix, so this is the
   * one writer left in the process that can still create work for the repo-identity
   * upgrade. The facade runs the upgrade when a database has never been past it OR
   * when this reports an import, so the upgrade's bound does not rest on the
   * assumption that a legacy import can only ever precede the marker.
   */
  importReposJson(dbPath: string, machineId: MachineId): number {
    if (dbPath === ':memory:') return 0
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM repos').get() as { c: number }).c
    if (count > 0) return 0
    let raw: string
    try {
      raw = readFileSync(join(dirname(dbPath), 'repos.json'), 'utf8')
    } catch {
      return 0 // no legacy file
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return 0 // corrupt file -> skip
    }
    if (!Array.isArray(parsed)) return 0
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO repos (machine_id, path, origin_url, repo_name, added_at) VALUES (?, ?, NULL, ?, ?)',
    )
    const now = new Date().toISOString()
    let imported = 0
    for (const p of parsed)
      if (typeof p === 'string') {
        insert.run(machineId, p, p.split('/').pop() ?? null, now)
        imported += 1
      }
    return imported
  }
}
