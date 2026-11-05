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
 * ONE EXECUTOR, THE FAMILY'S OWN HANDLER. Each kind runs the issue command's own
 * handler (`registry.ts`), with the record's input and the issue as its id, so
 * every check, every provenance and every answer is the one the command always
 * had. It runs AS THE WRITER AS THEY ARE NOW: a person's account and current
 * role, or an agent's current capability (its session's scope, delegated by its
 * human, whose account must still be active). A writer who has lost the right
 * since is refused at run time, like the other effect kinds.
 *
 * THE OLD COMMANDS ARE ADAPTERS. `IssueCommandDispatcher.run` sends these
 * commands here (every transport reaches it: the tRPC routes, the relay, MCP):
 * it creates the record through `sync.submit` as its caller, waits for it to
 * settle, and answers the command's old shape, or throws its old error.
 *
 *  - TARGET: the issue command's own scope check on the record's issue.
 *  - RUN: once per record (the runner claims it). A handler error is a
 *    definitive failure carrying the error's code and message.
 *  - RECOVER: the server stopped mid-run, and the machine may have acted, so
 *    the record says it lost track (`unknown`); the person checks and retries.
 *  - PUBLISH: the input, which holds no secret (an agent kind, a model).
 */

import { randomUUID } from 'node:crypto'
import {
  asMutationId,
  asUserId,
  type EffectTarget,
  type MutationId,
  mintDeviceId,
  type SessionId,
  spawnedByParentSessionId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import type { z } from 'zod'
import {
  type CommandPrincipal,
  resolvePrincipalAsync,
  userCommandPrincipal,
} from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { UsersRepository } from '../../store/users'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import type { IssueCaller } from './command-ctx'
import { type AnyIssueCommandDef, issueRegistry } from './registry'
import { isIssueNotFound } from './service/not-found'
import { IssueRefusal, isIssueRefusal } from './service/refusal'
import { issueTarget } from './sync-write'

/** The commands that run as effect records, by procedure name, with their kind. */
export const ISSUE_WORK_EFFECT_KIND = {
  start: 'issue.begin',
  stop: 'issue.stop',
  addSession: 'issue.addSession',
  addShell: 'issue.addShell',
  cleanup: 'issue.cleanup',
  ship: 'issue.ship',
  refreshAssistant: 'issue.assistant',
} as const

export type IssueWorkCommand = keyof typeof ISSUE_WORK_EFFECT_KIND

export const isIssueWorkCommand = (name: string): name is IssueWorkCommand =>
  Object.hasOwn(ISSUE_WORK_EFFECT_KIND, name)

/** How long a record may wait to start: the runner takes it at once, so a record
 *  still pending this long found no server to run it. */
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
}

function defOf(name: IssueWorkCommand): AnyIssueCommandDef {
  const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[name]
  if (def === undefined) throw new Error(`issue work effects: no issue command named ${name}`)
  return def
}

/** The record's input: the command's own, without the issue (the target) and the
 *  route's dedup key (the record's id is its identity). */
function inputOf(name: IssueWorkCommand): z.ZodType<Record<string, unknown>> {
  return (defOf(name).input as unknown as z.AnyZodObject).omit({
    id: true,
    mutationId: true,
  }) as unknown as z.ZodType<Record<string, unknown>>
}

/** A handler's error, as the code the old command answers it with again. */
const REFUSED = 'refused'
const NOT_FOUND = 'not-found'

function failedOf(error: unknown): EffectOutcome {
  const message = error instanceof Error ? error.message : String(error)
  if (isIssueRefusal(error)) return { status: 'failed', error: { code: REFUSED, message } }
  if (isIssueNotFound(error)) return { status: 'failed', error: { code: NOT_FOUND, message } }
  if (error instanceof TRPCError) return { status: 'failed', error: { code: error.code, message } }
  return { status: 'failed', error: { code: 'failed', message } }
}

const LOST_TRACK: EffectOutcome = {
  status: 'unknown',
  error: {
    code: 'lost-track',
    message: 'The server stopped while this ran; check the issue before running it again.',
  },
}

const NO_LONGER_ALLOWED = 'The writer may no longer do this.'

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

export function registerIssueWorkEffects(deps: IssueWorkEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('issue work effects: no effects module')

  /** The writing agent, when an agent wrote it (`session:<id>`). */
  const agentOf = (record: EffectRow): SessionId | undefined =>
    record.actor?.startsWith('session:')
      ? (record.actor.slice('session:'.length) as SessionId)
      : undefined

  /** The writer as they are NOW, as the issue family's caller. */
  const writerOf = async (record: EffectRow): Promise<IssueCaller | undefined> => {
    if (record.createdBy === null) return undefined
    const user = await deps.users.get(record.createdBy)
    if (!user || user.disabledAt) return undefined
    const agent = agentOf(record)
    if (agent === undefined) {
      const principal = userCommandPrincipal(asUserId(user.id), user.role)
      return { capability: principal.capability, principal }
    }
    const sessions = deps.modules().sessions
    if (!(await sessions.sessionRowExists(agent))) return undefined
    const capability = await sessions.capabilityForSession(agent)
    const principal = await resolvePrincipalAsync(capability, {
      parentSessionOf: async (sessionId) =>
        spawnedByParentSessionId((await sessions.sessionById(sessionId))?.spawnedBy),
    })
    if (principal.kind === 'system') return undefined
    return { capability, principal }
  }

  const executorOf = (name: IssueWorkCommand): EffectExecutor<Record<string, unknown>> => {
    const def = defOf(name)
    return {
      kind: ISSUE_WORK_EFFECT_KIND[name],
      input: inputOf(name),
      deadlineMs: ISSUE_WORK_DEADLINE_MS,
      target: async (target: EffectTarget, principal: CommandPrincipal) => {
        const caller = callerOf(principal)
        if (caller === undefined || target.kind !== 'issue') return undefined
        return await issueTarget(deps.modules(), def, { id: target.id }, caller)
      },
      run: async (ctx) => {
        const caller = await writerOf(ctx.record)
        if (caller === undefined) {
          return { status: 'failed', error: { code: REFUSED, message: NO_LONGER_ALLOWED } }
        }
        try {
          const parsed: unknown = def.input.parse({ ...ctx.input, id: ctx.record.target.id })
          const result = await deps
            .modules()
            .issueCommands.withoutEffects()
            .run(caller, name, def, parsed)
          return { status: 'succeeded', result: result ?? null }
        } catch (error) {
          return failedOf(error)
        }
      },
      recover: async () => LOST_TRACK,
    }
  }

  for (const name of Object.keys(ISSUE_WORK_EFFECT_KIND) as IssueWorkCommand[]) {
    effects.executors.register(executorOf(name))
  }
}

// ---------------------------------------------------------------------------
// The old commands as adapters
// ---------------------------------------------------------------------------

export interface IssueWorkEffectPort {
  /** Run one command as an effect record, as this caller; answer as it always did. */
  run(caller: IssueCaller, name: IssueWorkCommand, input: unknown): Promise<unknown>
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
      if (typeof ref !== 'string') throw new Error(`issues.${name}: no issue named`)
      const issueId = await modules.issues.reports.resolveRef(ref)
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
            kind: ISSUE_WORK_EFFECT_KIND[name],
            target: { kind: 'issue', id: issueId },
            input: rest,
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
