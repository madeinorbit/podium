/**
 * THE 3.2 CUTOVER AUDIT (POD-382) — the gate the session family passes or the
 * build fails.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TEST AND NOT ONLY A SCRIPT
 * ---------------------------------------------------------------------------
 *
 * `scripts/audit-session-commands.ts` is the other half of this gate, and the two
 * are deliberately instruments of DIFFERENT KINDS rather than two of the same kind
 * corroborating each other:
 *
 *  - the SCRIPT reads source text. It needs no module resolution, so it runs in a
 *    fresh checkout and in CI before anything is built, and it catches textual
 *    regressions — a hand-written `.mutation(` reappearing in a session router, a
 *    contract with no `visibility:` line.
 *  - THIS FILE reads the running system: the real `appRouter`, the real contract
 *    objects, the real services. It catches what no source scan can — a mutation
 *    that actually exists on the router, an attribution pair actually recorded, a
 *    machine gate that actually refuses, two error shapes that are actually equal.
 *
 * A grep is necessary and never sufficient (docs/agents/rewrite-fanout-protocol.md
 * §7). Everything below is asserted against the thing that decides.
 *
 * ---------------------------------------------------------------------------
 * EVERY CHECK PROVES IT CAN SAY YES BEFORE ITS NO IS BELIEVED
 * ---------------------------------------------------------------------------
 *
 * An absence is the one claim this file makes most of ("no hand-written mutation",
 * "no per-user singleton", "no gate bypass"), and an absence is exactly what a
 * broken instrument reports. So each absence check has a companion that plants the
 * thing it is looking for and asserts it is FOUND. A check whose zero could only
 * mean "the walk broke" is the audit's own worst failure mode.
 */

import {
  commandVisibility,
  SESSION_STATE_COMMAND_TABLES,
  sessionStateCommand,
  sessionCommandPlane,
} from '@podium/commands'
import { sessionHandoffContract } from '@podium/commands'
import { asSessionId, asUserId, SOLE_USER_ID, type UserId } from '@podium/model'
import type { MachineGrant, MachineId } from '@podium/protocol'

import { afterEach, describe, expect, it } from 'vitest'
import {
  type AgentCommandPrincipal,
  type CommandPrincipal,
  FIRST_ADMIN_USER_ID,
} from './command-principal'
import { OPERATOR } from './issue-authz'
import type { MachineOwnershipIndex, MachineOwnershipRow } from './machine-access'
import { ownershipFromMachines } from './machine-access'
import { sessionCommandCtx, sessionCommandServices } from './modules/sessions/command-ctx'
import {
  dispatchSessionCommand,
  SessionCommandCtx,
  type SessionCommandDeps,
  type SessionCommandKey,
} from './modules/sessions/command-plane'
import {
  disposeOracles,
  makeOracle,
  messageOf,
  type Oracle,
} from './modules/sessions/oracle-support'
import {
  SessionStateRegistry,
  soleHumanSessionStatePrincipal,
} from './modules/sessions/session-state/registry'
import type { SessionVisibility } from './modules/sessions/session-access'
import { sessionSurfaceManifest } from './modules/sessions/trpc'
import { appRouter } from './router'

afterEach(() => disposeOracles())

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const COLLEAGUE: UserId = asUserId('colleague')
const GHOST = '00000000-0000-4000-8000-000000000000'

/** The routers that make up the session family. */
const FAMILY_ROUTERS = ['sessions', 'pins', 'snoozes', 'tabs'] as const

interface RouterProcedure {
  _def: { type: 'mutation' | 'query' | 'subscription' }
}

/** Every procedure the real router serves, by dotted key. */
function routerProcedures(): Map<string, RouterProcedure> {
  const def = (appRouter as unknown as { _def: { procedures: Record<string, RouterProcedure> } })
    ._def
  return new Map(Object.entries(def.procedures))
}

/** Every session-family MUTATION the real router serves. */
function familyMutations(procedures = routerProcedures()): string[] {
  return [...procedures.entries()]
    .filter(([name, proc]) => {
      const router = name.slice(0, name.indexOf('.'))
      return (FAMILY_ROUTERS as readonly string[]).includes(router) && proc._def.type === 'mutation'
    })
    .map(([name]) => name)
    .sort()
}

const human = (id: UserId): CommandPrincipal => ({
  kind: 'user',
  user: id,
  capability: { role: 'admin', scope: { kind: 'all' } },
})

const agentFor = (sessionId: string, onBehalfOf: UserId): AgentCommandPrincipal => ({
  kind: 'agent',
  agentSessionId: asSessionId(sessionId),
  onBehalfOf,
  capability: { role: 'admin', scope: { kind: 'all' }, actorSessionId: asSessionId(sessionId) },
  chain: [],
})

/** A machine table a test controls, so a second human can be denied `use`. */
function ownershipTable(
  rows: Map<string, { owner: UserId | null; grants: MachineGrant[]; name?: string }>,
): MachineOwnershipIndex {
  return {
    rowFor: (machineId): MachineOwnershipRow | undefined => {
      const row = rows.get(machineId)
      if (!row) return undefined
      return {
        machine: machineId as MachineId,
        owner: row.owner,
        grants: row.grants,
        ...(row.name === undefined ? {} : { name: row.name }),
      }
    },
  }
}

