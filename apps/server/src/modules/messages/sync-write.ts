/**
 * AGENT MAIL ON THE SYNC WRITE ENTRY POINT (POD-6525; design D on POD-6415,
 * approved by POD-6241).
 *
 * The mail writes register through the sync family builder: `mail.send`,
 * `mail.reply`, `mail.ask`, `mail.inboxConsume`, `mail.dismiss`, `mail.cancel`,
 * `mail.dismissNotice` and `mail.pendingReminders`. Every transport reaches
 * them through `submit`: the gate's dispatch is the adapter for the relay, the
 * CLI and MCP, and for the tRPC routes, each with its transport tag.
 *
 * THE HANDLER'S CONTEXT IS BUILT FROM THE PRINCIPAL. `MessageGate.handlerContext`
 * gives it the caller, the shared `MailAccess` under the principal's human
 * ceiling, and the gate's ports, exactly as a direct dispatch does.
 *
 * THE TARGET is the contract's role floor, read live, with no record
 * (`NO_TARGET`). The handlers keep resolving addresses under the human
 * ceiling, so an address that does not exist and one beyond the ceiling still
 * end the same way: a dead letter on the send path (POD-379), an empty list on
 * an inbox peek.
 *
 * NOTHING OUTSIDE THE DATABASE RUNS IN THE WRITE. A send stores its row in the
 * unit and hands it on after the commit (POD-6349); an address that can never
 * be delivered to is answered with its dead letter in the write. A retract
 * stamps the row in the unit and asks the machine after the commit. An ask
 * stores its question; the bounded wait for the answer is the adapter's.
 *
 * WHICH mutationId: a send's own `messageId` (the CLI's, repeated on a retry);
 * a spawn's `requestId`; otherwise a fresh one, deduplicated against nothing,
 * which is what a call without an id always meant.
 */

import { randomUUID } from 'node:crypto'
import { type AnyCommandContract, type CommandDef, spawnAgentContract } from '@podium/commands'
import { asMutationId, isSpawnedBy, type MutationId, SessionIdField } from '@podium/model'
import type { SyncSubmitRefusal } from '@podium/protocol'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import { checkIssueAccess } from '../../issue-authz'
import type { RegistryModules } from '../../relay'
import { withReadScope } from '../../store/executor/read-scope'
import type { FrontDoorTransport } from '../front-door'
import { commandAccess } from '../issues/command-ctx'
import { type DetailedSubmit, type SyncWriteEntry, SyncWriteRefused } from '../sync-write/entry'
import {
  humanWithRoleFloor,
  type SyncFamily,
  type SyncFamilyTargetContext,
  trpcErrorRefusal,
} from '../sync-write/family'
import {
  NO_TARGET,
  refuseTarget,
  type SyncWriteRegistry,
  type SyncWriteTarget,
} from '../sync-write/registry'
import { refusalAsTrpcError } from '../sync-write/route-adapter'
import type { MessageGateDeps, SpawnRecordPort } from './gate'
import { type AskSent, askAnswer, askSend } from './handlers/ask'
import type { MailHandlerContext } from './handlers/context'
import { inboxConsumeHandler } from './handlers/inbox-consume'
import { pendingRemindersHandler } from './handlers/pending-reminders'
import { cancelHandler, dismissHandler, dismissNoticeHandler } from './handlers/projections'
import { replyHandler } from './handlers/reply'
import { sendHandler } from './handlers/send'
import { SpawnBudgetExhausted, spawnAgentHandler } from './handlers/spawn-agent'
import { MailRefusal } from './refusal'
import { MAIL_COMMANDS } from './registry'
import type { MessageDeliveryService } from './service'

/** The mail procs written through the entry point, by their wire names. */
export const MAIL_WRITE_PROCS = [
  'send',
  'reply',
  'ask',
  'inbox',
  'dismiss',
  'cancel',
  'dismissNotice',
  'pendingReminders',
  'spawnAgent',
] as const
export type MailWriteProc = (typeof MAIL_WRITE_PROCS)[number]

const WRITES: ReadonlySet<string> = new Set(MAIL_WRITE_PROCS)
export const isMailWriteProc = (proc: string): proc is MailWriteProc => WRITES.has(proc)

/** The command names of the mail writes on the entry point, for the family list
 *  (held equal to {@link MAIL_WRITE_PROCS}' contracts by the family's test). */
