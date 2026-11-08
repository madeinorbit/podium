/**
 * THE ISSUE COMMANDS THE APPS QUEUE, ON THE SYNC WRITE ENTRY POINT
 * (POD-6350, ADR 12 D2).
 *
 * Each is registered from the issue command table (`registry.ts`): its contract,
 * a target resolver, and the table's own handler, run through the dispatcher so
 * revision arbitration (`exp-rev`) applies exactly as on every other transport.
 *
 * THE TARGET is the derived routes' guard (`guardIssueCommand` →
 * `checkIssueAccess`), answered as a target instead of thrown, so the entry point
 * makes the one `authorize` call with the envelope's confirmation:
 *
 *  - a command with no target issue (the read marks, tuck): no target, the
 *    role decides;
 *  - a target that does not exist: a `target-not-found` refusal;
 *  - a member (`owned` scope): the shared task, with no owner/grant gate;
 *  - a `subtree` scope: the issue and its ancestors, where an out-of-scope write
 *    needs the confirmation.
 *
 * THE HANDLER runs without its own dedup (`withoutDedup`): the entry point has
 * already deduplicated by the envelope's mutationId. A definitive error from it
 * (a 4xx `TRPCError`, `IssueNotFound`, `IssueRefusal`) is a refusal carrying the
 * error as its cause, which the old routes rethrow unchanged. Anything else
 * propagates, and the outbox retries it.
 */

import {
  ISSUE_CONTRACTS,
  type IssueContractName,
  QUEUED_ISSUE_COMMANDS,
  SYNCED_ISSUE_COMMANDS,
  writesThroughEntry,
} from '@podium/commands'
import { asSessionId, isPersonCapability } from '@podium/model'
import type { SyncSubmitRefusal } from '@podium/protocol'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import { type DetailedSubmit, type SyncWriteEntry, SyncWriteRefused } from '../sync-write/entry'
import { trpcErrorRefusal } from '../sync-write/family'
import {
  NO_TARGET,
  refuseTarget,
  type SyncWriteRegistry,
  type SyncWriteTarget,
} from '../sync-write/registry'
import { mutationIdOf } from '../sync-write/route-adapter'
import { commandAccess, type IssueCaller, type MailHandOn } from './command-ctx'
import type { IssueCommandDispatcher } from './dispatcher'
import { type AnyIssueCommandDef, issueRegistry } from './registry'
import type { IssueTrackerCapabilities } from './service'
import { isIssueNotFound } from './service/not-found'
import { isIssueForbidden, isIssueRefusal } from './service/refusal'

/** The issue commands the apps queue (client `OUTBOX_COMMANDS`), by proc name. */
export { QUEUED_ISSUE_COMMANDS }

export interface IssueSyncWriteDeps {
  modules(): RegistryModules
}

/** `checkIssueAccess`'s decision, as the target it would authorize. Shared with the
 *  generic issue record (`modules/records/issue-record.ts`). */
export async function issueTarget(
  modules: RegistryModules,
  def: AnyIssueCommandDef,
  input: unknown,
  caller: IssueCaller,
): Promise<SyncWriteTarget> {
  const scope = caller.capability.scope
  if (def.target === undefined) return NO_TARGET
  const access = commandAccess(modules.issues)
  const raw = def.target((input ?? {}) as Record<string, unknown>)
  // Display refs (#seq) resolve to the internal id before the scope check, scoped
  // to the bound issue's repo (#140), exactly as the guard does.
  const scopeRepoPath =
    scope.kind === 'subtree'
      ? ((await access.getMeta(scope.rootId))?.repoPath ?? undefined)
      : undefined
  const targetId = typeof raw === 'string' ? await access.resolveRef(raw, scopeRepoPath) : raw
  // A named issue that does not exist is refused HERE, before the handler, so
  // no handler words ("unknown issue <id>") reach the caller: an existence
  // oracle otherwise (ADR 3 Amendment 1 D20.2). Tasks are shared with every
  // member, so a missing task is the same refusal for every caller. No id is
  // the handler's own default (a ship from the agent's subtree root).
  if (!targetId) return raw === undefined || raw === '' ? NO_TARGET : missingTarget()
  if (!(await access.has(targetId))) return missingTarget()
  return scope.kind === 'subtree'
    ? { id: targetId, ancestorIds: await access.ancestorIds(targetId) }
    : { id: targetId }
}

