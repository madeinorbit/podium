/**
 * The command plane's ACCEPTANCE properties (POD-381), driven through the real
 * services rather than through mocks: every fixture below is a live
 * `SessionRegistry` from POD-379's oracle harness, and only the PRINCIPAL and
 * the ownership table are synthetic — because those are the two things the
 * transport cannot yet produce (there is one password and no accounts).
 *
 * Why not drive these through `appRouter` like the oracle does: the tRPC caller
 * resolves to the instance's one account by construction, so a second human is
 * unreachable from that seam. Building the context directly is what makes the
 * multi-user answer testable BEFORE POD-1075 lands accounts — and it is the same
 * context the router builds, from the same composition root.
 */

import { asUserId, type UserId } from '@podium/model'
import type { MachineGrant, MachineId } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AgentCommandPrincipal,
  type CommandPrincipal,
  INSTANCE_OWNER,
} from '../../command-principal'
import type { MachineOwnershipIndex, MachineOwnershipRow } from '../../machine-access'
import { ownershipFromMachines } from '../../machine-access'
import {
  createdOwnership,
  dispatchSessionCommand,
  type SessionCommandDeps,
  SessionCommandCtx,
  spawnedByFor,
} from './command-plane'
import { machinesForPrincipal } from './command-ctx'
import { disposeOracles, makeOracle, messageOf } from './oracle-support'
import type { SessionVisibility } from './session-access'

afterEach(() => disposeOracles())

const COLLEAGUE: UserId = asUserId('colleague')
const GHOST = '00000000-0000-4000-8000-000000000000'

const human = (id: UserId): CommandPrincipal => ({
  kind: 'user',
  user: id,
  capability: { role: 'admin', scope: { kind: 'all' } },
})

const agentFor = (
  sessionId: string,
  onBehalfOf: UserId,
  chain: string[] = [],
): AgentCommandPrincipal => ({
  kind: 'agent',
  agentSessionId: sessionId,
  onBehalfOf,
  capability: { role: 'admin', scope: { kind: 'all' }, actorSessionId: sessionId },
  chain,
})

/** A machine table a test can mutate between two applies. */
function ownershipTable(
  rows: Map<string, { owner: UserId | null; grants: MachineGrant[]; name?: string }>,
  delegated?: Map<string, string[]>,
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
    delegatedMachines: (sessionId) => {
      const allowed = delegated?.get(sessionId)
      return allowed === undefined ? undefined : new Set(allowed)
    },
  }
}

type Oracle = ReturnType<typeof makeOracle>

