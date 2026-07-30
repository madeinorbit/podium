/**
 * DELEGATION AS A REFERENCE, RESOLVED LIVE — ADR 3 Amendment 1 D16, readiness
 * §3.1.3 A1/A2, ADR 9 D5.
 *
 * The handshake carries a server-minted delegation REFERENCE. Nothing in this
 * file copies rights into a connection, and there is deliberately no type that
 * could hold a snapshotted "effective capability": a snapshot means revoking a
 * person leaves their unattended agents running with rights the human no longer
 * holds, with no cleanup trigger. Live resolution makes "revoke the human"
 * transitively disable their agents with no reaper to write.
 *
 * The chain is resolved at handshake time only far enough to prove the reference
 * resolves to a live delegation with exactly one human at its root (D16.2) —
 * enough to refuse a connection whose delegation is unresolvable, and not one
 * step further. Every apply re-resolves (ADR 3 D8/D16.1).
 */

import type { AgentIdentityId, DelegationRef, UserId } from '../planes/principal'

/**
 * What an agent was SPAWNED FOR — readiness §3.1.3 A2: the human is a CEILING,
 * not the default grant. A task agent's default scope is its session, its issue
 * and that issue's subtree.
 */
export interface SpawnedForScope {
  readonly kind: 'spawned-for'
  readonly sessionId?: string
  readonly issueId?: string
  /** The issue subtree the agent may reach; widening stays explicit (D16.3). */
  readonly subtreeRootId?: string
}

/**
 * THE ONE EXCEPTION, and it has to say so. A superagent (readiness §3.1.6 S1)
 * and a scheduled automation (S6) are spawned for a PERSON, not for a task, so
 * their scope is everything their human can see. Modelled as its own tagged
 * member with a REQUIRED justification rather than as a wide `spawned-for`
 * scope, so "broad scope" can never be reached by leaving fields off — every
 * broad delegation names why it is one.
 */
export interface HumanCeilingScope {
  readonly kind: 'everything-human-can-see'
  readonly justification: 'superagent' | 'scheduled-automation'
}

export type DelegationScope = SpawnedForScope | HumanCeilingScope

export const isBroadDelegation = (scope: DelegationScope): scope is HumanCeilingScope =>
  scope.kind === 'everything-human-can-see'

/**
 * One link of the chain. A sub-agent's `delegatedBy` is its PARENT AGENT; only
 * the root link names the human (D16.2).
 */
export interface DelegationLink {
  readonly ref: DelegationRef
  readonly agentIdentity: AgentIdentityId
  readonly scope: DelegationScope
  /** The parent agent's delegation, or `null` at the root of the chain. */
  readonly delegatedBy: DelegationRef | null
  /** Set ONLY on the root link: the one human the whole chain hangs from. */
  readonly rootUser: UserId | null
  /** A revoked link collapses everything below it (D16.2). */
  readonly revoked: boolean
}

/**
 * The live directory the strategy consults. Implemented by the server against
 * `SessionBinding` (POD-323), which owns the agent principal's LIFECYCLE — this
 * package must not invent a parallel identity system, alias table or history
 * (readiness §3.1.3 A5).
 */
export interface DelegationDirectory {
  /** `null` for unknown, expired or deleted references — indistinguishably. */
  linkOf(ref: DelegationRef): DelegationLink | null
  /** Is this human's account currently able to act at all? Fails closed. */
  userIsActive(user: UserId): boolean
}

export type ChainResolution =
  | {
      readonly ok: true
      /** Root-to-leaf, so a reader sees the human first. */
      readonly chain: readonly DelegationLink[]
      readonly leaf: DelegationLink
      readonly onBehalfOf: UserId
    }
  | { readonly ok: false; readonly reason: ChainFailure }

export type ChainFailure =
  | 'unknown-delegation'
  | 'revoked-delegation'
  | 'no-human-at-root'
  | 'multiple-humans'
  | 'cycle'
  | 'chain-too-long'
  | 'user-inactive'
  | 'widening-delegation'

/**
 * D16.3, as a predicate: "a sub-agent delegates from its parent agent, NEVER
 * widening". Broadening from a task scope to the human ceiling is the sharp case
 * — that is how a task agent would silently acquire everything its human can
 * see — and a subtree that escapes its parent's subtree is the other.
 *
 * Deliberately conservative: anything this function cannot prove narrow is
 * treated as widening. A parent that declares a subtree bounds every child.
 */
export const delegationWidens = (parent: DelegationScope, child: DelegationScope): boolean => {
  if (isBroadDelegation(child)) {
    // Only a chain that is ALREADY at the human ceiling may stay there. A
    // superagent's own sub-agents inherit the ceiling; a task agent's do not.
    return !isBroadDelegation(parent)
  }
  if (isBroadDelegation(parent)) return false
  if (parent.subtreeRootId === undefined) return false
  return child.subtreeRootId !== parent.subtreeRootId
}

/** A depth bound so a corrupted `delegatedBy` cycle cannot hang a handshake. */
export const MAX_DELEGATION_DEPTH = 16

/**
 * Resolve leaf → root. FAILS CLOSED on every ambiguity: an unknown or revoked
 * link anywhere, a chain with no human at its root, a chain where a non-root
 * link also names a human (that would give the chain two humans' authority and
 * make revoking the parent insufficient — D16's rejected alternative), a cycle,
 * or a human whose account is not active.
 */
export const resolveDelegationChain = (
  ref: DelegationRef,
  directory: DelegationDirectory,
): ChainResolution => {
  const chain: DelegationLink[] = []
  const seen = new Set<string>()
  let cursor: DelegationRef | null = ref
  while (cursor !== null) {
    if (seen.has(cursor)) return { ok: false, reason: 'cycle' }
    seen.add(cursor)
    if (chain.length >= MAX_DELEGATION_DEPTH) return { ok: false, reason: 'chain-too-long' }
    const link = directory.linkOf(cursor)
    if (link === null) return { ok: false, reason: 'unknown-delegation' }
    if (link.revoked) return { ok: false, reason: 'revoked-delegation' }
    chain.push(link)
    // A human may appear ONLY at the root — the link with no parent.
    if (link.rootUser !== null && link.delegatedBy !== null)
      return { ok: false, reason: 'multiple-humans' }
    cursor = link.delegatedBy
  }
  // Root-to-leaf, so each step compares a child against its own parent.
  for (let i = chain.length - 1; i > 0; i -= 1) {
    const parent = chain[i]
    const child = chain[i - 1]
    if (parent && child && delegationWidens(parent.scope, child.scope))
      return { ok: false, reason: 'widening-delegation' }
  }
  const root = chain[chain.length - 1]
  const leaf = chain[0]
  if (!root || !leaf || root.rootUser === null) return { ok: false, reason: 'no-human-at-root' }
  if (!directory.userIsActive(root.rootUser)) return { ok: false, reason: 'user-inactive' }
  return {
    ok: true,
    chain: [...chain].reverse(),
    leaf,
    onBehalfOf: root.rootUser,
  }
}
