import { createLogger, describeError } from '@podium/logger'
import type { MachineId, SessionId } from '@podium/model'
import type { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { TRPCError } from '@trpc/server'
import type { Capability } from '../../issue-authz'

const log = createLogger('server:issues')

/** Routers/procs a relayed agent may invoke. `issues.*` is capability-gated by the shared
 *  command guard (guardIssueCommand over the registry defs); everything else is an explicit
 *  least-privilege list — a relay can never reach an ungated router. The sessions slice
 *  exposes only real-turn delivery (never spawn/kill/archive or raw PTY input). `null` =
 *  any proc on that router. */
export const RELAY_ALLOWED: Readonly<Record<string, ReadonlySet<string> | null>> = {
  // The sync write entry point (ADR 12 D2, POD-6413): the relay is one of its
  // thin adapters. It grants no reach of its own: the envelope's command must be
  // one this list allows directly, and the entry point then checks its exposure
  // on the relay, its role and its target, as for any caller.
  sync: new Set(['submit']),
  // null = every issues.* command, which includes the agent-mail procs
  // (mailSend/mailInbox/mailClaim/mailPending, issue #103).
  issues: null,
  repos: new Set(['inferFromPath']),
  // Read-only resolved experimental state lets agent-side CLI help match the UI.
  features: new Set(['state']),
  // Read-only agent plan limits. This is the same global multi-machine summary
  // the operator sees in the top-bar panel; no provider credentials cross it.
  quota: new Set(['summary']),
  // The living spec (pspec, #135): agents read/write pspec/ files they could
  // touch with their own tools anyway — the specs router adds no privilege
  // beyond its repo-root allowlist.
  specs: null,
  // status/read = read-toolkit tiers 1–2 (#237) [spec:SP-34d7] — structured
  // status + bounded transcript window, scope-gated like the send ops and
  // event-logged per read.
  // title = the agent naming its OWN session (#490): it carries no sessionId, the
  // target is the CALLING session (bound from the capability), and the user's own
  // name always wins — so it grants no reach over any other session.
  // stop = clean end + free worktree keep branch [spec:SP-9904]; self/subtree
  // free, outside needs --outside-scope (gated in the dispatch arm).
  // handoff = move a LIVE session to another machine (POD-642), exposed to agents
  // by POD-1386/POD-1424. It is the one entry here that causes execution on a second
  // machine, and it is safe to carry for the reason the coordinator is built
  // around: `use` is asserted on BOTH machines before anything stops, and the
  // target is re-authorized at each apply point, so the relay grants reach to the
  // command, never to a machine. Unlike spawn/kill it moves a session the caller
  // can already drive rather than creating or destroying one.
  sessions: new Set([
    'sendText',
    'resumeAndSend',
    'continue',
    'status',
    'read',
    'title',
    'stop',
    'handoff',
  ]),
  // Read-only fleet enumeration (POD-1386/POD-1424): "what can I run on?". Before this
  // a coordinating agent had no way to ask — it read the sqlite machines table directly,
  // or `tailscale status`, which knows the network and nothing about Podium. The answer
  // is the SAME authorization projection the router serves — see-set filtered, `use`
  // stamped per row — so this allowlist entry grants reach to a projection, not to the
  // machines table. An agent that could not see a machine still cannot.
  // `list` is byte-identical to the router's machines.list, because a proc returning one
  // shape over HTTP and another over the relay is a trap for every caller that can reach
  // both. `listWithRepos` is a SECOND proc rather than a wider `list`, and it joins the
  // registered checkout paths server-side, use-gated: relaying repos.listDetailed instead
  // would hand over every row on every machine, unscoped. The reprobe is the bounded
  // recovery write: it reaches only an online machine with this caller's live use grant.
  machines: new Set(['list', 'listWithRepos', 'reprobe']),
  // Unified messaging (#237) [spec:SP-34d7]: podium mail, cross-harness child
  // spawn/bounded await, and the stop-hook's single-reminder query. Sender and
  // parent identity are stamped from the capability; MessageGate owns target-
  // issue authz, spawn budgeting, and parent-only await authority.
  messages: new Set([
    'send',
    'inbox',
    'show',
    // status = the sender-queryable lifecycle (#834): "what happened to msg X"
    // after a synchronous send returned at queued. mayView-gated (own sends /
    // receipts only), so unlike the operator-only `ledger` it is safe via relay.
    'status',
    'reply',
    'pendingReminders',
    'spawnAgent',
    'awaitAgent',
  ]),
  // Approval broker [spec:SP-edbb]: agents may REQUEST any management op (and
  // poll its status); approve/deny/execution stay operator+daemon-side.
  approvals: new Set(['request', 'get']),
  // Instruction-first workflows: every procedure is schema-validated and
  // capability-scoped by WorkflowService; protected writes still need approval.
  workflows: null,
  // Lazy cross-machine workspace fetch [POD-658]: fetch materializes another
  // session's working state on the CALLER's machine (scope-gated against the
  // target's issue in the dispatch arm); clean removes only what fetch made.
  workspace: new Set(['fetch', 'clean']),
  // Advisory named lease locks [spec:SP-85d1] — coordination tokens agents
  // acquire/release via `podium lock`/`podium merge-lock`; role-gated by the
  // lock registry's guard, caller identity stamped from the relay capability.
  lock: null,
  // Agent action offer [spec:SP-c7f1] — `podium offer` set/clear. Carries no
  // sessionId; the target is ALWAYS the CALLING session (bound from the
  // capability), so it grants no reach over any other session.
  offer: new Set(['set', 'clear']),
  // An issue pin is the human's own pin record (POD-6692): `podium issue update
  // --pinned` creates or removes it through the entry point. Only pins, and the
  // pin adapter refuses any row that is not the caller's human's.
  // An agent's own trigger subscriptions (`podium issue subscription remove`) and
  // its session's workflow binding (`podium workflow assign`), POD-6676: the
  // adapters refuse any subscription that is not the agent's derived subscriber's
  // and any binding the agent's scope does not reach, as the commands did.
  records: new Set([
    'pin.create',
    'pin.remove',
    'subscription.edit',
    'subscription.remove',
    'workflowBinding.edit',
  ]),
}

/**
 * The dispatcher's answer for "this router/proc pair does not exist here".
 *
 * A UNIQUE SYMBOL, so it cannot collide with any value a real procedure might
 * resolve to — `undefined` could not make that promise, and every void mutation
 * over the relay produces exactly `undefined`.
 */
export const NO_SUCH_PROCEDURE: unique symbol = Symbol('agent relay: no such procedure')

type RelayRequest = Extract<DaemonMessage, { type: 'agentRelayRequest' }>

/**
 * The relay context bound onto a call's input, never taken from the agent.
 * attachSession acts on the CALLING session: its id comes from the relay context
 * (the daemon's /agent/<sessionId> path). Approvals bind to the calling session
 * and its machine, both from the relay context (provenance cannot lie).
 */
function bindRelayContext(
  router: string,
  proc: string,
  input: unknown,
  sessionId: SessionId,
  machineId: MachineId,
): unknown {
  if (router === 'issues' && proc === 'attachSession') {
    return { ...(input as Record<string, unknown> | undefined), sessionId }
  }
  if (router === 'approvals') {
    return { ...(input as Record<string, unknown> | undefined), sessionId, machineId }
  }
  return input
}

/** Whether the relay reaches `router.proc` (own keys only, see `run`). */
function relayAllows(router: string, proc: string): boolean {
  if (!Object.hasOwn(RELAY_ALLOWED, router)) return false
  const allowed = RELAY_ALLOWED[router]
  return allowed === null || (allowed !== undefined && allowed.has(proc))
}

/** The command a `sync.submit` envelope names, split at its first dot. */
function envelopeCommand(envelope: unknown): { router: string; proc: string } | undefined {
  const command = (envelope as { command?: unknown } | null | undefined)?.command
  if (typeof command !== 'string') return undefined
  const dot = command.indexOf('.')
  if (dot <= 0) return undefined
  return { router: command.slice(0, dot), proc: command.slice(dot + 1) }
}

/** A `sync.submit` envelope with the relay context bound onto its command's input. */
function bindEnvelopeContext(
  envelope: unknown,
  sessionId: SessionId,
  machineId: MachineId,
): unknown {
  const inner = envelopeCommand(envelope)
  if (inner === undefined) return envelope
  const { input } = envelope as { input?: unknown }
  return {
    ...(envelope as object),
    input: bindRelayContext(inner.router, inner.proc, input, sessionId, machineId),
  }
}

/**
 * The call the after-reply hook judges: the request as it came, or, for a
 * command sent through `sync.submit`, that command and its result. A refused
 * submit succeeded as a reply but did nothing, so no hook runs for it.
 */
function submittedCommand(
  msg: RelayRequest,
  value: unknown,
): { msg: RelayRequest; result: unknown } | undefined {
  if (msg.router !== 'sync' || msg.proc !== 'submit') return { msg, result: value }
  const reply = value as { outcome?: unknown; result?: unknown } | null
  const inner = envelopeCommand(msg.input)
  if (reply?.outcome !== 'applied' || inner === undefined) return undefined
  return { msg: { ...msg, ...inner }, result: reply.result }
}

export interface AgentRelayGateDeps {
  /** Run one relayed op through the derived command surface (the registry
   *  dispatcher for issues/repos, the specs module for specs) — router-equal
   *  guard + schema, no router involved.
   *
   *  NO SUCH PROCEDURE IS A VALUE, NOT AN ABSENCE. It resolves to
   *  {@link NO_SUCH_PROCEDURE}. This used to be spelled `Promise<unknown> |
   *  undefined`, where returning something that was not a promise WAS the
   *  signal — and POD-3221's async flip broke that in both directions at once
   *  (the implementation became `async`, so the undefined arm could no longer
   *  be produced; the caller began awaiting, so a command that RESOLVED to
   *  undefined started reading as a missing procedure). A union of "a promise"
   *  and "not a promise" cannot survive an await being added anywhere along the
   *  path, which is spec rule 52b's whole point. A sentinel can. */
  dispatch(
    capability: Capability,
    overrideScope: boolean | undefined,
    router: string,
    proc: string,
    input: unknown,
  ): Promise<unknown>
  /** Check this authenticated sender against the same session snapshot used
   * to derive authority. Missing or foreign sessions must mint no capability. */
  capabilityForSession(sessionId: SessionId, machineId: MachineId): Capability | Promise<Capability>
  toMachine(machineId: MachineId, msg: ControlMessage): void
  /**
   * After a successful agentRelayResult is on the wire. Used to arm self-stop
   * kill only once the CLI has received the reply [spec:SP-9904] — never a
   * fixed timer inside the stop helper.
   */
  afterSuccessfulReply?(
    msg: Extract<DaemonMessage, { type: 'agentRelayRequest' }>,
    result: unknown,
  ): void
}

/**
 * Run a relayed agent op against the shared backend and reply to its daemon.
 *
 * TRANSPORT + capability resolution only: the op is dispatched through the command
 * registry's derived surface (modules/issues/registry.ts), whose guard is the SAME
 * guardIssueCommand the derived tRPC middleware applies — nothing is re-implemented
 * here, and the router is not involved. The capability itself is minted from the
 * requesting session's cwd (capabilityForSession), and the agent's `--outside-scope`
 * flag rides through as overrideScope. RELAY_ALLOWED restricts which router/proc a
 * relay may reach so it can never touch an ungated router or arbitrary session
 * lifecycle operations; the allowlisted session send ops are additionally scope-gated
 * against the TARGET session's issue by the dispatch arm in the composition root.
 */
export class AgentRelayGate {
  // NO correlation state, and deliberately not the daemon-RPC correlator
  // (POD-318): the direction is INVERTED. The daemon asks and the server
  // answers, so the requestId is the daemon's, this gate never waits, and there
  // is nothing to time out or to settle. `reply` below just echoes the id back.
  constructor(private readonly deps: AgentRelayGateDeps) {}

  async run(
    machineId: MachineId,
    msg: Extract<DaemonMessage, { type: 'agentRelayRequest' }>,
  ): Promise<void> {
    const reply = (r: { ok: boolean; result?: unknown; error?: string }): void =>
      this.deps.toMachine(machineId, { type: 'agentRelayResult', requestId: msg.requestId, ...r })
    try {
      // RELAY_ALLOWED is a plain object; index it only for OWN keys so a router of
      // 'constructor'/'__proto__'/'toString' can't resolve to an inherited value
      // (which would throw a confusing TypeError on `.has(...)`) — treat any
      // non-own key as simply not permitted.
      if (!Object.hasOwn(RELAY_ALLOWED, msg.router)) {
        reply({ ok: false, error: `${msg.router}.${msg.proc} is not permitted via relay` })
        return
      }
      if (!relayAllows(msg.router, msg.proc)) {
        reply({ ok: false, error: `${msg.router}.${msg.proc} is not permitted via relay` })
        return
      }
      // Through the entry point, the command INSIDE the envelope must be one the
      // relay reaches directly: `sync.submit` adds no reach to the allowlist.
      const inner =
        msg.router === 'sync' && msg.proc === 'submit' ? envelopeCommand(msg.input) : undefined
      if (
        msg.router === 'sync' &&
        (inner === undefined || !relayAllows(inner.router, inner.proc))
      ) {
        const name = inner === undefined ? 'this command' : `${inner.router}.${inner.proc}`
        reply({ ok: false, error: `${name} is not permitted via relay` })
        return
      }
      // A command sent through the sync write entry point (`sync.submit`, POD-6413)
      // carries its own command name and input in the envelope: the relay
      // context is bound onto THAT input, exactly as onto a direct call's.
      const input =
        msg.router === 'sync' && msg.proc === 'submit'
          ? bindEnvelopeContext(msg.input, msg.sessionId, machineId)
          : bindRelayContext(msg.router, msg.proc, msg.input, msg.sessionId, machineId)
      const result = this.deps.dispatch(
        await this.deps.capabilityForSession(msg.sessionId, machineId),
        msg.outsideScope,
        msg.router,
        msg.proc,
        input,
      )
      const value = await result
      if (value === NO_SUCH_PROCEDURE) {
        reply({ ok: false, error: `no such procedure: ${msg.router}.${msg.proc}` })
        return
      }
      // Reply FIRST so the agent CLI observes success before any self-stop kill.
      reply({ ok: true, result: value })
      const done = submittedCommand(msg, value)
      if (done !== undefined) this.deps.afterSuccessfulReply?.(done.msg, done.result)
    } catch (err) {
      // THE ONLY RECORD THIS FAILURE LEAVES, and until POD-3805 there was none
      // at all: the agent got a reply and the server logged nothing, so a day of
      // failing `podium lock` calls was invisible here (POD-3802 §2). `err`
      // rather than its message, because the logger walks `err.cause` and the
      // cause is where a store refusal lives.
      log.warn('agent command failed', {
        router: msg.router,
        proc: msg.proc,
        sessionId: msg.sessionId,
        err,
      })
      // Expected refusals already carry their public message. Diagnostic class
      // names and causes must not rewrite that contract. Unexpected failures
      // still include the cause that explains an opaque database wrapper.
      reply({
        ok: false,
        error:
          err instanceof TRPCError && err.code !== 'INTERNAL_SERVER_ERROR'
            ? err.message
            : describeError(err),
      })
    }
  }
}