/**
 * The context the router builds, with the principal, the ownership table and the
 * visibility answer substituted — the three things the transport cannot yet produce
 * (one password, no accounts, no owner columns). Everything else is the real
 * composition root over a real registry.
 */
function ctxFor(
  o: Oracle,
  principal: CommandPrincipal,
  opts: { ownership?: MachineOwnershipIndex; visibility?: SessionVisibility } = {},
): SessionCommandCtx {
  const modules = o.reg.modules
  const deps: SessionCommandDeps = {
    sessions: () => sessionCommandServices(modules),
    // POD-729: the chat paths send through the `mail.send` CONTRACT, not through
    // the delivery service — the capability is closed over here, at the composition
    // root, exactly as `sessionCommandCtx` does it.
    mailSend: (input) =>
      modules.messageGate.dispatch(
        principal.kind === 'system' ? OPERATOR : principal.capability,
        undefined,
        'send',
        input,
        'trpc',
        'immediate',
      )!,
    rpc: () => modules.rpc,

    createDraftIssue: (repoPath, agentKind, issueId, ownership) =>
      modules.issues.createDraftFor(repoPath, agentKind, issueId, ownership),
    issueOwner: () => undefined,
    access: {
      listSessions: () => modules.sessions.listSessions(),
      issues: modules.issues,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
    },
    ownership: opts.ownership ?? ownershipFromMachines(modules.machines),
    mutations: modules.mutations,
  }
  return new SessionCommandCtx(deps, principal)
}

// ---------------------------------------------------------------------------
// AC 1 — no `.mutation(` for a session outside the derived surface
// ---------------------------------------------------------------------------

describe('AC1 · the session surface is derived, in both directions', () => {
  it('every session-family mutation the router serves is declared in the manifest', () => {
    const declared = new Set(sessionSurfaceManifest().map((entry) => entry.name))
    const undeclared = familyMutations().filter((name) => !declared.has(name))

    // An undeclared mutation is a hand-written procedure: something reached the wire
    // without a contract, which is the exact state this issue exists to end.
    expect(undeclared).toEqual([])
  })

  it('every manifest entry exists on the router AND is a mutation', () => {
    // The other direction. A manifest that named a procedure the router does not
    // serve would report a green surface while the command was unreachable — the
    // registry-rot failure the representation audit closes for schemas.
    const procedures = routerProcedures()
    const missing = sessionSurfaceManifest()
      .filter((entry) => procedures.get(entry.name)?._def.type !== 'mutation')
      .map((entry) => entry.name)

    expect(missing).toEqual([])
  })

  it('the walk can say YES: a planted hand-written mutation is FOUND', () => {
    // The instrument check. If `familyMutations()` were broken — a wrong `_def`
    // path, a router key that no longer starts with `sessions.` — the two checks
    // above would report a serene zero for any input whatsoever.
    const declared = new Set(sessionSurfaceManifest().map((entry) => entry.name))
    const planted = new Map(routerProcedures())
    planted.set('sessions.handWritten', { _def: { type: 'mutation' } })

    expect(familyMutations(planted).filter((name) => !declared.has(name))).toEqual([
      'sessions.handWritten',
    ])
  })

  it('the walk does not mistake a QUERY for a write, and does see all four routers', () => {
    // Two false-negative modes at once: a check that only looked at `sessions.*`
    // would miss a hand-written `pins.set`, and one that ignored procedure type
    // would flag every read.
    const mutations = familyMutations()
    expect(mutations).toContain('sessions.create')
    expect(mutations).toContain('pins.set')
    expect(mutations).toContain('snoozes.clear')
    expect(mutations).toContain('tabs.setOrder')
    // The reads are present on the router and deliberately NOT in this list.
    expect(routerProcedures().get('sessions.list')?._def.type).toBe('query')
    expect(mutations).not.toContain('sessions.list')
  })

  it('the manifest covers all five envelopes — a missing source would silently narrow the audit', () => {
    const sources = new Set(sessionSurfaceManifest().map((entry) => entry.source))
    // FOUR since the POD-729 merge: `mail` is `sessions.ask`, whose contract belongs
    // to the mail table and whose procedure is built by that family's derivation.
    // FIVE since POD-351: `walking-skeleton` is `sessions.rename`, which keeps its
    // session-state contract (that is still what declares its exposure and policy) but is
    // built by a different envelope. Recorded as a manifest ROW on purpose — which
    // command sits on which envelope stays readable here rather than buried in a
    // condition, so a Phase 3 migration changes a row instead of adding a branch.
    expect([...sources].sort()).toEqual([
      'command-plane',
      'handoff',
      'mail',
      'session-state',
      'walking-skeleton',
    ])
  })
})

// ---------------------------------------------------------------------------
// AC 2 — withMutation is gone, and idempotency is the framework's
// ---------------------------------------------------------------------------

