/**
 * THE ISSUE REPOSITORIES ON THE TEST RUN'S ENGINE [POD-6984, POD-6958 design 2.10].
 *
 * `store/issues-golden.test.ts` and `store/issues.engines.test.ts` read and write issues
 * through `issues`, `repos` and the artifact uploads. A full `SessionStore` cannot open on
 * Postgres until POD-6994, so {@link openIssueEngineStore} builds those repositories the way
 * `store.ts` builds them, over the slice store of the run's engine (`openSliceStore`): a
 * migrated SQLite database on the store lane, a clone of the Postgres template on
 * `server-store-pg`, with strict timestamps on.
 *
 * CHANGE CAPTURE. On Postgres every write to a source table is a capture form
 * (`sync/capture-pg.ts`) that also writes its `sync_capture` rows, which the baseline's
 * guard refuses to commit undrained. As `drainedRepository` does, each async method call
 * runs in one transaction that drops what it captured ({@link drainedWrite}); the issue
 * repository's own panel and git-state repositories are wrapped the same way. On SQLite
 * the repositories are returned as they are. {@link IssueEngineStore.captureOf} reads what
 * one write captures, for a test of the capture forms themselves.
 *
 * THE REPOSITORY REGISTRY ON POSTGRES IS A STAND-IN, until `store/repos.ts` has its
 * Postgres forms (POD-6987: its registry read orders by `rowid`). The issue tests use the
 * registry only to register a root and to resolve an issue's repository id, so on Postgres
 * {@link PathRepoRegistry} answers those two from memory by the rule `ReposRepository`
 * applies (the longest registered root containing the path, the machine's own first, the
 * id derived from machine and path). On SQLite it is the real `ReposRepository`.
 */

import { randomUUID } from 'node:crypto'
import {
  asUserId,
  isMachinePathWithinRoot,
  type MachineId,
  machinePathKey,
  primeFirstAdminMember,
  type RepoId,
} from '@podium/model'
import type { CapturedRow } from '@podium/sync'
import { SyncRepository } from '@podium/sync/adapters/sqlite/sync-repository'
import { syncServerTables } from '../migrations/sync-server-tables'
import { deriveRepoId } from '../repo-id'
import { SELF_HOSTED_WORKSPACE_ID } from '../self-hosted-workspace'
import { ArtifactUploadsRepository } from '../store/artifact-uploads'
import { IssueGitStatesRepository } from '../store/issue-git-states'
import { IssuePanelRepository } from '../store/issue-panel'
import { IssuesRepository } from '../store/issues'
import { normalizeRepoPath, ReposRepository } from '../store/repos'
import { TableWrites } from '../store/table-writes'
import { drainedWrite, seedSliceRow } from './drained-repository'
import { openSliceStore, type SliceStore } from './pg-slice-tables'
import type { TestStoreEngine } from './pg-test-database'

/** What the issue tests use of the repository registry. */
export interface IssueRepoRegistry {
  addRepo(path: string, machineId: MachineId): Promise<void>
  resolveRepoIdForPath(repoPath: string, machineId?: MachineId | null): Promise<RepoId>
}

/** The registry's two answers the issue tests need, from memory (see the module comment). */
class PathRepoRegistry implements IssueRepoRegistry {
  private readonly roots: { path: string; machineId: MachineId; repoId: RepoId }[] = []

  async addRepo(path: string, machineId: MachineId): Promise<void> {
    const key = machinePathKey(normalizeRepoPath(path))
    if (this.roots.some((root) => root.path === key && root.machineId === machineId)) return
    this.roots.push({ path: key, machineId, repoId: deriveRepoId({ machineId, path: key }) })
    this.roots.sort((a, b) => b.path.length - a.path.length)
  }

