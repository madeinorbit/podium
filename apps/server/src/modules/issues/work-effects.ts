/**
 * THE ISSUE COMMANDS THAT ACT ON MACHINES, AS EFFECT RECORDS (POD-6414, ADR 12
 * D5 E2).
 *
 * Starting an issue's work, stopping it, adding a session or a shell, cleaning
 * up its worktree, shipping it and refreshing its assistant all do work outside
 * the database inside the request: a git worktree, a daemon spawn or stop, a
 * daemon's read of a branch tip, an LLM call. None of that may run inside the
 * sync write entry point's unit of work. So each is a one-off effect: a record
 * of its own kind, targeting the issue, created through `effects.create`, which
 * the runner hands to the executor below once it commits.
 *
 *   issue.begin       `issues.start`: worktree, then the first session
 *   issue.addSession  `issues.addSession` and `issues.addShell` (`shell: true`)
 *   issue.stop        `issues.stop`: every member stopped, then the worktree freed
 *   issue.cleanup     `issues.cleanup`: worktree and branch removed
 *   issue.ship        `issues.ship`: the daemon reads both branch tips, then the order
 *   issue.assistant   `issues.refreshAssistant`: the LLM call
 *
 * THE WRITER AS THEY ARE NOW. Every run re-reads who wrote the record: a
 * person's active account and current role, or an agent's current capability
 * (its session's scope, delegated by its human, whose account must still be
 * active). A writer who has lost the right since is refused at run time.
 *
 * SPAWNS ARE ONCE PER ID (session.launch semantics). `issue.begin` and
 * `issue.addSession` carry the new session's id, minted on the device (or by
 * the old route). A session row already under it means an earlier run got as
 * far as the spawn: `succeeded`, nothing started. Before a spawn the writer's
 * machine `use` on the issue's machine is checked again, narrowed by the
 * writing agent's delegation.
 *
 * STOP WRITES THE DESIRED STATE. `issue.stop` never calls a stop service: it
 * writes `desired: stopped` on each member's session record through
 * `records.session.edit` as the writer, waits for the lifecycle controller's
 * action on that revision, then frees the worktree. The writing agent's own
 * session, when it is a member, is stopped last and only after its reply is on
 * the wire: the answer carries `deferredKill`, and the relay's reply hook
 * writes its `desired: stopped` (`finishSelfStop`).
 *
 * The other kinds run the issue command's own handler (`registry.ts`) with the
 * record's input and the issue as its id, so every check and every answer is
 * the one the command always had.
 *
 *  - TARGET: the issue command's own scope check on the record's issue.
 *  - READY: a daemon for the issue's machine (any machine for an issue placed
 *    nowhere yet). The assistant needs none, and neither does a stop: it writes
 *    desired states, and a member whose machine is away stops when it attaches.
 *  - RECOVER: check the world where it can say (the session row exists; the
 *    worktree is gone and nothing runs); otherwise `unknown`.
 *  - PUBLISH: the input, which holds no secret (an agent kind, a model).
 *
 * THE OLD COMMANDS ARE ADAPTERS. `IssueCommandDispatcher.run` sends these
 * commands here (every transport reaches it: the tRPC routes, the relay, MCP):
 * it creates the record through `sync.submit` as its caller, waits for it to
 * settle, and answers the command's old shape, or throws its old error. The old
 * command never does the work itself (POD-6603): with no daemon to run it now it
 * creates nothing and answers at once, as `sessions.create` does
 * (`refuseUnplaceable`, POD-6416): its own refusals and no-ops first, then the
 * machine refusal; these are reads. A stop, the assistant and an answer need
 * no daemon and always take the record path.
 */

