import { dirname } from 'node:path'
import type { GitDiscoveryDiagnosticWire, GitRepositoryWire } from '@podium/protocol'
import { normalizeOriginUrl } from './repo-id'
import type { ScanReposResult } from './relay'
import { normalizeRepoPath } from './store'

/**
 * [spec:SP-3701] Tiered repo discovery for a (newly paired or reconnecting) machine —
 * POD-787. Answers "what repos does this machine have?" without ever walking blindly:
 *
 *   T1 probe    — exact-path probes derived from repos registered on OTHER machines
 *                 (raw path + home-translated `~/…` form). maxDepth 0: a handful of
 *                 stats on the daemon, no walk. The common "same layout on my laptop"
 *                 case completes here in milliseconds.
 *   T2 adjacent — a shallow walk (depth 2) of the PARENT directories of everything
 *                 known on that machine (registered + T1 hits): repos cluster, so
 *                 siblings of known repos are where the rest usually live.
 *   T3 sweep    — a bounded $HOME walk (depth 4, standard ignore list). Only when
 *                 `deep: true` (the explicit "scan this machine" action) — never on
 *                 the automatic connect trigger, so reconnects stay cheap.
 *
 * All walking happens ON THE DAEMON (the target machine); the hub only awaits RPC
 * replies, so nothing here contends with the hub main loop or session reattach.
 *
 * Registration policy: a discovered repo whose origin URL matches a repo already
 * registered on another machine is auto-registered (identity converges to the same
 * repo_id via deriveRepoId, so it is unambiguously "the same repo, here too");
 * anything else is returned as a candidate for the user to confirm — never a
 * silent add.
 */

export type DiscoveredRepo = {
  path: string
  originUrl?: string
  branch?: string
  status: 'registered' | 'auto-registered' | 'candidate'
  /** Names of other machines that carry the same repo (origin match). */
  alsoOn: string[]
}

export type MachineDiscoveryResult = {
  machineId: string
  startedAt: number
  durationMs: number
  deep: boolean
  repos: DiscoveredRepo[]
  diagnostics: GitDiscoveryDiagnosticWire[]
}

type RepoRow = { machineId: string; path: string; originUrl: string | null }

/** `/home/u/src/x` | `/Users/u/src/x` → `~/src/x` (undefined when not under a home). */
export function homeRelativePath(path: string): string | undefined {
  const m = /^\/(?:home|Users)\/[^/]+\/(.+)$/.exec(path)
  return m ? `~/${m[1]}` : undefined
}

/** T1 probe roots for `machineId`: paths of repos on OTHER machines, raw + `~`-form,
 *  minus paths already registered on the target. Order-stable and deduped. */
export function probeRootsFor(machineId: string, rows: RepoRow[]): string[] {
  const registered = new Set(
    rows.filter((r) => r.machineId === machineId).map((r) => normalizeRepoPath(r.path)),
  )
  const probes: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.machineId === machineId) continue
    const path = normalizeRepoPath(row.path)
    for (const candidate of [path, homeRelativePath(path)]) {
      if (!candidate || seen.has(candidate)) continue
      seen.add(candidate)
      // Raw absolute paths already registered on the target need no probe; the
      // `~` form can't be compared here (the daemon expands it) — probe anyway,
      // already-registered results are classified below, not re-added.
      if (registered.has(candidate)) continue
      probes.push(candidate)
    }
  }
  return probes
}

/** T2 walk roots: parents of every path known on the machine (registered + found),
 *  excluding `/` and home-ish roots (the deep sweep owns those), capped. */
export function adjacentRootsFor(knownPaths: string[], cap = 12): string[] {
  const parents = new Set<string>()
  for (const p of knownPaths) {
    const parent = dirname(normalizeRepoPath(p))
    if (parent === '/' || /^\/(?:home|Users)\/[^/]+$/.test(parent)) continue
    parents.add(parent)
  }
  // Drop parents contained in another collected parent — the shallow walk from the
  // outer one already covers them.
  const sorted = [...parents].sort()
  const roots = sorted.filter(
    (p, i) => !(i > 0 && sorted.slice(0, i).some((outer) => p.startsWith(`${outer}/`))),
  )
  return roots.slice(0, cap)
}

export interface RepoDiscoveryDeps {
  listRepos(): RepoRow[]
  addRepo(path: string, machineId: string, originUrl?: string): Promise<void> | void
  scanRepos(
    roots: string[],
    opts: { includeHome?: boolean; maxDepth?: number },
    machineId: string,
  ): Promise<ScanReposResult>
  machineName(machineId: string): string
  localMachineId: string
  log?: (message: string) => void
  now?: () => number
}

const CONNECT_SCAN_DELAY_MS = 3_000
const CONNECT_SCAN_MIN_INTERVAL_MS = 10 * 60_000

export class MachineRepoDiscovery {
  private readonly running = new Map<string, Promise<MachineDiscoveryResult>>()
  private readonly lastConnectScanAt = new Map<string, number>()
  private readonly lastResults = new Map<string, MachineDiscoveryResult>()