const missingTarget = (): SyncWriteTarget => refuseTarget({ kind: 'target-not-found' })

/**
 * A definitive error from an issue handler, as a refusal; undefined to propagate.
 * It carries the handler's message (POD-6412): the handler ran after both
 * permission checks, and its words are what the old routes showed this caller.
 */
export function issueRefusalOf(error: unknown): SyncSubmitRefusal | undefined {
  if (isIssueNotFound(error)) return { kind: 'target-not-found', message: error.message }
  if (isIssueRefusal(error)) return { kind: 'conflict', message: error.message }
  if (isIssueForbidden(error)) return { kind: 'unauthorized', message: error.message }
  return trpcErrorRefusal(error)
}

/** Why the entry point refuses one call of a listed command (see `@podium/commands`
 *  `issues/synced.ts`), or undefined when it takes it. */
function unwritable(key: string, input: unknown): string | undefined {
  if (key === 'create' && (input as { startNow?: unknown } | undefined)?.startNow === true) {
    return 'Start a new task with its agent through an issue.start effect record.'
  }
  if (!writesThroughEntry(key, input)) {
    return 'Add, upload or remove an artifact through its issue.artifact* effect record.'
  }
  return undefined
}

export function registerIssueCommands(registry: SyncWriteRegistry, deps: IssueSyncWriteDeps): void {
  const defs = issueRegistry.defs as Record<string, AnyIssueCommandDef>
  for (const key of SYNCED_ISSUE_COMMANDS) {
    const def = defs[key]
    const contract = ISSUE_CONTRACTS[key as IssueContractName]
    if (!def || !contract) throw new Error(`sync write: no issue command named ${key}`)
    registry.register({
      contract,
      target: async (input, { principal }) =>
        principal.kind === 'system'
          ? undefined
          : await issueTarget(deps.modules(), def, input, {
              capability: principal.capability,
              principal,
            }),
      handle: async (ctx, input) => {
        const principal = ctx.principal
        // The entry point never lets a system principal through; the narrowing
        // is for the capability the dispatcher reads.
        if (principal.kind === 'system')
          throw new Error('issue write reached its handler as system')
        const caller: IssueCaller = {
          capability: principal.capability,
          principal,
          // The command's own writer (ADR 12 D9): every issue write it makes.
          writer: ctx.ledger,
          ...(ctx.confirmed ? { overrideScope: true } : {}),
        }
        const refused = unwritable(key, input)
        if (refused !== undefined) throw new SyncWriteRefused({ kind: 'invalid', message: refused })
        try {
          return await deps.modules().issueCommands.withoutDedup().run(caller, key, def, input)
        } catch (error) {
          const refusal = issueRefusalOf(error)
          if (refusal === undefined) throw error
          throw new SyncWriteRefused(refusal, { cause: error })
        }
      },
    })
  }
}

/** The transports whose adapters send issue writes through the entry point. */
export type IssueWriteTransport = 'trpc' | 'relay' | 'mcp'

export interface IssueWriteCall {
  readonly principal: CommandPrincipal
  readonly transport: IssueWriteTransport
  /** The procedure name (`create`), one of `SYNCED_ISSUE_COMMANDS`. */
  readonly name: string
  /** The caller's input, unparsed: the entry point parses it. */
  readonly input: unknown
  /** The caller's out-of-scope confirmation (`--outside-scope`). */
  readonly confirmed: boolean
}

/**
 * A create without its start. The start does work outside the database (a git
 * worktree, a daemon spawn), so it is never part of the write; an adapter runs
 * it after the create commits ({@link startAfterCreate}), the order the family
 * always used (`createAndMaybeStart` committed the issue before starting it).
 */