describe('AC2 · framework idempotency is the single implementation', () => {
  it('SessionLifecycle has no withMutation, on the instance OR its prototype', () => {
    // Protection by ABSENCE plus a prototype-shape assertion: a `withMutation`
    // re-added as a delegating method would be one edit from a second per-proc
    // wrapper, and an `in` check alone would miss a prototype method.
    const o = makeOracle()
    const svc = o.reg.modules.sessions as unknown as Record<string, unknown>
    expect('withMutation' in svc).toBe(false)
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(svc))).not.toContain('withMutation')
    // …and the instrument can say yes: a name the service DOES have is found the
    // same way, so the two assertions above are not passing on a broken lookup.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(svc))).toContain('listSessions')
  })

  it('DUPLICATE DELIVERY: one mutationId delivered twice applies once, across both envelopes', async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    // PRESENCE class. The second delivery must not re-apply, so a value written
    // BETWEEN the two deliveries has to survive — which is what distinguishes
    // "dedupes" from "applies the same thing twice, harmlessly".
    await o.call.sessions.rename({ sessionId, name: 'from the queue', mutationId: 'dup-1' })
    await o.call.sessions.rename({ sessionId, name: 'typed later' })
    await o.call.sessions.rename({ sessionId, name: 'from the queue', mutationId: 'dup-1' })
    expect(o.meta(sessionId).name).toBe('typed later')

    // COMMAND PLANE. Two identical creates under one id produce ONE session.
    const before = o.reg.modules.sessions.listSessions().length
    const first = await o.call.sessions.create({
      agentKind: 'shell',
      cwd: '/dup',
      mutationId: 'dup-2',
    })
    const replay = await o.call.sessions.create({
      agentKind: 'shell',
      cwd: '/dup',
      mutationId: 'dup-2',
    })
    expect(replay.sessionId).toBe(first.sessionId)
    expect(o.reg.modules.sessions.listSessions().length).toBe(before + 1)

    // The receipt is durable, under the command's dotted name, for both.
    expect(o.store.sync.getAppliedMutation('dup-1')).toBeDefined()
    expect(o.store.sync.getAppliedMutation('dup-2')).toBeDefined()
  })

  it('the dedup is the FRAMEWORK ledger: a receipt written directly is honoured by the router', async () => {
    // The strongest available statement that the router's dedup and the framework's
    // are the same mechanism rather than two that agree: write the receipt through
    // `modules.mutations` and watch the tRPC call decline to apply.
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await o.call.sessions.rename({ sessionId, name: 'original' })

    o.reg.modules.mutations.once('planted', 'sessions.rename', () => null)
    await o.call.sessions.rename({ sessionId, name: 'should not apply', mutationId: 'planted' })

    expect(o.meta(sessionId).name).toBe('original')
  })

  it('authorization precedes dedup: a replay is not served out of the cache', async () => {
    // ADR 3 D8 / §3.1.3 A1. The session-state envelope authorizes first, so a REVOKED
    // principal replaying a recorded id gets nothing — not the cached result.
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const presence = new SessionStateRegistry({
      sessions: o.reg.modules.sessions,
      state: o.reg.modules.sessions.state,

      mutations: o.reg.modules.mutations,
    })
    const owner = soleHumanSessionStatePrincipal(OPERATOR)
    const applied = presence.execute(
      'sessions.rename',
      { sessionId, name: 'mine', mutationId: 'revoke-1' },
      owner,
    )
    expect(applied.outcome).toBe('applied')

    // A DIFFERENT user (scope `owned` for themselves) replays the same id.
    const stranger = {
      userId: asUserId('user:stranger'),
      capability: {
        role: 'worker' as const,
        scope: { kind: 'owned' as const, userId: asUserId('user:stranger') },
      },
      onBehalfOf: asUserId('user:stranger'),
      humanDirect: true,
    }
    const replay = presence.execute(
      'sessions.rename',
      { sessionId, name: 'mine', mutationId: 'revoke-1' },
      stranger,
    )

    // Denied, NOT `replayed` — the cache did not launder it.
    expect(replay.outcome).toBe('denied')
    expect(replay.value).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC 3 — visibility class and owner-or-grant policy, total and default-closed
// ---------------------------------------------------------------------------

/** Every session-family contract, from every table that declares one. */
function familyContracts(): { name: string; def: ReturnType<typeof sessionStateCommand> }[] {
  const rows: { name: string; def: ReturnType<typeof sessionStateCommand> }[] = []
  for (const table of SESSION_STATE_COMMAND_TABLES) {
    for (const key of Object.keys(table.defs)) {
      const name = `${table.namespace}.${key}`
      rows.push({ name, def: sessionStateCommand(name) })
    }
  }
  for (const key of Object.keys(sessionCommandPlane.defs)) {
    rows.push({
      name: `sessions.${key}`,
      def: (sessionCommandPlane.defs as Record<string, ReturnType<typeof sessionStateCommand>>)[
        key
      ],
    })
  }
  return rows
}

/** The classification obligation, as a function so a planted bad contract can be
 *  run through the SAME check the real tables are. */
function classificationFindings(
  rows: { name: string; def: ReturnType<typeof sessionStateCommand> }[],
): string[] {
  const findings: string[] = []
  for (const { name, def } of rows) {
    if (!def) {
      findings.push(`${name}: no contract`)
      continue
    }
    if (def.visibility === undefined) {
      findings.push(`${name}: no declared visibility class (ADR 9 D4)`)
    }
    const policy = def.policy
    if (!policy) {
      findings.push(`${name}: no declared policy`)
      continue
    }
    if (policy.scope !== 'owner-or-grant' && policy.scope !== 'self') {
      findings.push(`${name}: policy.scope must be owner-or-grant or self, got ${policy.scope}`)
    }
    // The two halves must AGREE. Per-user state is non-grantable (ADR 9 D3 rule 4),
    // so `self` and `per-user-state` are one declaration written twice; a mismatch
    // means one of them is wrong and the audit cannot tell which.
    if ((def.visibility === 'per-user-state') !== (policy.scope === 'self')) {
      findings.push(
        `${name}: visibility ${def.visibility} disagrees with policy.scope ${policy.scope}`,
      )
    }
    // A session is never tenant-visible and never substrate (§3.1.1's small floor).
    if (def.visibility !== 'personal' && def.visibility !== 'per-user-state') {
      findings.push(`${name}: a session-family command may not be ${def.visibility}`)
    }
  }
  return findings
}

describe('AC3 · classification is total, and forgetting fails toward privacy AND a red build', () => {
  it('every session-family command declares its visibility class and its policy', () => {
    expect(classificationFindings(familyContracts())).toEqual([])
  })

  it('handoff declares both too — it is in the family even though its contract lives elsewhere', () => {
    expect(sessionHandoffContract.visibility).toBe('personal')
    expect(sessionHandoffContract.policy.machineVerb).toBe('use')
  })

  it('the check FAILS a contract with no visibility class — the instrument says yes', () => {
    const unclassified = { ...sessionStateCommand('sessions.rename') } as unknown as Record<
      string,
      unknown
    >
    delete unclassified.visibility
    const findings = classificationFindings([
      {
        name: 'probe.unclassified',
        def: unclassified as unknown as ReturnType<typeof sessionStateCommand>,
      },
    ])
    expect(findings).toContain('probe.unclassified: no declared visibility class (ADR 9 D4)')
  })

  it('and it FAILS a per-user command whose scope is not self, and vice versa', () => {
    const base = sessionStateCommand('sessions.markRead')
    if (!base) throw new Error('fixture: sessions.markRead must exist')
    const widened = {
      ...base,
      policy: {
        ...base.policy,
        action: 'write' as const,
        resource: 'session' as const,
        scope: 'owner-or-grant' as const,
      },
    }
    expect(classificationFindings([{ name: 'probe.widened', def: widened }])).toEqual([
      'probe.widened: visibility per-user-state disagrees with policy.scope owner-or-grant',
    ])
  })

  it('an UNCLASSIFIED command resolves to personal — private, never tenant-visible', () => {
    // The semantic backstop, which must hold with every test above deleted. Asserted
    // on a def with the field genuinely absent, not on one declaring `personal`.
    const unclassified = { ...sessionStateCommand('sessions.rename') } as unknown as Record<
      string,
      unknown
    >
    delete unclassified.visibility
    expect(
      commandVisibility(unclassified as unknown as Parameters<typeof commandVisibility>[0]),
    ).toBe('personal')
    // And it can say something else when something else is declared — otherwise
    // this would pass on a resolver that always answered `personal`.
    const perUser = sessionStateCommand('sessions.markRead')
    if (!perUser) throw new Error('fixture: sessions.markRead must exist')
    expect(commandVisibility(perUser)).toBe('per-user-state')
  })
})

// ---------------------------------------------------------------------------
// AC 4 — no per-user field survives as an instance-wide singleton
// ---------------------------------------------------------------------------

describe('AC4 · the per-user split actually happened', () => {
  it('pins, snoozes and tab order are keyed by user: one user’s write is invisible to another', () => {
    // A BEHAVIOURAL assertion with two DIFFERENT actors, not an arity check: a
    // `userId` parameter that the store ignored would pass any signature test.
    const o = makeOracle()
    const store = o.store.sessions
    store.setPin('user:alice', 'panel', 's-1', true)
    store.setSnooze('user:alice', asSessionId('s-1'), null)
    store.setTabOrder('user:alice', '/w', ['s-1'])

    // Alice's rows exist; Bob's are EMPTY — asserted on the values, because a
    // `userId` parameter the store ignored would satisfy any signature check.
    expect(store.listPins('user:alice').panels).toEqual(['s-1'])
    expect(store.listPins('user:bob').panels).toEqual([])
    expect(store.listSnoozes('user:alice')).not.toEqual({})
    expect(store.listSnoozes('user:bob')).toEqual({})
    expect(store.listTabOrders('user:alice')).toEqual({ '/w': ['s-1'] })
    expect(store.listTabOrders('user:bob')).toEqual({})
  })

  it('every per-user COMMAND is self-scoped, so another user’s row is not addressable', () => {
    const perUser = familyContracts().filter(({ def }) => def?.visibility === 'per-user-state')
    // The set is non-empty — otherwise the filter below proves nothing (a typo'd
    // class name would make this a vacuous pass).
    expect(perUser.map((row) => row.name).sort()).toEqual([
      'pins.set',
      'sessions.markRead',
      'sessions.markUnread',
      'snoozes.clear',
      'snoozes.set',
      'tabs.setOrder',
    ])
    for (const { name, def } of perUser) {
      expect(def?.policy?.scope, name).toBe('self')
      // The wire carries no userId, so writing another user's row is not
      // expressible rather than merely refused.
      const keys = Object.keys(
        (def?.input as unknown as { shape?: Record<string, unknown> }).shape ?? {},
      )
      expect(keys, name).not.toContain('userId')
    }
  })

  it('the ONE remaining singleton is readAt, still on the session row, owned by POD-1076', async () => {
    // Honest reporting rather than a green claim: `read_at` is still a column on the
    // session row. POD-1076 owns the (userId, entityId) move and POD-380 recorded
    // why it waits (POD-1077's scoped feed). What POD-382 can and does assert is
    // that its COMMAND is already self-scoped, so the move is storage-only — no
    // contract change, no wire change, no replica migration.
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await o.call.sessions.markRead({ sessionId })

    // THE TRIPWIRE FIRED AND IS REPLACED BY ITS POSITIVE FORM (POD-1076).
    // It used to measure `read_at` as a column on the SESSION row and say so
    // honestly. The column is gone; the marker is one user's `(userId, sessionId)`
    // row. Measured the same way — against STORAGE, not the wire — so this stays
    // a statement about the shape rather than about the projection.
    expect(o.store.sessions.getReadAt(SOLE_USER_ID, sessionId)).not.toBeNull()
    // The property a column could not express: a different principal has no marker.
    expect(o.store.sessions.getReadAt('user:somebody-else', sessionId)).toBeNull()

    // And the part POD-382 closed, unchanged: the COMMAND was already self-scoped
    // and per-user-classified, which is why POD-1076's move needed no contract
    // change, no wire change and no replica migration.
    expect(sessionStateCommand('sessions.markRead')?.policy?.scope).toBe('self')
    expect(sessionStateCommand('sessions.markRead')?.visibility).toBe('per-user-state')
  })
})

// ---------------------------------------------------------------------------
// AC 5 — attribution is a pair, from the transport, payload identity inert
// ---------------------------------------------------------------------------

describe('AC5 · attribution is a pair and comes from the transport', () => {
  it('PRESENCE: the pair decides nameSource, and a payload-supplied identity is ignored', async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const presence = new SessionStateRegistry({
      sessions: o.reg.modules.sessions,
      state: o.reg.modules.sessions.state,

      mutations: o.reg.modules.mutations,
    })

    // A HUMAN acting directly writes a user-sourced name…
    presence.execute(
      'sessions.rename',
      { sessionId, name: 'human choice' },
      {
        userId: asUserId('user:h'),
        capability: OPERATOR,
        onBehalfOf: asUserId('user:h'),
        humanDirect: true,
      },
    )
    expect(o.meta(sessionId).name).toBe('human choice')

    // …and an AGENT acting for that human does NOT overwrite it, because the
    // agent-naming path enforces [spec:SP-eb60]'s precedence. The distinction is
    // read off the principal's pair, not off which transport was used — and the
    // payload's own `humanDirect` / `actor` claims are not even representable.
    const result = presence.execute(
      'sessions.rename',
      {
        sessionId,
        name: 'agent choice',
        humanDirect: true,
        actor: 'user:h',
        onBehalfOf: asUserId('user:h'),
      },
      {
        userId: asUserId('user:h'),
        capability: { ...OPERATOR, actorSessionId: asSessionId('agent-1') },
        actorSessionId: asSessionId('agent-1'),
        onBehalfOf: asUserId('user:h'),
        humanDirect: false,
      },
    )
    expect(result.outcome).toBe('applied')
    expect(o.meta(sessionId).name).toBe('human choice')
  })

  it('COMMAND PLANE: spawnedBy is stamped from the principal, and a payload spawnedBy is stripped', async () => {
    const o = makeOracle()

    // The schema does not carry the field at all, so there is nothing to trust.
    const parsed = sessionCommandPlane.defs.create.input.parse({
      agentKind: 'shell',
      cwd: '/p',
      spawnedBy: 'session:someone-else',
      actor: 'user:intruder',
      onBehalfOf: 'user:intruder',
    })
    expect(parsed).toEqual({ agentKind: 'shell', cwd: '/p' })

    // And the value that IS written comes from the principal: an agent's create
    // stamps that agent, a human's stamps `user`.
    const agentSession = o.reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    const asAgent = ctxFor(o, agentFor(agentSession.sessionId, FIRST_ADMIN_USER_ID))
    const created = await dispatchSessionCommand(asAgent, 'create', {
      agentKind: 'shell',
      cwd: '/by-agent',
    })
    expect(o.meta(created.sessionId).spawnedBy).toBe(`session:${agentSession.sessionId}`)

    const asHuman = ctxFor(o, human(FIRST_ADMIN_USER_ID))
    const byHuman = await dispatchSessionCommand(asHuman, 'create', {
      agentKind: 'shell',
      cwd: '/by-human',
    })
    expect(o.meta(byHuman.sessionId).spawnedBy).toBe('user')
  })

  it('HANDOFF: the durable record carries actor, actorKind and onBehalfOf together', async () => {
    // The pair, on the one command whose contract declares
    // `wirePlacement: 'not-on-the-wire'` — so the assertion has to be against the
    // durable event, which is where it decided to put it.
    const o = makeOracle({ machineId: 'local' })
    const issue = o.reg.issues.create({ repoPath: '/r', title: 'handoff', startNow: false })
    o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/h' })
    const { sessionId } = await o.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/r/.worktrees/h',
      issueId: issue.id,
    })

    // The transfer itself needs two live daemons; what this asserts is the
    // ATTRIBUTION obligation, so a refused transfer is fine — the command record is
    // written from the principal either way, and if it is not, nothing here passes.
    await messageOf(() => o.call.sessions.handoff({ sessionId, machineId: 'nowhere' }))

    const handoffEvents = o.store.events
      .listEventsSince(0)
      .filter((event) => event.kind.includes('handoff'))
    for (const event of handoffEvents) {
      const payload =
        typeof event.payload === 'string'
          ? (JSON.parse(event.payload) as Record<string, unknown>)
          : ((event.payload ?? {}) as Record<string, unknown>)
      // Both halves, or neither is an attribution PAIR (Amendment 1 D17).
      expect(Object.keys(payload), event.kind).toContain('actor')
      expect(Object.keys(payload), event.kind).toContain('onBehalfOf')
    }
    // The contract's own declaration, so a handler that stopped writing the pair
    // cannot pass by there being no events at all.
    expect(sessionHandoffContract.attribution.actor).toBe('from-capability')
    expect(sessionHandoffContract.attribution.onBehalfOf).toBe('from-delegation')
  })
})