  constructor(private readonly deps: RepoDiscoveryDeps) {}

  /** Fire-and-forget connect trigger: delayed (reattach settles first), throttled
   *  per machine, never awaited by the attach path, shallow tiers only. */
  onMachineConnected(machineId: string): void {
    if (machineId === this.deps.localMachineId) return // local repos are adopted at boot
    const now = this.deps.now?.() ?? Date.now()
    const last = this.lastConnectScanAt.get(machineId)
    if (last !== undefined && now - last < CONNECT_SCAN_MIN_INTERVAL_MS) return
    this.lastConnectScanAt.set(machineId, now)
    setTimeout(() => {
      this.scan(machineId, { deep: false }).catch((err) => {
        this.deps.log?.(
          `repo discovery for ${machineId} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }, CONNECT_SCAN_DELAY_MS).unref?.()
  }

  /** Most recent finished result for a machine (auto or explicit). */
  lastResult(machineId: string): MachineDiscoveryResult | undefined {
    return this.lastResults.get(machineId)
  }

  /** Run the tiered discovery. Concurrent calls for one machine coalesce. */
  scan(machineId: string, opts: { deep: boolean }): Promise<MachineDiscoveryResult> {
    const inFlight = this.running.get(machineId)
    if (inFlight) return inFlight
    const run = this.runScan(machineId, opts).finally(() => this.running.delete(machineId))
    this.running.set(machineId, run)
    return run
  }

  private async runScan(
    machineId: string,
    opts: { deep: boolean },
  ): Promise<MachineDiscoveryResult> {
    const startedAt = this.deps.now?.() ?? Date.now()
    const rows = this.deps.listRepos()
    const diagnostics: GitDiscoveryDiagnosticWire[] = []
    const found = new Map<string, GitRepositoryWire>()

    const collect = (result: ScanReposResult): void => {
      diagnostics.push(...result.diagnostics)
      for (const repo of result.repositories) {
        // Worktrees ride along with their repository row; registering them
        // separately would double-list every repo.
        if (repo.kind !== 'repository') continue
        const path = normalizeRepoPath(repo.path)
        if (!found.has(path)) found.set(path, repo)
      }
    }

    // T1 — exact probes of other machines' repo paths (maxDepth 0 = stat only).
    const probes = probeRootsFor(machineId, rows)
    if (probes.length > 0) {
      collect(await this.deps.scanRepos(probes, { includeHome: false, maxDepth: 0 }, machineId))
    }

    // T2 — shallow walk around everything known on this machine so far.
    const knownOnMachine = [
      ...rows.filter((r) => r.machineId === machineId).map((r) => r.path),
      ...found.keys(),
    ]
    const adjacent = adjacentRootsFor(knownOnMachine)
    if (adjacent.length > 0) {
      collect(await this.deps.scanRepos(adjacent, { includeHome: false, maxDepth: 2 }, machineId))
    }

    // T3 — bounded home sweep, explicit scans only.
    if (opts.deep) {
      collect(await this.deps.scanRepos([], { includeHome: true, maxDepth: 4 }, machineId))
    }

    // Classify + auto-register origin matches.
    const registeredHere = new Set(
      rows.filter((r) => r.machineId === machineId).map((r) => normalizeRepoPath(r.path)),
    )
    const byOrigin = new Map<string, RepoRow[]>()
    for (const row of rows) {
      const origin = normalizeOriginUrl(row.originUrl)
      if (!origin) continue
      const list = byOrigin.get(origin) ?? []
      list.push(row)
      byOrigin.set(origin, list)
    }

    const repos: DiscoveredRepo[] = []
    for (const [path, repo] of found) {
      const origin = normalizeOriginUrl(repo.originUrl ?? null)
      const elsewhere = (origin ? (byOrigin.get(origin) ?? []) : []).filter(
        (r) => r.machineId !== machineId,
      )
      const alsoOn = [...new Set(elsewhere.map((r) => this.deps.machineName(r.machineId)))]
      let status: DiscoveredRepo['status']
      if (registeredHere.has(path)) {
        status = 'registered'
      } else if (elsewhere.length > 0) {
        await this.deps.addRepo(path, machineId, repo.originUrl)
        status = 'auto-registered'
        this.deps.log?.(
          `auto-registered ${path} on ${this.deps.machineName(machineId)} (same origin as ${alsoOn.join(', ')})`,
        )
      } else {
        status = 'candidate'
      }
      repos.push({
        path,
        ...(repo.originUrl ? { originUrl: repo.originUrl } : {}),
        ...(repo.branch ? { branch: repo.branch } : {}),
        status,
        alsoOn,
      })
    }

    repos.sort((a, b) => a.path.localeCompare(b.path))
    const result: MachineDiscoveryResult = {
      machineId,
      startedAt,
      durationMs: (this.deps.now?.() ?? Date.now()) - startedAt,
      deep: opts.deep,
      repos,
      diagnostics,
    }
    this.lastResults.set(machineId, result)
    return result
  }
}
