/**
 * THE FOLDER PICKER'S WRITES AS EFFECT RECORDS (ADR 12 D5 E2, POD-6417).
 *
 * Three one-off changes to a machine's disk, each one `dirOp` round trip to the
 * daemon that owns that disk (POD-1295), as `repo.clone` is (POD-6396):
 *
 *  - `folder.create`: a new folder (`repos.createFolder`);
 *  - `folder.rename`: rename a folder (`repos.renameFolder`). A folder that is,
 *    or holds, a registered repository is refused: the rename would strand
 *    those rows. Asked when the record runs, so it is the state of that moment;
 *  - `repo.create`: a new folder with `git init`, then registered
 *    (`repos.createRepo`).
 *
 * PERMISSION: machine `use` (the contracts' verb), checked live at create,
 * cancel and dismiss. The machine must be able to host repositories, checked
 * again when the record runs. The daemon owns validation and containment: it
 * is the only side that can see the filesystem.
 *
 * RECOVERY after a server stop: the folder the record names is looked for on
 * the machine. There (and, for a rename, the old name gone): `succeeded`, and a
 * new repository is registered. Anything else is `unknown`: the daemon may yet
 * have done it, so the person checks before trying again.
 *
 * THE OLD ROUTES are adapters (`handlers.ts`): they create the record through
 * `sync.submit` as their caller, wait for it, and answer their old shapes.
 */