  async resolveRepoIdForPath(repoPath: string, machineId?: MachineId | null): Promise<RepoId> {
    const key = machinePathKey(normalizeRepoPath(repoPath))
    const containing = this.roots.filter((root) => isMachinePathWithinRoot(root.path, key))
    const found = containing.find((root) => root.machineId === machineId) ?? containing[0]
    if (!found) {
      throw new Error(
        `no reporting machine for repo path ${repoPath}; choose a machine or wait for discovery`,
      )
    }
    return found.repoId
  }
}

/** What the issue tests use of a store, on either engine. */
export interface IssueEngineStore {
  readonly engine: TestStoreEngine
  readonly issues: IssuesRepository
  /**
   * The same repository without the per-call transaction (it is `issues` on SQLite), for
   * statement pins of reads: the pin counts the read's own statements on both engines.
   */
  readonly reads: IssuesRepository
  readonly repos: IssueRepoRegistry
  readonly uploads: ArtifactUploadsRepository
  readonly hostMachineId: MachineId
  /** What `countStatements` attaches to: the store's driver, on either engine. */
  readonly probeTarget: object
  /**
   * Run `write` in one transaction and return the capture rows it wrote, drained. Empty
   * on SQLite, whose test database has no capture triggers.
   */
  captureOf(write: (issues: IssuesRepository) => Promise<unknown>): Promise<CapturedRow[]>
  /** Write a row the repositories cannot produce (a legacy row), as `seedSliceRow` does. */
  seedRow(build: Parameters<typeof seedSliceRow>[1]): Promise<void>
  close(): Promise<void>
}

/** `target` with each async method call in one {@link drainedWrite} on Postgres. */
function drained<T extends object>(slice: SliceStore, target: T): T {
  if (slice.engine !== 'pg') return target
  return new Proxy(target, {
    get(of, key, receiver) {
      const value = Reflect.get(of, key, receiver) as unknown
      if (value instanceof IssuePanelRepository || value instanceof IssueGitStatesRepository)
        return drained(slice, value)
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      // A synchronous method, or a page reader (async generator), runs as it is.
      if (method.constructor.name !== 'AsyncFunction') return method.bind(of)
      return async (...args: unknown[]) =>
        await drainedWrite(slice, async () => await method.apply(of, args))
    },
  })
}

/** The issue repositories on the test run's engine (`PODIUM_TEST_STORE_ENGINE`). */
export async function openIssueEngineStore(): Promise<IssueEngineStore> {
  const slice = await openSliceStore()
  const { queries } = slice
  // The issue fixtures name the first admin as owner. On SQLite the pre-migrated image
  // primes it; the Postgres template seeds no member, so a fixed one stands in.
  if (slice.engine === 'pg') primeFirstAdminMember(asUserId('user:pg-first-admin'))
  // Wired as `SessionStore`'s constructor wires them: the cross-aggregate edges are
  // late-bound, and the repos' callback reaches the issues through the wrapper.
  let issues: IssuesRepository | undefined
  const repos =
    slice.engine === 'pg'
      ? new PathRepoRegistry()
      : new ReposRepository(
          queries,
          async (repoId, repoPath) => await issues?.assignRepoIdToIssuesUnder(repoId, repoPath),
          new TableWrites(),
        )
  const reads = new IssuesRepository(queries, async (repoPath, machineId) =>
    repos instanceof ReposRepository
      ? await repos.resolveIssueRepoId(repoPath, machineId)
      : await repos.resolveRepoIdForPath(repoPath, machineId),
  )
  issues = drained(slice, reads)
  const sync = new SyncRepository(queries, syncServerTables, SELF_HOSTED_WORKSPACE_ID)
  return {
    engine: slice.engine,
    issues,
    reads,
    repos: drained(slice, repos),
    uploads: drained(slice, new ArtifactUploadsRepository(queries)),
    hostMachineId: `mach_${randomUUID()}` as MachineId,
    probeTarget: slice.probeTarget,
    captureOf: async (write) =>
      await queries.createOrJoinTransaction(async () => {
        await write(reads)
        return await sync.drainCapture()
      }),
    seedRow: async (build) => await seedSliceRow(slice, build),
    close: async () => await slice.close(),
  }
}
