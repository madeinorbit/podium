import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createLogger } from '@podium/logger'
import type { GitRepositoryWire, MachineId } from '@podium/model'
import type { ScanReposResult, SessionRegistry } from './relay'
import { readLocalOriginUrl } from './repo-id'
import { normalizeRepoPath, type SessionStore } from './store'

const log = createLogger('server:repo-registry')

export type DirectoryBrowserEntry = {
  name: string
  path: string
}

export type DirectoryBrowserListing = {
  path: string
  homePath: string
  parentPath: string | null
  entries: DirectoryBrowserEntry[]
}

/** Server-side directory browser used by the web picker. */
export async function browseDirectories(
  path?: string,
  options: { includeHidden?: boolean } = {},
): Promise<DirectoryBrowserListing> {
  const homePath = currentHomeDir()
  const requested = expandHome(path?.trim() || homePath, homePath)
  if (!isAbsolute(requested)) throw new Error(`directory path must be absolute: ${requested}`)

  let current = requested
  try {
    const s = await stat(current)
    if (!s.isDirectory()) throw new Error('path is not a directory')
    current = await realpath(current)
  } catch (err) {
    throw new Error(
      `Could not open directory ${requested}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  let entries: DirectoryBrowserEntry[]
  try {
    entries = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .filter((entry) => options.includeHidden || !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    throw new Error(
      `Could not read directory ${current}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const parent = dirname(current)
  return {
    path: current,
    homePath,
    parentPath: parent === current ? null : parent,
    entries,
  }
}

/** The longest repo root among `roots` that contains `path` (cwd → repo inference).
 *  A root `r` contains `path` iff `path === r` or `path` starts with `r + '/'`,
 *  so `/a` does not match `/ab`. Pure — shared by RepoRegistry and the in-process
 *  issue command dispatcher (modules/issues/registry). */
export function inferRepoFromRoots(roots: string[], path: string): string | undefined {
  const normalizedPath = normalizeRepoPath(path)
  return roots
    .map((r) => normalizeRepoPath(r))
    .filter((r) => normalizedPath === r || normalizedPath.startsWith(r === '/' ? r : `${r}/`))
    .sort((a, b) => b.length - a.length)[0]
}

/** Persisted list of absolute repo-root paths, backed by SessionStore. Shared by all
 *  clients so the repo list survives and shows on every device (desktop + phone).
 *
 *  Multi-machine: repos are keyed (machine_id, path). The optional `machineId`
 *  parameter on `list`/`add`/`remove` selects a specific machine's repos; omitting
 *  it returns/uses all machines (back-compat for callers that don't know the machine),
 *  except `add` which defaults to the registry's default machine so a single-machine
 *  install attributes the repo to its one machine. `scanReposAll()` fans out one
 *  `scanReposRequest` per online machine and stamps each returned `GitRepositoryWire`
 *  with the responding machine's id. */
export class RepoRegistry {
  constructor(
    private readonly sessionReg: SessionRegistry,
    private readonly store: SessionStore,
  ) {}

  /** Flat list of registered repo paths. Optionally filtered to a machine. */
  list(machineId?: MachineId): string[] {
    return this.store.repos.listRepoPaths(machineId)
  }

  /** The longest registered repo root that contains `path` (cwd → repo inference).
   *  Pure over `list()` — see {@link inferRepoFromRoots}. */
  inferFromPath(path: string, machineId?: MachineId): string | undefined {
    return inferRepoFromRoots(this.list(machineId), path)
  }

  async add(path: string, machineId?: MachineId, prefix?: string): Promise<void> {
    const p = normalizeRepoPath(path)
    if (!p) throw new Error('repo path is empty')
    if (!isAbsolute(p)) throw new Error(`repo path must be absolute: ${p}`)
    const mid = machineId ?? this.sessionReg.modules.machines.defaultMachine()
    // THE GUARD THE REPO SCREEN NEEDED (POD-2700 §2.5). Every path that registers
    // a repository — `repos.add`, `repos.addMany`, `repos.createRepo`, and
    // whatever is written next — funnels through here, which is why the check
    // sits at the WRITE rather than in each handler: a filtered dropdown does
    // nothing for a stale tab, a direct RPC call or a CLI, and a per-handler
    // guard is one someone can forget to copy.
    this.sessionReg.modules.machines.requireRepoHostStructure(mid)
    // Best-effort origin capture: reads <p>/.git locally, so it only yields a URL
    // when the path exists on this host (remote repos get it later via scan).
    // `prefix` (uppercased courtesy) overrides the derived nice-id prefix (#474).
    this.store.repos.addRepo(p, mid, readLocalOriginUrl(p) ?? undefined, prefix?.toUpperCase())
    // A new repo mints a prefix (addRepo → ensurePrefixForRepoId), so it is a
    // new 'repo' entity on the feed [POD-822].
    this.publishRepos()
  }

  /** Register a checkout whose origin was established by a machine-side clone. */
  async addKnownOrigin(path: string, machineId: MachineId, originUrl: string): Promise<void> {
    const p = normalizeRepoPath(path)
    if (!p) throw new Error('repo path is empty')
    if (!isAbsolute(p)) throw new Error(`repo path must be absolute: ${p}`)
    // Same gate as `add` — a clone lands a repo on a machine just as much as a
    // registration does, and this is the second write path (POD-2700).
    this.sessionReg.modules.machines.requireRepoHostStructure(machineId)
    this.store.repos.addRepo(p, machineId, originUrl)
    this.publishRepos()
  }

  /** Change a repo's human-facing prefix (#474). Validated ^[A-Z]{2,5}$ + unique
   *  server-wide; previously written refs stop resolving (the caller warns). */
  setPrefix(path: string, prefix: string, machineId?: MachineId): void {
    const mid = machineId ?? this.sessionReg.modules.machines.defaultMachine()
    this.store.repos.setRepoPrefix(mid, normalizeRepoPath(path), prefix.toUpperCase())
    this.publishRepos()
  }

  /**
   * Publish the repo truth onto the feed [POD-822].
   *
   * The prefix is the join input for every `displayRef` a replica derives, and
   * this registry is the ONLY thing that writes it. Without this call the write
   * would land in sqlite and stop there: no ledger commit, no change row, and the
   * replica keeps rendering `POD-13` under the old prefix until some unrelated
   * issue write happened to trigger a full reconcile. That is a bug that presents
   * as a caching problem and is really a missing emitter, so it is a call at the
   * write, not a periodic sweep.
   *
   * The whole cost is a reconcile over the LOGICAL repos — a handful of rows,
   * deduped to no-op by the ledger when nothing changed. It is deliberately NOT
   * O(the repo's issues): keeping the prefix on its own entity rather than
   * materializing `displayRef` onto every issue is what buys that, and is the
   * D7.2 decision POD-822 recorded (see model's `repo/fields.ts`).
   *
   * Best-effort by construction: the store write already succeeded, and a feed
   * that missed one publish self-heals on the next boot reconcile. Never let it
   * fail the mutation that triggered it.
   */
  private publishRepos(): void {
    try {
      this.sessionReg.modules.issues.publishRepos()
    } catch (err) {
      log.warn('repo projection publish failed', { err })
    }
  }

  async remove(path: string, machineId?: MachineId): Promise<void> {
    const mid = machineId ?? this.sessionReg.modules.machines.defaultMachine()
    this.store.repos.removeRepo(normalizeRepoPath(path), mid)
  }

  /**
   * Fan out one `scanReposRequest` to each online daemon (using the roots that
   * machine has registered), await all replies, and stamp each returned
   * `GitRepositoryWire` with the responding machine's `machineId`.
   *
   * Single-machine invariant: with one online daemon this returns exactly the
   * same repos that `scanRepos(list())` returned before — just with `machineId`
   * added. The web ignores `machineId` until the machine-aware UI lands, so the
   * single-machine UI is unchanged.
   */
  /**
   * @param mayUse - POD-1079: the machines this caller may place work on. A
   * fan-out with no filter would walk every paired host's filesystem through its
   * daemon, which is exactly the code-execution boundary `use` draws. Absent
   * means unfiltered, and the ONLY callers that omit it are in-process ones with
   * no principal to filter by (boot reconcile, tests) — every transport path
   * supplies it, and `audit:machine-grants` checks that.
   */
  async scanReposAll(mayUse?: (machineId: MachineId) => boolean): Promise<ScanReposResult> {
    const registeredRows = this.store.repos
      .listRepos()
      .filter((row) => mayUse?.(row.machineId) ?? true)
    const fallbackFor = (rows: typeof registeredRows) =>
      rows.map((row) => ({
        path: normalizeRepoPath(row.path),
        kind: 'repository' as const,
        ...(row.originUrl ? { originUrl: row.originUrl } : {}),
        worktrees: [],
        machineId: row.machineId,
        ...(row.repoId ? { repoId: row.repoId } : {}),
      }))
    const machineIds = this.sessionReg.modules.machines
      .onlineMachineIds()
      .filter((id) => mayUse?.(id) ?? true)
    if (machineIds.length === 0) {
      return {
        // A daemon restart does not unregister its repositories. A page reload
        // inside that gap must therefore render the durable roots rather than
        // replace the workspace snapshot with an authoritative-looking empty
        // list. As with a timed-out scan below, empty worktrees means unknown.
        repositories: fallbackFor(registeredRows),
        diagnostics: [{ severity: 'error', path: '', message: 'no daemons online' }],
      }
    }

    const perMachine = await Promise.all(
      machineIds.map(async (machineId) => {
        const roots = this.store.repos.listRepoPaths(machineId)
        const result = await this.sessionReg.modules.rpc.scanRepos(
          roots,
          { includeHome: false, maxDepth: 0 },
          machineId,
        )
        // Record scan-reported origins for registered repos (upgrades path-fallback
        // repo_ids to origin-derived ones — remote/late origins included).
        for (const r of result.repositories) {
          if (r.originUrl) this.store.repos.updateRepoOrigin(machineId, r.path, r.originUrl)
        }
        const storedRows = registeredRows.filter((row) => row.machineId === machineId)
        const repoIdByPath = new Map(
          storedRows.map((row) => [normalizeRepoPath(row.path), row.repoId]),
        )
        const seenPaths = new Set(result.repositories.map((r) => normalizeRepoPath(r.path)))
        // Stamp each repo with the machine that returned it (+ its stable repoId).
        const scanned = result.repositories.map((r) => {
          const repoId = repoIdByPath.get(normalizeRepoPath(r.path))
          return { ...r, machineId, ...(repoId ? { repoId } : {}) }
        })
        // Keep registered roots visible even when the daemon scan times out or returns
        // no metadata. The path is still a valid spawn target for this machine, and
        // diagnostics continue to surface the scan failure separately.
        //
        // READ `worktrees: []` HERE AS "UNKNOWN", NEVER AS "NONE" (POD-1704). These
        // rows are SYNTHESIZED from the registry because the scan told us nothing —
        // `scanRepos` resolves rather than rejects on its 10s timeout, so a slow
        // daemon lands here with every root intact and every worktree missing. A
        // consumer that reads the emptiness as absence concludes that live worktrees
        // were deleted; one did, and offered to destroy the sessions running in them.
        // The result is a UNION of machines and a snapshot of a moment, so it is
        // sound for POSITIVE answers ("here is a worktree you can use") and unsound
        // for negative ones. To ask whether a path really exists, ask the daemon that
        // owns it — `IssueWorkflow.ensureWorktree` does, and rebuilds from the branch.
        const registeredFallbacks = fallbackFor(
          storedRows.filter((row) => !seenPaths.has(normalizeRepoPath(row.path))),
        )
        return {
          repositories: [...scanned, ...registeredFallbacks],
          diagnostics: result.diagnostics,
        }
      }),
    )

    const online = new Set(machineIds)
    return {
      repositories: [
        ...perMachine.flatMap((r) => r.repositories),
        ...fallbackFor(registeredRows.filter((row) => !online.has(row.machineId))),
      ],
      diagnostics: perMachine.flatMap((r) => r.diagnostics),
    }
  }
}

function currentHomeDir(): string {
  return process.env.HOME || homedir()
}

function expandHome(path: string, homePath: string): string {
  if (path === '~') return homePath
  if (path.startsWith('~/')) return join(homePath, path.slice(2))
  return path
}