import { randomUUID } from 'node:crypto'
import {
  asMutationId,
  type EffectTarget,
  type IssueId,
  type MachineId,
  type MutationId,
  machineRejectionMessage,
  mintDeviceId,
  NewSessionId,
  type SessionId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { liveSessionsUsingWorktree } from '../../issue-util'
import { checkMachineUse, ownershipSnapshotFromMachines } from '../../machine-access'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import {
  agentCommandPrincipal,
  WRITER_NO_LONGER_ALLOWED,
  writerPrincipalNow,
  writingAgentOf,
} from '../effects/writer'
import { refusalAsTrpcError } from '../sync-write/route-adapter'
import { commandAccess, type IssueCaller } from './command-ctx'
import {
  type AnyIssueCommandDef,
  assertStartable,
  guardIssueCommand,
  issueRegistry,
} from './registry'
import { isIssueNotFound } from './service/not-found'
import { IssueRefusal, isIssueRefusal } from './service/refusal'
import { issueTarget } from './sync-write'

/** The commands that run as effect records, by procedure name, with their kind. */
export const ISSUE_WORK_EFFECT_KIND = {
  start: 'issue.begin',
  stop: 'issue.stop',
  addSession: 'issue.addSession',
  addShell: 'issue.addSession',
  cleanup: 'issue.cleanup',
  ship: 'issue.ship',
  refreshAssistant: 'issue.assistant',
  /** The Tray's answer (POD-6415): the one answer kind, its target the issue
   *  (`modules/interactions/answer-effect.ts` registers it). */
  answerQuestion: 'session.answer',
} as const

export type IssueWorkCommand = keyof typeof ISSUE_WORK_EFFECT_KIND
export type IssueWorkKind = (typeof ISSUE_WORK_EFFECT_KIND)[IssueWorkCommand]

export const isIssueWorkCommand = (name: string): name is IssueWorkCommand =>
  Object.hasOwn(ISSUE_WORK_EFFECT_KIND, name)

/**
 * Every issue command whose write is an effect record: the work above and the
 * git actions (`git-effects.ts`: `action`, `integrate`). Its tRPC route is an
 * adapter onto `effects.create` (POD-6603), as `files.write`'s is.
 */
export const ISSUE_EFFECT_RECORD_COMMANDS: readonly string[] = [
  ...Object.keys(ISSUE_WORK_EFFECT_KIND),
  'action',
  'integrate',
]

export const runsAsEffectRecord = (name: string): boolean =>
  ISSUE_EFFECT_RECORD_COMMANDS.includes(name)

/** How long a record may wait to start: a machine that has not attached by then
 *  will not, for work a person is waiting on. */
export const ISSUE_WORK_DEADLINE_MS = 10 * 60 * 1000

/** How long the old command waits for its record. A start may clone a repo. */
const WAIT_MS: Readonly<Record<IssueWorkCommand, number>> = {
  start: 10 * 60 * 1000,
  addSession: 10 * 60 * 1000,
  addShell: 5 * 60 * 1000,
  stop: 5 * 60 * 1000,
  cleanup: 5 * 60 * 1000,
  ship: 5 * 60 * 1000,
  refreshAssistant: 2 * 60 * 1000,
  answerQuestion: 60 * 1000,
}

function defOf(name: IssueWorkCommand): AnyIssueCommandDef {
  const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[name]
  if (def === undefined) throw new Error(`issue work effects: no issue command named ${name}`)
  return def
}

const objectOf = (name: IssueWorkCommand) => defOf(name).input as unknown as z.AnyZodObject

// ---------------------------------------------------------------------------
// The record inputs: the command's own fields, without the issue (the target)
// and the route's dedup key (the record's id is its identity).
// ---------------------------------------------------------------------------

export const IssueBeginInput = objectOf('start')
  .omit({ id: true, mutationId: true, sessionId: true })
  .extend({ sessionId: NewSessionId })
  .strict()
export type IssueBeginInput = z.infer<typeof IssueBeginInput>

export const IssueAddSessionInput = z
  .object({
    agentKind: z.string().optional(),
    forceUnknownModel: z.boolean().optional(),
    /** A shell (`issues.addShell`): no agent, no model. */
    shell: z.boolean().optional(),
    sessionId: NewSessionId,
  })
  .strict()
export type IssueAddSessionInput = z.infer<typeof IssueAddSessionInput>

export const IssueStopInput = z.object({ force: z.boolean().optional() }).strict()
export type IssueStopInput = z.infer<typeof IssueStopInput>

const Nothing = z.object({}).strict()

/** A handler's error, as the code the old command answers it with again. */
const REFUSED = 'refused'
const NOT_FOUND = 'not-found'

const failed = (code: string, message: string): EffectOutcome => ({
  status: 'failed',
  error: { code, message },
})

/** An issue command's thrown refusal as a failed outcome, read back by {@link answerOf}. */
export const issueCommandFailure = (error: unknown): EffectOutcome => failedOf(error)

function failedOf(error: unknown): EffectOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (isIssueRefusal(error)) return failed(REFUSED, message)
  if (isIssueNotFound(error)) return failed(NOT_FOUND, message)
  if (error instanceof TRPCError) return failed(error.code, message)
  return failed('failed', message)
}

