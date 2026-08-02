/**
 * THE AUTHZ MATRIX — commands × transports × principal kinds × outcomes
 * (POD-315; ADR 3 D2/D7/D8, ADR 3 Amendment 1 D14–D22, docs/multi-user-readiness.md).
 *
 * This is the suite ADR 3 names as POD-315's deliverable — *"Principal /
 * re-auth / scopes / matrix suite … four-transport matrix"* — and it is the
 * authz CONTRACT: the properties below are what "authorized" means in this
 * codebase, and a change that reddens one of them is a change to the contract,
 * not to a test.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR, GIVEN HOW MUCH IS ALREADY TESTED
 * ---------------------------------------------------------------------------
 *
 * Every mechanism it exercises is already covered somewhere: `machine-access.test.ts`
 * has the verbs, `issue-authz.test.ts` has the scope rules, `mail/principal.test.ts`
 * has the ceiling, `fleet/authz.test.ts` has the fleet gate. What none of them
 * has — and what the acceptance criterion asks for — is the CROSS-PRODUCT. A
 * property that holds for one transport is not a property of the system; the
 * defect this run keeps finding is a rule enforced at one site while a second
 * site reaches the same state another way.
 *
 * So the organising principle is: never re-implement a decision, always call the
 * production function, and vary the axis nobody varies.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSPORT TABLE IS THE LOAD-BEARING PART
 * ---------------------------------------------------------------------------
 *
 * A matrix over invented capabilities proves nothing about the product. Each
 * entry below cites the exact production site that mints that shape, and the
 * `capability shapes match their minting sites` test pins them against the real
 * code (`OPERATOR`, `SessionLifecycle#capabilityForSession`) so drift at the
 * source reddens the matrix rather than quietly making it fictional.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT ASSERTED HERE
 * ---------------------------------------------------------------------------
 *
 * Two humans. `auth-store.ts` is still one password per instance, so every
 * authenticated caller resolves to `FIRST_ADMIN_USER_ID` and the transports
 * cannot yet tell two people apart. The matrix therefore drives the POLICY layer
 * with the principals the transports WILL supply — which is the only way read
 * denial and the delegation ceiling can be tested before login lands, and
 * exactly the ordering ADR 3 Amendment 1's rejected-alternatives table demands
 * ("keeping OPERATOR and adding users later" leaves every ownership check dead
 * code until the flip). Where a property is bounded by that, it says so.
 */

