/**
 * AN ISSUE'S ARTIFACTS AS EFFECT RECORDS (ADR 12 D5 E2, POD-6420).
 *
 * Adding and removing an issue's artifacts moves files: a daemon read of the
 * issue's worktree, a staged CLI upload moved into the server's artifact store,
 * a snapshot dir deleted. None of that may run inside the sync write entry
 * point's unit of work, so each is a one-off effect of its own kind targeting
 * the issue:
 *
 *   issue.artifactAdd      `panelApply` artifact-add: the daemon pulls the source
 *   issue.artifactPublish  `panelApply` artifact-upload `commit`: the staged upload
 *   issue.artifactRemove   `panelApply` artifact-remove: the entry, then its dir
 *
 * THE RECORD CARRIES A REFERENCE, NEVER BYTES: a source path in the issue's
 * worktree, a staged upload's id, or the entry's path. The upload's `begin`,
 * `chunk` and `abort` packets are byte transport into a private staging dir
 * that nothing shows; they stay on the panelApply route and never reach the
 * feed. A staged upload never published is removed by the hourly upload sweep
 * after a day (`IssueArtifactStore.sweepUploads`).
 *
 * THE PANEL CHANGE GOES THROUGH THE ENTRY POINT. Once the bytes are in the
 * store, the executor stages the snapshot on the record (`ctx.stage`) and
 * submits `issues.panelApply` with the record's id (`effectId`) as the writer,
 * as the writer is now. The entry point's handler takes the entry from the
 * record, not from the call: a caller cannot name a snapshot it did not make.
 *
 * KEYED BY THE RECORD. The snapshot's artifact id is derived from the record's
 * id, and so is the commit's mutation id: a run that finds its entry on the
 * panel answers `succeeded`; a re-run pulls into the same dir and replays the
 * same commit. RECOVER: entry on the panel → succeeded; snapshot staged but not
 * committed → commit it now; otherwise nothing is visible → `failed`, and the
 * partial dir goes.
 *
 * THE OLD COMMANDS ARE ADAPTERS (`IssueCommandDispatcher`, every transport): the
 * panelApply handler creates the record through `effects.create` as its
 * caller, waits for it to settle and answers the issue as it always did, or
 * throws its old refusal. With no daemon to read the source an add creates
 * nothing and writes nothing: it answers the command's own refusals, then the
 * machine's, as the work commands do (`answerUnready`, POD-6603). Only an
 * upload's byte packets run on the handler, and they write no issue (POD-6605).
 */

import { randomUUID } from 'node:crypto'
import {
  asArtifactId,
  asMutationId,
  type EffectTarget,
  type IssueId,
  type MachineId,
  machineRejectionMessage,
  mintDeviceId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome, EffectRunContext } from '../effects/registry'
import {
  ARTIFACT_TRANSPORT,
  type ArtifactCall,
  artifactIdOfEffect,
  ISSUE_ARTIFACT_EFFECT_KIND,
  IssueArtifactAddInput,
  type IssueArtifactEffectPort,
  IssueArtifactPublishInput,
  IssueArtifactRemoveInput,
  type StagedEntry,
} from './artifact-effect-record'
import type { IssueCaller } from './command-ctx'
import { type AnyIssueCommandDef, issueRegistry } from './registry'
import { isIssueNotFound } from './service/not-found'
import { IssueRefusal, isIssueRefusal } from './service/refusal'
import { issueTarget } from './sync-write'
import { effectWriterOf } from './work-effects'

/** How long a record may wait to start: a person or agent is waiting on it. */
export const ISSUE_ARTIFACT_DEADLINE_MS = 10 * 60 * 1000

/** How long the old command waits: a bundle pull is at most 500 MB in 4 MB slices. */
const WAIT_MS = 10 * 60 * 1000

const REFUSED = 'refused'
const NOT_FOUND = 'not-found'
const NO_LONGER_ALLOWED = 'The writer may no longer do this.'

const failed = (code: string, message: string): EffectOutcome => ({
  status: 'failed',
  error: { code, message },
})

function failedOf(error: unknown): EffectOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (isIssueRefusal(error)) return failed(REFUSED, message)
  if (isIssueNotFound(error)) return failed(NOT_FOUND, message)
  if (error instanceof TRPCError) return failed(error.code, message)
  return failed('failed', message)
}

function panelApplyDef(): AnyIssueCommandDef {
  const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>).panelApply
  if (def === undefined) throw new Error('artifact effects: no panelApply command')
  return def
}

function callerOf(principal: CommandPrincipal): IssueCaller | undefined {
  if (principal.kind === 'system') return undefined
  return { capability: principal.capability, principal }
}