export const MAIL_SYNC_COMMANDS = [
  'mail.send',
  'mail.reply',
  'mail.ask',
  'mail.inboxConsume',
  'mail.dismiss',
  'mail.cancel',
  'mail.dismissNotice',
  'mail.pendingReminders',
  'mail.spawnAgent',
] as const

/** What a mail write's service is: its handler context, built per call. */
export interface MailWriteService {
  context(): Promise<MailHandlerContext>
}

type EntryHandler = (ctx: MailHandlerContext, input: never) => Promise<unknown>

/** The handler each write runs in its unit of work. `ask` stores its question only. */
const ENTRY_HANDLERS: Record<MailWriteProc, EntryHandler> = {
  send: sendHandler,
  reply: replyHandler,
  ask: askSend,
  inbox: inboxConsumeHandler,
  dismiss: dismissHandler,
  cancel: cancelHandler,
  dismissNotice: dismissNoticeHandler,
  pendingReminders: pendingRemindersHandler,
  spawnAgent: spawnAgentHandler,
}

function entryCommand(proc: MailWriteProc) {
  const handler = ENTRY_HANDLERS[proc] as (
    ctx: MailHandlerContext,
    input: unknown,
  ) => Promise<unknown>
  return {
    contract: MAIL_COMMANDS[proc].contract,
    handler: async (svc: MailWriteService, input: unknown) =>
      await handler(await svc.context(), input),
  }
}

const MAIL_WRITE_COMMANDS = Object.fromEntries(
  MAIL_WRITE_PROCS.map((proc) => [proc, entryCommand(proc)]),
) as Record<MailWriteProc, ReturnType<typeof entryCommand>>

/** A mail handler's error as the entry point's refusal; `undefined` propagates it. */
export function mailRefusalOf(error: unknown): SyncSubmitRefusal | undefined {
  if (error instanceof MailRefusal) return { kind: error.kind, message: error.message }
  return trpcErrorRefusal(error)
}

export const MAIL_SYNC_FAMILY: SyncFamily<MailWriteService, typeof MAIL_WRITE_COMMANDS> = {
  family: 'messages',
  service: (state) => ({
    context: async () =>
      await state.modules.messageGate.handlerContext(
        state.principal,
        state.confirmed,
        true,
        state.writer,
      ),
  }),
  commands: MAIL_WRITE_COMMANDS,
  target: async (contract, input, ctx) =>
    contract.name === spawnAgentContract.name
      ? await spawnTarget(contract, input, ctx)
      : await humanWithRoleFloor(contract, ctx),
  refusalOf: mailRefusalOf,
  // A spawn the budget refused leaves its trail outside the write it refused.
  rolledBack: async (_contract, _input, error, ctx) => {
    const cause = error instanceof SyncWriteRefused ? error.cause : error
    if (!(cause instanceof SpawnBudgetExhausted)) return
    const gate = ctx.modules.messageGate
    await gate.recordSpawnRefusal(cause)
  },
}

/**
 * A SPAWN'S TARGET (POD-6525): the issue `--issue` names, as the write target,
 * after the old gate (`checkIssueAccess`) decided it in its own words. The
 * name resolves under the human ceiling first, so an issue that does not
 * exist and one beyond the ceiling both reach the handler, which answers
 * them alike as an unknown issue (ADR 3 Amendment 1 D20.2). A `--new` names
 * no record: the role floor decides.
 */
async function spawnTarget(
  contract: AnyCommandContract,
  input: unknown,
  ctx: SyncFamilyTargetContext,
): Promise<SyncWriteTarget> {
  const floor = await humanWithRoleFloor(contract, ctx)
  if (floor === undefined) return undefined
  const request = (input ?? {}) as { issue?: string; newTitle?: string }
  if (!request.issue || request.newTitle) return NO_TARGET
  const { principal } = ctx
  if (principal.kind === 'system') return undefined
  const mail = await ctx.modules.messageGate.handlerContext(principal, ctx.confirmed)
  const resolved = await mail.access.resolveIssueAddress(request.issue)
  if (resolved.kind !== 'issue') return NO_TARGET
  const access = commandAccess(ctx.modules.issues)
  try {
    await checkIssueAccess(mail.caller, access, 'agent.spawn', 'write', resolved.id)
  } catch (error) {
    const refusal = mailRefusalOf(error)
    if (refusal === undefined) throw error
    return refuseTarget(refusal)
  }
  const scope = principal.capability.scope
  if (scope.kind === 'all') return NO_TARGET
  if (scope.kind === 'owned') return { id: resolved.id }
  return { id: resolved.id, ancestorIds: await access.ancestorIds(resolved.id) }
}

