/**
 * Repos aggregate — owns the `repos` table (registered repo roots per machine,
 * origin URLs and the stable repo_id identity, #74).
 *
 * Cross-aggregate note: upgrading a repo's identity dual-writes the new
 * repo_id onto issues bucketed under it. That write is owned by the issues
 * repository and injected here as `assignRepoIdToIssuesUnder`.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { derivePrefix, isValidPrefix } from '@podium/protocol'
import { type SqlDatabase, transaction } from '@podium/runtime/sqlite'
import { deriveRepoId, isPathFallbackRepoId, readLocalOriginUrl } from '../repo-id'

export function normalizeRepoPath(path: string): string {
  const trimmed = path.trim()
  if (/^\/+$/u.test(trimmed)) return '/'
  return trimmed.replace(/\/+$/u, '')
}

export class ReposRepository {
  constructor(
    private readonly db: SqlDatabase,
    /** Issues-aggregate dual-write: stamp repoId onto issues under repoPath. */
    private readonly assignRepoIdToIssuesUnder: (repoId: string, repoPath: string) => void,
  ) {}

  /** Back-compat: flat list of paths across all machines. RepoRegistry.list() uses this. */
  listRepoPaths(machineId?: string): string[] {
    return this.listRepos(machineId).map((r) => r.path)
  }

  /** Full repo rows including machineId, originUrl, repoId and prefix (#474). */
  listRepos(machineId?: string): {
    machineId: string
    path: string
    originUrl: string | null
    repoId: string | null
    prefix: string | null
  }[] {
    const rows = (
      machineId
        ? this.db
            .prepare(
              'SELECT machine_id, path, origin_url, repo_id FROM repos WHERE machine_id = ? ORDER BY rowid ASC',
            )
            .all(machineId)
        : this.db
            .prepare('SELECT machine_id, path, origin_url, repo_id FROM repos ORDER BY rowid ASC')
            .all()
    ) as Record<string, unknown>[]
    const prefixes = new Map(
      (
        this.db.prepare('SELECT repo_id, prefix FROM repo_prefixes').all() as {
          repo_id: string
          prefix: string
        }[]
      ).map((r) => [r.repo_id, r.prefix]),
    )
    return rows.map((r) => {
      const repoId = (r.repo_id as string | null) ?? null
      return {
        machineId: r.machine_id as string,
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
  prefixForRepoId(repoId: string): string | null {
    const row = this.db
      .prepare('SELECT prefix FROM repo_prefixes WHERE repo_id = ?')
      .get(repoId) as { prefix: string } | undefined
    return row?.prefix ?? null
  }

  /** The prefix chosen for the logical repo containing `repoPath` (or null). */
  prefixForPath(repoPath: string): string | null {
    return this.prefixForRepoId(this.resolveRepoIdForPath(repoPath))
  }

  /** The registered repo owning `prefix` (its repoId + a representative path). */
  repoForPrefix(prefix: string): { repoId: string; path: string } | null {
    const row = this.db
      .prepare('SELECT repo_id FROM repo_prefixes WHERE prefix = ?')
      .get(prefix) as { repo_id: string } | undefined
    if (!row) return null
    const pathRow = this.db
      .prepare('SELECT path FROM repos WHERE repo_id = ? LIMIT 1')
      .get(row.repo_id) as { path: string } | undefined
    return { repoId: row.repo_id, path: pathRow?.path ?? '' }
  }

  /** Ensure the logical repo `repoId` has a prefix; derive+persist one if not.
   *  Idempotent. Returns the effective prefix. */
  ensurePrefixForRepoId(repoId: string, repoName: string): string {
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
  setRepoPrefix(machineId: string, path: string, prefix: string): void {
    if (!isValidPrefix(prefix)) {
      throw new Error(`invalid repo prefix ${JSON.stringify(prefix)} — must match ^[A-Z]{2,5}$`)
    }
    const repoId = this.resolveRepoIdForPath(normalizeRepoPath(path))
    const owner = this.db
      .prepare('SELECT repo_id FROM repo_prefixes WHERE prefix = ?')
      .get(prefix) as { repo_id: string } | undefined
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
  nextDraftSeq(repoId: string): number {
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

  /** Per-boot heal: derive+assign a prefix for every logical repo still missing
   *  one (idempotent). Keyed by resolved repo_id, so runs AFTER backfillRepoIds. */
  backfillPrefixes(): void {
    const rows = this.db
      .prepare('SELECT path, repo_name, repo_id FROM repos ORDER BY rowid ASC')
      .all() as { path: string; repo_name: string | null; repo_id: string | null }[]
    for (const r of rows) {
      const repoId = r.repo_id ?? this.resolveRepoIdForPath(r.path)
      this.ensurePrefixForRepoId(repoId, r.repo_name ?? r.path.split('/').pop() ?? 'REPO')
    }
  }

  // No path validation here by design — RepoRegistry (the caller) rejects empty/non-absolute paths.
  // readLocalOriginUrl is a no-op (null) for paths that don't exist on this host, so remote-machine
  // repos simply get the path-fallback id until a scan reports their origin (updateRepoOrigin then
  // upgrades it). An explicit `prefix` overrides derivation (validated + uniqueness-checked, #474).
  addRepo(path: string, machineId = '__local__', originUrl?: string, prefix?: string): void {
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
  updateRepoOrigin(machineId: string, path: string, originUrl: string): void {
    const normalizedPath = normalizeRepoPath(path)
    const rows = this.db
      .prepare('SELECT path, repo_id FROM repos WHERE machine_id = ?')
      .all(machineId) as { path: string; repo_id: string | null }[]
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

  /** repo_id for an issue's repoPath: the longest registered repo root that contains
   *  it (any machine), else the deterministic '__local__' path-fallback. */
  resolveRepoIdForPath(repoPath: string): string {
    const normalizedRepoPath = normalizeRepoPath(repoPath)
    const match = this.listRepos()
      .map((r) => ({ ...r, path: normalizeRepoPath(r.path) }))
      .filter(
        (r) =>
          normalizedRepoPath === r.path ||
          normalizedRepoPath.startsWith(r.path === '/' ? r.path : `${r.path}/`),
      )
      .sort((a, b) => b.path.length - a.path.length)[0]
    return match?.repoId ?? deriveRepoId({ machineId: '__local__', path: normalizedRepoPath })
  }

  removeRepo(path: string, machineId = '__local__'): void {
    const normalizedPath = normalizeRepoPath(path)
    const rows = this.db.prepare('SELECT path FROM repos WHERE machine_id = ?').all(machineId) as {
      path: string
    }[]
    const remove = this.db.prepare('DELETE FROM repos WHERE machine_id = ? AND path = ?')
    for (const row of rows) {
      if (normalizeRepoPath(row.path) === normalizedPath) remove.run(machineId, row.path)
    }
  }

  /** Multi-machine adoption: rewrite placeholder '__local__' rows to the real id. */
  adoptLocalRows(machineId: string): void {
    this.db.prepare("UPDATE repos SET machine_id = ? WHERE machine_id = '__local__'").run(machineId)
  }

  // ---- per-boot data heals (idempotent; invoked by the SessionStore facade) ----

  /** v8 backfill (idempotent — only touches NULL repo_id rows, so it is safe to run
   *  every boot and also covers rows inserted by importReposJson). The issues-side
   *  backfill lives in the issues repository; the facade sequences both. */
  backfillRepoIds(): void {
    const repos = this.db
      .prepare('SELECT machine_id, path, origin_url FROM repos WHERE repo_id IS NULL')
      .all() as { machine_id: string; path: string; origin_url: string | null }[]
    const setRepo = this.db.prepare(
      'UPDATE repos SET repo_id = ? WHERE machine_id = ? AND path = ?',
    )
    for (const r of repos) {
      setRepo.run(
        deriveRepoId({ originUrl: r.origin_url, machineId: r.machine_id, path: r.path }),
        r.machine_id,
        r.path,
      )
    }
  }

  /** Self-heal origins for repos whose path exists on this host: pre-v8 rows never
   *  recorded origin_url, so without this they'd sit on path-fallback ids until a
   *  daemon scan happens to run. updateRepoOrigin upgrades fallback ids only (and
   *  dual-writes issues), so this is idempotent — once recorded, the read is skipped. */
  healLocalOrigins(): void {
    const originless = this.db
      .prepare('SELECT machine_id, path FROM repos WHERE origin_url IS NULL')
      .all() as { machine_id: string; path: string }[]
    for (const r of originless) {
      const origin = readLocalOriginUrl(r.path)
      if (origin) this.updateRepoOrigin(r.machine_id, r.path, origin)
    }
  }

  /** One-time import of a legacy ~/.podium/repos.json sitting next to the db. */
  importReposJson(dbPath: string): void {
    if (dbPath === ':memory:') return
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM repos').get() as { c: number }).c
    if (count > 0) return
    let raw: string
    try {
      raw = readFileSync(join(dirname(dbPath), 'repos.json'), 'utf8')
    } catch {
      return // no legacy file
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // corrupt file -> skip
    }
    if (!Array.isArray(parsed)) return
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO repos (machine_id, path, origin_url, repo_name, added_at) VALUES ('__local__', ?, NULL, ?, ?)",
    )
    const now = new Date().toISOString()
    for (const p of parsed)
      if (typeof p === 'string') insert.run(p, p.split('/').pop() ?? null, now)
  }
}
