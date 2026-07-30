/**
 * The L3 handler context for the agent-mail contracts (POD-728).
 *
 * ADR 3 D1's split: the CONTRACT is L1 data in `@podium/commands`; the HANDLER
 * is here, with the feature, where it may call `IssueService`,
 * `MessageDeliveryService` and the spawn seam. This module holds what all six
 * handlers share — the authz arithmetic, the mailbox principals, and the wire
 * projection — so there is exactly ONE authz path rather than one per transport
 * and one per command.
 *
 * The two structural properties this migration must not weaken:
 *
 *  - Validation and authz stay shared VERBATIM with the daemon relay arm. Both
 *    the relay and the tRPC router reach the same `MailAccess`; neither has a
 *    copy.
 *  - Sender identity is stamped from the capability. `senderFromCapability` is
 *    the single site, and there is no path by which client input contributes a
 *    sender field (ADR 3 D7, the mailIdentity pattern). Under multi-user this
 *    now stamps BOTH halves of the attribution pair (§3.1.3 A3) — the actor from
 *    `Capability.actorSessionId`, the on-behalf-of human from the resolved
 *    delegation — and neither half is reachable from payload.
 */

import { asIssueId, asSessionId, type IssueId, type SessionId } from '@podium/model'
import {
  type AddressResolution,
  type HumanCeiling,
  type PlacementDecision,
  placementDecision,
  resolveAddress,
  SINGLE_USER_CEILING,
} from '@podium/commands'
import { type Capability, checkIssueAccess } from '../../../issue-authz'
import type { MessageRow } from '../../../store'
import type { MessageGateDeps, MessageWire } from '../gate'
import type { MessageDeliveryDeps } from '../service'

export interface MailCaller {
  capability: Capability
  overrideScope?: boolean
}

/**
 * Whether the effective principal may `use` a machine, and whether the machine
 * is reachable — readiness §3.1.4 M1/M5/M6. A PORT: the answer comes from the
 * machine ownership + grant tables (POD-1079), resolved against the EFFECTIVE
 * principal (the agent's scope intersected with its human's current rights), not
 * from a separate fleet ACL.
 */
export interface MachineAccess {
  mayUse(machineId: string): boolean
  isReachable(machineId: string): boolean
}

/**
 * Machine access as it stands until POD-1079 lands the grant model.
 *
 * The honest statement of today's fact, in the same shape as
 * `SINGLE_USER_CEILING`: one human owns every paired machine, so `use` is held
 * on all of them, and reachability is not yet observable from this seam so a
 * machine is assumed reachable and the spawn's own failure reports otherwise.
 *
 * EXPIRES WHEN: POD-1079 lands machine ownership and grants. The composition root
 * then resolves this against the effective principal and this constant is
 * DELETED — not reconfigured. A code-execution boundary that can be widened by
 * configuration is one that can be widened by accident (readiness §3.1.4 M2).
 */
export const SINGLE_USER_MACHINE_ACCESS: MachineAccess = {
  mayUse: () => true,
  isReachable: () => true,
}

/**
 * THE OTHER HALF OF THE CEILING, and it must be wired from the SAME object.
 *
 * `MailAccess` applies the ceiling when an address is RESOLVED. That closes the
 * ordinary case, but not the collision case: a caller who supplies the literal
 * internal id of an issue beyond its human's visibility gets an address that
 * looks unresolvable to the gate and resolvable to the delivery path. The
 * apply-time port is what closes it, at both sites that could act on the row
 * (the legacy mirror write and every delivery attempt).
 *
 * So a composition root that hands a real ceiling to `MessageGate` must hand
 * THIS to `MessageDeliveryService`, built from the same object. Two ceilings
 * that could disagree is the defect; one object read twice is the fix.
 *
 * The refusal reason is byte-identical to the one an id that does not exist
 * produces, so the queue cannot be read as an existence oracle one step removed
 * (ADR 3 Amendment 1 D20.2).
 */
export const applyAuthFromCeiling =
  (ceiling: HumanCeiling): NonNullable<MessageDeliveryDeps['authorizeAtApply']> =>
  (message) => {
    if (message.toKind !== 'issue' || !message.toId) return { ok: true }
    if (ceiling.canSee({ kind: 'issue', id: message.toId })) return { ok: true }
    return { ok: false, reason: 'issue no longer exists' }
  }

export interface MailHandlerContext {
  caller: MailCaller
  deps: MessageGateDeps
  access: MailAccess
}

/**
 * The shared authz + projection arithmetic. Extracted from `MessageGate` with
 * its behaviour unchanged — POD-727's characterization suite is the oracle for
 * that claim, and it drives the same `gate.dispatch` entry point it always did.
 */
export class MailAccess {
  constructor(
    private readonly deps: MessageGateDeps,
    /** The delegating human's visibility (readiness §3.1.5 / ADR 3 Amd 1 D20). */
    readonly ceiling: HumanCeiling = SINGLE_USER_CEILING,
    /** Owned-compute grants (readiness §3.1.4). */
    readonly machines: MachineAccess = SINGLE_USER_MACHINE_ACCESS,
  ) {}