const LOST_TRACK: EffectOutcome = {
  status: 'unknown',
  error: {
    code: 'lost-track',
    message: 'The server stopped while this ran; check the issue before running it again.',
  },
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface IssueWorkEffectDeps {
  /** The composed modules, read per call (registered before they exist). */
  modules(): RegistryModules
  /** The writer's account as it is now. */
  readonly users: Pick<UsersRepository, 'get'>
}

function callerOf(principal: CommandPrincipal): IssueCaller | undefined {
  if (principal.kind === 'system') return undefined
  return { capability: principal.capability, principal }
}

/** Whether a daemon can do the work now: the issue's machine, or any machine
 *  for an issue placed nowhere yet. */
async function machineReady(modules: RegistryModules, issueId: string): Promise<boolean> {
  const machineId = (await modules.issues.reports.getMeta(issueId))?.machineId ?? null
  return machineId !== null
    ? modules.machines.hasDaemon(machineId as MachineId)
    : modules.machines.onlineMachineIds().length > 0
}

/**
 * An issue effect's writer as they are NOW, as the issue family's caller: a
 * person's active account and current role, or an agent's current capability.
 * Undefined when the writer may no longer act. Shared with the artifact effects.
 */
export async function effectWriterOf(
  deps: IssueWorkEffectDeps,
  record: EffectRow,
): Promise<IssueCaller | undefined> {
  const principal = await writerPrincipalNow(deps.modules(), deps.users, record)
  return principal === undefined ? undefined : callerOf(principal)
}

export function registerIssueWorkEffects(deps: IssueWorkEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('issue work effects: no effects module')

  /** The writer as they are NOW, as the issue family's caller. */
  const writerOf = async (record: EffectRow): Promise<IssueCaller | undefined> =>
    await effectWriterOf(deps, record)

  /** Machine `use` on the issue's machine, now: the writer's role, narrowed by the
   *  writing agent's delegation (as `session.launch`). */
  const mayUseIssueMachine = async (record: EffectRow, caller: IssueCaller): Promise<boolean> => {
    const modules = deps.modules()
    const machineId = (await modules.issues.reports.getMeta(record.target.id))?.machineId ?? null
    if (machineId === null) return true
    const ownership = await ownershipSnapshotFromMachines(modules.machines)
    if (checkMachineUse(caller.principal as CommandPrincipal, machineId as MachineId, ownership)) {
      return false
    }
    const agent = writingAgentOf(record)
    const delegated = agent ? ownership.delegatedMachines?.(agent) : undefined
    return delegated === undefined || delegated.has(machineId as MachineId)
  }

  const sessionExists = async (id: string) =>
    await deps.modules().sessions.sessionRowExists(id as SessionId)

  const targetOf =
    (name: IssueWorkCommand) => async (target: EffectTarget, principal: CommandPrincipal) => {
      const caller = callerOf(principal)
      if (caller === undefined || target.kind !== 'issue') return undefined
      return await issueTarget(deps.modules(), defOf(name), { id: target.id }, caller)
    }

  /** Run one issue command's own handler as the writer, with the issue as its id. */
  const runHandler = async (
    record: EffectRow,
    caller: IssueCaller,
    name: IssueWorkCommand,
    input: Record<string, unknown>,
  ): Promise<EffectOutcome> => {
    const def = defOf(name)
    try {
      const parsed: unknown = def.input.parse({ ...input, id: record.target.id })
      const result = await deps
        .modules()
        .issueCommands.forEffectRun()
        .run(caller, name, def, parsed)
      return { status: 'succeeded', result: result ?? null }
    } catch (error) {
      return failedOf(error)
    }
  }

  // ---- issue.begin / issue.addSession: a spawn, once per session id --------

  const spawnOnce = async (
    record: EffectRow,
    name: 'start' | 'addSession' | 'addShell',
    input: Record<string, unknown> & { sessionId: string },
  ): Promise<EffectOutcome> => {
    if (await sessionExists(input.sessionId)) {
      return {
        status: 'succeeded',
        result: { sessionId: input.sessionId, output: 'already started' },
      }
    }
    const caller = await writerOf(record)
    if (caller === undefined) return failed(REFUSED, WRITER_NO_LONGER_ALLOWED)
    if (!(await mayUseIssueMachine(record, caller)))
      return failed(REFUSED, WRITER_NO_LONGER_ALLOWED)
    return await runHandler(record, caller, name, input)
  }

  const spawnRecover = async (sessionId: string): Promise<EffectOutcome> =>
    (await sessionExists(sessionId))
      ? { status: 'succeeded', result: { sessionId } }
      : // The worktree may have been made; the session row is written before the
        // spawn frame is sent, so no row means no session was started.
        failed('interrupted', 'The server stopped before the session started; nothing was started.')

  const machineKindReady = async (record: EffectRow) =>
    await machineReady(deps.modules(), record.target.id)

  const begin: EffectExecutor<IssueBeginInput> = {
    kind: ISSUE_WORK_EFFECT_KIND.start,
    input: IssueBeginInput as unknown as z.ZodType<IssueBeginInput>,
    deadlineMs: ISSUE_WORK_DEADLINE_MS,
    target: targetOf('start'),
    ready: machineKindReady,
    run: async (ctx) =>
      await spawnOnce(ctx.record, 'start', ctx.input as IssueBeginInput & { sessionId: string }),
    recover: async (ctx) => await spawnRecover(String(ctx.input.sessionId)),
  }

  const addSession: EffectExecutor<IssueAddSessionInput> = {
    kind: ISSUE_WORK_EFFECT_KIND.addSession,
    input: IssueAddSessionInput as unknown as z.ZodType<IssueAddSessionInput>,
    deadlineMs: ISSUE_WORK_DEADLINE_MS,
    target: targetOf('addSession'),
    ready: machineKindReady,
    run: async (ctx) => {
      const { shell, agentKind, forceUnknownModel, sessionId } = ctx.input
      return shell === true
        ? await spawnOnce(ctx.record, 'addShell', { sessionId })
        : await spawnOnce(ctx.record, 'addSession', {
            sessionId,
            ...(agentKind !== undefined ? { agentKind } : {}),
            ...(forceUnknownModel !== undefined ? { forceUnknownModel } : {}),
          })
    },
    recover: async (ctx) => await spawnRecover(ctx.input.sessionId),
  }

  // ---- issue.stop: desired `stopped` on each member, then the worktree -----

  const stopRun = async (record: EffectRow, input: IssueStopInput): Promise<EffectOutcome> => {
    const caller = await writerOf(record)
    if (caller === undefined) return failed(REFUSED, WRITER_NO_LONGER_ALLOWED)
    const principal = caller.principal as CommandPrincipal
    const modules = deps.modules()
    const issueId = record.target.id as IssueId
    const issue = await modules.issues.reports.getMeta(issueId)
    if (!issue) return failed('PRECONDITION_FAILED', 'unknown issue')
    const self = writingAgentOf(record)
    const members = await modules.sessions.listSessionsForIssue(
      issue.worktreePath ?? null,
      issue.id,
    )
    const force = input.force === true
    const stopped: string[] = []
    const waiting: string[] = []
    let deferredKill = false
    for (const member of members) {
      if (member.sessionId === self) continue
      const outcome = await desireStopped(modules, principal, member.sessionId, force, record.id)
      if (outcome.ok !== true) {
        return failed(
          'PRECONDITION_FAILED',
          outcome.reason ?? `failed to stop session ${member.sessionId}`,
        )
      }
      stopped.push(member.sessionId)
      if (outcome.waiting === true) waiting.push(member.sessionId)
    }
    // The writing agent's own session goes last, after its reply (the relay's
    // reply hook): its worktree is freed below while it is still alive, as the
    // self-stop always did.
    const own = self === undefined ? undefined : members.find((m) => m.sessionId === self)
    if (own !== undefined) {
      stopped.push(own.sessionId)
      deferredKill =
        own.status === 'live' || own.status === 'starting' || own.status === 'reconnecting'
    }
    const kill = deferredKill
      ? {
          deferredKill: true as const,
          selfStopPending: true as const,
          ...(force ? { force: true } : {}),
        }
      : {}
    const current = await modules.issues.reports.getMeta(issueId)
    const worktree = current?.worktreePath ?? null
    if (worktree === null) {
      return {
        status: 'succeeded',
        result: { ok: true, stopped, worktreeFreed: Boolean(current?.branch), ...kill },
      }
    }
    // A member still waiting for its machine runs in the worktree, and that
    // machine is the one that would free it.
    if (waiting.length > 0) {
      return {
        status: 'succeeded',
        result: {
          ok: true,
          reason: `sessions stop when their machine attaches; worktree not freed: ${waiting.join(', ')}`,
          stopped,
          worktreeFreed: false,
          ...kill,
        },
      }
    }
    const stillUsing = liveSessionsUsingWorktree(
      worktree,
      modules.sessions.runningSessionFacts(),
      self,
    )
    if (stillUsing.length > 0) {
      return { status: 'succeeded', result: { ok: true, stopped, worktreeFreed: false, ...kill } }
    }
    try {
      const freed = await modules.issues.gitWorkflow.freeWorktreeKeepBranch(issueId, principal, {
        force,
      })
      if (!freed.ok) {
        return {
          status: 'succeeded',
          result: {
            ok: true,
            reason: `sessions stopped but worktree not freed: ${freed.output}`,
            stopped,
            worktreeFreed: false,
            ...kill,
          },
        }
      }
      return {
        status: 'succeeded',
        result: { ok: true, stopped, worktreeFreed: freed.worktreeFreed, ...kill },
      }
    } catch (error) {
      return failedOf(error)
    }
  }

  const stop: EffectExecutor<IssueStopInput> = {
    kind: ISSUE_WORK_EFFECT_KIND.stop,
    input: IssueStopInput as unknown as z.ZodType<IssueStopInput>,
    deadlineMs: ISSUE_WORK_DEADLINE_MS,
    target: targetOf('stop'),
    // No machine gate: it writes desired states, which the controller acts on
    // when each session's machine is there.
    run: async (ctx) => await stopRun(ctx.record, ctx.input),
    // Stopped and freed: done. Anything else the controller may still be acting
    // on; the person looks and stops again (a second stop is harmless).
    recover: async (ctx) => {
      const modules = deps.modules()
      const issue = await modules.issues.reports.getMeta(ctx.record.target.id)
      if (!issue) return LOST_TRACK
      const running = liveSessionsUsingWorktree(
        issue.worktreePath ?? null,
        modules.sessions.runningSessionFacts(),
      )
      return issue.worktreePath == null && running.length === 0
        ? { status: 'succeeded', result: { ok: true, stopped: [], worktreeFreed: true } }
        : LOST_TRACK
    },
  }

  // ---- issue.cleanup / issue.ship / issue.assistant: the handler as is ------

  const plain = (
    name: 'cleanup' | 'ship' | 'refreshAssistant',
    opts: { needsMachine: boolean; recover?: EffectExecutor<object>['recover'] },
  ): EffectExecutor<object> => ({
    kind: ISSUE_WORK_EFFECT_KIND[name],
    input: Nothing as unknown as z.ZodType<object>,
    deadlineMs: ISSUE_WORK_DEADLINE_MS,
    target: targetOf(name),
    ...(opts.needsMachine ? { ready: machineKindReady } : {}),
    run: async (ctx) => {
      const caller = await writerOf(ctx.record)
      if (caller === undefined) return failed(REFUSED, WRITER_NO_LONGER_ALLOWED)
      return await runHandler(ctx.record, caller, name, {})
    },
    recover: opts.recover ?? (async () => LOST_TRACK),
  })

  effects.executors.register(begin)
  effects.executors.register(addSession)
  effects.executors.register(stop)
  effects.executors.register(
    plain('cleanup', {
      needsMachine: true,
      // The worktree and branch gone: the cleanup got there.
      recover: async (ctx) => {
        const issue = await deps.modules().issues.reports.getMeta(ctx.record.target.id)
        return issue && issue.worktreePath == null && issue.branch == null
          ? { status: 'succeeded', result: { ok: true, output: 'cleaned up' } }
          : LOST_TRACK
      },
    }),
  )
  effects.executors.register(plain('ship', { needsMachine: true }))
  effects.executors.register(plain('refreshAssistant', { needsMachine: false }))

  // A machine attached: its waiting records can run now rather than at the sweep.
  const kinds = new Set<string>(Object.values(ISSUE_WORK_EFFECT_KIND))
  deps.modules().bus.on('machine.connected', () => {
    for (const kind of kinds) {
      if (
        kind === ISSUE_WORK_EFFECT_KIND.refreshAssistant ||
        kind === ISSUE_WORK_EFFECT_KIND.answerQuestion
      ) {
        continue
      }
      effects.runner.poke(kind).catch(() => undefined)
    }
  })
}

/**
 * One member's `desired: stopped`, written through `records.session.edit` as
 * the writer, and the lifecycle controller's answer for that revision. The edit's
 * mutation id is the record's and the session's, so a re-run of the same record
 * replays the same edit instead of writing a second one.
 */
async function desireStopped(
  modules: RegistryModules,
  principal: CommandPrincipal,
  sessionId: SessionId,
  force: boolean,
  recordId: string,
): Promise<{ ok?: boolean; reason?: string; waiting?: boolean; deferredKill?: unknown }> {
  const state = await modules.sessions.desiredStateOf(sessionId)
  if (!state) return { ok: true }
  const { reply } = await modules.syncWrite.submitDetailed(
    {
      mutationId: asMutationId(`mut_${recordId}_${sessionId}`),
      command: 'records.session.edit',
      version: 1,
      input: {
        id: sessionId,
        patch: { desired: 'stopped', ...(force ? { force: true } : {}) },
        expectedRevision: state.lifecycle.revision,
      },
    },
    principal,
    'trpc',
  )
  if (reply.outcome !== 'applied') {
    return {
      ok: false,
      reason: `session ${sessionId} could not be stopped (${reply.refusal.kind})`,
    }
  }
  const revision = (reply.result as { revision?: unknown } | null)?.revision
  if (typeof revision !== 'number')
    return { ok: false, reason: `session ${sessionId}: no revision` }
  const controller = modules.sessionLifecycleController
  // Joins the pass the commit already started, and waits for its action.
  await controller.reconcile(sessionId, { principal })
  const outcome = controller.outcomeFor(sessionId, revision)
  // Its machine is away: the stop is written and the controller acts on it when
  // the machine attaches (the session is pending until then).
  if (outcome === undefined) return { ok: true, waiting: true }
  return outcome
}

/**
 * The writing agent's own stop, after its reply is on the wire (the relay's
 * reply hook, for an `issues.stop` answered with `deferredKill`): its own
 * `desired: stopped`, as itself. The controller parks it and, as for any
 * self-stop (POD-6422), leaves the process to whoever holds the reply: here
 * that is this function, so it ends the process once the row is parked.
 */
export async function finishSelfStop(
  modules: RegistryModules,
  sessionId: SessionId,
  force: boolean,
): Promise<void> {
  const principal = await agentCommandPrincipal(modules, sessionId)
  if (principal === undefined) return
  const outcome = await desireStopped(modules, principal, sessionId, force, `self_${randomUUID()}`)
  if (outcome.deferredKill === true) await modules.sessions.finalizeDeferredStopKill(sessionId)
}

// ---------------------------------------------------------------------------
// The old commands as adapters
// ---------------------------------------------------------------------------

export interface IssueWorkEffectPort {
  /** Run one command as an effect record, as this caller, and answer as it always
   *  did; refused at once, with no record, when no daemon can run it now. */
  run(caller: IssueCaller, name: IssueWorkCommand, input: unknown): Promise<unknown>
}

/** The kinds that need a daemon to run: the rest write desired state, call an
 *  LLM or deliver an answer, and wait for nothing. */
const NEEDS_DAEMON: ReadonlySet<IssueWorkKind> = new Set([
  ISSUE_WORK_EFFECT_KIND.start,
  ISSUE_WORK_EFFECT_KIND.addSession,
  ISSUE_WORK_EFFECT_KIND.cleanup,
  ISSUE_WORK_EFFECT_KIND.ship,
])

/**
 * A command with no daemon to run it NOW creates no record (it would sit
 * pending while its caller waits for minutes). It answers what it answers
 * without a machine today: the caller's check as the route makes it, then the
 * command's own refusals and its no-ops (a start of an already-started issue
 * answers its projection; a cleanup of an open issue, or of one with nothing
 * recorded, its `ok: false`), read by `GitWorkflow.answerWithoutMachine`.
 * Only a command with work for a machine is refused for the machine. The old
 * command did the work inline here, through the issue family's
 * composition-time writer; nothing writes here now (POD-6603).
 */
async function answerUnready(
  modules: RegistryModules,
  caller: IssueCaller,
  name: IssueWorkCommand,
  issueId: IssueId,
  rest: Record<string, unknown>,
): Promise<unknown> {
  await guardIssueCommand(caller, commandAccess(modules.issues), name, defOf(name), {
    id: issueId,
  })
  const workflow = modules.issues.gitWorkflow
  if (name === 'start') {
    await assertStartable(
      { reports: modules.issues.reports, hierarchy: modules.issues.hierarchy, caller },
      issueId,
    )
    const opts = {
      ...(typeof rest.defaultModel === 'string' ? { model: rest.defaultModel } : {}),
      ...(typeof rest.defaultEffort === 'string' ? { effort: rest.defaultEffort } : {}),
      ...(typeof rest.agentProfile === 'string' ? { agentProfile: rest.agentProfile } : {}),
    }
    const answer = await workflow.answerWithoutMachine('start', issueId, opts)
    if (answer !== undefined) return answer
  } else if (name === 'addSession' || name === 'addShell' || name === 'cleanup') {
    const answer = await workflow.answerWithoutMachine(name, issueId)
    if (answer !== undefined) return answer
  }
  const machineId = (await modules.issues.reports.getMeta(issueId))?.machineId ?? null
  if (machineId !== null) {
    const machine = await modules.machines.machineName(machineId)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: machineRejectionMessage(machine, 'offline', VERB[name]),
    })
  }
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `no machine is online to ${VERB[name]}`,
  })
}