/** Whether a daemon can read the issue's files now (as the work effects ask). */
async function machineReady(modules: RegistryModules, issueId: string): Promise<boolean> {
  const machineId = (await modules.issues.reports.getMeta(issueId))?.machineId ?? null
  return machineId !== null
    ? modules.machines.hasDaemon(machineId as MachineId)
    : modules.machines.onlineMachineIds().length > 0
}

export interface IssueArtifactEffectDeps {
  /** The composed modules, read per call (registered before they exist). */
  modules(): RegistryModules
  /** The writer's account as it is now. */
  readonly users: Pick<UsersRepository, 'get'>
}

export function registerIssueArtifactEffects(deps: IssueArtifactEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('artifact effects: no effects module')
  const crud = () => deps.modules().issues.crud

  const target = async (t: EffectTarget, principal: CommandPrincipal) => {
    const caller = callerOf(principal)
    if (caller === undefined || t.kind !== 'issue') return undefined
    return await issueTarget(deps.modules(), panelApplyDef(), { id: t.id }, caller)
  }

  /** The panel commit, through the entry point as the writer, keyed by the record. */
  const commit = async (
    record: EffectRow,
    op: 'artifact-add' | 'artifact-remove',
  ): Promise<EffectOutcome> => {
    const writer = await effectWriterOf(deps, record)
    if (writer?.principal === undefined) return failed(REFUSED, NO_LONGER_ALLOWED)
    const principal = writer.principal as CommandPrincipal
    const { reply, cause } = await deps.modules().syncWrite.submitDetailed(
      {
        mutationId: asMutationId(`mut_${record.id}_commit`),
        command: 'issues.panelApply',
        version: 1,
        input: { id: record.target.id, op, effectId: record.id },
      },
      principal,
      principal.kind === 'agent' ? 'relay' : 'trpc',
    )
    if (reply.outcome === 'applied') return { status: 'succeeded' }
    if (cause !== undefined) return failedOf(cause)
    return failed(
      REFUSED,
      reply.refusal.message ?? `the panel change was refused (${reply.refusal.kind})`,
    )
  }

  /** Whether the record's own snapshot is already on the panel. */
  const committed = async (record: EffectRow): Promise<boolean> => {
    const id = artifactIdOfEffect(record.id)
    return (await crud().artifactEntries(record.target.id as IssueId)).some(
      (a) => a.artifactId === id,
    )
  }

  /** Stage the snapshot, commit it, then drop the snapshot it replaced. */
  const stageAndCommit = async (
    ctx: EffectRunContext<unknown>,
    staged: StagedEntry,
  ): Promise<EffectOutcome> => {
    await ctx.stage('committing', staged)
    return await finish(ctx.record, staged)
  }

  const finish = async (record: EffectRow, staged: StagedEntry): Promise<EffectOutcome> => {
    const outcome = await commit(record, 'artifact-add')
    if (outcome.status !== 'succeeded') {
      await crud().discardArtifact(record.target.id as IssueId, staged.entry.artifactId)
      return outcome
    }
    if (staged.replaces !== undefined && staged.replaces !== staged.entry.artifactId) {
      await crud().discardArtifact(record.target.id as IssueId, staged.replaces)
    }
    return { status: 'succeeded', result: staged }
  }

  /** After a crash: the panel says whether it landed; a staged entry is committed now. */
  const recoverStaged = async (ctx: EffectRunContext<unknown>): Promise<EffectOutcome> => {
    try {
      if (await committed(ctx.record)) return { status: 'succeeded', result: ctx.record.result }
      const staged = ctx.record.result as StagedEntry | undefined
      if (staged?.entry?.artifactId === artifactIdOfEffect(ctx.record.id)) {
        return await finish(ctx.record, staged)
      }
      await crud().discardArtifact(
        ctx.record.target.id as IssueId,
        artifactIdOfEffect(ctx.record.id),
      )
      return failed(
        'interrupted',
        'The server stopped before the artifact was added; nothing was added.',
      )
    } catch (error) {
      return failedOf(error)
    }
  }

  const add: EffectExecutor<IssueArtifactAddInput> = {
    kind: ISSUE_ARTIFACT_EFFECT_KIND.add,
    input: IssueArtifactAddInput as unknown as z.ZodType<IssueArtifactAddInput>,
    deadlineMs: ISSUE_ARTIFACT_DEADLINE_MS,
    target,
    ready: async (record) => await machineReady(deps.modules(), record.target.id),
    run: async (ctx) => {
      try {
        if (await committed(ctx.record)) return { status: 'succeeded', result: ctx.record.result }
        const writer = await effectWriterOf(deps, ctx.record)
        if (writer === undefined) return failed(REFUSED, NO_LONGER_ALLOWED)
        const actorSessionId = writer.capability.actorSessionId
        // The command's own checks, as the writer is now.
        const plan = await crud().planArtifactAdd(
          ctx.record.target.id,
          ctx.input,
          actorSessionId ? { actorSessionId } : undefined,
        )
        await ctx.stage('copying')
        const { entry } = await crud().snapshotArtifact(plan, artifactIdOfEffect(ctx.record.id))
        return await stageAndCommit(ctx as EffectRunContext<unknown>, {
          entry,
          ...(plan.replaces ? { replaces: plan.replaces } : {}),
        })
      } catch (error) {
        return failedOf(error)
      }
    },
    recover: async (ctx) => await recoverStaged(ctx as EffectRunContext<unknown>),
  }

  const publish: EffectExecutor<IssueArtifactPublishInput> = {
    kind: ISSUE_ARTIFACT_EFFECT_KIND.publish,
    input: IssueArtifactPublishInput as unknown as z.ZodType<IssueArtifactPublishInput>,
    deadlineMs: ISSUE_ARTIFACT_DEADLINE_MS,
    target,
    run: async (ctx) => {
      try {
        if (await committed(ctx.record)) return { status: 'succeeded', result: ctx.record.result }
        const issueId = ctx.record.target.id as IssueId
        const before = await crud().artifactEntries(issueId)
        const published = await crud().publishStagedUpload(
          issueId,
          ctx.input.uploadId,
          artifactIdOfEffect(ctx.record.id),
        )
        if (published === undefined) {
          return failed(REFUSED, 'nothing is staged under this upload; send the file again')
        }
        const replaces = before.find((a) => a.path === published.entry.path)?.artifactId
        return await stageAndCommit(ctx as EffectRunContext<unknown>, {
          entry: published.entry,
          ...(replaces ? { replaces } : {}),
        })
      } catch (error) {
        return failedOf(error)
      }
    },
    recover: async (ctx) => await recoverStaged(ctx as EffectRunContext<unknown>),
  }

  const removeRun = async (
    record: EffectRow,
    input: IssueArtifactRemoveInput,
  ): Promise<EffectOutcome> => {
    try {
      const outcome = await commit(record, 'artifact-remove')
      if (outcome.status !== 'succeeded') return outcome
      if (input.artifactId !== undefined) {
        await crud().discardArtifact(record.target.id as IssueId, asArtifactId(input.artifactId))
      }
      return { status: 'succeeded', result: { path: input.path } }
    } catch (error) {
      return failedOf(error)
    }
  }

  const remove: EffectExecutor<IssueArtifactRemoveInput> = {
    kind: ISSUE_ARTIFACT_EFFECT_KIND.remove,
    input: IssueArtifactRemoveInput as unknown as z.ZodType<IssueArtifactRemoveInput>,
    deadlineMs: ISSUE_ARTIFACT_DEADLINE_MS,
    target,
    run: async (ctx) => await removeRun(ctx.record, ctx.input),
    // Both steps are keyed: the commit replays its mutation, the dir delete
    // finds nothing to delete.
    recover: async (ctx) => await removeRun(ctx.record, ctx.input),
  }

  effects.executors.register(add)
  effects.executors.register(publish)
  effects.executors.register(remove)

  // A machine attached: adds waiting for it can run now rather than at the sweep.
  deps.modules().bus.on('machine.connected', () => {
    effects.runner.poke(ISSUE_ARTIFACT_EFFECT_KIND.add).catch(() => undefined)
  })
}