  /**
   * `to` is a session id when it names a known session, else an issue ref —
   * resolved UNDER THE HUMAN CEILING. An address beyond the ceiling collapses to
   * `unresolvable`, which is the same value an id that does not exist produces:
   * the consistent-error rule (ADR 3 Amendment 1 D20.2) enforced by construction
   * rather than by two error strings kept in sync.
   */
  resolveRecipient(to: string): AddressResolution {
    return resolveAddress(to, {
      isKnownSession: (ref) => this.deps.listSessions().some((s) => s.sessionId === ref),
      resolveIssueRef: (ref) => this.deps.issues().resolveRef(ref),
      issueExists: (id) => this.deps.issues().has(id),
      ceiling: this.ceiling,
    })
  }

  /**
   * The same resolution for a ref that is KNOWN to name an issue (`inbox
   * --issue`, the ledger filters) — the session arm is skipped so an issue ref
   * that happens to match a session id cannot be re-routed. Same ceiling, same
   * single `unresolvable` value.
   */
  resolveIssueAddress(ref: string): AddressResolution {
    return resolveAddress(ref, {
      isKnownSession: () => false,
      resolveIssueRef: (r) => this.deps.issues().resolveRef(r),
      issueExists: (id) => this.deps.issues().has(id),
      ceiling: this.ceiling,
    })
  }

  /** Placement, authorization decided before reachability (§3.1.4 M5). */
  placement(machineId: string): PlacementDecision {
    return placementDecision(machineId, this.machines)
  }

  /** The session-target containment gate — same posture as the relay sessions
   *  slice (#237 authz): issue-bound targets need write access to that issue;
   *  issueless targets are parent/operator-only (--outside-scope never
   *  substitutes there). */
  assertSessionTargetAccess(caller: MailCaller, sessionId: SessionId, proc: string): void {
    const target = this.deps.listSessions().find((s) => s.sessionId === sessionId)
    if (!target) throw new Error('session not found')
    const issues = this.deps.issues()
    const targetIssueId = target.issueId ?? issues.issueForCwd(target.cwd)
    if (targetIssueId) {
      checkIssueAccess(caller, issues, proc, 'write', targetIssueId)
      return
    }
    const isOperator = caller.capability.scope.kind === 'all'
    const isParent =
      caller.capability.actorSessionId !== undefined &&
      target.spawnedBy === `session:${caller.capability.actorSessionId}`
    if (!isOperator && !isParent) {
      throw new Error('target session has no issue; only its parent or the operator may message it')
    }
  }

  /** The mailbox principals a capability owns: its issue subtree root and its
   *  own session; the operator owns the operator box. */
  callerPrincipals(
    capability: Capability,
  ): { kind: 'issue' | 'session' | 'operator'; id?: string }[] {
    if (capability.scope.kind === 'all') return [{ kind: 'operator' }]
    const out: { kind: 'issue' | 'session' | 'operator'; id?: string }[] = []
    if (capability.scope.kind === 'subtree') {
      out.push({ kind: 'issue', id: capability.scope.rootId })
    }
    if (capability.actorSessionId) out.push({ kind: 'session', id: capability.actorSessionId })
    return out
  }

  isRecipient(capability: Capability, m: MessageRow): boolean {
    if (m.deliveredTo && m.deliveredTo === capability.actorSessionId) return true
    return this.callerPrincipals(capability).some(
      (p) => p.kind === m.toKind && (p.kind === 'operator' || p.id === m.toId),
    )
  }

  mayView(capability: Capability, m: MessageRow): boolean {
    if (capability.scope.kind === 'all') return true
    if (this.isRecipient(capability, m)) return true
    // The sender may re-read what it sent.
    if (m.fromSession && m.fromSession === capability.actorSessionId) return true
    return (
      m.fromKind === 'agent' &&
      capability.scope.kind === 'subtree' &&
      m.fromIssue === capability.scope.rootId
    )
  }

  wire(m: MessageRow): MessageWire {
    const issues = this.deps.issues()
    const label = (kind: string, issueId: IssueId | null, sessionId: SessionId | null): string => {
      if (kind === 'agent' || kind === 'issue') {
        if (issueId) {
          const issue = issues.getMeta(issueId)
          // Nice-id form (#474), matching the envelope labels.
          if (issue) return `issue:${issues.niceRef(issue)}`
          return issueId
        }
        if (sessionId) return `session:${sessionId}`
      }
      if (kind === 'session' && sessionId) return `session:${sessionId}`
      return kind
    }
    return {
      id: m.id,
      threadId: m.threadId,
      inReplyTo: m.inReplyTo,
      from:
        m.fromKind === 'system' && m.fromName
          ? `system:${m.fromName}`
          : label(m.fromKind, m.fromIssue, m.fromSession),
      // `toId` is polymorphic by `toKind` (see the MessageRow field's note), so the
      // brand is recovered inside each discriminated branch — never once, up front.
      to: label(
        m.toKind,
        m.toKind === 'issue' && m.toId ? asIssueId(m.toId) : null,
        m.toKind === 'session' && m.toId ? asSessionId(m.toId) : null,
      ),
      kind: m.kind,
      urgency: m.urgency,
      lifecycle: m.lifecycle,
      body: m.body,
      createdAt: m.createdAt,
      status: m.status,
      ackedBy: m.ackedBy,
      deliveredAt: m.deliveredAt,
      deliveredTo: m.deliveredTo,
      expiresAt: m.expiresAt,
      clampedFrom: m.clampedFrom,
      hop: m.hop,
      readAt: m.readAt ?? null,
      deadLetteredAt: m.deadLetteredAt ?? null,
      expectsResponse: m.expectsResponse ?? false,
    }
  }
}
