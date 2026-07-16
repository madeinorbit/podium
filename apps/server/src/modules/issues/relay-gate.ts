import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import type { Capability } from '../../issue-authz'

/** Routers/procs a relayed agent may invoke. `issues.*` is capability-gated by the shared
 *  command guard (guardIssueCommand over the registry defs); everything else is an explicit
 *  least-privilege list — a relay can never reach an ungated router. The sessions slice
 *  exposes only real-turn delivery (never spawn/kill/archive or raw PTY input). `null` =
 *  any proc on that router. */
const RELAY_ALLOWED: Record<string, Set<string> | null> = {
  // null = every issues.* command, which includes the agent-mail procs
  // (mailSend/mailInbox/mailClaim/mailPending, issue #103).
  issues: null,
  repos: new Set(['inferFromPath']),
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
  sessions: new Set(['sendText', 'resumeAndSend', 'continue', 'status', 'read', 'title']),
  // Unified messaging (#237) [spec:SP-34d7]: podium mail, cross-harness child
  // spawn/bounded await, and the stop-hook's single-reminder query. Sender and
  // parent identity are stamped from the capability; MessageGate owns target-
  // issue authz, spawn budgeting, and parent-only await authority.
  messages: new Set([
    'send',
    'inbox',
    'show',
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
}

export interface AgentRelayGateDeps {
  /** Run one relayed op through the derived command surface (the registry
   *  dispatcher for issues/repos, the specs module for specs) — router-equal
   *  guard + schema, no router involved. Undefined = no such procedure. */
  dispatch(
    capability: Capability,
    overrideScope: boolean | undefined,
    router: string,
    proc: string,
    input: unknown,
  ): Promise<unknown> | undefined
  capabilityForSession(sessionId: string): Capability
  toMachine(machineId: string, msg: ControlMessage): void
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
  constructor(private readonly deps: AgentRelayGateDeps) {}

  async run(
    machineId: string,
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
      const allowed = RELAY_ALLOWED[msg.router]
      if (allowed === undefined || (allowed !== null && !allowed.has(msg.proc))) {
        reply({ ok: false, error: `${msg.router}.${msg.proc} is not permitted via relay` })
        return
      }
      // attachSession acts on the CALLING session: take its id from the relay
      // context (the daemon's /agent/<sessionId> path), never from agent input.
      const input =
        msg.router === 'issues' && msg.proc === 'attachSession'
          ? { ...(msg.input as Record<string, unknown> | undefined), sessionId: msg.sessionId }
          : // approvals bind to the CALLING session + its machine — both come from
            // the relay context, never from agent input (provenance cannot lie).
            msg.router === 'approvals'
            ? {
                ...(msg.input as Record<string, unknown> | undefined),
                sessionId: msg.sessionId,
                machineId,
              }
            : msg.input
      const result = this.deps.dispatch(
        this.deps.capabilityForSession(msg.sessionId),
        msg.outsideScope,
        msg.router,
        msg.proc,
        input,
      )
      if (result === undefined) {
        reply({ ok: false, error: `no such procedure: ${msg.router}.${msg.proc}` })
        return
      }
      reply({ ok: true, result: await result })
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
