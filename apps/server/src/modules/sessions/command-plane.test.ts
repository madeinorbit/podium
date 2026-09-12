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

import type { MachineId } from '@podium/model'
import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { MachineGrant } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type AgentCommandPrincipal,
  type CommandPrincipal,
  firstAdminMemberId,
} from '../../command-principal'
import type { MachineOwnershipIndex, MachineOwnershipRow } from '../../machine-access'
import { ownershipSnapshotFromMachines } from '../../machine-access'
import { machinesForPrincipal, sessionCommandServices, usableRepos } from './command-ctx'
import {
  bindingPrincipalFor,
  createdOwnership,
  dispatchSessionCommand,
  SessionCommandCtx,
  type SessionCommandDeps,
  spawnedByFor,
} from './command-plane'
import { disposeOracles, makeOracle, messageOf } from './oracle-support'
import {
  asyncSessionIssueAccess,
  sessionOwnerVisibility,
  type SessionVisibility,
} from './session-access'

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
  chain: SessionId[] = [],
): AgentCommandPrincipal => ({
  kind: 'agent',
  agentSessionId: asSessionId(sessionId),
  onBehalfOf,
  capability: { role: 'admin', scope: { kind: 'all' }, actorSessionId: asSessionId(sessionId) },
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

type Oracle = Awaited<ReturnType<typeof makeOracle>>

/** The context the router builds, with the principal and ownership substituted. */
async function ctxFor(
  o: Oracle,
  principal: CommandPrincipal,
  opts: { ownership?: MachineOwnershipIndex; visibility?: SessionVisibility } = {},
): Promise<SessionCommandCtx> {
  const modules = o.reg.modules
  const deps: SessionCommandDeps = {
    sessions: () => sessionCommandServices(modules),
    stageAttachment: (input) => modules.sessions.runtimeGateway.stageAttachment(input),
    runtimeContractActive: async (sessionId) => modules.sessions.receiptSender.onContract(sessionId),
    // The chat path's send dispatches the `mail.send` CONTRACT (POD-729), so the
    // fixture binds the port the same way the composition root does — from the
    // principal's own capability, through the real gate. Substituting the
    // delivery service here instead would have let these tests pass while the
    // production path went around the mail policy, which is precisely the
    // bypass POD-729 exists to close.
    mailSend: (input) =>
      modules.messageGate.dispatch(
        'capability' in principal
          ? principal.capability
          : { role: 'admin', scope: { kind: 'all' } },
        undefined,
        'send',
        input,
        'relay',
        'immediate',
      )!,

    createDraftIssue: async (repoPath, agentKind, issueId, ownership) =>
      await modules.issues.createDraftFor(repoPath, agentKind, issueId, ownership),
    attachDraftArtifacts: async (issueId, artifacts) => {
      for (const artifact of artifacts) await modules.issues.panelArtifactUpload(issueId, artifact)
    },
    discardUnlaunchedDraft: async (issueId) => await modules.issues.discardUnlaunchedDraft(issueId),
    access: {
      sessionById: async (sessionId) => await modules.sessions.sessionById(sessionId),
      issues: asyncSessionIssueAccess(modules.issues),
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
    },
    rpc: () => modules.rpc,
    ownership: opts.ownership ?? (await ownershipSnapshotFromMachines(modules.machines)),
    mutations: modules.mutations,
  }
  return new SessionCommandCtx(deps, principal)
}

describe('draft launch compensation', () => {
  it('stores browser attachments on the draft before starting its session', async () => {
    const o = await makeOracle()
    const created = await dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
      agentKind: 'codex',
      cwd: '/p',
      draftIssue: { repoPath: '/p' },
      draftArtifacts: [
        {
          id: 'att-1',
          filename: 'mock.png',
          mimeType: 'image/png',
          dataBase64: 'UE5H',
        },
      ],
    })

    const draft = (await o.reg.issues.list('/p')).find((issue) => issue.draft)
    expect(draft?.panel?.artifacts).toEqual([
      expect.objectContaining({
        path: 'attachments/att-1/mock.png',
        title: 'mock.png',
        entry: 'mock.png',
      }),
    ])
    expect(o.reg.modules.sessions.getSessionIssueId(created.sessionId)).toBe(draft?.id)
    expect((await o.reg.issues.panelArtifactRead(draft?.id ?? '', { index: 1 })).dataBase64).toBe(
      'UE5H',
    )
  })

  it('does not create a draft when an existing issue takes precedence', async () => {
    const o = await makeOracle()
    const issue = await o.reg.issues.create({ repoPath: '/p', title: 'Existing work', startNow: false })

    const created = await dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
      agentKind: 'codex',
      cwd: '/p',
      issueId: issue.id,
      draftIssue: { repoPath: '/p' },
    })

    expect((await o.reg.issues.list('/p')).filter((candidate) => candidate.draft)).toEqual([])
    expect(o.reg.modules.sessions.getSessionIssueId(created.sessionId)).toBe(issue.id)
  })

  it('purges only the placeholder created for a session spawn that throws', async () => {
    const o = await makeOracle()
    vi.spyOn(o.reg.modules.sessions, 'createSession').mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
        agentKind: 'codex',
        cwd: '/p',
        draftIssue: { repoPath: '/p' },
      }),
    ).rejects.toThrow('spawn failed')

    expect((await o.reg.issues.list('/p')).filter((issue) => issue.draft)).toEqual([])
    expect(await o.reg.modules.sessions.listSessions(undefined, 'rpc')).toEqual([])
  })

  it('refuses compensation once the session has been registered against the draft', async () => {
    const o = await makeOracle()
    const createSession = o.reg.modules.sessions.createSession.bind(o.reg.modules.sessions)
    vi.spyOn(o.reg.modules.sessions, 'createSession').mockImplementationOnce(async (input) => {
      await createSession(input)
      throw new Error('late spawn failure')
    })

    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId())), 'create', {
        agentKind: 'codex',
        cwd: '/p',
        draftIssue: { repoPath: '/p' },
      }),
    ).rejects.toThrow('late spawn failure')

    const draft = (await o.reg.issues.list('/p')).find((issue) => issue.draft)
    expect(draft).toBeDefined()
    expect(await o.reg.modules.sessions.listSessions(undefined, 'rpc')).toContainEqual(
      expect.objectContaining({ issueId: draft?.id }),
    )
  })
})