/** The id a mail write's envelope carries (see the header). */
export function mailMutationId(proc: string, input: unknown): MutationId {
  const raw = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const own = proc === 'send' ? raw.messageId : proc === 'spawnAgent' ? raw.requestId : undefined
  return typeof own === 'string' && own.length > 0
    ? asMutationId(own)
    : asMutationId(`mut_mail_${randomUUID()}`)
}

/** One adapter call of a mail write. */
export interface MailWriteCall {
  readonly principal: CommandPrincipal
  readonly transport: FrontDoorTransport
  readonly proc: MailWriteProc
  readonly input: unknown
  /** The caller's out-of-scope confirmation (`--outside-scope`). */
  readonly confirmed: boolean
}

/** Submit one mail write through the entry point, as its caller. */
export async function submitMailWrite(
  entry: Pick<SyncWriteEntry, 'submitDetailed'>,
  call: MailWriteCall,
): Promise<DetailedSubmit> {
  const contract: AnyCommandContract = MAIL_COMMANDS[call.proc].contract
  return await entry.submitDetailed(
    {
      mutationId: mailMutationId(call.proc, call.input),
      command: contract.name,
      version: contract.version,
      input: call.input,
      ...(call.confirmed ? { confirmed: true as const } : {}),
    },
    call.principal,
    call.transport,
  )
}

/**
 * LEGACY(remove-after: 2027-03): the answer a mail write's old door gave, from
 * the write's recorded result. The relay, an older CLI and the shipped mobile
 * app read these shapes; removing this breaks their mail.
 *
 *  - a send or a reply: the hand-on's outcome after the commit, as the inline
 *    send answered it (delivered, queued with its position, held, a late dead
 *    letter); a replay, or a dead letter answered in the write, as recorded;
 *  - an ask: the bounded wait for the answer, and the target's status;
 *  - a retract: the row once the machine answered;
 *  - anything else: the recorded result.
 */
export async function answerAsBefore(
  deps: Pick<MessageGateDeps, 'messages' | 'spawnRecord'>,
  contextOf: () => Promise<MailHandlerContext>,
  proc: MailWriteProc,
  input: unknown,
  result: unknown,
): Promise<unknown> {
  switch (proc) {
    case 'send':
    case 'reply':
      return await withHandOn(deps.messages, result)
    case 'ask':
      return await askAnswer(await contextOf(), input as never, result as AskSent)
    case 'cancel': {
      const id = (result as { id?: unknown } | null)?.id
      if (typeof id !== 'string') return result
      const row = await deps.messages.retractOf(id)
      if (row === undefined) return result
      const ctx = await contextOf()
      return await withReadScope(async () => await ctx.access.wire(row))
    }
    case 'spawnAgent':
      return await withSpawn(deps.spawnRecord, result)
    default:
      return result
  }
}

/**
 * A spawn's answer once its record settled: the child as the start answered
 * it (its agent, model, effort, machine, its task's message), or the start's
 * refusal thrown. A replay waits on the same record: one child per request id.
 */
async function withSpawn(record: SpawnRecordPort | undefined, result: unknown): Promise<unknown> {
  const recorded = result as Record<string, unknown> | null
  const effectId = recorded?.effectId
  if (record === undefined || recorded === null || typeof effectId !== 'string') return result
  const spawned = await record.settled(effectId)
  const { effectId: _effectId, ...rest } = recorded
  return {
    ...rest,
    agentId: spawned.agentId ?? rest.sessionId,
    harness: spawned.harness ?? rest.harness,
    model: spawned.model === undefined ? rest.model : (spawned.model ?? null),
    effort: spawned.effort === undefined ? rest.effort : (spawned.effort ?? null),
    machine: spawned.machine ?? spawned.machineId ?? rest.machine,
    ...(spawned.promptMessageId ? { promptMessageId: spawned.promptMessageId } : {}),
  }
}

/** The fields a send answers with that the hand-on decides. */
const HAND_ON_FIELDS = ['ok', 'queued', 'reason', 'position', 'disposition'] as const