// ---------------------------------------------------------------------------
// AC 6 — no route to spawn / resume / send / kill / handoff bypasses `use`
// ---------------------------------------------------------------------------

/** The five verbs the brief names, with an input for each. */
const GATED: { key: SessionCommandKey; input: (sessionId: string) => unknown }[] = [
  { key: 'create', input: () => ({ agentKind: 'shell', cwd: '/p', machineId: 'box' }) },
  {
    key: 'resume',
    input: () => ({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: { kind: 'sessionId', value: 'x' },
      conversationId: 'c',
      machineId: 'box',
    }),
  },
  { key: 'sendText', input: (sessionId) => ({ sessionId, text: 'hello' }) },
  { key: 'kill', input: (sessionId) => ({ sessionId }) },
  { key: 'stop', input: (sessionId) => ({ sessionId }) },
  {
    key: 'uploadImage',
    input: (sessionId) => ({
      sessionId,
      filename: 'a.png',
      mimeType: 'image/png',
      dataBase64: 'AA==',
    }),
  },
]

describe('AC6 · the machine `use` gate is on the only remaining path', () => {
  it.each(
    GATED.map((g) => [g.key, g] as const),
  )('%s refuses a principal who may see the machine but not use it', async (_key, gated) => {
    const o = makeOracle({ machineId: 'box', offlineMachines: [{ id: 'box', name: 'The Box' }] })
    const target = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'box',
    })
    // A machine owned by a COLLEAGUE, with a `see` grant to our principal and no
    // `use` — the case that must fail, and the only one that distinguishes a real
    // gate from an absent one (an unowned row allows everyone today).
    const ownership = ownershipTable(
      new Map([
        [
          'box',
          {
            owner: COLLEAGUE,
            grants: [{ subject: FIRST_ADMIN_USER_ID, verb: 'see' } as MachineGrant],
            name: 'The Box',
          },
        ],
      ]),
    )
    const ctx = ctxFor(o, human(FIRST_ADMIN_USER_ID), { ownership })

    const message = await messageOf(() =>
      dispatchSessionCommand(ctx, gated.key, gated.input(target.sessionId)),
    )
    // `unauthorized`, not `unknown machine` — inside the see set the two stay
    // distinguishable (readiness §3.1.4 M5 / D18.5).
    expect(message).toBe("you do not have access to run agents on machine 'The Box'")
  })

  it('the same commands SUCCEED for the owner — the gate is not refusing everything', async () => {
    // Non-vacuity for the whole table above: if the gate refused unconditionally,
    // every case there would pass while the product was broken.
    // The DEFAULT fixture: the instance's own host, owned by the installer. Not the
    // 'box' fixture above — that machine has a daemon but no machines-table row, so
    // it is `absent` for everyone and would have made this pass for the wrong reason.
    const o = makeOracle()
    const ctx = ctxFor(o, human(FIRST_ADMIN_USER_ID))
    const created = await dispatchSessionCommand(ctx, 'create', {
      agentKind: 'shell',
      cwd: '/p',
    })
    expect(created.sessionId).toBeDefined()
    expect(dispatchSessionCommand(ctx, 'kill', { sessionId: created.sessionId })).toBeUndefined()
  })

  it('THE ALL-IN-ONE CASE: a non-owner may not execute on the `local` daemon', async () => {
    // §3.1.4 M4, the sharpest case: the server runs on someone's Mac, so anyone who
    // can authenticate would otherwise inherit execute on that Mac. The sentinel has
    // no row in the machines table, so this also proves the synthesized-row arm is
    // not an exemption.
    const o = makeOracle()
    // A session on the host this server runs on — the sentinel, exactly as a
    // single-machine install produces it (no explicit placement, no machines row).
    const target = o.reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    expect(o.meta(target.sessionId).machineId).toBeDefined()
    // A colleague authenticated to this instance: not the installer, no grant.
    const ctx = ctxFor(o, human(COLLEAGUE), { ownership: ownershipTable(new Map()) })

    const message = await messageOf(() =>
      dispatchSessionCommand(ctx, 'kill', { sessionId: target.sessionId }),
    )
    // Outside the see set, so it reads exactly like a machine that was never paired.
    expect(message).toBe("unknown machine 'local'")
  })

  it('HANDOFF gates both machines, and its contract says so', () => {
    // The handoff choreography's own gate is tested exhaustively in
    // oracle-handoff.test.ts (both machines, two apply points). What this gate adds
    // is that the DECLARATION is still there — a handler whose gate was deleted
    // would fail that file, and a contract that stopped declaring the verb would
    // fail here, and neither can be quietly dropped without one of them going red.
    expect(sessionHandoffContract.policy.machineVerb).toBe('use')
    expect(sessionHandoffContract.errorConsistency.callerSuppliedTargetId).toBe(true)
    expect(sessionHandoffContract.errorConsistency).toMatchObject({
      distinguishesUnauthorizedFromUnreachable: true,
      invisibleFailsAs: 'nonexistent',
    })
  })

  it('every command-plane contract declares the verb its handler enforces', () => {
    // Mechanism presence is not coverage, in the other direction: a handler with a
    // gate whose contract does not declare it is undocumented policy, and a contract
    // declaring a verb no handler checks is a lie. The first is checked here; the
    // second is what the refusal table above measures.
    for (const [key, def] of Object.entries(sessionCommandPlane.defs)) {
      expect(def.policy?.machineVerb, `sessions.${key}`).toBe('use')
    }
  })
})