/** A fixture with one paired machine row that HAS an owner to be denied on. */
async function oracleWithPairedMachine(): Promise<{
  o: Oracle
  rows: Map<string, { owner: UserId | null; grants: MachineGrant[]; name?: string }>
}> {
  const o = await makeOracle({
    machineId: asMachineId('box'),
    offlineMachines: [{ id: asMachineId('box'), name: 'The Box' }],
  })
  const rows = new Map([
    ['box', { owner: firstAdminMemberId(), grants: [] as MachineGrant[], name: 'The Box' }],
  ])
  return { o, rows }
}

describe('the machine `use` gate, on every command that starts or feeds work', () => {
  it('denies a principal with no use grant, on create — and the owner still passes', async () => {
    const { o, rows } = await oracleWithPairedMachine()
    const ownership = ownershipTable(rows)

    // The owner may spawn there: the fixture is not one that denies everybody.
    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId()), { ownership }), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'box',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })

    // A second human cannot — and the machine is invisible to them, so the
    // refusal is the never-paired one.
    expect(
      await messageOf(async () =>
        dispatchSessionCommand(await ctxFor(o, human(COLLEAGUE), { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'box',
        }),
      ),
    ).toBe("unknown machine 'box'")
  })

  it('denies resume on a machine the principal may see but not use', async () => {
    const { o, rows } = await oracleWithPairedMachine()
    rows.set('box', {
      owner: COLLEAGUE,
      grants: [{ subject: firstAdminMemberId(), verb: 'see' }],
      name: 'The Box',
    })
    const ownership = ownershipTable(rows)

    expect(
      await messageOf(async () =>
        dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId()), { ownership }), 'resume', {
          agentKind: 'claude-code',
          cwd: '/p',
          resume: { kind: 'claude-session', value: 'n1' },
          conversationId: 'n1',
          machineId: 'box',
        }),
      ),
    ).toBe("you do not have access to run agents on machine 'The Box'")
    // Nothing was spawned, and nothing was persisted.
    expect(await o.reg.modules.sessions.listSessions(undefined, 'rpc')).toEqual([])
  })

  it.each([
    'kill',
    'hibernate',
    'interrupt',
    'resurrect',
    'sendText',
    'resumeAndSend',
    'continue',
  ] as const)('denies %s against a session living on a machine the principal may not use', async (command) => {
    const { o, rows } = await oracleWithPairedMachine()
    const ownership = ownershipTable(rows)
    const owner = await ctxFor(o, human(firstAdminMemberId()), { ownership })
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
      await messageOf(async () =>
        dispatchSessionCommand(
          await ctxFor(o, human(firstAdminMemberId()), { ownership }),
          command,
          input,
        ),
      ),
    ).toBe("unknown machine 'box'")
  })

  it("M4: a non-owner authenticated to a server running on the owner's machine cannot execute on it", async () => {
    // The default ownership index — the one the router actually builds — over the
    // real machines table. The HOST is the sharpest case for M4 and since POD-318
    // it is an ordinary machine with an ordinary row: `ensureHostMachine` wrote it
    // at construction, owned by whoever set the instance up. There is no sentinel
    // arm underneath any more, so this exercises the same rule as any other machine.
    const o = await makeOracle()
    const host = o.store.hostMachineId
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    expect((await o.meta(sessionId)).machineId).toBe(host)

    // The instance owner — whoever set it up — may kill it.
    const asOwner = await ctxFor(o, human(firstAdminMemberId()))
    // ...and a second authenticated human may not, on the SAME machine.
    const asColleague = await ctxFor(o, human(COLLEAGUE))

    expect(await messageOf(() => dispatchSessionCommand(asColleague, 'kill', { sessionId }))).toBe(
      `unknown machine '${host}'`,
    )
    expect(await dispatchSessionCommand(asOwner, 'kill', { sessionId })).toBeUndefined()
  })
})

