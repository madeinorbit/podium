import { isPersonCapability } from '@podium/model'
import {
  type CommandDef,
  type CommandTransport,
  defineCommands,
  type LockCommandName,
} from '@podium/commands'
import { lockNameProblem } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { type CommandPrincipal, resolvePrincipal } from '../../command-principal'
import { authorize } from '../../issue-authz'
import type { IssueCaller } from '../issues/command-ctx'
import type { IssueService } from '../issues/service'
import type { FrontDoorTransport } from '../front-door'
import { runPlainDef } from '../plain-command/entry'
import type { LockCallerIdentity, LockHolderId, LockService } from './service'

/**
 * The lock command registry [spec:SP-85d1]: every lock.* command (advisory
 * named lease locks) defined once — input schema, required action, handler
 * over LockService — with the tRPC router, the daemon relay dispatch and the
 * CLI client shape all derived from it, exactly like the issues registry
 * (#248 [spec:SP-3fe2]). The def keys are pinned to @podium/protocol's
 * LOCK_COMMAND_NAMES via `satisfies`.
 *
 * Authorization is declared like `mailSend`: writes with NO issue-scope target
 * (a lock is a repo-scoped coordination token, not an issue mutation), so
 * agents may always reach them once the role gate passes.
 *
 * THE PLAIN COMMAND PATH (ADR 12 D8, POD-6419). A lease is a condition that
 * expires by itself, which no screen lists: ADR 12 D1 places lock status among
 * the request answers, and nothing a lock write touches is synced. So the five
 * lock writes are plain commands: the front door (exposure on the transport,
 * the member floor, the action's role, then the parse) and a plain handler, on
 * tRPC and on the relay alike. These routes are their real doors, not adapters.
 * The grant and steal notices are mail, sent after the commit as the server's
 * own write (`relay.ts`).
 */

export type LockCommandKind = 'query' | 'mutation'

export interface LockCommandDef<
  K extends LockCommandKind = LockCommandKind,
  In extends z.ZodTypeAny = z.ZodTypeAny,
  Out = unknown,
> extends CommandDef<In, Out> {
  kind: K
  handler: (ctx: LockCommandCtx, input: z.infer<In>) => Out
}

/** Generics-erased wildcard def (heterogeneous collections) — see the issues
 *  registry's AnyIssueCommandDef for why this is structural. */
export type AnyLockCommandDef = {
  kind: LockCommandKind
  input: z.ZodTypeAny
  action: CommandDef['action']
  scope?: CommandDef['scope']
  cli?: CommandDef['cli']
  // biome-ignore lint/suspicious/noExplicitAny: the wildcard def erases per-command generics on purpose
  handler: (ctx: LockCommandCtx, input: any) => any
}

function def<K extends LockCommandKind, In extends z.ZodTypeAny, Out>(
  d: LockCommandDef<K, In, Out>,
): LockCommandDef<K, In, Out> {
  return d
}

export interface LockCommandDeps {
  locks: LockService
  /** Issue seq lookup for holder labels (`issue:#<seq>`). */
  issues: IssueService
  /**
   * Live session workspace root (cwd) for co-location refuse + status display.
   * Unknown / operator → null.
   */
  sessionWorkspace?(sessionId: LockHolderId): Promise<string | null>
}

/** Per-call execution context: caller identity + the LockService. */
export class LockCommandCtx {
  constructor(
    readonly deps: LockCommandDeps,
    readonly caller: IssueCaller,
  ) {}

  get locks(): LockService {
    return this.deps.locks
  }