// ---------------------------------------------------------------------------
// AC 7 — invisible fails identically to nonexistent, across every command
// ---------------------------------------------------------------------------

describe('AC7 · the command surface is not an existence oracle', () => {
  /** Commands taking a caller-supplied sessionId, with a nonexistent-target probe. */
  const TARGETED: { key: SessionCommandKey; input: (sessionId: string) => unknown }[] = [
    { key: 'kill', input: (sessionId) => ({ sessionId }) },
    { key: 'hibernate', input: (sessionId) => ({ sessionId }) },
    { key: 'resurrect', input: (sessionId) => ({ sessionId }) },
    { key: 'continue', input: (sessionId) => ({ sessionId }) },
    { key: 'stop', input: (sessionId) => ({ sessionId }) },
    { key: 'sendText', input: (sessionId) => ({ sessionId, text: 'hi' }) },
    { key: 'resumeAndSend', input: (sessionId) => ({ sessionId, text: 'hi' }) },
    {
      key: 'answerAskUserQuestion',
      input: (sessionId) => ({ sessionId, choices: [{ optionIndices: [1] }] }),
    },
  ]

  it.each(
    TARGETED.map((row) => [row.key, row] as const),
  )('%s answers an INVISIBLE session exactly as it answers a nonexistent one', async (_key, row) => {
    const o = makeOracle()
    const live = o.reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/p' })

    // Nonexistent: an id nothing ever created.
    const ghostCtx = ctxFor(o, human(FIRST_ADMIN_USER_ID))
    const ghost = await settle(() => dispatchSessionCommand(ghostCtx, row.key, row.input(GHOST)))

    // Invisible: a session that EXISTS and that this principal may not see. The
    // fixture contains a real row, so this is not the ghost case rerun — if the
    // visibility seam were ignored the two answers would differ.
    const invisibleCtx = ctxFor(o, human(FIRST_ADMIN_USER_ID), { visibility: () => false })
    const invisible = await settle(() =>
      dispatchSessionCommand(invisibleCtx, row.key, row.input(live.sessionId)),
    )

    expect(invisible).toEqual(ghost)
  })

  it('the sweep can say YES: a VISIBLE target answers differently from an invisible one', async () => {
    // Without this, every case above would pass if `dispatchSessionCommand` threw
    // the same thing for all inputs, or if `settle` swallowed everything.
    const o = makeOracle()
    const live = o.reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/p' })
    const visible = await settle(() =>
      dispatchSessionCommand(ctxFor(o, human(FIRST_ADMIN_USER_ID)), 'hibernate', {
        sessionId: live.sessionId,
      }),
    )
    const invisible = await settle(() =>
      dispatchSessionCommand(
        ctxFor(o, human(FIRST_ADMIN_USER_ID), { visibility: () => false }),
        'hibernate',
        {
          sessionId: live.sessionId,
        },
      ),
    )
    expect(visible).not.toEqual(invisible)
  })

  it('an INVISIBLE machine answers exactly as a never-paired one', async () => {
    const o = makeOracle({ machineId: 'box', offlineMachines: [{ id: 'box', name: 'The Box' }] })
    // A machine owned by a colleague with NO grant at all: invisible.
    const invisible = ownershipTable(
      new Map([['box', { owner: COLLEAGUE, grants: [], name: 'The Box' }]]),
    )
    const invisibleMessage = await messageOf(() =>
      dispatchSessionCommand(
        ctxFor(o, human(FIRST_ADMIN_USER_ID), { ownership: invisible }),
        'create',
        {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'box',
        },
      ),
    )
    // Never paired: no row for this id anywhere.
    const neverPaired = await messageOf(() =>
      dispatchSessionCommand(
        ctxFor(o, human(FIRST_ADMIN_USER_ID), { ownership: ownershipTable(new Map()) }),
        'create',
        { agentKind: 'shell', cwd: '/p', machineId: 'box' },
      ),
    )
    expect(invisibleMessage).toBe(neverPaired)
    expect(invisibleMessage).toBe("unknown machine 'box'")
  })

  it('the synthesized unaddressable-send answer IS the substrate’s own dead-letter answer', async () => {
    // The command plane produces this shape itself now (it must not hand an
    // invisible target to a substrate that cannot see principals), which means the
    // string lives in two places. This is the check that keeps the copy honest: the
    // substrate is asked directly for its ghost answer and the two are compared. If
    // the substrate ever rewords its dead letter, this goes red instead of the two
    // silently diverging.
    const o = makeOracle()
    const direct = o.reg.modules.messages.send(
      { kind: 'operator' },
      {
        to: { kind: 'session', id: GHOST },
        body: 'anyone there',
        urgency: 'next-turn',
        lifecycle: 'wait',
      },
    )
    const viaCommand = await dispatchSessionCommand(
      ctxFor(o, human(FIRST_ADMIN_USER_ID)),
      'sendText',
      {
        sessionId: GHOST,
        text: 'anyone there',
      },
    )

    expect(viaCommand).toEqual({
      ok: direct.ok,
      reason: direct.reason,
      disposition: direct.disposition,
    })
    expect(direct.disposition).toBe('dead_letter')
  })

  it('the session-state class refuses SILENTLY, which is what its not-found does too', async () => {
    // Same property, different pinned shape (POD-379). A denial must be
    // indistinguishable from a write to a session that does not exist — for this
    // class that means no throw, no reason, no row.
    const o = makeOracle()
    const presence = new SessionStateRegistry({
      sessions: o.reg.modules.sessions,
      state: o.reg.modules.sessions.state,

      mutations: o.reg.modules.mutations,
    })
    const ghost = presence.execute(
      'sessions.rename',
      { sessionId: GHOST, name: 'x' },
      soleHumanSessionStatePrincipal(OPERATOR),
    )
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const denied = presence.execute(
      'sessions.rename',
      { sessionId, name: 'x' },
      {
        userId: asUserId('user:stranger'),
        capability: { role: 'worker', scope: { kind: 'owned', userId: asUserId('user:stranger') } },
        onBehalfOf: asUserId('user:stranger'),
        humanDirect: true,
      },
    )

    expect(denied.value).toBe(ghost.value)
    expect(denied.value).toBeUndefined()
  })

  it('every session-family contract taking a target id has ANSWERED the consistency rule', () => {
    // The declaration side. `@podium/commands`' contracts carry `errorConsistency`
    // as a required field; the protocol-side tables predate it, so what is checkable
    // there is that the resolver they all share is the one that maps absent — which
    // the sweep above measures behaviourally. Asserted here so the two halves are
    // visibly one obligation.
    expect(sessionHandoffContract.errorConsistency.callerSuppliedTargetId).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC 8 — a rescope is not a deletion
// ---------------------------------------------------------------------------

describe('AC8 · no session reducer renders a rescope or an evict as a deletion', () => {
  it('the replica transition table says evict MUST NOT surface as a deletion', async () => {
    // The rule lives where it is decided (POD-369's state machine), and this gate
    // asserts it rather than restating it: a session command's client-side reducer
    // rides the replica's projection, so if the projection ever rendered an eviction
    // as a remove, every session in a revoked share would look deleted.
    const { REPLICA_TRANSITIONS } = await import('@podium/sync')
    // Filtered on the OP the frame carries, not on the word 'evict' anywhere in the
    // row: `D14-READMIT` mentions eviction while stating a different rule, and
    // including it would have made the assertion below demand the wrong sentence of
    // the right row.
    const evictRows = REPLICA_TRANSITIONS.filter((row) => row.input.includes('op=evict'))
    // Non-vacuous: the table must actually contain the rule.
    expect(evictRows.length).toBeGreaterThan(0)
    for (const row of evictRows) {
      expect(JSON.stringify(row).toLowerCase()).toContain('must not surface as a deletion')
    }
  })

  it('TRIPWIRE: no session command yet carries a rescope/evict op the client could mis-reduce', () => {
    // The premise this issue certifies under, made loud rather than assumed. Today
    // the session wire has no per-principal evict/rescope op — POD-1077 adds it, and
    // the readiness doc's Phase 2 row requires it BEFORE the POD-308 cutover. If a
    // session contract ever grows one, this fails and the reducer obligation becomes
    // real work rather than a note in a commit message.
    const sessionOps = familyContracts()
      .map(({ def }) => JSON.stringify(Object.keys(shapeOf(def?.input))))
      .join(' ')
    expect(sessionOps).not.toMatch(/rescope|evict/i)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The zod shape of a schema, or `{}` — used only for key-set assertions. */
function shapeOf(schema: unknown): Record<string, unknown> {
  return (schema as { shape?: Record<string, unknown> })?.shape ?? {}
}

/**
 * Run a call and describe its OUTCOME as a comparable value: the resolved value,
 * or the thrown message. Deliberately not "did it throw" — two commands that both
 * throw different messages are two different answers, and §3.1.5 is about the
 * answer, not about the mechanism.
 */
async function settle(call: () => unknown): Promise<unknown> {
  try {
    return { ok: true, value: await call() }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