import { FLEET_CONTRACTS } from '@podium/commands'
import {
  asMachineId,
  type EffectTarget,
  HOST_REPOS,
  isMachinePathWithinRoot,
  joinMachinePath,
  type MachineId,
  machinePathsEqual,
} from '@podium/model'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { checkMachineUse, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import { normalizeRepoPath } from '../../store'
import type { EffectRow } from '../../store/effects'
import type { EffectOutcome } from '../effects/registry'
import { NO_TARGET } from '../sync-write/registry'
import { MACHINE_EFFECT_DEADLINE_MS } from './discovery-effects'

export const FOLDER_CREATE_KIND = 'folder.create'
export const FOLDER_RENAME_KIND = 'folder.rename'
export const REPO_CREATE_KIND = 'repo.create'

/** The error code of a refusal the daemon gave: the routes answered it as
 *  BAD_REQUEST, its other failures as PRECONDITION_FAILED. */
export const DIR_OP_FAILED = 'dir-op'

/** How long the old routes wait: one directory operation (plus `git init`). */
export const FOLDER_EFFECT_WAIT_MS = 60_000

export const FolderCreateInput = FLEET_CONTRACTS['repos.createFolder'].input
  .omit({ machineId: true })
  .strict()
export type FolderCreateInput = z.infer<typeof FolderCreateInput>

export const FolderRenameInput = FLEET_CONTRACTS['repos.renameFolder'].input
  .omit({ machineId: true })
  .strict()
export type FolderRenameInput = z.infer<typeof FolderRenameInput>

export const RepoCreateInput = FLEET_CONTRACTS['repos.createRepo'].input
  .omit({ machineId: true })
  .strict()
export type RepoCreateInput = z.infer<typeof RepoCreateInput>

export interface FolderEffectResult {
  readonly path: string
}

export interface FolderEffectDeps {
  modules(): RegistryModules
  /** Register a new repository (`RepoRegistry.add`: its guard, the row, the feed). */
  register(path: string, machineId: MachineId): Promise<void>
  /** The repositories registered on a machine. */
  registeredPaths(machineId: MachineId): Promise<string[]>
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const failed = (code: string, message: string): EffectOutcome => ({
  status: 'failed',
  error: { code, message },
})

const lostTrack = (path: string): EffectOutcome => ({
  status: 'unknown',
  error: {
    code: 'lost-track',
    message: `The machine did not confirm the change; check ${path} before trying again.`,
  },
})

/** Why a rename would strand registered rows, or `undefined` (POD-1295). */
export function strandedRefusal(
  registered: readonly string[],
  parentPath: string,
  currentName: string,
): string | undefined {
  const source = normalizeRepoPath(joinMachinePath(parentPath, currentName))
  // The folder itself, or anything registered BELOW it: both sets of rows point
  // at paths the rename would invalidate.
  const stranded = registered.filter((repo) => isMachinePathWithinRoot(source, repo))
  if (stranded.length === 0) return undefined
  return machinePathsEqual(stranded[0]!, source)
    ? `${currentName} is registered in Podium. Remove it from your repositories first, then rename it.`
    : `${currentName} holds a repository Podium has registered (${stranded[0]}). Remove it from your repositories first, then rename it.`
}

export function registerFolderEffects(deps: FolderEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('folder effects: no effects module')
  const machines = () => deps.modules().machines
  const rpc = () => deps.modules().rpc

  /** Machine `use`, live. */
  const target = async (t: EffectTarget, principal: CommandPrincipal) => {
    if (t.kind !== 'machine' || principal.kind === 'system') return undefined
    const ownership = await ownershipSnapshotFromMachines(machines())
    return checkMachineUse(principal, asMachineId(t.id), ownership) === undefined
      ? NO_TARGET
      : undefined
  }

  const hostRefusal = async (machineId: MachineId, action: string) => {
    try {
      await machines().requireCapability(machineId, HOST_REPOS, action)
      return undefined
    } catch (error) {
      return failed('refused', errorText(error))
    }
  }

  /** Whether the folder is there, asked of its machine; `undefined` when it cannot tell. */
  const exists = async (path: string, machineId: MachineId): Promise<boolean | undefined> => {
    try {
      const answer = await rpc().browseDirs(path, {}, machineId)
      if (answer.listing !== undefined) return true
      return answer.error !== undefined && /timed out/.test(answer.error) ? undefined : false
    } catch {
      return undefined
    }
  }

  const machineOf = (record: EffectRow) => asMachineId(record.target.id)

  effects.executors.register<FolderCreateInput>({
    kind: FOLDER_CREATE_KIND,
    input: FolderCreateInput,
    target,
    deadlineMs: MACHINE_EFFECT_DEADLINE_MS,
    run: async (ctx) => {
      const machineId = machineOf(ctx.record)
      const refused = await hostRefusal(machineId, 'hold folders')
      if (refused) return refused
      await ctx.stage('creating')
      const result = await rpc().dirOp('createFolder', machineId, ctx.input)
      if (result.error || !result.path) {
        return failed(DIR_OP_FAILED, result.error ?? 'Could not create the folder')
      }
      return { status: 'succeeded', result: { path: result.path } satisfies FolderEffectResult }
    },
    recover: async (ctx) => {
      const path = joinMachinePath(ctx.input.parentPath, ctx.input.name)
      return (await exists(path, machineOf(ctx.record))) === true
        ? { status: 'succeeded', result: { path } satisfies FolderEffectResult }
        : lostTrack(path)
    },
  })

  effects.executors.register<FolderRenameInput>({
    kind: FOLDER_RENAME_KIND,
    input: FolderRenameInput,
    target,
    deadlineMs: MACHINE_EFFECT_DEADLINE_MS,
    run: async (ctx) => {
      const machineId = machineOf(ctx.record)
      const refused = await hostRefusal(machineId, 'hold folders')
      if (refused) return refused
      const stranded = strandedRefusal(
        await deps.registeredPaths(machineId),
        ctx.input.parentPath,
        ctx.input.currentName,
      )
      if (stranded !== undefined) return failed('registered', stranded)
      await ctx.stage('renaming')
      const result = await rpc().dirOp('renameFolder', machineId, ctx.input)
      if (result.error || !result.path) {
        return failed(DIR_OP_FAILED, result.error ?? 'Could not rename the folder')
      }
      return { status: 'succeeded', result: { path: result.path } satisfies FolderEffectResult }
    },
    recover: async (ctx) => {
      const machineId = machineOf(ctx.record)
      const path = joinMachinePath(ctx.input.parentPath, ctx.input.name)
      const old = joinMachinePath(ctx.input.parentPath, ctx.input.currentName)
      return (await exists(path, machineId)) === true && (await exists(old, machineId)) === false
        ? { status: 'succeeded', result: { path } satisfies FolderEffectResult }
        : lostTrack(path)
    },
  })

  effects.executors.register<RepoCreateInput>({
    kind: REPO_CREATE_KIND,
    input: RepoCreateInput,
    target,
    deadlineMs: MACHINE_EFFECT_DEADLINE_MS,
    run: async (ctx) => {
      const machineId = machineOf(ctx.record)
      const refused = await hostRefusal(machineId, 'host repositories')
      if (refused) return refused
      await ctx.stage('creating')
      const result = await rpc().dirOp('createRepo', machineId, ctx.input)
      // `path` WITH `error` is the real case where git could not run: the folder
      // is on disk and the user will see it on the next listing, but it is not a
      // repository, so registering it would hand them a row that breaks on first use.
      if (result.error || !result.path) {
        return failed(DIR_OP_FAILED, result.error ?? 'Could not create the repository')
      }
      await ctx.stage('registering')
      await deps.register(result.path, machineId)
      return { status: 'succeeded', result: { path: result.path } satisfies FolderEffectResult }
    },
    recover: async (ctx) => {
      const machineId = machineOf(ctx.record)
      const path = joinMachinePath(ctx.input.parentPath, ctx.input.name)
      // A folder there may be one `git init` never reached: only a repository
      // the machine reports at that path is registered.
      const found = await rpc().scanRepos([path], { includeHome: false, maxDepth: 0 }, machineId)
      const repo = found.repositories.find(
        (r) =>
          r.kind === 'repository' &&
          machinePathsEqual(normalizeRepoPath(r.path), normalizeRepoPath(path)),
      )
      if (repo === undefined) return lostTrack(path)
      await deps.register(path, machineId)
      return { status: 'succeeded', result: { path } satisfies FolderEffectResult }
    },
  })
}