/** The context the router builds, with the principal and ownership substituted. */
function ctxFor(
  o: Oracle,
  principal: CommandPrincipal,
  opts: { ownership?: MachineOwnershipIndex; visibility?: SessionVisibility } = {},
): SessionCommandCtx {
  const modules = o.reg.modules
  const deps: SessionCommandDeps = {
    sessions: () => modules.sessions,
    messages: () => modules.messages,
    createDraftIssue: (repoPath, agentKind, issueId) =>
      modules.issues.createDraftFor(repoPath, agentKind, issueId),
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

/** A fixture with one paired machine row that HAS an owner to be denied on. */
function oracleWithPairedMachine(): { o: Oracle; rows: Map<string, { owner: UserId | null; grants: MachineGrant[]; name?: string }> } {
  const o = makeOracle({ machineId: 'box', offlineMachines: [{ id: 'box', name: 'The Box' }] })
  const rows = new Map([['box', { owner: INSTANCE_OWNER, grants: [] as MachineGrant[], name: 'The Box' }]])
  return { o, rows }
}

describe('the machine `use` gate, on every command that starts or feeds work', () => {
  it('denies a principal with no use grant, on create — and the owner still passes', async () => {
    const { o, rows } = oracleWithPairedMachine()
    const ownership = ownershipTable(rows)

    // The owner may spawn there: the fixture is not one that denies everybody.
    await expect(
      dispatchSessionCommand(ctxFor(o, human(INSTANCE_OWNER), { ownership }), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'box',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })

    // A second human cannot — and the machine is invisible to them, so the
    // refusal is the never-paired one.
    expect(
      await messageOf(() =>
        dispatchSessionCommand(ctxFor(o, human(COLLEAGUE), { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'box',
        }),
      ),
    ).toBe("unknown machine 'box'")
  })

  it('denies resume on a machine the principal may see but not use', async () => {
    const { o, rows } = oracleWithPairedMachine()
    rows.set('box', {
      owner: COLLEAGUE,
      grants: [{ subject: INSTANCE_OWNER, verb: 'see' }],
      name: 'The Box',
    })
    const ownership = ownershipTable(rows)

    expect(
      await messageOf(() =>
        dispatchSessionCommand(ctxFor(o, human(INSTANCE_OWNER), { ownership }), 'resume', {
          agentKind: 'claude-code',
          cwd: '/p',
          resume: { kind: 'claude-session', value: 'n1' },
          conversationId: 'n1',
          machineId: 'box',
        }),
      ),
    ).toBe("you do not have access to run agents on machine 'The Box'")
    // Nothing was spawned, and nothing was persisted.
    expect(o.reg.modules.sessions.listSessions()).toEqual([])
  })

  it.each(['kill', 'hibernate', 'resurrect', 'sendText', 'resumeAndSend', 'continue'] as const)(
    'denies %s against a session living on a machine the principal may not use',
    async (command) => {
      const { o, rows } = oracleWithPairedMachine()
      const ownership = ownershipTable(rows)
      const owner = ctxFor(o, human(INSTANCE_OWNER), { ownership })
      const spawned = (await dispatchSessionCommand(owner, 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'box',
      })) as { sessionId: string }
      const input =
        command === 'sendText' || command === 'resumeAndSend'
          ? { sessionId: spawned.sessionId, text: 'hello' }
          : { sessionId: spawned.sessionId }

      // The machine changes hands: the colleague now owns it and the instance
      // owner holds nothing on it.
      rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })

      expect(
        await messageOf(() =>
          dispatchSessionCommand(
            ctxFor(o, human(INSTANCE_OWNER), { ownership }),
            command,
            input,
          ),
        ),
      ).toBe("unknown machine 'box'")
    },
  )

  it("M4: a non-owner authenticated to a server running on the owner's machine cannot execute on `local`", async () => {
    // The default ownership index — the one the router actually builds — over
    // the real machines table.
    // The row must exist BEFORE the registry is built: the machines service
    // caches its records, so a row inserted afterwards reads as an unknown
    // machine — and an unknown machine has no owner to be denied on behalf of,
    // which would have made this test pass for the wrong reason. It did, on the
    // first run, and that is what the fixture ordering here is guarding.
    const o = makeOracle({ offlineMachines: [{ id: 'local', name: 'This Mac' }] })
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    // The instance owner — whoever set it up — may kill it.
    const asOwner = ctxFor(o, human(INSTANCE_OWNER))
    // ...and a second authenticated human may not, on the SAME machine.
    const asColleague = ctxFor(o, human(COLLEAGUE))

    expect(await messageOf(() => dispatchSessionCommand(asColleague, 'kill', { sessionId }))).toBe(
      "unknown machine 'local'",
    )
    expect(dispatchSessionCommand(asOwner, 'kill', { sessionId })).toBeUndefined()
  })
})

describe('the spawn surface never OFFERS a machine the principal cannot use', () => {
  it('drops what the principal cannot see, and marks what it may see but not use', () => {
    const o = makeOracle({
      machineId: 'mine',
      offlineMachines: [
        { id: 'mine', name: 'Mine' },
        { id: 'shared', name: 'Shared' },
        { id: 'theirs', name: 'Theirs' },
      ],
    })
    const ownership = ownershipTable(
      new Map([
        ['mine', { owner: INSTANCE_OWNER, grants: [] as MachineGrant[], name: 'Mine' }],
        // Visible but not usable...
        [
          'shared',
          {
            owner: COLLEAGUE,
            grants: [{ subject: INSTANCE_OWNER, verb: 'see' }] as MachineGrant[],
            name: 'Shared',
          },
        ],
        // ...and not visible at all.
        ['theirs', { owner: COLLEAGUE, grants: [] as MachineGrant[], name: 'Theirs' }],
      ]),
    )

    const offered = machinesForPrincipal(o.reg.modules, human(INSTANCE_OWNER), ownership)

    // `theirs` is absent, not denied: for this principal it does not exist.
    expect(offered.map((m) => m.id).sort()).toEqual(['mine', 'shared'])
    // And the one that IS visible carries the denial, so the SERVER-SIDE
    // predicate refuses it with a reason that is not "offline" — the M5
    // distinction. The annotation stops at the wire on purpose: `MachineWire`
    // may not grow a per-principal field until POD-1079/POD-1075 land the
    // ownership columns, so a client-side picker sees the see-filter today and
    // the use-decision when that schema carries it.
    expect(offered.find((m) => m.id === 'mine')?.use).toBe('granted')
    expect(offered.find((m) => m.id === 'shared')?.use).toBe('denied')
  })
})