describe('the spawn surface never OFFERS a machine the principal cannot use', () => {
  it('drops what the principal cannot see, and marks what it may see but not use', async () => {
    const o = await makeOracle({
      machineId: asMachineId('mine'),
      offlineMachines: [
        { id: asMachineId('mine'), name: 'Mine' },
        { id: asMachineId('shared'), name: 'Shared' },
        { id: asMachineId('theirs'), name: 'Theirs' },
      ],
    })
    const ownership = ownershipTable(
      new Map([
        ['mine', { owner: firstAdminMemberId(), grants: [] as MachineGrant[], name: 'Mine' }],
        // Visible but not usable...
        [
          'shared',
          {
            owner: COLLEAGUE,
            grants: [{ subject: firstAdminMemberId(), verb: 'see' }] as MachineGrant[],
            name: 'Shared',
          },
        ],
        // ...and not visible at all.
        ['theirs', { owner: COLLEAGUE, grants: [] as MachineGrant[], name: 'Theirs' }],
      ]),
    )

    const offered = await machinesForPrincipal(o.reg.modules, human(firstAdminMemberId()), ownership)

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

    /**
     * POD-1495 — and the field the comment above was WAITING for. The same
     * projection now also carries "may you give this machine away", so the
     * settings panel can withhold a transfer control the server would refuse.
     *
     * Both arms in one list, so neither can be the fixture's only answer: the
     * owned machine says `true` and the visible-but-not-owned one says `false`.
     * `false` is what a manage grantee would see here too — ownership is
     * strictly larger than any verb the machine can grant — and it is
     * deliberately the same `false` an unowned machine produces, since no owner
     * IDENTITY may cross this boundary.
     */
    expect(offered.find((m) => m.id === 'mine')?.owned).toBe(true)
    expect(offered.find((m) => m.id === 'shared')?.owned).toBe(false)

    /**
     * POD-1386 — `podium machine list` joins each machine's registered checkouts
     * onto this projection, because an enumeration without them cannot answer
     * "which machine can take this work". Repo rows are stored UNSCOPED, so the
     * join is where the disclosure decision is taken, and the cut is `use`, not
     * `see`: a checkout path answers "what can I run on your hardware, and as
     * whom", the same question `inventory` answers.
     *
     * All three cases in one list on purpose. Against a fixture with only a usable
     * machine, a join that filtered NOTHING would pass — the see-only row is what
     * makes this able to fail.
     */
    const repos = usableRepos(offered, [
      { machineId: asMachineId('mine'), path: '/home/me/src/podium' },
      { machineId: asMachineId('shared'), path: '/home/colleague/src/podium' },
      { machineId: asMachineId('theirs'), path: '/home/colleague/src/secret' },
    ])
    expect(repos).toEqual([{ machineId: 'mine', path: '/home/me/src/podium' }])
  })
})