async function withHandOn(messages: MessageDeliveryService, result: unknown): Promise<unknown> {
  const recorded = result as Record<string, unknown> | null
  const id = recorded?.id
  if (recorded === null || typeof id !== 'string') return result
  const outcome = await messages.handOnOf(id)
  if (outcome === undefined) return result
  const rest = Object.fromEntries(
    Object.entries(recorded).filter(
      ([key]) => !(HAND_ON_FIELDS as readonly string[]).includes(key),
    ),
  )
  return {
    ...rest,
    ok: outcome.ok,
    ...(outcome.queued !== undefined ? { queued: outcome.queued } : {}),
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.position !== undefined ? { position: outcome.position } : {}),
    disposition: outcome.disposition,
  }
}

/** A refused mail write, as the error its old door threw. */
export function mailWriteError(proc: MailWriteProc, submitted: DetailedSubmit): unknown {
  const { reply, cause } = submitted
  if (reply.outcome === 'applied') throw new Error('mailWriteError: the write was applied')
  if (cause !== undefined) return cause
  return refusalAsTrpcError(MAIL_COMMANDS[proc].contract.name, reply.refusal)
}

// ---------------------------------------------------------------------------
// The await's one write
// ---------------------------------------------------------------------------

/**
 * A PARENT OBSERVED ITS CHILD SETTLE (POD-6525). `mail.awaitAgent` is a
 * bounded wait, and stays on its route: a wait replayed later answers about a
 * window that has closed. Its one durable effect is this: when the parent's
 * await saw its child settle (done, gone, blocked, or an ack), the
 * session-parent wake claim retires, so a later genuine re-completion can wake
 * the parent once more (POD-917/POD-923). That retirement is its own small
 * write on the entry point, submitted by the await's adapter with the await's
 * transport.
 *
 * A `defineCommands` entry, server-local: no client sends it, and it has no
 * contract of its own beyond the await's. Its target is the child, and only the
 * session that spawned it may say it observed it.
 */
export const MAIL_AWAIT_OBSERVED = 'mail.awaitObserved'

const awaitObservedDef = {
  input: z.object({ sessionId: SessionIdField }).strict(),
  action: 'write',
  exposure: ['trpc', 'cli', 'mcp', 'relay'],
  conflict: 'n/a',
  visibility: 'personal',
  decision:
    'POD-6525: the await stays a wait on its route; only the claim it retires is a write, ' +
    'so a replay of the wait never re-runs it and a replay of the write retires nothing twice.',
} as const satisfies CommandDef

/** The wake claim a parent's await retires for `child`. */
export const parentNudgeFactKey = (child: string): string =>
  `sessionparentnudge:phase-reported:${child}`

export function registerMailAwaitObserved(
  registry: SyncWriteRegistry,
  deps: { modules(): RegistryModules },
): void {
  registry.register({
    name: MAIL_AWAIT_OBSERVED,
    def: awaitObservedDef,
    target: async (input, { principal }) => {
      if (principal.kind !== 'agent') return undefined
      const child = await deps.modules().sessions.sessionById(input.sessionId)
      return isSpawnedBy(child?.spawnedBy, { kind: 'session', id: principal.agentSessionId })
        ? NO_TARGET
        : undefined
    },
    handle: async (ctx, input) => {
      const { principal } = ctx
      if (principal.kind !== 'agent')
        throw new Error('mail.awaitObserved reached its handler without an agent')
      await deps
        .modules()
        .messageGate.retireParentNudge(
          parentNudgeFactKey(input.sessionId),
          principal.agentSessionId,
        )
      return { retired: true }
    },
  })
}

/** The await's retirement, as the awaiting parent, on the await's transport. A
 *  refusal (the caller is not the child's parent) retires nothing, as before. */
export async function submitAwaitObserved(
  entry: Pick<SyncWriteEntry, 'submitDetailed'>,
  principal: CommandPrincipal,
  transport: FrontDoorTransport,
  child: string,
): Promise<void> {
  try {
    await entry.submitDetailed(
      {
        mutationId: asMutationId(`mut_mail_${randomUUID()}`),
        command: MAIL_AWAIT_OBSERVED,
        version: 1,
        input: { sessionId: child },
      },
      principal,
      transport,
    )
  } catch {
    // Never break an await: the claim stays, and the parent is woken once more.
  }
}