// ---------------------------------------------------------------------------
// The old commands as adapters
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function issueArtifactEffectPort(deps: {
  modules(): RegistryModules
  record(id: string): Promise<EffectRow | undefined>
}): IssueArtifactEffectPort {
  return {
    record: deps.record,
    run: async (caller, call) => {
      // An upload's byte packets are transport into private staging: no record,
      // and the handler that stages them writes no issue.
      if (call.op === 'artifact-upload' && call.upload?.action !== 'commit') {
        if (!call.upload) throw new IssueRefusal('artifact-upload requires an upload packet')
        return ARTIFACT_TRANSPORT
      }
      const modules = deps.modules()
      const effects = modules.effects
      const principal = caller.principal
      if (effects === undefined || principal === undefined) {
        throw new Error('issues.panelApply: artifact effect records are not served here')
      }
      const scope = caller.capability.scope
      const repoPath =
        scope.kind === 'subtree'
          ? ((await modules.issues.reports.getMeta(scope.rootId))?.repoPath ?? undefined)
          : undefined
      const issueId = await modules.issues.reports.resolveRef(call.id, repoPath)
      const planned = await recordOf(modules, caller, issueId, call)
      // A retry of the same command (its mutationId) writes the same record.
      const id =
        call.mutationId !== undefined && UUID.test(call.mutationId)
          ? `eff_${call.mutationId}`
          : mintDeviceId('eff_')
      const { reply, cause } = await modules.syncWrite.submitDetailed(
        {
          mutationId: asMutationId(call.mutationId ?? `mut_artifact_${randomUUID()}`),
          command: 'effects.create',
          version: 1,
          input: {
            id,
            kind: planned.kind,
            target: { kind: 'issue', id: issueId },
            input: planned.input,
          },
          ...(caller.overrideScope === true ? { confirmed: true as const } : {}),
        },
        principal,
        principal.kind === 'agent' ? 'relay' : 'trpc',
      )
      if (reply.outcome !== 'applied') {
        if (cause !== undefined) throw cause
        throw new IssueRefusal(`issues.panelApply was refused (${reply.refusal.kind})`)
      }
      settledOrThrow(id, await effects.awaitSettled(id, WAIT_MS))
      return await modules.issues.gitWorkflow.projectionNow(issueId)
    },
  }
}