describe('delegation, resolved live at every apply', () => {
  it('an agent whose human lost the machine grant is denied on the NEXT apply, with no reaper', async () => {
    const { o, rows } = await oracleWithPairedMachine()
    rows.set('box', {
      owner: COLLEAGUE,
      grants: [{ subject: firstAdminMemberId(), verb: 'use' }],
      name: 'The Box',
    })
    const ownership = ownershipTable(rows)
    const worker = agentFor('agent-1', firstAdminMemberId())

    const first = (await dispatchSessionCommand(await ctxFor(o, worker, { ownership }), 'create', {
      agentKind: 'shell',
      cwd: '/p',
      machineId: 'box',
    })) as { sessionId: string }
    expect(first.sessionId).toEqual(expect.any(String))

    // Revoke the HUMAN's grant. Nothing is told about the agent; nothing kills it.
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })

    expect(
      await messageOf(async () =>
        dispatchSessionCommand(await ctxFor(o, worker, { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'box',
        }),
      ),
    ).toBe("unknown machine 'box'")
  })

  it('a sub-agent cannot spawn on a machine its PARENT could not use', async () => {
    const o = await makeOracle({
      machineId: asMachineId('a'),
      offlineMachines: [
        { id: asMachineId('a'), name: 'A' },
        { id: asMachineId('b'), name: 'B' },
      ],
    })
    // 'b' needs a live daemon, or every spawn on it refuses as OFFLINE and the
    // `use` denial below would be indistinguishable from unreachability — the
    // exact conflation D18.5 exists to prevent, arriving in the test that is
    // supposed to prove it.
    o.reg.gateway.attachDaemon('b', () => {})
    const ownership = ownershipTable(
      new Map([
        ['a', { owner: firstAdminMemberId(), grants: [] as MachineGrant[], name: 'A' }],
        ['b', { owner: firstAdminMemberId(), grants: [] as MachineGrant[], name: 'B' }],
      ]),
      // The parent's delegation is narrowed to machine 'a'; the HUMAN may still
      // use 'b', which is what makes this a chain test and not a repeat of the
      // human gate.
      new Map([['parent', ['a']]]),
    )
    const child = agentFor('child', firstAdminMemberId(), [asSessionId('parent')])

    // The human may spawn on 'b'...
    await expect(
      dispatchSessionCommand(await ctxFor(o, human(firstAdminMemberId()), { ownership }), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'b',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })

    // ...the child, delegating through that parent, may not.
    expect(
      await messageOf(async () =>
        dispatchSessionCommand(await ctxFor(o, child, { ownership }), 'create', {
          agentKind: 'shell',
          cwd: '/p',
          machineId: 'b',
        }),
      ),
    ).toBe("you do not have access to run agents on machine 'B'")

    // Counterfactual: the narrowing denies 'b' specifically, not everything.
    await expect(
      dispatchSessionCommand(await ctxFor(o, child, { ownership }), 'create', {
        agentKind: 'shell',
        cwd: '/p',
        machineId: 'a',
      }),
    ).resolves.toMatchObject({ sessionId: expect.any(String) })
  })
})

