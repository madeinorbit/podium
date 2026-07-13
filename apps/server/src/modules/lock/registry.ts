import { type CommandDef, defineCommands, type LockCommandName } from '@podium/protocol'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { authorize } from '../../issue-authz'
import type { IssueCaller } from '../issues/registry'
import type { IssueService } from '../issues/service'
import type { LockCallerIdentity, LockService } from './service'

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
  /** Lazy — LockService is assigned late in the composition root. */
  locks(): LockService
  /** Issue seq lookup for holder labels (`issue:#<seq>`). Lazy for the same reason. */
  issues(): IssueService
}

/** Per-call execution context: caller identity + the LockService. */
export class LockCommandCtx {
  constructor(
    readonly deps: LockCommandDeps,
    readonly caller: IssueCaller,
  ) {}

  get locks(): LockService {
    return this.deps.locks()
  }

  /**
   * Holder identity, stamped SERVER-SIDE from the relay capability (the same
   * mechanism as `podium issue attach` — there is no --session flag): the
   * calling session id + its bound issue for a relayed agent; the operator
   * (direct-HTTP, no actor session) holds as `operator`.
   */
  callerIdentity(): LockCallerIdentity {
    const cap = this.caller.capability
    // Only the unconstrained operator (scope 'all', no actor session) maps to
    // the null holder; a constrained caller with no known session gets the
    // UNKNOWN_RELAY_SESSION sentinel so it can never impersonate the operator.
    const sessionId =
      cap.actorSessionId ?? (cap.scope.kind === 'all' ? null : UNKNOWN_RELAY_SESSION)
    const issueId = cap.scope.kind === 'subtree' ? cap.scope.rootId : null
    let label = 'operator'
    if (issueId) {
      const me = this.deps.issues().get(issueId)
      label = me ? `issue:#${me.seq}` : `session:${sessionId ?? '?'}`
    } else if (sessionId) {
      label = `session:${sessionId}`
    }
    return { sessionId, issueId, label }
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
// The charset covers merge:<branch> for real branch names (slashes, dots,
// dashes, underscores); first char alphanumeric so a name can't look like a
// flag.
const lockName = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    'lock names allow letters, digits and - _ : . / (starting with a letter or digit)',
  )

// Shared input fragments. repoPath is REQUIRED: a lock is meaningless without
// its repo scope; the CLI injects it from the cwd (repos.inferFromPath).
const lockRef = z.object({ repoPath: z.string(), name: lockName })
const ttlField = { ttlSeconds: z.number().int().positive().max(86_400).optional() }

const defs = {
  acquire: def({
    kind: 'mutation',
    input: lockRef.extend({ ...ttlField, note: z.string().max(500).optional() }),
    action: 'write',
    cli: { positional: ['name'], summary: 'Acquire (or renew) a named lease lock.' },
    handler: (ctx, input) => ctx.locks.acquire(ctx.callerIdentity(), input),
  }),
  cancel: def({
    kind: 'mutation',
    input: lockRef,
    action: 'write',
    cli: { positional: ['name'], summary: "Leave a lock's wait queue." },
    handler: (ctx, input) => ctx.locks.cancel(ctx.callerIdentity(), input),
  }),
  release: def({
    kind: 'mutation',
    input: lockRef,
    action: 'write',
    cli: { positional: ['name'], summary: 'Release a lock you hold.' },
    handler: (ctx, input) => ctx.locks.release(ctx.callerIdentity(), input),
  }),
  renew: def({
    kind: 'mutation',
    input: lockRef.extend(ttlField),
    action: 'write',
    cli: { positional: ['name'], summary: 'Extend the lease on a lock you hold.' },
    handler: (ctx, input) => ctx.locks.renew(ctx.callerIdentity(), input),
  }),
  status: def({
    kind: 'query',
    input: z.object({ repoPath: z.string(), name: lockName.optional() }),
    action: 'read',
    cli: { positional: ['name'], summary: 'Show lock state (one lock or the whole repo).' },
    handler: (ctx, input) => ctx.locks.status(input),
  }),
  steal: def({
    kind: 'mutation',
    input: lockRef.extend({ ...ttlField, note: z.string().max(500).optional() }),
    action: 'write',
    cli: { positional: ['name'], summary: 'Force-take a lock regardless of holder.' },
    handler: (ctx, input) => ctx.locks.steal(ctx.callerIdentity(), input),
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

  /** Run one relayed command from RAW input. Undefined = no such procedure. */
  dispatch(caller: IssueCaller, proc: string, rawInput: unknown): Promise<unknown> | undefined {
    if (!Object.hasOwn(lockRegistry.defs, proc)) return undefined
    const def = (lockRegistry.defs as Record<string, AnyLockCommandDef>)[proc] as AnyLockCommandDef
    return Promise.resolve().then(() => {
      guardLockCommand(caller, def)
      const input: unknown = def.input.parse(rawInput)
      return this.run(caller, proc, def, input)
    })
  }
}
