/**
 * THE BINDING MINT (POD-4806 review).
 *
 * ONE place that authors the server-minted SessionBinding instructions every
 * spawn and reattach frame carries — headed PTY sessions (`SessionStart`,
 * `SessionClientPlane`) and headless superagent sessions (`HeadlessService`)
 * alike. It used to live inline in `SessionStart.spawn` while the headless
 * path hand-built a smaller copy beside it (no scope narrowing, no observation
 * lease, a constant reattach generation); the copy is what let a headless
 * spawn reach a daemon that refuses unminted frames. A second literal here is
 * a second fork, so both frame sites build through these functions and neither
 * restates the transition-id format, the default scope, or the containment
 * check.
 *
 * PURE by construction: everything store-backed (the agent principal's parent
 * lookup, the observation-lease fence, the machine-use decision) is resolved
 * by the caller and passed in. What is minted here is decided here, from
 * arguments alone — which is also what makes it unit-testable without a
 * registry.
 */

import { asAgentIdentityId, type IssueId, type SessionDelegation, type SessionId, type UserId } from '@podium/model'
import type {
  BindingMachineAccess,
  SessionBindingReattachInstruction,
  SessionBindingSpawnInstruction,
  SessionBindingSpawnPrincipal,
} from '@podium/protocol'

/** Declared-scope containment is checked by the authoring server, never the daemon. */
export function scopeWithin(
  child: SessionDelegation['grantedScope'],
  parent: SessionDelegation['grantedScope'],
): boolean {
  if (child.kind === 'none' || parent.kind === 'all') return true
  if (child.kind !== parent.kind) return false
  switch (child.kind) {
    case 'subtree':
      return parent.kind === 'subtree' && child.rootId === parent.rootId
    case 'owned':
    case 'self':
      return parent.kind === child.kind && child.userId === parent.userId
    default:
      return false
  }
}

/**
 * Author a spawn's identity half: the principal, its delegation, and the full
 * `SessionBindingSpawnInstruction` for the frame. Throws on a scope violation
 * rather than minting a widening delegation. The transition id names the
 * session it births (`spawn:<sessionId>`); a second spawn frame for the same
 * session is a relaunch decision the daemon makes, not a second mint here.
 */
export function authorSpawnBinding(input: {
  sessionId: SessionId
  principal: SessionBindingSpawnPrincipal
  parent?: Pick<SessionDelegation, 'onBehalfOf' | 'grantedScope'>
  issueId?: IssueId
  requestedScope?: SessionDelegation['grantedScope']
  scopeOverrideConfirmed?: boolean
  relaunch?: boolean
  machineAccess?: BindingMachineAccess
}): {
  principal: SessionBindingSpawnPrincipal
  delegation: SessionDelegation
  binding: SessionBindingSpawnInstruction
} {
  const { sessionId, principal, parent, issueId } = input
  if (principal.kind === 'agent' && !parent) throw new Error('parent delegation missing')
  const narrowDefault: SessionDelegation['grantedScope'] = issueId
    ? { kind: 'subtree', rootId: issueId }
    : { kind: 'none' }
  const grantedScope = input.requestedScope ?? narrowDefault
  if (principal.kind === 'agent' && !scopeWithin(grantedScope, parent!.grantedScope))
    throw new Error('child delegation cannot widen its parent scope')
  if (
    principal.kind === 'user' &&
    !input.scopeOverrideConfirmed &&
    !scopeWithin(grantedScope, narrowDefault)
  )
    throw new Error('scope override is not authorized')
  const delegation: SessionDelegation = {
    actor: asAgentIdentityId(sessionId),
    onBehalfOf:
      principal.kind === 'system' ? null : principal.kind === 'user' ? principal.userId : parent!.onBehalfOf,
    grantedScope,
    parentBindingId: principal.kind === 'agent' ? principal.parentBindingId : null,
    revision: 1,
  }
  return {
    principal,
    delegation,
    binding: {
      ...(input.requestedScope ? { requestedScope: input.requestedScope } : {}),
      ...(input.scopeOverrideConfirmed ? { scopeOverrideConfirmed: true as const } : {}),
      ...(input.relaunch ? { relaunch: true as const } : {}),
      principal,
      delegation,
      transitionId: `spawn:${sessionId}`,
      machineAccess: input.machineAccess ?? 'allowed',
      ...(issueId ? { issueId } : {}),
    },
  }
}

/**
 * Author a reattach's binding: the probe principal, the session's own
 * delegation for adoption, and a transition id carrying the freshly fenced
 * observation generation. The generation MUST be fenced per reattach (the
 * caller fences first): the daemon dedupes on transition id, so a constant
 * generation turns the second reattach into a no-op exactly when the binding
 * may need to move (machine access, adoption).
 */
export function authorReattachBinding(input: {
  sessionId: SessionId
  delegation?: SessionDelegation
  ownerUserId: UserId
  issueId?: IssueId
  observationGeneration: number
  machineAccess: BindingMachineAccess
}): SessionBindingReattachInstruction {
  return {
    ...(input.delegation ? { delegation: input.delegation } : {}),
    transitionId: `reattach:${input.sessionId}:${input.observationGeneration}`,
    machineAccess: input.machineAccess,
    sessionAccess: 'allowed',
    principal: { kind: 'system' },
    // WHO this session belongs to, for a survivor the daemon has no binding
    // record for (every session older than the binding store). The daemon
    // cannot know it; this row is where it lives. `principal` above is the
    // probe, not the owner — see SessionBindingReattachInstruction.adopt.
    adopt: {
      ownerUserId: input.ownerUserId,
      ...(input.issueId ? { issueId: input.issueId } : {}),
    },
  }
}