function withoutStart(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input
  const {
    startNow: _startNow,
    startSessionId: _startSessionId,
    ...rest
  } = input as Record<string, unknown>
  return { ...rest, startNow: false }
}

/** One adapter call of a listed issue command, through the entry point. */
export async function submitIssueWrite(
  entry: Pick<SyncWriteEntry, 'submitDetailed'>,
  call: IssueWriteCall,
): Promise<DetailedSubmit> {
  return await entry.submitDetailed(
    {
      mutationId: mutationIdOf(call.input),
      command: `issues.${call.name}`,
      version: 1,
      input: call.name === 'create' ? withoutStart(call.input) : call.input,
      ...(call.confirmed ? { confirmed: true as const } : {}),
    },
    call.principal,
    call.transport,
  )
}

/**
 * LEGACY(remove-after: 2027-03): `mailSend`'s answer on its old doors (the route, the relay, MCP), with the hand-on its send started after the commit; the CLI's `podium issue mail send` prints it. Removing it shows every send as queued.
 *
 * The write answers at its commit, before the hand-on; a replay, and a dead
 * letter answered in the write, keep the recorded answer.
 */
export async function answerMailSendAsBefore(
  handOnOf: ((messageId: string) => Promise<MailHandOn | undefined>) | undefined,
  result: unknown,
): Promise<unknown> {
  const recorded = result as Record<string, unknown> | null
  const id = recorded?.id
  if (handOnOf === undefined || recorded === null || typeof id !== 'string') return result
  const outcome = await handOnOf(id)
  if (outcome === undefined) return result
  const { ok: _ok, disposition: _disposition, reason: _reason, ...rest } = recorded
  return {
    ...rest,
    ok: outcome.ok,
    disposition: outcome.disposition,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }
}

/** The create input fields the start reads. */
interface StartRequest {
  readonly startNow?: boolean
  readonly startSessionId?: string
  readonly parentId?: string
}

/** What a create answers with: the issue, plus the notes the handler adds. */
type CreatedIssue = { readonly id: string; readonly worktreePath?: string | null } & Record<
  string,
  unknown
>

/**
 * After an adapter's create committed: start the task when the caller asked to
 * and the family's rules let the create start (`registry.ts` `create`): an
 * agent's top-level task is a proposal and an agent's task under a proposal is
 * inert, and neither starts. Answers what the create would have answered had it
 * started: the started issue with the create's notes, or the create's own
 * answer when nothing starts. A replayed create whose task already started is
 * not started twice.
 */
export async function startAfterCreate(
  issues: Pick<IssueTrackerCapabilities, 'gitWorkflow' | 'hierarchy' | 'reports'>,
  caller: IssueCaller,
  input: unknown,
  created: unknown,
  commands: Pick<IssueCommandDispatcher, 'dispatch'>,
): Promise<unknown> {
  const request = (input ?? {}) as StartRequest
  const issue = created as CreatedIssue
  if (request.startNow !== true || typeof issue?.id !== 'string') return created
  const isOperator = isPersonCapability(caller.capability)
  if (!isOperator) {
    if (!request.parentId) return created
    const parent = await issues.reports.getMeta(request.parentId)
    if (parent && (await issues.hierarchy.inProposedSubtree(parent.id))) return created
  }
  const notes = {
    ...(issue.coordinator !== undefined ? { coordinator: issue.coordinator } : {}),
    ...(issue.warning !== undefined ? { warning: issue.warning } : {}),
  }
  const current = await issues.reports.getMeta(issue.id)
  if (current?.worktreePath)
    return { ...(await issues.gitWorkflow.projectionNow(issue.id)), ...notes }
  // Use the same command/effect path as an explicit start: it checks current
  // machine USE before execution, retains the shared-machine warning and stamps
  // the session with this caller's original human, never the task's assignee.
  const started = await commands.dispatch(caller, 'issues', 'start', {
    id: issue.id,
    ...(request.startSessionId ? { sessionId: asSessionId(request.startSessionId) } : {}),
  })
  if (started === null || typeof started !== 'object') {
    throw new Error('issues.start returned no issue after create')
  }
  return { ...started, ...notes }
}
