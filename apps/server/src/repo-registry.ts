import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { readLocalOriginUrl } from './repo-id'
import type { ScanReposResult, SessionRegistry } from './relay'
import type { SessionStore } from './store'

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
  list(machineId?: string): string[] {
    return this.store.listRepoPaths(machineId)
  }

  /** The longest registered repo root that contains `path` (cwd → repo inference).
   *  A root `r` contains `path` iff `path === r` or `path` starts with `r + '/'`,
   *  so `/a` does not match `/ab`. Pure over `list()`. */
  inferFromPath(path: string, machineId?: string): string | undefined {
    return this.list(machineId)
      .filter((r) => path === r || path.startsWith(r.endsWith('/') ? r : `${r}/`))
      .sort((a, b) => b.length - a.length)[0]
  }

  async add(path: string, machineId?: string): Promise<void> {
    const p = path.trim()
    if (!p) throw new Error('repo path is empty')
    if (!isAbsolute(p)) throw new Error(`repo path must be absolute: ${p}`)
    const mid = machineId ?? this.sessionReg.defaultMachineId()
    // Best-effort origin capture: reads <p>/.git locally, so it only yields a URL
    // when the path exists on this host (remote repos get it later via scan).
    this.store.addRepo(p, mid, readLocalOriginUrl(p) ?? undefined)
  }

  async remove(path: string, machineId?: string): Promise<void> {
    const mid = machineId ?? this.sessionReg.defaultMachineId()
    this.store.removeRepo(path.trim(), mid)
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
  async scanReposAll(): Promise<ScanReposResult> {
    const machineIds = this.sessionReg.onlineMachineIds()
    if (machineIds.length === 0) {
      return {
        repositories: [],
        diagnostics: [{ severity: 'error', path: '', message: 'no daemons online' }],
      }
    }

    const perMachine = await Promise.all(
      machineIds.map(async (machineId) => {
        const roots = this.store.listRepoPaths(machineId)
        const result = await this.sessionReg.scanReposForMachine(roots, machineId, {
          includeHome: false,
          maxDepth: 0,
        })
        // Record scan-reported origins for registered repos (upgrades path-fallback
        // repo_ids to origin-derived ones — remote/late origins included).
        for (const r of result.repositories) {
          if (r.originUrl) this.store.updateRepoOrigin(machineId, r.path, r.originUrl)
        }
        const repoIdByPath = new Map(
          this.store.listRepos(machineId).map((row) => [row.path, row.repoId]),
        )
        // Stamp each repo with the machine that returned it (+ its stable repoId)
        return {
          repositories: result.repositories.map((r) => {
            const repoId = repoIdByPath.get(r.path)
            return { ...r, machineId, ...(repoId ? { repoId } : {}) }
          }),
          diagnostics: result.diagnostics,
        }
      }),
    )

    return {
      repositories: perMachine.flatMap((r) => r.repositories),
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
