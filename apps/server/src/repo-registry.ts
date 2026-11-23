import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { describeError } from '@podium/logger'
import type { GitDiscoveryDiagnosticWire, MachineId } from '@podium/model'
import { isAbsoluteMachinePath, isMachinePathWithinRoot } from '@podium/model'
import type { IssueWriter } from './modules/issues/service/types'
import type { SessionRegistry } from './relay'
import { readLocalOriginUrl } from './repo-id'
import { normalizeRepoPath, type SessionStore } from './store'

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
    throw new Error(`Could not open directory ${requested}: ${describeError(err)}`)
  }

  let entries: DirectoryBrowserEntry[]
  try {
    entries = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .filter((entry) => options.includeHidden || !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    throw new Error(`Could not read directory ${current}: ${describeError(err)}`)
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
    .filter((r) => isMachinePathWithinRoot(r, normalizedPath))
    .sort((a, b) => b.length - a.length)[0]
}

/**
 * Whether `name` is a plain branch name by `git check-ref-format --branch` rules:
 * no revision syntax (`~ ^ : ? * [ \`, `..`, `@{`), no control characters or
 * spaces, no leading `-` or `/`, no trailing `/`, `.` or `.lock`, no empty or
 * dot-led component, and not `HEAD` [POD-2065].
 *
 * Stricter than git on one name: `@` alone. `check-ref-format --branch` reads it
 * as the current branch's shorthand and answers with that branch, not with `@`,
 * so there is no branch literally named `@` to store.
 */
export function isBranchName(name: string): boolean {
  if (name === '' || name === '@' || name === 'HEAD') return false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (/[\x00-\x20\x7f~^:?*[\\]/u.test(name)) return false
  if (name.includes('..') || name.includes('@{')) return false
  if (name.startsWith('-') || name.startsWith('/')) return false
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  return name
    .split('/')
    .every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
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
/** What a repo write commits on (ADR 12 D9). */
export type RepoWriter = IssueWriter

export class RepoRegistry {
  constructor(
    private readonly sessionReg: SessionRegistry,
    private readonly store: SessionStore,
  ) {}

  /** Flat list of registered repo paths. Optionally filtered to a machine. */
  async list(machineId?: MachineId): Promise<string[]> {
    return await this.store.repos.listRepoPaths(machineId)
  }

  /** The longest registered repo root that contains `path` (cwd → repo inference).
   *  Pure over `list()` — see {@link inferRepoFromRoots}. */
  async inferFromPath(path: string, machineId?: MachineId): Promise<string | undefined> {
    return inferRepoFromRoots(await this.list(machineId), path)
  }

  async add(
    writer: RepoWriter,
    path: string,
    machineId?: MachineId,
    prefix?: string,
  ): Promise<void> {
    const p = normalizeRepoPath(path)
    if (!p) throw new Error('repo path is empty')
    if (!isAbsoluteMachinePath(p)) throw new Error(`repo path must be absolute: ${p}`)
    const mid = machineId ?? (await this.sessionReg.modules.machines.defaultMachine())
    // THE GUARD THE REPO SCREEN NEEDED (POD-2700 §2.5). Every path that registers
    // a repository — `repos.add`, `repos.addMany`, `repos.createRepo`, and
    // whatever is written next — funnels through here, which is why the check
    // sits at the WRITE rather than in each handler: a filtered dropdown does
    // nothing for a stale tab, a direct RPC call or a CLI, and a per-handler
    // guard is one someone can forget to copy.
    await this.sessionReg.modules.machines.requireRepoHostStructure(mid)
    // Best-effort origin capture: reads <p>/.git locally, so it only yields a URL
    // when the path exists on this host (remote repos get it later via scan).
    // `prefix` (uppercased courtesy) overrides the derived nice-id prefix (#474).
    // A new repo mints a prefix (addRepo → ensurePrefixForRepoId), so it is a
    // new 'repo' entity on the feed [POD-822].
    await this.commitRepoWrite(
      writer,
      async () =>
        await this.store.repos.addRepo(
          p,
          mid,
          readLocalOriginUrl(p) ?? undefined,
          prefix?.toUpperCase(),
        ),
    )
    await this.checkoutsMoved(mid)
  }

  /** Register a checkout whose origin was established by a machine-side clone. */
  async addKnownOrigin(path: string, machineId: MachineId, originUrl: string): Promise<void> {
    const p = normalizeRepoPath(path)
    if (!p) throw new Error('repo path is empty')
    if (!isAbsoluteMachinePath(p)) throw new Error(`repo path must be absolute: ${p}`)
    // Same gate as `add` — a clone lands a repo on a machine just as much as a
    // registration does, and this is the second write path (POD-2700).
    await this.sessionReg.modules.machines.requireRepoHostStructure(machineId)
    await this.commitRepoWrite(
      this.serverWriter,
      async () => await this.store.repos.addRepo(p, machineId, originUrl),
    )
    await this.checkoutsMoved(machineId)
  }

  /** Change a repo's human-facing prefix (#474). Validated ^[A-Z]{2,5}$ + unique
   *  server-wide; previously written refs stop resolving (the caller warns). */
  async setPrefix(
    writer: RepoWriter,
    path: string,
    prefix: string,
    machineId?: MachineId,
  ): Promise<void> {
    const mid = machineId ?? (await this.sessionReg.modules.machines.defaultMachine())
    await this.commitRepoWrite(
      writer,
      async () =>
        await this.store.repos.setRepoPrefix(mid, normalizeRepoPath(path), prefix.toUpperCase()),
    )
  }

  /**
   * Set (or clear, with null) the repo's base branch: the parent new issues in it
   * are cut from and the branch they land on [POD-2065]. Refused unless the branch
   * exists in the checkout at `path`, asked of the machine that holds it. Existing
   * issues keep their parent; only issues created afterwards pick this up.
   */
  async setDefaultParentBranch(
    writer: RepoWriter,
    path: string,
    branch: string | null,
    machineId?: MachineId,
  ): Promise<void> {
    await this.verifyDefaultParentBranch(path, branch, machineId)
    await this.storeDefaultParentBranch(writer, path, branch, machineId)
  }

  /**
   * The check half of {@link setDefaultParentBranch}: the name is a branch name
   * and the branch exists in the checkout, asked of the machine that holds it.
   * Throws the refusal. A daemon round trip, so it runs before any unit of work
   * (the sync write path asks it at the target check, POD-6417).
   */
  async verifyDefaultParentBranch(
    path: string,
    branch: string | null,
    machineId?: MachineId,
  ): Promise<void> {
    const mid = machineId ?? (await this.sessionReg.modules.machines.defaultMachine())
    const p = normalizeRepoPath(path)
    const name = branch?.trim() || null
    if (name !== null) {
      // A name, not a revision: `refs/heads/<x>` plus the daemon's `^{commit}` would
      // otherwise let `tf.dev~1` resolve and be stored as a branch.
      if (!isBranchName(name)) throw new Error(`invalid branch name '${name}'`)
      const rpc = this.sessionReg.modules.rpc
      const found = await rpc.repoOp('revParseVerify', p, { ref: `refs/heads/${name}` }, mid)
      if (!found.ok) {
        // A repository that cannot resolve HEAD either did not answer; say that
        // rather than blaming the branch.
        const head = await rpc.repoOp('revParseVerify', p, { ref: 'HEAD' }, mid)
        if (!head.ok)
          throw new Error(`could not read the repository at ${p}: ${head.output.trim()}`)
        throw new Error(`branch '${name}' does not exist in ${p}`)
      }
    }
  }

  /** The write half of {@link setDefaultParentBranch}, database only. */
  async storeDefaultParentBranch(
    writer: RepoWriter,
    path: string,
    branch: string | null,
    machineId?: MachineId,
  ): Promise<void> {
    const mid = machineId ?? (await this.sessionReg.modules.machines.defaultMachine())
    await this.commitRepoWrite(
      writer,
      async () =>
        await this.store.repos.setRepoDefaultParentBranch(
          mid,
          normalizeRepoPath(path),
          branch?.trim() || null,
        ),
    )
  }

  /**
   * A registry write and the repo truth it moves, in one ledger commit
   * [POD-822, POD-6524].
   *
   * The prefix is the join input for every `displayRef` a replica derives, and
   * this registry is the ONLY thing that writes it. Without a change row the
   * write would land in sqlite and stop there: the replica keeps rendering
   * `POD-13` under the old prefix until some unrelated issue write happened to
   * trigger a full reconcile. That is a bug that presents as a caching problem
   * and is really a missing emitter, so the change rides the write.
   *
   * A declared commit rather than a reconcile after the write: the change rows
   * carry the causing command's provenance (a `repos.*` write through
   * `sync.submit` confirms by its `mutationId`, POD-6272), and the store write
   * and its rows commit or roll back together. The declaration covers the
   * LOGICAL repos, a handful of rows deduped to no-op when nothing changed;
   * deliberately NOT O(the repo's issues), which is what keeping the prefix on
   * its own entity buys (the D7.2 decision POD-822 recorded, see model's
   * `repo/fields.ts`).
   */
  /**
   * One repo write, on `writer` (ADR 12 D9): a fleet command's own writer, or the
   * issues service's server writer for the server's own repo facts (a clone's
   * origin, a scan).
   */
  private async commitRepoWrite<T>(writer: RepoWriter, write: () => Promise<T>): Promise<T> {
    return await this.sessionReg.modules.issues.reports.store.commitRepoWrite(writer, write)
  }

  /** The server's own repo writer: the issues service's (`issues.server`), for
   *  the repo facts the server records on its own account (a clone's register). */
  get serverWriter(): RepoWriter {
    return this.sessionReg.modules.issues.reports.store.serverWriter
  }

  async remove(writer: RepoWriter, path: string, machineId?: MachineId): Promise<void> {
    const mid = machineId ?? (await this.sessionReg.modules.machines.defaultMachine())
    // The removed checkout may have been the repo's chosen root or the source
    // of its name (POD-6246): the logical repo row is a function of the rest.
    await this.commitRepoWrite(
      writer,
      async () => await this.store.repos.removeRepo(normalizeRepoPath(path), mid),
    )
    await this.checkoutsMoved(mid)
  }

  /**
   * A registration moved: the machine's checkout records follow it at once
   * (the root appears or goes), then a scan fills in its branch and worktrees
   * (POD-6644).
   */
  private async checkoutsMoved(machineId: MachineId): Promise<void> {
    const checkouts = this.sessionReg.modules.checkouts
    await checkouts.registrationsChanged(machineId)
    checkouts.rescanSoon(machineId)
  }

  /**
   * Scan every machine this caller may use and bring its checkout records up
   * to date (POD-6644): the explicit "look again" a person asks for after
   * changing repositories outside Podium. The checkouts themselves reach the
   * apps as records; this answers only the scans' diagnostics, which the view
   * that asked shows.
   *
   * @param mayUse - the machines this caller may place work on (POD-1079): a
   * scan walks the machine's filesystem through its daemon, which is the
   * code-execution boundary `use` draws.
   */
  async rescanUsable(mayUse: (machineId: MachineId) => boolean): Promise<GitDiscoveryDiagnosticWire[]> {
    const machineIds = this.sessionReg.modules.machines.onlineMachineIds().filter(mayUse)
    if (machineIds.length === 0) {
      return [{ severity: 'error', path: '', message: 'no daemons online' }]
    }
    const diagnostics = await Promise.all(
      machineIds.map(async (machineId) => await this.sessionReg.modules.checkouts.rescan(machineId)),
    )
    return diagnostics.flat()
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
