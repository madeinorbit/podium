/**
 * STARTING A NAMED TASK IS AN EFFECT RECORD (POD-6410, ADR 12 D5 E2).
 *
 * "New task with its first agent" files an issue and starts it at once. Both
 * ids are minted on the device (the issue's `iss_<uuid>`, ADR 12 D4, and the
 * session's uuid), and the start is an effect record of kind `issue.start`
 * whose target is the issue: every device sees it pending ("Starting…", also
 * while the machine is offline), and the issue and session rows are born under
 * those ids when it runs.
 *
 *  - TARGET (at `effects.create`): a new issue id of the D4 shape that no issue
 *    holds yet (a create never overwrites, and an existing id is not a start).
 *  - READY: only while a daemon can take it (the create's machine, or any).
 *  - RUN, once per record (the runner claims it): the issue family's own
 *    `issues.create` with `startNow`, under the WRITER as they are NOW (active
 *    account, current role), so its checks run at act time: who may file in
 *    that repo and under that parent, proposals, and the start itself; machine
 *    `use` on an explicit placement is checked first. Only a person writes one:
 *    an agent files and starts through `issues.create` (POD-6359). A session row
 *    under the id already there means an earlier run got that far: succeeded.
 *    An issue already under the id at run time is a collision: failed, nothing
 *    filed. An issue filed whose agent then failed to start is `failed` with
 *    the issue kept; the failure shows on the record, which targets the issue.
 *    A task the family files as a proposal (a member's top-level task) starts
 *    nothing by design: `failed` with code `proposed`, which the apps show as
 *    the proposal it is, never as an error.
 *  - RECOVER: the session row → succeeded; the issue alone → failed, the task
 *    kept and its agent not started; neither → failed, nothing filed.
 *    A chosen `stage` (the New task dialogs' stage pick, POD-6421) is the
 *    family's own `issues.update` once the task is filed and its agent asked
 *    for (the start itself moves it to In progress), never on a proposal. A
 *    refused stage leaves the started task where it is: the record still
 *    succeeds, its result saying why the stage did not apply.
 *  - PUBLISH: everything but the description and the brief, which come with the
 *    issue row.
 */