/** What each command needs a machine for, in the refusal's words. */
const VERB: Readonly<Record<IssueWorkCommand, string>> = {
  start: "start this issue's work",
  addSession: 'add a session to this issue',
  addShell: 'add a shell to this issue',
  cleanup: "clean up this issue's worktree",
  ship: 'ship this issue',
  stop: "stop this issue's sessions",
  refreshAssistant: "refresh this issue's assistant",
  answerQuestion: "answer this issue's question",
}

/** The issue a command names, resolved as its handler resolves it (`shipIssue`):
 *  a display ref within the caller's repo, or a bound agent's own issue for a
 *  ship that names none. */
async function issueOf(
  modules: RegistryModules,
  caller: IssueCaller,
  name: IssueWorkCommand,
  ref: string | undefined,
): Promise<IssueId> {
  const scope = caller.capability.scope
  if (ref !== undefined) {
    const repoPath =
      scope.kind === 'subtree'
        ? ((await modules.issues.reports.getMeta(scope.rootId))?.repoPath ?? undefined)
        : undefined
    return await modules.issues.reports.resolveRef(ref, repoPath)
  }
  if (name === 'ship' && scope.kind === 'subtree') return scope.rootId
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'no issue bound to this caller; pass an issue id',
  })
}

/** The record's input for one old command's input. */
function recordInputOf(name: IssueWorkCommand, rest: Record<string, unknown>): object {
  switch (name) {
    case 'start':
      return { ...rest, sessionId: rest.sessionId ?? randomUUID() }
    case 'addSession':
      return { ...rest, sessionId: rest.sessionId ?? randomUUID() }
    case 'addShell':
      return { shell: true, sessionId: rest.sessionId ?? randomUUID() }
    case 'stop':
      return rest.force === true ? { force: true } : {}
    case 'answerQuestion':
      return { via: 'issue', text: rest.answer }
    default:
      return {}
  }
}