  /**
   * Holder identity, stamped SERVER-SIDE from the relay capability (the same
   * mechanism as `podium issue attach` — there is no --session flag): the
   * calling session id + its bound issue for a relayed agent; the operator
   * (direct-HTTP, no actor session) holds as `operator`.
   */
  async callerIdentity(): Promise<LockCallerIdentity> {
    const cap = this.caller.capability
    // Only a person (no actor session, POD-6288) maps to
    // the null holder; a constrained caller with no known session gets the
    // UNKNOWN_RELAY_SESSION sentinel so it can never impersonate the operator.
    const sessionId: LockHolderId | null =
      cap.actorSessionId ?? (isPersonCapability(cap) ? null : UNKNOWN_RELAY_SESSION)
    const issueId = cap.scope.kind === 'subtree' ? cap.scope.rootId : null
    let label = 'operator'
    if (issueId) {
      const me = await this.deps.issues.reports.getMeta(issueId)
      label = me ? `issue:#${me.seq}` : `session:${sessionId ?? '?'}`
    } else if (sessionId) {
      label = `session:${sessionId}`
    }
    const workspace =
      sessionId != null && sessionId !== UNKNOWN_RELAY_SESSION
        ? ((await this.deps.sessionWorkspace?.(sessionId)) ?? null)
        : null
    return { sessionId, issueId, label, workspace }
  }
}

/**
 * Sentinel session id for a RELAYED caller whose session is unknown to the
 * live map (capabilityForSession minted no actorSessionId). Distinct from the
 * operator's null holder so an anomalous relay caller can never release/renew
 * an operator-held lock (null == null would have conflated them). Behaves as a
 * dead session everywhere else (pruned from queues; its own leases expire by
 * TTL).
 */
export const UNKNOWN_RELAY_SESSION = 'unknown-session'

// Lock names are interpolated into agent mail and the durable event log, so
// they are tightly constrained: printable, short, no control chars/newlines.
// Beyond the charset, the `merge` namespace is RESERVED to the canonical
// `merge:<branch>` (POD-672): the store keys leases on the exact bytes, so a
// near-miss like the bare `merge` is a SECOND lease that serialises against
// nothing and only shows up later as someone else's lost commits. Refusing here
// is the whole point — it fails at acquire time instead of at reset time.
// Rules live in @podium/protocol so the CLI, the web read binding and this
// schema cannot drift apart.
const lockName = z
  .string()
  .superRefine((name, ctx) => {
    const problem = lockNameProblem(name)
    if (problem != null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
  })

// Shared input fragments. repoPath is REQUIRED: a lock is meaningless without
// its repo scope; the CLI injects it from the cwd (repos.inferFromPath).
const lockRef = z.object({ repoPath: z.string(), name: lockName })
const ttlField = { ttlSeconds: z.number().int().positive().max(86_400).optional() }

/** Where a lock write is served: the operator's tRPC and an agent's relay. */
const LOCK_WRITE_TRANSPORTS: readonly CommandTransport[] = ['trpc', 'relay']

const defs = {
  acquire: def({
    kind: 'mutation',
    exposure: LOCK_WRITE_TRANSPORTS,
    input: lockRef.extend({
      ...ttlField,
      note: z.string().max(500).optional(),
      /** Opt into holding/queueing beside another session on the same issue or worktree. */
      allowSibling: z.boolean().optional(),
    }),
    action: 'write',
    cli: { positional: ['name'], summary: 'Acquire (or renew) a named lease lock.' },
    handler: async (ctx, input) => await ctx.locks.acquire(await ctx.callerIdentity(), input),
  }),
  cancel: def({
    kind: 'mutation',
    exposure: LOCK_WRITE_TRANSPORTS,
    input: lockRef,
    action: 'write',
    cli: { positional: ['name'], summary: "Leave a lock's wait queue." },
    handler: async (ctx, input) => await ctx.locks.cancel(await ctx.callerIdentity(), input),
  }),
  release: def({
    kind: 'mutation',
    exposure: LOCK_WRITE_TRANSPORTS,
    input: lockRef,
    action: 'write',
    cli: { positional: ['name'], summary: 'Release a lock you hold.' },
    handler: async (ctx, input) => await ctx.locks.release(await ctx.callerIdentity(), input),
  }),
  renew: def({
    kind: 'mutation',
    exposure: LOCK_WRITE_TRANSPORTS,
    input: lockRef.extend(ttlField),
    action: 'write',
    cli: { positional: ['name'], summary: 'Extend the lease on a lock you hold.' },
    handler: async (ctx, input) => await ctx.locks.renew(await ctx.callerIdentity(), input),
  }),
  status: def({
    kind: 'query',
    input: z.object({ repoPath: z.string(), name: lockName.optional() }),
    action: 'read',
    cli: { positional: ['name'], summary: 'Show lock state (one lock or the whole repo).' },
    handler: async (ctx, input) => await ctx.locks.status(input),
  }),
  steal: def({
    kind: 'mutation',
    exposure: LOCK_WRITE_TRANSPORTS,
    input: lockRef.extend({ ...ttlField, note: z.string().max(500).optional() }),
    action: 'write',
    cli: { positional: ['name'], summary: 'Force-take a lock regardless of holder.' },
    handler: async (ctx, input) => await ctx.locks.steal(await ctx.callerIdentity(), input),
  }),
} satisfies Record<LockCommandName, AnyLockCommandDef>

export const lockRegistry = defineCommands('lock', defs)

/**
 * The capability guard: role gate only. Lock commands never target an existing
 * issue, so there is no subtree/scope check — exactly the `mailSend` posture
 * (a write allowed for agents, including scope-'none' workers).
 */
export function guardLockCommand(
  caller: IssueCaller,
  def: Pick<AnyLockCommandDef, 'action'>,
): void {
  if (authorize(caller.capability, def.action) === 'forbidden') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'not allowed to use locks' })
  }
}