import {
  asUserId,
  type EffectTarget,
  IssueBoardStage,
  type IssueId,
  type MachineId,
  NewIssueId,
  NewSessionId,
  type SessionId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import { type CommandPrincipal, userCommandPrincipal } from '../../command-principal'
import { checkMachineUse, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import { NO_LONGER_ALLOWED } from '../sessions/lifecycle-controller'
import { NO_TARGET } from '../sync-write/registry'
import type { IssueCaller } from './command-ctx'
import { type AnyIssueCommandDef, issueRegistry } from './registry'
import { isIssueRefusal } from './service/refusal'
import { issueTarget } from './sync-write'

export const ISSUE_START_KIND = 'issue.start'

/** The record's code when the family filed the task as a proposal and started
 *  nothing: an admin starts it. The apps paint it as a proposal, not a failure. */
export const ISSUE_START_PROPOSED = 'proposed'
const PROPOSED_MESSAGE = 'Filed as a proposal; an admin starts it.'

/** A start whose machine has not attached for this long expires unrun. */
export const ISSUE_START_DEADLINE_MS = 24 * 60 * 60 * 1000

function defOf(name: 'create' | 'update'): AnyIssueCommandDef {
  const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[name]
  if (def === undefined) throw new Error(`issue start: no issue command named ${name}`)
  return def
}

/** `issues.create`'s own fields, without the ids (the record's target and the
 *  session below), the start flag (always on) and the route's dedup key; plus
 *  the stage the task is moved to once it has started. */
export const IssueStartInput = (defOf('create').input as unknown as z.AnyZodObject)
  .omit({ id: true, startSessionId: true, startNow: true, mutationId: true })
  .extend({ sessionId: NewSessionId, stage: IssueBoardStage.optional() })
export type IssueStartInput = z.infer<typeof IssueStartInput> & {
  readonly sessionId: string
  readonly machineId?: MachineId
  readonly stage?: IssueBoardStage
}

export interface IssueStartEffectDeps {
  modules(): RegistryModules
  users: Pick<UsersRepository, 'get'>
}

/** A definitive answer from the family's checks, not a fault. */
const refusalOf = (error: unknown): boolean =>
  isIssueRefusal(error) ||
  (error instanceof TRPCError &&
    (error.code === 'BAD_REQUEST' || error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND'))

const failed = (code: string, message: string): EffectOutcome => ({
  status: 'failed',
  error: { code, message },
})

export function registerIssueStartEffect(deps: IssueStartEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('issue start: no effects module')

  const issueExists = async (id: string): Promise<boolean> => {
    const row = await deps.modules().issues.reports.getMeta(id)
    return row !== null && row.id === id
  }
  const sessionExists = async (id: string) =>
    await deps.modules().sessions.sessionRowExists(id as SessionId)

  /** The writer as they are now, as the issue family's caller. */
  const writerOf = async (record: EffectRow): Promise<IssueCaller | undefined> => {
    if (record.createdBy === null) return undefined
    const user = await deps.users.get(record.createdBy)
    if (!user || user.disabledAt) return undefined
    const principal = userCommandPrincipal(asUserId(user.id), user.role)
    return { capability: principal.capability, principal }
  }

  const mayUse = async (caller: IssueCaller, machineId: MachineId) =>
    !checkMachineUse(
      caller.principal as CommandPrincipal,
      machineId,
      await ownershipSnapshotFromMachines(deps.modules().machines),
    )

  const run = async (record: EffectRow, input: IssueStartInput): Promise<EffectOutcome> => {
    const issueId = record.target.id as IssueId
    const { sessionId, stage, ...create } = input
    if (await sessionExists(sessionId)) {
      return { status: 'succeeded', result: { issueId, sessionId, output: 'already started' } }
    }
    const caller = await writerOf(record)
    if (!caller) return failed('refused', NO_LONGER_ALLOWED)
    if (create.machineId !== undefined && !(await mayUse(caller, create.machineId))) {
      return failed('refused', NO_LONGER_ALLOWED)
    }
    // The target check refused an existing id at create; one here is a race
    // with another writer, and is never started or overwritten.
    if (await issueExists(issueId)) {
      return failed('conflict', 'an issue with this id already exists')
    }
    const def = defOf('create')
    const parsed = def.input.safeParse({
      ...create,
      id: issueId,
      startNow: true,
      startSessionId: sessionId,
    })
    if (!parsed.success) return failed('invalid', parsed.error.message)
    try {
      await deps.modules().issueCommands.withoutDedup().run(caller, 'create', def, parsed.data)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Filed, then its agent could not start: the task stays (it is the
      // writer's now), and the record says why its agent did not.
      if (await issueExists(issueId)) {
        if (stage !== undefined) await moveTo(caller, issueId, stage)
        return failed('start-failed', message)
      }
      return failed(refusalOf(error) ? 'refused' : 'failed', message)
    }
    // Filed as a proposal (the family files a non-operator's top-level task,
    // or one under a proposal, inert): the expected outcome, not an error. The
    // record ends with its own code so the apps show the task as proposed.
    if (!(await sessionExists(sessionId))) {
      return failed(ISSUE_START_PROPOSED, PROPOSED_MESSAGE)
    }
    const stageRefused = stage === undefined ? undefined : await moveTo(caller, issueId, stage)
    return {
      status: 'succeeded',
      result: { issueId, sessionId, ...(stageRefused ? { stageRefused } : {}) },
    }
  }

  /** The chosen stage as the family's own update; why it did not apply, if not. */
  const moveTo = async (
    caller: IssueCaller,
    issueId: IssueId,
    stage: IssueBoardStage,
  ): Promise<string | undefined> => {
    const def = defOf('update')
    const parsed = def.input.safeParse({ id: issueId, patch: { stage } })
    if (!parsed.success) return parsed.error.message
    try {
      await deps.modules().issueCommands.withoutDedup().run(caller, 'update', def, parsed.data)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const executor: EffectExecutor<IssueStartInput> = {
    kind: ISSUE_START_KIND,
    input: IssueStartInput as unknown as z.ZodType<IssueStartInput>,
    deadlineMs: ISSUE_START_DEADLINE_MS,
    /**
     * A person's start only: an agent files and starts through `issues.create`
     * (POD-6359), whose principal this record could not carry to the run. A new
     * id of the D4 shape may be started; once the record's issue is filed, the
     * issue family's own scope check on it decides cancel and dismiss.
     */
    target: async (target: EffectTarget, principal: CommandPrincipal) => {
      if (principal.kind !== 'user' || target.kind !== 'issue') return undefined
      if (!NewIssueId.safeParse(target.id).success) return undefined
      if (!(await issueExists(target.id))) return NO_TARGET
      const caller: IssueCaller = { capability: principal.capability, principal }
      return await issueTarget(deps.modules(), defOf('update'), { id: target.id }, caller)
    },
    publish: (input) => {
      const {
        description: _description,
        brief: _brief,
        ...rest
      } = input as IssueStartInput & {
        description?: string
        brief?: string
      }
      return rest
    },
    ready: (_record, input) => {
      const machines = deps.modules().machines
      return input.machineId !== undefined
        ? machines.hasDaemon(input.machineId)
        : machines.onlineMachineIds().length > 0
    },
    run: async (ctx) => await run(ctx.record, ctx.input),
    recover: async (ctx) => {
      if (await sessionExists(ctx.input.sessionId)) {
        return { status: 'succeeded', result: { issueId: ctx.record.target.id } }
      }
      return (await issueExists(ctx.record.target.id))
        ? failed(
            'interrupted',
            'The server stopped after filing the task; its agent did not start.',
          )
        : failed(
            'interrupted',
            'The server stopped before the task was filed; nothing was started.',
          )
    },
  }
  effects.executors.register(executor)
  deps
    .modules()
    .bus.on('machine.connected', () => effects.runner.poke(ISSUE_START_KIND).catch(() => undefined))
}