export function issueWorkEffectPort(
  deps: Pick<IssueWorkEffectDeps, 'modules'>,
): IssueWorkEffectPort {
  return {
    run: async (caller, name, input) => {
      const modules = deps.modules()
      const effects = modules.effects
      const principal = caller.principal
      if (effects === undefined || principal === undefined) {
        throw new Error(`issues.${name}: the effect path is not wired`)
      }
      const {
        id: ref,
        mutationId,
        ...rest
      } = (input ?? {}) as { id?: string; mutationId?: MutationId } & Record<string, unknown>
      const issueId = await issueOf(modules, caller, name, ref)
      const kind = ISSUE_WORK_EFFECT_KIND[name]
      // Nothing can run it now: no record, its machine-free answer (answerUnready).
      if (NEEDS_DAEMON.has(kind) && !(await machineReady(modules, issueId))) {
        return await answerUnready(modules, caller, name, issueId, rest)
      }
      // A retry of the same command (its mutationId) writes the same record,
      // when that id can be one (a device id is its kind's prefix and a UUID).
      const id =
        mutationId !== undefined && UUID.test(mutationId)
          ? `eff_${mutationId}`
          : mintDeviceId('eff_')
      const { reply, cause } = await modules.syncWrite.submitDetailed(
        {
          mutationId: asMutationId(mutationId ?? `mut_${name}_${randomUUID()}`),
          command: 'effects.create',
          version: 1,
          input: {
            id,
            kind,
            target: { kind: 'issue', id: issueId },
            input: recordInputOf(name, rest),
          },
          ...(caller.overrideScope === true ? { confirmed: true as const } : {}),
        },
        principal,
        // An agent reaches the issue commands over the daemon relay; a person over
        // tRPC (the apps, the CLI over HTTP, in-process MCP).
        principal.kind === 'agent' ? 'relay' : 'trpc',
      )
      if (reply.outcome !== 'applied') {
        if (cause !== undefined) throw cause
        // A missing or unreachable issue answers as the old route did (a 404 or a
        // 403), refused at the target check before any record exists.
        if (reply.refusal.kind === 'target-not-found' || reply.refusal.kind === 'unauthorized') {
          throw refusalAsTrpcError(`issues.${name}`, reply.refusal)
        }
        throw new IssueRefusal(`issues.${name} was refused (${reply.refusal.kind})`)
      }
      return answerOf(name, id, await effects.awaitSettled(id, WAIT_MS[name]))
    },
  }
}