/**
 * The in-process lock command surface (mirrors IssueCommandDispatcher): runs
 * one command as `caller` with the router-equivalent pipeline (guard on the
 * raw input, zod parse with the same schema, then the handler) — serving the
 * daemon relay gate.
 */
export class LockCommandDispatcher {
  constructor(private readonly deps: LockCommandDeps) {}

  run<D extends AnyLockCommandDef>(
    caller: IssueCaller,
    _name: string,
    def: D,
    input: z.infer<D['input']>,
  ): ReturnType<D['handler']> {
    return def.handler(new LockCommandCtx(this.deps, caller), input) as ReturnType<D['handler']>
  }

  /**
   * One lock WRITE on the plain command path (POD-6419), from RAW input: the
   * front door, then the handler inside the plain scope. A refused caller gets
   * the guard's answer it always got; bad input, the schema's error.
   */
  async runPlain(
    caller: IssueCaller,
    principal: CommandPrincipal,
    transport: FrontDoorTransport,
    proc: string,
    rawInput: unknown,
  ): Promise<unknown> {
    const def = (lockRegistry.defs as Record<string, AnyLockCommandDef>)[proc]
    if (def === undefined || def.kind !== 'mutation') {
      throw new Error(`lock: ${proc} is not a lock write`)
    }
    const reply = await runPlainDef({
      name: `lock.${proc}`,
      def,
      principal,
      transport,
      input: rawInput,
      run: async (input) => await this.run(caller, proc, def, input),
    })
    if (reply.outcome === 'applied') return reply.result
    if (reply.refusal.kind === 'invalid') throw reply.refusal.error
    throw new TRPCError({ code: 'FORBIDDEN', message: 'not allowed to use locks' })
  }

  /**
   * Run one relayed command from RAW input. Undefined = no such procedure. A
   * write takes the plain command path; `status` is a read, behind the guard.
   */
  async dispatch(
    caller: IssueCaller,
    proc: string,
    rawInput: unknown,
    /** Who is asking, for the front door; an in-process caller's capability
     *  read as a principal when absent. */
    principal: () => Promise<CommandPrincipal> = async () =>
      resolvePrincipal(caller.capability, { parentSessionOf: () => undefined }),
  ): Promise<unknown | undefined> {
    if (!Object.hasOwn(lockRegistry.defs, proc)) return undefined
    const def = (lockRegistry.defs as Record<string, AnyLockCommandDef>)[proc] as AnyLockCommandDef
    if (def.kind === 'mutation') {
      return await this.runPlain(caller, await principal(), 'relay', proc, rawInput)
    }
    return await Promise.resolve().then(() => {
      guardLockCommand(caller, def)
      const input: unknown = def.input.parse(rawInput)
      return this.run(caller, proc, def, input)
    })
  }
}