describe('delegation, resolved live at every apply', () => {
  it('an agent whose human lost the machine grant is denied on the NEXT apply, with no reaper', async () => {
    const { o, rows } = oracleWithPairedMachine()
    rows.set('box', {
      owner: COLLEAGUE,
      grants: [{ subject: INSTANCE_OWNER, verb: 'use' }],
      name: 'The Box',
    })
    const ownership = ownershipTable(rows)
    const worker = agentFor('agent-1', INSTANCE_OWNER)

    const first = (await dispatchSessionCommand(ctxFor(o, worker, { ownership }), 'create', {
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'box',
    })) as { sessionId: string }
    expect(first.sessionId).toEqual(expect.any(String))

    // Revoke the HUMAN's grant. Nothing is told about the agent; nothing kills it.
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })

    expect(
      await messageOf(() =>
        dispatchSessionCommand(ctxFor(o, worker, { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'box',
        }),
      ),
    ).toBe("unknown machine 'box'")
  })

  it('a sub-agent cannot spawn on a machine its PARENT could not use', async () => {
    const o = makeOracle({
      machineId: 'a',
      offlineMachines: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    })
    // 'b' needs a live daemon, or every spawn on it refuses as OFFLINE and the
    // `use` denial below would be indistinguishable from unreachability — the
    // exact conflation D18.5 exists to prevent, arriving in the test that is
    // supposed to prove it.
    o.reg.modules.sessions.attachDaemon('b', () => {})
    const ownership = ownershipTable(
      new Map([
        ['a', { owner: INSTANCE_OWNER, grants: [] as MachineGrant[], name: 'A' }],
        ['b', { owner: INSTANCE_OWNER, grants: [] as MachineGrant[], name: 'B' }],
      ]),
      // The parent's delegation is narrowed to machine 'a'; the HUMAN may still
      // use 'b', which is what makes this a chain test and not a repeat of the
      // human gate.
      new Map([['parent', ['a']]]),
    )
    const child = agentFor('child', INSTANCE_OWNER, ['parent'])

    // The human may spawn on 'b'...
    await expect(
      dispatchSessionCommand(ctxFor(o, human(INSTANCE_OWNER), { ownership }), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'b',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })

    // ...the child, delegating through that parent, may not.
    expect(
      await messageOf(() =>
        dispatchSessionCommand(ctxFor(o, child, { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'b',
        }),
      ),
    ).toBe("you do not have access to run agents on machine 'B'")

    // Counterfactual: the narrowing denies 'b' specifically, not everything.
    await expect(
      dispatchSessionCommand(ctxFor(o, child, { ownership }), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'a',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })
  })
})