/** The record one old call makes; a call that may make none is refused. */
async function recordOf(
  modules: RegistryModules,
  caller: IssueCaller,
  issueId: IssueId,
  call: ArtifactCall,
): Promise<{ kind: string; input: object }> {
  switch (call.op) {
    case 'artifact-add': {
      if (!call.path) throw new IssueRefusal('artifact-add requires a path')
      const input = {
        path: call.path,
        ...(call.title ? { title: call.title } : {}),
        ...(call.extraPaths ? { extraPaths: call.extraPaths } : {}),
        ...(call.terminalEvidence ? { terminalEvidence: true } : {}),
        ...(call.sourceRoot ? { sourceRoot: call.sourceRoot } : {}),
      }
      if (!(await machineReady(modules, issueId))) {
        return await refuseUnready(modules, caller, issueId, input)
      }
      return { kind: ISSUE_ARTIFACT_EFFECT_KIND.add, input }
    }
    case 'artifact-upload': {
      if (!call.upload) throw new IssueRefusal('artifact-upload requires an upload packet')
      return {
        kind: ISSUE_ARTIFACT_EFFECT_KIND.publish,
        input: { uploadId: call.upload.uploadId },
      }
    }
    case 'artifact-remove': {
      if (call.index == null) throw new IssueRefusal('artifact-remove requires an index')
      // The position is read now; the record names the entry, which may move.
      const list = await modules.issues.crud.artifactEntries(issueId)
      const entry = list[call.index - 1]
      if (!entry) throw new IssueRefusal(`no item ${call.index} (list has ${list.length})`)
      return {
        kind: ISSUE_ARTIFACT_EFFECT_KIND.remove,
        input: {
          path: entry.path,
          ...(entry.artifactId !== undefined ? { artifactId: entry.artifactId } : {}),
        },
      }
    }
  }
}

/**
 * An add with no daemon to read its source NOW creates no record (it would sit
 * pending while its caller waits) and writes nothing (POD-6605). It answers the
 * command's own refusals first, as the executor would check them
 * (`planArtifactAdd`: a path outside the worktree, no worktree, terminal
 * evidence from the wrong session), then the machine's. The old command pulled
 * inline here through a composition-time writer, the `issues.artifacts` origin.
 */
async function refuseUnready(
  modules: RegistryModules,
  caller: IssueCaller,
  issueId: IssueId,
  input: IssueArtifactAddInput,
): Promise<never> {
  const actorSessionId = caller.capability.actorSessionId
  const plan = await modules.issues.crud.planArtifactAdd(
    issueId,
    input,
    actorSessionId ? { actorSessionId } : undefined,
  )
  const action = "read this issue's artifact"
  if (plan.machineId !== undefined) {
    const machine = await modules.machines.machineName(plan.machineId)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: machineRejectionMessage(machine, 'offline', action),
    })
  }
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `no machine is online to ${action}` })
}

/** A settled record's failure, as the old command threw it. */
function settledOrThrow(id: string, row: EffectRow | undefined): void {
  if (row === undefined) throw new Error(`issues.panelApply: effect ${id} is gone`)
  switch (row.status) {
    case 'succeeded':
      return
    case 'failed': {
      const code = row.error?.code ?? 'failed'
      const message = row.error?.message ?? 'issues.panelApply failed'
      if (code === REFUSED) throw new IssueRefusal(message)
      if (code === NOT_FOUND) throw new TRPCError({ code: 'NOT_FOUND', message })
      if (/^[A-Z_]+$/.test(code)) throw new TRPCError({ code: code as TRPCError['code'], message })
      throw new Error(message)
    }
    case 'pending':
    case 'running':
      throw new Error(
        `issues.panelApply is still running as effect ${id}${row.stage ? ` (${row.stage})` : ''}; its status shows on the issue`,
      )
    default:
      throw new Error(`issues.panelApply ${row.status}: ${row.error?.message ?? ''}`.trim())
  }
}
