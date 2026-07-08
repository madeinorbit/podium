import type { ControlMessage, DaemonMessage } from '@podium/protocol'
import type { Capability } from '../../issue-authz'

/** Routers/procs a relayed agent may invoke. `issues.*` is capability-gated by the router
 *  middleware (issueCapabilityGuard); everything else must be explicitly listed so a relay
 *  can never reach an ungated router (sessions/spawn/kill/etc.). `null` = any proc on that
 *  router. */
const RELAY_ALLOWED: Record<string, Set<string> | null> = {
  // null = every issues.* proc, which includes the agent-mail procs
  // (mailSend/mailInbox/mailClaim/mailPending, issue #103).
  issues: null,
  repos: new Set(['inferFromPath']),
  // The living spec (pspec, #135): agents read/write pspec/ files they could
  // touch with their own tools anyway — the specs router adds no privilege
  // beyond its repo-root allowlist.
  specs: null,
}

/** The capability-scoped caller factory (the in-process issue command service). */
export type IssueCallerFactory = (
  capability: Capability,
  overrideScope?: boolean,
) => { [router: string]: Record<string, (i: unknown) => Promise<unknown>> | undefined }

export interface IssueRelayGateDeps {
  /** Build a capability-bound caller over the in-process issue command service
   *  (modules/issues/commands) — router-equal authz, no router involved. */
  caller: IssueCallerFactory
  capabilityForSession(sessionId: string): Capability
  toMachine(machineId: string, msg: ControlMessage): void
}

/**
 * Run a relayed agent issue op against the shared tracker and reply to its daemon.
 *
 * The op is invoked through the capability-scoped in-process command service
 * (modules/issues/commands), whose guard applies the SAME checkIssueAccess the router's
 * issueCapabilityGuard middleware applies — the gate is NOT re-implemented here, and the
 * router is not involved (the old makeIssueCaller → appRouter.createCaller detour is gone).
 * The capability itself is minted from the requesting session's cwd (capabilityForSession),
 * and the agent's `--outside-scope` flag rides through as overrideScope. RELAY_ALLOWED
 * restricts which router/proc a relay may reach so it can never touch an ungated router
 * (sessions/spawn/kill).
 */
export class IssueRelayGate {
  constructor(private readonly deps: IssueRelayGateDeps) {}

  async run(
    machineId: string,
    msg: Extract<DaemonMessage, { type: 'issueRelayRequest' }>,
  ): Promise<void> {
    const reply = (r: { ok: boolean; result?: unknown; error?: string }): void =>
      this.deps.toMachine(machineId, { type: 'issueRelayResult', requestId: msg.requestId, ...r })
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
      const caller = this.deps.caller(
        this.deps.capabilityForSession(msg.sessionId),
        msg.outsideScope,
      )
      const fn = caller[msg.router]?.[msg.proc]
      if (!fn) {
        reply({ ok: false, error: `no such procedure: ${msg.router}.${msg.proc}` })
        return
      }
      // attachSession acts on the CALLING session: take its id from the relay
      // context (the daemon's /issue/<sessionId> path), never from agent input.
      const input =
        msg.router === 'issues' && msg.proc === 'attachSession'
          ? { ...(msg.input as Record<string, unknown> | undefined), sessionId: msg.sessionId }
          : msg.input
      reply({ ok: true, result: await fn(input) })
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
}