/** The old command's answer for a settled (or still running) record. */
function answerOf(name: IssueWorkCommand, id: string, row: EffectRow | undefined): unknown {
  if (row === undefined) throw new Error(`issues.${name}: effect ${id} is gone`)
  switch (row.status) {
    case 'succeeded':
      return row.result ?? undefined
    case 'failed': {
      const code = row.error?.code ?? 'failed'
      const message = row.error?.message ?? `issues.${name} failed`
      if (code === REFUSED) throw new IssueRefusal(message)
      if (code === NOT_FOUND) throw new TRPCError({ code: 'NOT_FOUND', message })
      if (isTrpcCode(code)) throw new TRPCError({ code, message })
      throw new Error(message)
    }
    case 'pending':
    case 'running':
      throw new Error(
        `issues.${name} is still running as effect ${id}${row.stage ? ` (${row.stage})` : ''}; its status shows on the issue`,
      )
    default:
      throw new Error(`issues.${name} ${row.status}: ${row.error?.message ?? ''}`.trim())
  }
}

const TRPC_CODES = new Set<string>([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
  'TIMEOUT',
  'PAYLOAD_TOO_LARGE',
  'METHOD_NOT_SUPPORTED',
  'UNPROCESSABLE_CONTENT',
  'CLIENT_CLOSED_REQUEST',
  'NOT_IMPLEMENTED',
])

const isTrpcCode = (code: string): code is TRPCError['code'] => TRPC_CODES.has(code)