describe('invisible fails exactly like nonexistent', () => {
  it('a session hidden from the principal produces the same answer as one that never existed', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    // The multi-user answer POD-1075 will supply, injected here so the branch is
    // exercised rather than merely present.
    const hidden = await ctxFor(o, human(COLLEAGUE), { visibility: () => false })
    const visible = await ctxFor(o, human(firstAdminMemberId()))

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
    expect(await dispatchSessionCommand(hidden, 'kill', { sessionId })).toEqual(
      await dispatchSessionCommand(visible, 'kill', { sessionId: GHOST }),
    )
    // And the hidden session is still alive: the refusal refused, it did not act.
    expect((await o.reg.modules.sessions.listSessions(undefined, 'rpc')).map((s) => s.sessionId)).toEqual([sessionId])
  })

  it('a relayed send to a hidden session throws the same message as one to a ghost', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const agent = agentFor('agent-1', firstAdminMemberId())
    const hidden = await ctxFor(o, agent, { visibility: () => false })
    const visible = await ctxFor(o, agent)

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

describe('chat interrupt ordering', () => {
  it('reserves a stopped message id so a send arriving later cannot recreate it', async () => {
    const o = await makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const ctx = await ctxFor(o, human(firstAdminMemberId()))
    vi.spyOn(o.reg.modules.sessions, 'interruptTurn').mockResolvedValue({
      ok: false,
      reason: 'no active turn',
    })

    expect(
      await dispatchSessionCommand(ctx, 'interrupt', { sessionId, messageId: 'msg_stopped' }),
    ).toEqual({ ok: true, requested: 'retraction' })

    expect(
      await dispatchSessionCommand(ctx, 'sendText', {
        sessionId,
        text: 'must stay stopped',
        mutationId: 'msg_stopped',
      }),
    ).toEqual({
      ok: false,
      reason: 'interaction interrupted',
      disposition: 'dead_letter',
    })
    expect(await o.store.messages.getMessage('msg_stopped')).toBeNull()
  })
})

describe('attribution and ownership come from the principal', () => {
  it('derives binding spawn authority from each authenticated principal arm', () => {
    expect(bindingPrincipalFor(human(COLLEAGUE))).toEqual({
      kind: 'user',
      userId: COLLEAGUE,
    })
    expect(bindingPrincipalFor(agentFor('parent-agent', COLLEAGUE))).toEqual({
      kind: 'agent',
      parentBindingId: asSessionId('parent-agent'),
    })
    // POD-1516: the job NAME survives the crossing. It used to be dropped here,
    // which made every system-spawned session attributable to "some job".
    expect(bindingPrincipalFor({ kind: 'system', job: 'steward' })).toEqual({
      kind: 'system',
      job: 'steward',
    })
  })

  it('answerAskUserQuestion records WHICH human answered, and a payload identity is inert', async () => {
    // The colleague needs a machine they may actually use — on the local
    // sentinel they would be denied outright, which is M4 working and would make
    // this test prove nothing about attribution.
    const { o, rows } = await oracleWithPairedMachine()
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })
    const ownership = ownershipTable(rows)
    const ctx = await ctxFor(o, human(COLLEAGUE), { ownership })
    const { sessionId } = (await dispatchSessionCommand(ctx, 'create', {
      agentKind: 'claude-code',
      cwd: '/p',
      machineId: 'box',
    })) as { sessionId: string }
    o.reg.gateway.routeDaemonFrame('box', {
      type: 'bind',
      sessionId: asSessionId(sessionId),
      cmd: 'claude',
      cwd: '/p',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })

    const answered = await dispatchSessionCommand(ctx, 'answerAskUserQuestion', {
      sessionId,
      choices: [{ optionIndices: [1] }],
      // A payload-supplied answerer, offered and NOT taken.
      humanQuestionAskedBy: firstAdminMemberId(),
    })

    expect(answered).toEqual({ ok: true })
    // The pair the write is attributed with comes from the transport principal:
    // the colleague answered, whatever the payload said.
    expect(ctx.principal.kind === 'user' && ctx.principal.user).toBe(COLLEAGUE)
    expect(spawnedByFor(ctx.principal)).not.toBe(firstAdminMemberId())
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

  it('persists an agent-created session under its delegating human with the agent recorded as actor', async () => {
    const { o, rows } = await oracleWithPairedMachine()
    rows.set('box', { owner: COLLEAGUE, grants: [], name: 'The Box' })
    const principal = agentFor('agent-1', COLLEAGUE)
    const created = (await dispatchSessionCommand(
      await ctxFor(o, principal, { ownership: ownershipTable(rows) }),
      'create',
      { agentKind: 'shell', cwd: '/p', machineId: 'box' },
    )) as { sessionId: SessionId }

    expect(
      (await o.store.sessions.loadSessions()).find((row) => row.id === created.sessionId),
    ).toMatchObject({
      ownerUserId: COLLEAGUE,
      spawnedBy: 'session:agent-1',
    })
    expect(await o.reg.modules.sessions.sessionOwner(created.sessionId)).toEqual({
      owner: COLLEAGUE,
      grants: [],
    })
  })

  /**
   * INVERTED BY B1 (PDM-133). This asserted "a session spawned under an issue
   * inherits THAT issue's owner, not the actor's", on the reasoning that
   * otherwise sharing an issue would not share the work done inside it. Sharing
   * a TASK now shares the task; it does not hand over the private runs executing
   * on it, which is the distinction the multi-user architecture draws and this
   * rule collapsed.
   */
  it('a session spawned under an issue is owned by the DELEGATING HUMAN, not the issue', () => {
    const underIssue = createdOwnership(agentFor('agent-1', COLLEAGUE), {
      id: asIssueId('podium-7'),
    })

    // COLLEAGUE is not the first-enrolled admin, so this cannot pass by the two
    // identities happening to coincide — the shape that made the old precedence
    // invisible on a one-account instance.
    expect(COLLEAGUE).not.toBe(firstAdminMemberId())
    expect(underIssue).toEqual({
      owner: COLLEAGUE,
      actor: 'session:agent-1',
      // The PLACEMENT is still recorded; it just no longer decides ownership.
      inheritedFrom: { kind: 'issue', id: 'podium-7' },
    })

    // NEGATIVE, for the case this change is NOT about: with no parent issue the
    // answer was already the delegating human and must not have moved.
    expect(createdOwnership(agentFor('agent-1', COLLEAGUE), undefined)).toEqual({
      owner: COLLEAGUE,
      actor: 'session:agent-1',
      inheritedFrom: { kind: 'principal' },
    })

    // The owner is now INDEPENDENT of the issue argument: same principal, two
    // placements, one owner. There is no longer a parameter through which an
    // issue's owner could reach session ownership — `parentIssue` carries only
    // an id.
    expect(createdOwnership(agentFor('agent-1', COLLEAGUE), { id: asIssueId('draft-1') }).owner).toBe(
      createdOwnership(agentFor('agent-1', COLLEAGUE), undefined).owner,
    )
  })
})

/**
 * THE HUMAN CEILING ON THE COMMAND PATH (B1, PDM-133).
 *
 * `session-access.ts` has always documented this rule and shipped
 * `everythingVisible` as the answer, with the composition root carrying the note
 * "POD-1075 supplies the owner/grant answer; today one account sees all". B1
 * supplies it. These tests exercise `sessionOwnerVisibility` directly, and then
 * through the same `ctxFor` the rest of this file uses, so the refusal is shown
 * at the seam a command actually travels.
 */
/** Resolve OR reject, reduced to a comparable value — the audit file's `settle`
 *  in the one place this file needs it. A thrown refusal and a returned
 *  disposition are both answers; the consistent-error rule is about them being
 *  the SAME answer, not about which shape they take. */
const settleOf = async (run: () => unknown): Promise<unknown> => {
  try {
    return { ok: await run() }
  } catch (error) {
    return { err: error instanceof Error ? error.message : String(error) }
  }
}

describe('session visibility is bounded by the delegating human', () => {
  const BOB = asUserId('user:bob')
  const row = (sessionId: SessionId) => ({ sessionId }) as never
  const ownedBy = (owner: UserId) => async () => ({ owner })

  it('admits the owner and refuses everyone else', async () => {
    const visible = sessionOwnerVisibility(ownedBy(BOB))
    const target = row(asSessionId(GHOST))

    expect(await visible(human(BOB), target)).toBe(true)
    // NEGATIVE: a different human, and an agent acting for that different human
    // — the ceiling is the HUMAN, so the agent arm must answer identically.
    expect(await visible(human(COLLEAGUE), target)).toBe(false)
    expect(await visible(agentFor('agent-x', COLLEAGUE), target)).toBe(false)
    // ...and an agent acting for the OWNER is admitted, so the agent arm is not
    // simply refusing everything.
    expect(await visible(agentFor('agent-x', BOB), target)).toBe(true)
  })

  it('refuses a session whose owner cannot be resolved, and admits system jobs', async () => {
    const unresolvable = sessionOwnerVisibility(async () => undefined)
    const target = row(asSessionId(GHOST))

    expect(await unresolvable(human(BOB), target)).toBe(false)
    // A system job has no human ceiling to apply — the janitor and the outbox
    // drain are not people. Stated as a case rather than left implicit.
    expect(await unresolvable({ kind: 'system', job: 'janitor' } as never, target)).toBe(true)
  })

  it("a command against another human's session answers not-found, not forbidden", async () => {
    const o = await makeOracle()
    // Owned by COLLEAGUE, who is NOT the principal below.
    const live = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/p',
      ownerUserId: COLLEAGUE,
    })
    expect(await o.reg.modules.sessions.sessionOwner(live.sessionId)).toEqual({
      owner: COLLEAGUE,
      grants: [],
    })

    const stranger = await ctxFor(o, human(firstAdminMemberId()), {
      visibility: sessionOwnerVisibility((id) => o.reg.modules.sessions.sessionOwner(id)),
    })
    /**
     * ASSERTED AS "SAME ANSWER AS A GHOST", not as a thrown message.
     *
     * A human's `sendText` to an unresolvable target does not throw — it returns
     * a `dead_letter` disposition, while the RELAYED (agent) send throws
     * `session not found`. Both are the shipped shapes POD-379 pinned. The
     * property under test is neither of those spellings: it is that an invisible
     * session and a nonexistent one produce the SAME answer, whatever that
     * answer is, so the command surface is not an existence oracle (ADR 3
     * Amendment 1 D20.2). `session-cutover.audit.test.ts` states it this way for
     * the whole command table; this is the same claim for one owner boundary.
     */
    const onOwned = await settleOf(() =>
      dispatchSessionCommand(stranger, 'sendText', { sessionId: live.sessionId, text: 'hello' }),
    )
    const onGhost = await settleOf(() =>
      dispatchSessionCommand(stranger, 'sendText', { sessionId: asSessionId(GHOST), text: 'hello' }),
    )
    expect(onOwned).toEqual(onGhost)

    /**
     * AND THE INSTRUMENT CAN SAY YES. Without this, the equality above would
     * hold if `sendText` answered identically for every input — including a
     * build where visibility refused everyone. The OWNER gets a DIFFERENT
     * answer for the same session id.
     */
    const owner = await ctxFor(o, human(COLLEAGUE), {
      visibility: sessionOwnerVisibility((id) => o.reg.modules.sessions.sessionOwner(id)),
    })
    const asOwner = await settleOf(() =>
      dispatchSessionCommand(owner, 'sendText', { sessionId: live.sessionId, text: 'hello' }),
    )
    expect(asOwner).not.toEqual(onGhost)
  })
})