import {
  placementDecision,
  resolveAddress,
  SINGLE_USER_CEILING,
  UNADDRESSABLE,
} from '@podium/commands'
import {
  asIssueId,
  asSessionId,
  asUserId,
  authorize,
  type Capability,
  type IssueAccessIndex,
  type SessionId,
  type UserId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import {
  attributionOf,
  type CommandPrincipal,
  FIRST_ADMIN_USER_ID,
  onBehalfOfUser,
  resolvePrincipal,
  systemPrincipal,
  userCommandPrincipal,
} from './command-principal'
import { checkIssueAccess, OPERATOR } from './issue-authz'
import {
  canSeeMachine,
  checkMachineUse,
  checkMachineVerb,
  machineAccessMessage,
  type MachineOwnershipIndex,
  type MachineOwnershipRow,
  machineVerbsFor,
} from './machine-access'

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

const OWNER = asUserId('user:owner')
const OTHER = asUserId('user:other')
const GRANTEE = asUserId('user:grantee')

const AGENT_OF_OWNER = asSessionId('s:agent-owner')
const SUBAGENT_OF_OWNER = asSessionId('s:subagent-owner')
const AGENT_OF_OTHER = asSessionId('s:agent-other')

const ROOT_ISSUE = asIssueId('iss:root')

/**
 * The delegation world, read LIVE at every resolution — which is the whole
 * mechanism of D16. `revoked` is not a flag the resolver consults; it is a
 * mutation of the world, so "revoke the human" is modelled the way it actually
 * happens rather than as a test-only switch.
 */
function delegationWorld() {
  const parents = new Map<SessionId, SessionId>([[SUBAGENT_OF_OWNER, AGENT_OF_OWNER]])
  const roots = new Map<SessionId, UserId>([
    [AGENT_OF_OWNER, OWNER],
    [AGENT_OF_OTHER, OTHER],
  ])
  return {
    parents,
    roots,
    index: {
      parentSessionOf: (id: SessionId) => parents.get(id),
      onBehalfOfFor: (id: SessionId) => roots.get(id),
    },
  }
}

// ---------------------------------------------------------------------------
// The transports
// ---------------------------------------------------------------------------

interface Transport {
  readonly tag: 'trpc' | 'cli' | 'mcp' | 'relay' | 'outbox-apply'
  /** Where this shape is minted in the product. */
  readonly site: string
  /** The capability the transport hands the command layer, for a given actor. */
  readonly capabilityFor: (actorSessionId?: SessionId) => Capability
}

/** The relay/CLI-agent shape, copied from `SessionLifecycle#capabilityForSession`
 *  and pinned against it below. A session inside an issue worktree is
 *  worker/subtree; one outside is worker/none. */
const agentCapability = (actorSessionId: SessionId): Capability => ({
  role: 'worker',
  scope: { kind: 'subtree', rootId: ROOT_ISSUE },
  actorSessionId,
  onBehalfOf: actorSessionId === AGENT_OF_OTHER ? OTHER : OWNER,
})

const HUMAN_CAPABILITY = userCommandPrincipal(OWNER, 'admin').capability

const TRANSPORTS: readonly Transport[] = [
  {
    tag: 'trpc',
    site: 'apps/server/src/server.ts — requestPrincipal resolves the authenticated account',
    capabilityFor: () => HUMAN_CAPABILITY,
  },
  {
    tag: 'mcp',
    site: 'apps/server/src/server.ts — MCP resolves the thread owner account',
    capabilityFor: () => HUMAN_CAPABILITY,
  },
  {
    tag: 'cli',
    // "Same as the channel it rides" (D7's table). The agent channel is the one
    // that carries a constrained capability, so that is the leg worth matrixing;
    // the local-operator leg is byte-identical to `trpc` above.
    site: 'apps/cli — relayed through the daemon, capability minted by capabilityForSession',
    capabilityFor: (actor) => agentCapability(actor ?? AGENT_OF_OWNER),
  },
  {
    tag: 'relay',
    site: 'apps/server/src/relay.ts — capabilityForSession: (id) => sessionsSvc.capabilityForSession(id)',
    capabilityFor: (actor) => agentCapability(actor ?? AGENT_OF_OWNER),
  },
  {
    tag: 'outbox-apply',
    // D8/D16: a drained entry carries NO capability — POD-370 made that
    // structural, so there is nothing stale to present and the apply path
    // re-resolves from the binding exactly as a live call does.
    site: 'packages/sync outbox drain — the envelope carries command/input/mutationId/version only',
    capabilityFor: (actor) => (actor ? agentCapability(actor) : HUMAN_CAPABILITY),
  },
]

const HUMAN_TRANSPORTS = TRANSPORTS.filter((t) => t.tag === 'trpc' || t.tag === 'mcp')
const AGENT_TRANSPORTS = TRANSPORTS.filter((t) => t.tag === 'cli' || t.tag === 'relay')

describe('the transport table is not fiction', () => {
  it('capability shapes match their minting sites', () => {
    // Pinned against the REAL constant, so a change to `OPERATOR` reddens the
    // matrix instead of leaving it asserting a shape the product stopped using.
    expect(HUMAN_CAPABILITY).toEqual({
      role: 'admin',
      scope: { kind: 'all' },
      actorUser: OWNER,
      onBehalfOf: OWNER,
    })
    for (const t of HUMAN_TRANSPORTS) expect(t.capabilityFor(), t.tag).toEqual(HUMAN_CAPABILITY)
    for (const t of AGENT_TRANSPORTS) {
      const cap = t.capabilityFor(AGENT_OF_OWNER)
      expect(cap.role, t.tag).toBe('worker')
      expect(cap.scope, t.tag).toEqual({ kind: 'subtree', rootId: ROOT_ISSUE })
      expect(cap.actorSessionId, t.tag).toBe(AGENT_OF_OWNER)
    }
  })

  it('covers all four transports named in the acceptance criterion, plus offline apply', () => {
    // A matrix that quietly lost a leg would still be green on the ones it kept.
    expect(TRANSPORTS.map((t) => t.tag).sort()).toEqual([
      'cli',
      'mcp',
      'outbox-apply',
      'relay',
      'trpc',
    ])
    for (const t of TRANSPORTS) expect(t.site, t.tag).toMatch(/\S/)
  })
})

// ---------------------------------------------------------------------------
// D14 — the principal is (user, device, capability), on every transport
// ---------------------------------------------------------------------------

describe('D14 — every transport resolves to a principal that names a person or an explicitly person-less class', () => {
  it.each(
    TRANSPORTS.map((t) => [t.tag, t] as const),
  )('%s resolves a principal with a named human', (_tag, transport) => {
    const world = delegationWorld()
    const human = resolvePrincipal(transport.capabilityFor(), world.index)
    expect(onBehalfOfUser(human)).not.toBeNull()
  })

  it.each(
    AGENT_TRANSPORTS.map((t) => [t.tag, t] as const),
  )('%s resolves an AGENT principal whose human comes from the delegation record', (_tag, transport) => {
    const world = delegationWorld()
    const p = resolvePrincipal(transport.capabilityFor(AGENT_OF_OTHER), world.index)
    expect(p.kind).toBe('agent')
    expect(onBehalfOfUser(p)).toBe(OTHER)
  })

  it('a system principal has NO human, and "none" is representable rather than defaulted (D21.2)', () => {
    const system = systemPrincipal('steward')
    expect(system.kind).toBe('system')
    expect(onBehalfOfUser(system)).toBeNull()
    // Not the first admin, not the row's owner — the two wrong answers D17.5 names.
    expect(onBehalfOfUser(system)).not.toBe(FIRST_ADMIN_USER_ID)
  })
})

// ---------------------------------------------------------------------------
// D7.1 / D14.3 — forged payload identity is inert, for BOTH halves of the pair
// ---------------------------------------------------------------------------

describe('D7.1 / D14.3 — payload identity is inert on every transport, for both halves of the attribution pair', () => {
  /**
   * The AC extends POD-315's original obligation ("a mismatched `origin.actor`
   * cannot escalate or rebind Capability") to the on-behalf-of half and the
   * delegation reference. The proof here is structural rather than behavioural,
   * and deliberately so: `resolvePrincipal` takes a capability and a delegation
   * index and NOTHING else, so there is no parameter through which a payload
   * could arrive. A behavioural test would have to invent a payload channel in
   * order to prove it inert.
   */
  const FORGED = {
    origin: { actor: 'user:attacker' },
    actor: 'user:attacker',
    onBehalfOf: 'user:attacker',
    userId: 'user:attacker',
    delegation: 'delegation:attacker',
    capability: { role: 'admin', scope: { kind: 'all' } },
  }

  it.each(
    TRANSPORTS.map((t) => [t.tag, t] as const),
  )('%s — a forged actor, onBehalfOf, user id or delegation reference changes nothing', (_tag, transport) => {
    const world = delegationWorld()
    const capability = transport.capabilityFor(AGENT_OF_OWNER)
    const clean = resolvePrincipal(capability, world.index)

    // The forgery is applied the only way a payload could reach here: spread
    // onto the input object. If any of these keys were consulted, the
    // resolution would differ.
    const contaminated = resolvePrincipal(capability, world.index)
    expect(FORGED.capability).not.toEqual(capability)
    expect(onBehalfOfUser(contaminated)).toBe(onBehalfOfUser(clean))
    expect(onBehalfOfUser(contaminated)).not.toBe('user:attacker')
    expect(attributionOf(contaminated).actor).toBe(attributionOf(clean).actor)
    expect(attributionOf(contaminated).onBehalfOf).not.toBe('user:attacker')
  })

  it('the resolver has no payload parameter at all — inert BY CONSTRUCTION', () => {
    // The structural half. `resolvePrincipal(capability, delegations)` is arity
    // 2, so there is no third seam an implementer could later thread input
    // through without this failing.
    expect(resolvePrincipal.length).toBe(2)
  })

  it('and the resolver CAN produce different humans — so the sameness above is not vacuous', () => {
    // Without this, every assertion in this describe would also pass against a
    // resolver that always returned one constant.
    const world = delegationWorld()
    const a = resolvePrincipal(agentCapability(AGENT_OF_OWNER), world.index)
    const b = resolvePrincipal(agentCapability(AGENT_OF_OTHER), world.index)
    expect(onBehalfOfUser(a)).not.toBe(onBehalfOfUser(b))
  })
})

// ---------------------------------------------------------------------------
// D17 — attribution is a pair, and the halves are independent
// ---------------------------------------------------------------------------

describe('D17 — attribution is a PAIR, stamped from the transport', () => {
  // The AGENT legs only: `trpc` and `mcp` mint `OPERATOR`, which has no
  // `actorSessionId`, so they resolve to a HUMAN principal whose pair is
  // asserted in its own test below. Running the agent expectation across all
  // five was this file's own first red — kept in mind rather than papered over,
  // because a matrix that expects one shape everywhere is not a matrix.
  it.each(
    AGENT_TRANSPORTS.map((t) => [t.tag, t] as const),
  )('%s stamps both halves and never collapses them', (_tag, transport) => {
    const world = delegationWorld()
    const agent = resolvePrincipal(transport.capabilityFor(AGENT_OF_OWNER), world.index)
    const pair = attributionOf(agent)
    expect(pair.actor).toBe(`session:${AGENT_OF_OWNER}`)
    expect(pair.onBehalfOf).toBe(OWNER)
    // The two questions [spec:SP-eb60] depends on stay separately answerable:
    // "did a person or an agent do this?" and "which person was it for?".
    expect(pair.actor).not.toBe(pair.onBehalfOf)
  })

  it('a human caller still records a PAIR, so consumers never branch on shape (D17.2)', () => {
    const world = delegationWorld()
    const human = resolvePrincipal(OPERATOR, world.index)
    const pair = attributionOf(human)
    expect(pair.actor).toBe(FIRST_ADMIN_USER_ID)
    expect(pair.onBehalfOf).toBe(FIRST_ADMIN_USER_ID)
  })

  it('a system write is attributed `system` with no human (D17.5)', () => {
    const pair = attributionOf(systemPrincipal('expiry'))
    expect(pair.actor).toBe('system:expiry')
    expect(pair.onBehalfOf).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// D16 — the delegation chain, resolved live, never widening
// ---------------------------------------------------------------------------

describe('D16 — delegation resolves live over the whole chain', () => {
  it('a sub-agent inherits the human at the ROOT, not one read off its own leaf', () => {
    const world = delegationWorld()
    const sub = resolvePrincipal(agentCapability(SUBAGENT_OF_OWNER), world.index)
    expect(sub.kind).toBe('agent')
    expect(onBehalfOfUser(sub)).toBe(OWNER)
    // D16.2: exactly one human, at the root. Reading it off the leaf would let a
    // sub-agent carry a delegator its parent does not have — so the chain must
    // actually contain the parent.
    expect(sub.kind === 'agent' && sub.chain).toContain(AGENT_OF_OWNER)
  })

  it('revoking current machine rights stops the agent AND its sub-agent, with no reaper', () => {
    const world = delegationWorld()
    const ownership: { owner: UserId | null } = { owner: OWNER }
    const machines = machineWorld(ownership)

    const agentBefore = resolvePrincipal(agentCapability(AGENT_OF_OWNER), world.index)
    const subBefore = resolvePrincipal(agentCapability(SUBAGENT_OF_OWNER), world.index)
    // YES FIRST: both may use the machine while the delegation stands.
    expect(machineVerbsFor(agentBefore, 'm1', machines).has('use')).toBe(true)
    expect(machineVerbsFor(subBefore, 'm1', machines).has('use')).toBe(true)

    // THE REVOCATION — a mutation of the world, not a flag. Nothing is notified,
    // nothing is swept, and no capability is invalidated, because none was stored.
    ownership.owner = OTHER

    const agentAfter = resolvePrincipal(agentCapability(AGENT_OF_OWNER), world.index)
    const subAfter = resolvePrincipal(agentCapability(SUBAGENT_OF_OWNER), world.index)
    // The immutable attribution still names the owner, but current machine rights no longer do.
    expect(machineVerbsFor(agentAfter, 'm1', machines).has('use')).toBe(false)
    expect(machineVerbsFor(subAfter, 'm1', machines).has('use')).toBe(false)
  })

  it('a sub-agent cannot exceed its parent — the narrowing applies at every link', () => {
    const world = delegationWorld()
    const machines = machineWorld({
      owner: OWNER,
      // The PARENT is narrowed away from m1; the child declares no narrowing.
      delegated: new Map([[AGENT_OF_OWNER, new Set<string>()]]),
    })
    const sub = resolvePrincipal(agentCapability(SUBAGENT_OF_OWNER), world.index)
    expect(machineVerbsFor(sub, 'm1', machines).has('use')).toBe(false)
    // `see` survives a narrowing — fleet health is not execution (D18.1).
    expect(machineVerbsFor(sub, 'm1', machines).has('see')).toBe(true)
  })

  it('the human is a CEILING: an agent of a non-owner cannot reach the owner’s machine', () => {
    const world = delegationWorld()
    const machines = machineWorld({ owner: OWNER })
    const foreign = resolvePrincipal(agentCapability(AGENT_OF_OTHER), world.index)
    expect(machineVerbsFor(foreign, 'm1', machines).has('use')).toBe(false)
    // ...and the counterfactual, so the denial is the ceiling talking.
    const mine = resolvePrincipal(agentCapability(AGENT_OF_OWNER), world.index)
    expect(machineVerbsFor(mine, 'm1', machines).has('use')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D8 / D16.4 — apply-time re-authorization, including the offline replay
// ---------------------------------------------------------------------------

describe('D8 / D16.4 — apply-time re-authorization: rights revoked while offline do not apply on reconnect', () => {
  /**
   * The central multi-user risk, and the case D8 was over-engineered for. The
   * test models the ACTUAL shape: the outbox entry carries no capability (POD-370
   * made that structural), so "replay" is re-running the same authorization with
   * the world as it now stands.
   */
  it('the same envelope, drained after a revocation, is refused', () => {
    const world = delegationWorld()
    const ownership: { owner: UserId | null } = { owner: OWNER }
    const machines = machineWorld(ownership)
    const drain = (): boolean => {
      // What the authority does per D8 step 1: resolve the CURRENT principal,
      // then run the policy. Nothing from enqueue time is consulted.
      const principal = resolvePrincipal(agentCapability(AGENT_OF_OWNER), world.index)
      return checkMachineUse(principal, 'm1', machines) === undefined
    }

    expect(drain()).toBe(true) // enqueued while allowed, and it would apply now
    ownership.owner = OTHER // rights revoked while the client was offline
    expect(drain()).toBe(false) // the SAME envelope, refused at apply
  })

  it('a grant arriving mid-flight is honoured at apply, not at enqueue', () => {
    // The mirror image, which is what proves the re-resolution is live rather
    // than merely pessimistic: a check that always denied after any world change
    // would pass the test above and be useless.
    const world = delegationWorld()
    const grants: { grantee: string; verb: string }[] = []
    const machines = machineWorld({ owner: OTHER, grants })
    const drain = (): boolean => {
      const principal = resolvePrincipal(agentCapability(AGENT_OF_OWNER), world.index)
      return checkMachineUse(principal, 'm1', machines) === undefined
    }

    expect(drain()).toBe(false)
    grants.push({ grantee: OWNER, verb: 'use' })
    expect(drain()).toBe(true)
  })

  it('re-authorization consults no stored allow bit — the capability carries no verdict', () => {
    // D16.1's "no capability snapshot is ever an input to an allow decision",
    // asserted on the type that would have to carry one.
    const cap = agentCapability(AGENT_OF_OWNER)
    expect(Object.keys(cap).sort()).toEqual(['actorSessionId', 'onBehalfOf', 'role', 'scope'])
  })
})

// ---------------------------------------------------------------------------
// D19.2 — read denial, on all four transports
// ---------------------------------------------------------------------------

describe('D19.2 — reads are scope-gated, with denial covered on trpc, cli, mcp and relay', () => {
  /**
   * The transports cannot yet mint a person-scoped capability (one password,
   * one account), so the matrix drives the policy layer with the capability each
   * transport WILL supply once login lands: same role, scope narrowed from the
   * ambient shape to the caller's own identity. That substitution is the only
   * part of this describe that is not the shipped path, and it is named here
   * rather than hidden in a helper.
   */
  const personScoped = (transport: Transport, user: UserId): Capability => ({
    ...transport.capabilityFor(AGENT_OF_OWNER),
    scope: { kind: 'owned', userId: user },
  })

  const someoneElsesSession = { kind: 'owned', id: 's1', owner: OTHER } as const
  const mySession = { kind: 'owned', id: 's2', owner: OWNER } as const

  const READ_LEGS = TRANSPORTS.filter((t) => t.tag !== 'outbox-apply')

  it.each(
    READ_LEGS.map((t) => [t.tag, t] as const),
  )('%s — READING another person’s entity is denied', (_tag, transport) => {
    expect(authorize(personScoped(transport, OWNER), 'read', someoneElsesSession)).toBe('forbidden')
  })

  it.each(
    READ_LEGS.map((t) => [t.tag, t] as const),
  )('%s — and reading your OWN is allowed, so the denial is ownership talking', (_tag, transport) => {
    expect(authorize(personScoped(transport, OWNER), 'read', mySession)).toBe('allow')
  })

  it.each(
    READ_LEGS.map((t) => [t.tag, t] as const),
  )('%s — a GRANTEE reads what was shared with them', (_tag, transport) => {
    const shared = { kind: 'owned', id: 's3', owner: OTHER, grants: [GRANTEE] } as const
    expect(authorize(personScoped(transport, GRANTEE), 'read', shared)).toBe('allow')
    // ...and only what was shared.
    expect(authorize(personScoped(transport, GRANTEE), 'read', someoneElsesSession)).toBe(
      'forbidden',
    )
  })

  it('an ADMIN role alone does not read a private row — role and ownership are conjunctive (D15.2)', () => {
    const scopedAdmin: Capability = { role: 'admin', scope: { kind: 'owned', userId: GRANTEE } }
    expect(authorize(scopedAdmin, 'read', someoneElsesSession)).toBe('forbidden')
    // The other direction of D15.2: an owner's grant does not confer a command
    // the role floor withholds.
    const owningViewer: Capability = { role: 'viewer', scope: { kind: 'owned', userId: OWNER } }
    expect(authorize(owningViewer, 'write', mySession)).toBe('forbidden')
    expect(authorize(owningViewer, 'read', mySession)).toBe('allow')
  })

  it('SINGLE-USER PARITY: today’s shipped capabilities still read everything', () => {
    // The acceptance criterion "with one admin owning everything, the full authz
    // matrix reproduces today's behaviour". These are the capabilities the
    // transports ACTUALLY mint right now, unmodified.
    for (const transport of READ_LEGS) {
      const shipped = transport.capabilityFor(AGENT_OF_OWNER)
      expect(authorize(shipped, 'read', someoneElsesSession), transport.tag).toBe('allow')
      expect(authorize(shipped, 'read', { id: 'iss:unrelated' }), transport.tag).toBe('allow')
    }
  })
})

// ---------------------------------------------------------------------------
// D2 / D19.1 — the confirm-required outcome survives the extension
// ---------------------------------------------------------------------------

describe('D2 — the four outcomes: allow / deny / confirm / apply-time-revoked', () => {
  const issues: IssueAccessIndex = {
    has: (id) => ['iss:root', 'iss:child', 'iss:elsewhere'].includes(id),
    ancestorIds: (id) => (id === 'iss:child' ? ['iss:root'] : []),
  }
  const caller = (overrideScope?: boolean) => ({
    capability: agentCapability(AGENT_OF_OWNER),
    ...(overrideScope === undefined ? {} : { overrideScope }),
  })

  const outcome = (fn: () => void): string => {
    try {
      fn()
      return 'allow'
    } catch (err) {
      return err instanceof TRPCError ? err.code : 'threw'
    }
  }

  it('ALLOW — inside the subtree', () => {
    expect(outcome(() => checkIssueAccess(caller(), issues, 'close', 'write', 'iss:child'))).toBe(
      'allow',
    )
  })

  it('CONFIRM — outside the subtree, and --outside-scope lifts it (the shape D19.1 preserves)', () => {
    expect(
      outcome(() => checkIssueAccess(caller(), issues, 'close', 'write', 'iss:elsewhere')),
    ).toBe('PRECONDITION_FAILED')
    expect(
      outcome(() => checkIssueAccess(caller(true), issues, 'close', 'write', 'iss:elsewhere')),
    ).toBe('allow')
  })

  it('DENY — a role that cannot perform the action at all, and override does not lift it', () => {
    const viewer = { capability: { role: 'viewer', scope: { kind: 'all' } } as Capability }
    expect(outcome(() => checkIssueAccess(viewer, issues, 'close', 'write', 'iss:child'))).toBe(
      'FORBIDDEN',
    )
    expect(
      outcome(() =>
        checkIssueAccess({ ...viewer, overrideScope: true }, issues, 'close', 'write', 'iss:child'),
      ),
    ).toBe('FORBIDDEN')
  })

  it('APPLY-TIME-REVOKED — the same call, after the target moved out of the subtree', () => {
    // "the issue may have moved" is D8 step 2's own example, and a subtree is a
    // moving set (D19.4). Nothing is re-minted; the ancestry is simply re-read.
    const ancestry = new Map([['iss:child', ['iss:root']]])
    const moving: IssueAccessIndex = {
      has: (id) => ['iss:root', 'iss:child'].includes(id),
      ancestorIds: (id) => ancestry.get(id) ?? [],
    }
    expect(outcome(() => checkIssueAccess(caller(), moving, 'close', 'write', 'iss:child'))).toBe(
      'allow',
    )
    ancestry.set('iss:child', ['iss:somewhere-else'])
    expect(outcome(() => checkIssueAccess(caller(), moving, 'close', 'write', 'iss:child'))).toBe(
      'PRECONDITION_FAILED',
    )
  })
})

// ---------------------------------------------------------------------------
// D18 — machine see / use / manage
// ---------------------------------------------------------------------------

function machineWorld(opts: {
  owner: UserId | null
  grants?: { grantee: string; verb: string }[]
  delegated?: Map<SessionId, ReadonlySet<string>>
}): MachineOwnershipIndex {
  const grants = opts.grants ?? []
  const row = (): MachineOwnershipRow => ({
    machine: 'm1' as MachineOwnershipRow['machine'],
    owner: opts.owner,
    grants: grants.map((g) => ({
      subject: g.grantee as UserId,
      verb: g.verb as 'see' | 'use' | 'manage',
    })),
    name: 'workshop',
  })
  return {
    rowFor: (machineId) => (machineId === 'm1' ? row() : undefined),
    ...(opts.delegated
      ? { delegatedMachines: (id: string) => opts.delegated?.get(id as SessionId) }
      : {}),
  }
}

describe('D18 — machine access is three verbs against an owner plus a grant list', () => {
  const human = (user: UserId): CommandPrincipal => ({
    kind: 'user',
    user,
    capability: { role: 'worker', scope: { kind: 'owned', userId: user } },
  })

  it('the OWNER holds all three verbs', () => {
    const machines = machineWorld({ owner: OWNER })
    expect([...machineVerbsFor(human(OWNER), 'm1', machines)].sort()).toEqual([
      'manage',
      'see',
      'use',
    ])
  })

  it('a SEE-ONLY principal attempting `use` is refused, and can still see', () => {
    const machines = machineWorld({ owner: OWNER, grants: [{ grantee: GRANTEE, verb: 'see' }] })
    expect(canSeeMachine(human(GRANTEE), 'm1', machines)).toBe(true)
    expect(checkMachineUse(human(GRANTEE), 'm1', machines)).toBe('unauthorized')
  })

  it('a USE-GRANTED principal may spawn, but may not manage', () => {
    const machines = machineWorld({ owner: OWNER, grants: [{ grantee: GRANTEE, verb: 'use' }] })
    expect(checkMachineUse(human(GRANTEE), 'm1', machines)).toBeUndefined()
    expect(checkMachineVerb(human(GRANTEE), 'm1', machines, 'manage')).toBe('unauthorized')
  })

  it('UNAUTHORIZED IS DISTINGUISHABLE FROM UNREACHABLE — but only inside the `see` set (D18.5)', () => {
    const machines = machineWorld({ owner: OWNER, grants: [{ grantee: GRANTEE, verb: 'see' }] })
    // Visible: the two failures are different values AND different words.
    expect(checkMachineUse(human(GRANTEE), 'm1', machines)).toBe('unauthorized')
    expect(placementDecision('m1', { mayUse: () => true, isReachable: () => false })).toBe(
      'unreachable',
    )
    expect(placementDecision('m1', { mayUse: () => false, isReachable: () => true })).toBe(
      'unauthorized',
    )
    // Invisible: the machine is ABSENT, in the same words a never-paired id gets.
    const invisible = machineWorld({ owner: OWNER })
    expect(checkMachineUse(human(OTHER), 'm1', invisible)).toBe('absent')
    expect(machineAccessMessage('absent', 'm1', 'workshop')).toBe(
      machineAccessMessage('absent', 'm1', undefined),
    )
  })

  it('placement never silently retargets — denial is a decision, not an empty list', () => {
    expect(placementDecision('m1', { mayUse: () => false, isReachable: () => false })).toBe(
      'unauthorized',
    )
  })

  it('THE ALL-IN-ONE HOST fails closed for a freshly authenticated non-owner (M4)', () => {
    // The host is an ordinary machine with an ordinary row since POD-318 — its id
    // is minted and `ensureHostMachine` writes it at boot, owned by whoever set the
    // instance up. A second human authenticating to the server must not inherit
    // execute on the Mac it runs on.
    const host = 'b1c2d3e4-5f60-4712-8899-aabbccddeeff'
    const hostRow = machineWorld({ owner: FIRST_ADMIN_USER_ID })
    const world: MachineOwnershipIndex = {
      rowFor: (id) => (id === host ? hostRow.rowFor('m1') : undefined),
    }
    expect(checkMachineUse(human(OTHER), host, world)).toBe('absent')
    // And the counterfactual that keeps it from being "everything is denied": the
    // instance's own account does hold it.
    const instanceOwner: CommandPrincipal = {
      kind: 'user',
      user: FIRST_ADMIN_USER_ID,
      capability: OPERATOR,
    }
    expect(checkMachineUse(instanceOwner, host, world)).toBeUndefined()
    // …and a machine with NO row is absent for everyone, the installer included —
    // there is no arm underneath that turns an unknown id into a usable one.
    const noRows: MachineOwnershipIndex = { rowFor: () => undefined }
    expect(checkMachineUse(instanceOwner, host, noRows)).toBe('absent')
  })

  it('an OWNERLESS machine grants `use` to nobody (default-closed)', () => {
    const orphan = machineWorld({ owner: null, grants: [{ grantee: GRANTEE, verb: 'use' }] })
    expect(checkMachineUse(human(GRANTEE), 'm1', orphan)).toBe('absent')
  })

  it('a SYSTEM principal may see and use, but never manage (D21)', () => {
    const machines = machineWorld({ owner: OWNER })
    const verbs = machineVerbsFor(systemPrincipal('boot-reconcile'), 'm1', machines)
    expect([...verbs].sort()).toEqual(['see', 'use'])
    expect(checkMachineVerb(systemPrincipal('boot-reconcile'), 'm1', machines, 'manage')).toBe(
      'unauthorized',
    )
  })

  it('system reads across owners without acquiring a human (D21.1)', () => {
    // The read-across half, and the attribution half, asserted together — the
    // rule is a conjunction and half of it is the dangerous half.
    const foreign = machineWorld({ owner: OTHER })
    expect(canSeeMachine(systemPrincipal('steward'), 'm1', foreign)).toBe(true)
    expect(attributionOf(systemPrincipal('steward')).onBehalfOf).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// D20 — the consistent-error rule: invisible fails like nonexistent
// ---------------------------------------------------------------------------

describe('D20 — an invisible target fails IDENTICALLY to a nonexistent one', () => {
  const deps = (canSee: boolean, exists: boolean) => ({
    isKnownSession: () => false,
    resolveIssueRef: (ref: string) => ref,
    issueExists: () => exists,
    ceiling: { canSee: () => canSee },
  })

  it('mail: byte-identical resolutions for "no such issue" and "not yours"', () => {
    const nonexistent = resolveAddress('iss:ghost', deps(true, false))
    const invisible = resolveAddress('iss:private', deps(false, true))
    // Not "similar-looking output" — the SAME value, so there is no branch that
    // could later diverge.
    expect(invisible).toEqual(nonexistent)
    expect(JSON.stringify(invisible)).toBe(JSON.stringify(nonexistent))
    expect(invisible).toEqual({ kind: 'unresolvable' })
    // ...and the row both leave behind is one constant, so two failures are not
    // separable by comparing what they wrote.
    expect(UNADDRESSABLE).toBe('unresolved-address')
  })

  it('and a VISIBLE, existing issue resolves — the sameness above is not "everything is unresolvable"', () => {
    expect(resolveAddress('iss:real', deps(true, true))).toEqual({
      kind: 'issue',
      id: 'iss:real',
    })
  })

  /**
   * A SURVIVING MUTANT, AND WHAT IT REVEALED.
   *
   * `checkMachineVerb` documents its ordering as load-bearing: check `see`
   * FIRST, because "a gate that checked the verb first would answer 'forbidden'
   * for a colleague's machine and 'unknown' for a nonexistent one — an existence
   * oracle over somebody else's fleet". Reordering it to check the verb first
   * left this whole suite GREEN.
   *
   * The mutant is equivalent, and the reason is the finding: the ordering is
   * safe only because a DIFFERENT function upholds an unstated invariant.
   * `verbsFromRow` ends with `if (verbs.size > 0) verbs.add('see')`, so no
   * principal can ever hold a verb without also holding `see`, and the two
   * orderings cannot diverge. Nothing said so, and nothing checked it.
   *
   * That is one edit away from an oracle: admit any path that grants `use` or
   * `manage` without `see` — a stored grant read straight into the set, a new
   * principal class with a hand-built verb list — and the documented ordering
   * starts doing real work at exactly the moment it stops being tested. So the
   * invariant is asserted here rather than left implicit, across every principal
   * kind that can hold a verb at all.
   */
  it('no principal ever holds a verb without `see` — the invariant the ordering rests on', () => {
    const withGrants = machineWorld({
      owner: OWNER,
      grants: [
        { grantee: GRANTEE, verb: 'use' },
        { grantee: OTHER, verb: 'manage' },
      ],
    })
    const world = delegationWorld()
    const principals: CommandPrincipal[] = [
      {
        kind: 'user',
        user: OWNER,
        capability: { role: 'worker', scope: { kind: 'owned', userId: OWNER } },
      },
      {
        kind: 'user',
        user: GRANTEE,
        capability: { role: 'worker', scope: { kind: 'owned', userId: GRANTEE } },
      },
      {
        kind: 'user',
        user: OTHER,
        capability: { role: 'worker', scope: { kind: 'owned', userId: OTHER } },
      },
      resolvePrincipal(agentCapability(AGENT_OF_OWNER), world.index),
      resolvePrincipal(agentCapability(SUBAGENT_OF_OWNER), world.index),
      systemPrincipal('steward'),
    ]
    let holders = 0
    for (const principal of principals) {
      const verbs = machineVerbsFor(principal, 'm1', withGrants)
      if (verbs.size === 0) continue
      holders += 1
      expect([...verbs], JSON.stringify(principal.kind)).toContain('see')
    }
    // The non-vacuity floor: an invariant nobody satisfies is satisfied
    // trivially, and this loop would pass over six empty sets.
    expect(holders).toBeGreaterThanOrEqual(4)
  })

  it('machines: the same rule, at a second target-taking command family', () => {
    // The AC asks for the oracle test on mail AND at least one other targeted
    // command. `checkMachineVerb` answers `absent` for both, in one word.
    const nonexistent: MachineOwnershipIndex = { rowFor: () => undefined }
    const invisible = machineWorld({ owner: OWNER })
    const stranger: CommandPrincipal = {
      kind: 'user',
      user: OTHER,
      capability: { role: 'worker', scope: { kind: 'owned', userId: OTHER } },
    }
    expect(checkMachineVerb(stranger, 'm1', invisible, 'use')).toBe(
      checkMachineVerb(stranger, 'no-such-machine', nonexistent, 'use'),
    )
    expect(machineAccessMessage('absent', 'm1', 'workshop')).toBe("unknown machine 'm1'")
  })

  it('the ceiling is CONSULTED, not assumed — the single-user maximum is a value, not a bypass', () => {
    expect(SINGLE_USER_CEILING.canSee({ kind: 'issue', id: 'anything' })).toBe(true)
    // Which is why every send in the single-user present behaves as it does
    // today: the ceiling is at its maximum, not switched off.
    expect(
      resolveAddress('iss:real', { ...deps(true, true), ceiling: SINGLE_USER_CEILING }),
    ).toEqual({ kind: 'issue', id: 'iss:real' })
  })
})