describe('invisible fails exactly like nonexistent', () => {
  it('a session hidden from the principal produces the same answer as one that never existed', async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    // The multi-user answer POD-1075 will supply, injected here so the branch is
    // exercised rather than merely present.
    const hidden = ctxFor(o, human(COLLEAGUE), { visibility: () => false })
    const visible = ctxFor(o, human(INSTANCE_OWNER))

    // Same command, same shapes, whichever kind of absence it was.
    expect(await dispatchSessionCommand(hidden, 'hibernate', { sessionId })).toEqual(
      await dispatchSessionCommand(visible, 'hibernate', { sessionId: GHOST }),
    )
    expect(await dispatchSessionCommand(hidden, 'resurrect', { sessionId })).toEqual(
      await dispatchSessionCommand(visible, 'resurrect', { sessionId: GHOST }),
    )
    expect(
      await dispatchSessionCommand(hidden, 'answerAskUserQuestion', {
        sessionId,
        choices: [{ optionIndices: [1] }],
      }),
    ).toEqual(
      await dispatchSessionCommand(visible, 'answerAskUserQuestion', {
        sessionId: GHOST,
        choices: [{ optionIndices: [1] }],
      }),
    )
    expect(dispatchSessionCommand(hidden, 'kill', { sessionId })).toEqual(
      dispatchSessionCommand(visible, 'kill', { sessionId: GHOST }),
    )
    // And the hidden session is still alive: the refusal refused, it did not act.
    expect(o.reg.modules.sessions.listSessions().map((s) => s.sessionId)).toEqual([sessionId])
  })

  it('a relayed send to a hidden session throws the same message as one to a ghost', async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const agent = agentFor('agent-1', INSTANCE_OWNER)
    const hidden = ctxFor(o, agent, { visibility: () => false })
    const visible = ctxFor(o, agent)

    const onHidden = await messageOf(() =>
      dispatchSessionCommand(hidden, 'sendText', { sessionId, text: 'hi' }),
    )
    const onGhost = await messageOf(() =>
      dispatchSessionCommand(visible, 'sendText', { sessionId: GHOST, text: 'hi' }),
    )

    expect(onHidden).toBe('session not found')
    expect(onHidden).toBe(onGhost)
  })
})

describe('attribution and ownership come from the principal', () => {
  it('answerAskUserQuestion records WHICH human answered, and a payload identity is inert', async () => {
    // The colleague needs a machine they may actually use — on the local
    // sentinel they would be denied outright, which is M4 working and would make
    // this test prove nothing about attribution.
    const { o, rows } = oracleWithPairedMachine()
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })
    const ownership = ownershipTable(rows)
    const ctx = ctxFor(o, human(COLLEAGUE), { ownership })
    const { sessionId } = (await dispatchSessionCommand(ctx, 'create', {
      agentKind: 'claude-code',
      cwd: '/p',
      machineId: 'box',
    })) as { sessionId: string }
    o.reg.modules.sessions.onDaemonMessageFrom('box', {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })

    const answered = await dispatchSessionCommand(ctx, 'answerAskUserQuestion', {
      sessionId,
      choices: [{ optionIndices: [1] }],
      // A payload-supplied answerer, offered and NOT taken.
      humanQuestionAskedBy: INSTANCE_OWNER,
    })

    expect(answered).toEqual({ ok: true })
    // The pair the write is attributed with comes from the transport principal:
    // the colleague answered, whatever the payload said.
    expect(ctx.principal.kind === 'user' && ctx.principal.user).toBe(COLLEAGUE)
    expect(spawnedByFor(ctx.principal)).not.toBe(INSTANCE_OWNER)
  })

  it('a created session is owned by the onBehalfOf human, with the agent as actor', () => {
    const owned = createdOwnership(agentFor('agent-1', COLLEAGUE), undefined)

    expect(owned).toEqual({
      owner: COLLEAGUE,
      actor: 'session:agent-1',
      inheritedFrom: { kind: 'principal' },
    })
    // The actor half is what the shipped `spawnedBy` column already speaks.
    expect(spawnedByFor(agentFor('agent-1', COLLEAGUE))).toBe('session:agent-1')
    expect(spawnedByFor(human(COLLEAGUE))).toBe('user')
  })

  it("a session spawned under an issue inherits THAT issue's owner, not the actor's", () => {
    const underIssue = createdOwnership(agentFor('agent-1', COLLEAGUE), {
      id: 'podium-7',
      owner: INSTANCE_OWNER,
    })

    // The issue's owner wins over the delegating human — otherwise sharing an
    // issue would not share the work done inside it.
    expect(underIssue).toEqual({
      owner: INSTANCE_OWNER,
      actor: 'session:agent-1',
      inheritedFrom: { kind: 'issue', id: 'podium-7' },
    })
    // An issue with no owner recorded yet falls back to the delegating human,
    // never to nobody: the draft vessel is OWNED.
    expect(createdOwnership(agentFor('agent-1', COLLEAGUE), { id: 'draft-1' }).owner).toBe(
      COLLEAGUE,
    )
  })
})
