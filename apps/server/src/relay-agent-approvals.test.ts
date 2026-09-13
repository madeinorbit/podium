import { firstAdminMemberId, asSessionId, asUserId, type SessionId, type UserId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { nativeAccountId } from '@podium/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

/**
 * The agent relay's approvals arm, driven end to end through the real registry
 * [spec:SP-edbb] (#410): agent relay request → gate → service → operator decision
 * → exec frame to the owning daemon → result lands. Mirrors
 * relay-agent-relay.test.ts's harness, and shares its shard.
 *
 * NOT NAMED `*e2e*`, AND THE NAME IS THE LANE (PDM-289). The unit lane and every
 * package-local lane exclude the `*e2e*.test.ts` filename glob on the grounds that
 * such a file "boots a live in-process server on a real port" (vitest.unit.config.ts).
 * This file does no such thing — it constructs a `SessionRegistry` in process and
 * pushes daemon frames at it, exactly as relay-agent-relay.test.ts does — but it
 * was called `approvals-relay-e2e.test.ts`, so the filename alone kept it out of
 * every routinely-run lane and out of `test-shards.json`, which is derived from
 * what the unit lane collects. For as long as that was true the only thing
 * exercising this transport was `bun run test:integration`, and an inherited red
 * here (PDM-292) went undetected because nothing ran it.
 *
 * `scripts/test-configuration.test.ts` now refuses an `e2e`-named suite that
 * reaches for nothing real, so the next file cannot hide the same way.
 */

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

describe('approval broker relay arm (#410)', () => {
  const registries: SessionRegistry[] = []
  const machineId = 'm1'
  let registry: SessionRegistry
  let sA: string
  /** The issue worktree both sessions below run in. */
  let wtA: string
  let daemonInbox: ControlMessage[]

  beforeEach(async () => {
    registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    const A = await registry.issues.create({ repoPath: '/r', title: 'epic', startNow: false })
    await registry.issues.update(A.id, { worktreePath: '/r/.worktrees/issue-1-a' })
    wtA = (await registry.issues.get(A.id))?.worktreePath as string
    sA = (await registry.modules.sessions.createSession({ ownerUserId: firstAdminMemberId(), cwd: wtA, agentKind: 'shell' })).sessionId
    daemonInbox = []
    registry.gateway.attachDaemon(machineId, (msg) => daemonInbox.push(msg))
    await pair(machineId, firstAdminMemberId())
  })

  /**
   * PAIR THE MACHINE, BECAUSE `attachDaemon` DOES NOT (PDM-404).
   *
   * `attachDaemon` registers a frame SINK under a machine id. It writes no
   * `machines` row, and the row is what authorization reads: `mayDispatchTo`
   * resolves the requester's verbs through `ownershipSnapshotFromMachines`, and
   * `machineVerbsFor` documents that no row means no verbs, with no arm
   * underneath it. So every `approvals.request` on this transport was refused at
   * enqueue by B5's check (PDM-137) with `cannot request an approval on m1: that
   * machine is not yours to run on` — BEFORE any assertion in this file about
   * forged identity or another human could run. That is what made five of these
   * six tests red, and it is a defect in the FIXTURE, not in the gate: the
   * fixture registered a TRANSPORT without ever pairing the machine, and
   * `ensureHostMachine` (this host, at boot) and pairing (every remote) are the
   * writes it skipped.
   *
   * THAT EXPLAINS THIS FAILURE; IT DOES NOT PROVE A MISSING ROW IMPOSSIBLE. The
   * claim bounded here is about the fixture's own composition, not about the
   * production lifetime: whether deletion, restore or migration can ever leave a
   * live transport attached to a machine with no row is a separate audit, and
   * nothing in this file makes it.
   *
   * OWNED BY A NAMED HUMAN, never left `null`: an unowned machine is usable by
   * NOBODY (D19.4b), so a fixture that omitted the owner would reproduce the
   * same red by a second route and read as if the gate were broken.
   */
  const pair = async (machine: string, owner: UserId): Promise<void> => {
    await registry.sessionStore.machines.upsertMachine({
      id: machine,
      name: machine,
      hostname: machine,
      tokenHash: `${machine}-token`,
      ownerUserId: owner,
    })
    // Written straight to the store, behind the service, whose machine cache is
    // already warm by the time a test writes here — so the row would otherwise be
    // invisible to every read that resolves ownership.
    registry.modules.machines.invalidateMachineCache()
  }

  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  /** A relay frame from an arbitrary session — the daemon's `/agent/<sessionId>`
   *  path is what the gate reads, so this is the only thing that distinguishes
   *  one agent caller from another on this transport. */
  const relayVia = async (
    machine: string,
    sessionId: SessionId,
    proc: string,
    input: unknown,
  ): Promise<RelayResult> => {
    const before = daemonInbox.length
    registry.gateway.routeDaemonFrame(machine, {
      type: 'agentRelayRequest',
      requestId: `ir${before}`,
      sessionId,
      router: 'approvals',
      proc,
      input,
    })
    // the gate replies asynchronously (await inside run()); flush microtasks
    for (
      let i = 0;
      i < 10 && !daemonInbox.slice(before).some((m) => m.type === 'agentRelayResult');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 1))
    }
    const reply = daemonInbox.find(
      (m): m is RelayResult => m.type === 'agentRelayResult' && m.requestId === `ir${before}`,
    )
    if (!reply) throw new Error('no relay reply')
    return reply
  }

  /** The ordinary case: a frame from the machine this fixture paired above. The
   *  gate takes the machine from the CONNECTION, so this argument is the only
   *  thing that can vary it — agent input cannot (see the forged test below). */
  const relayFrom = (sessionId: SessionId, proc: string, input: unknown): Promise<RelayResult> =>
    relayVia(machineId, sessionId, proc, input)

  const relay = (proc: string, input: unknown): Promise<RelayResult> =>
    relayFrom(asSessionId(sA), proc, input)

  it('request → pending → approve → daemon exec → result → succeeded', async () => {
    const r = await relay('request', { op: { kind: 'update' } })
    expect(r.ok).toBe(true)
    const { id } = r.result as { id: string }
    expect(await registry.modules.approvals.listPending(firstAdminMemberId())).toHaveLength(1)

    await registry.modules.approvals.approve(id, firstAdminMemberId())
    const exec = daemonInbox.find((m) => m.type === 'approvalExecRequest')
    expect(exec).toMatchObject({ requestId: id, op: { kind: 'update' } })

    // AWAITED, and that is the assertion below's whole basis (PDM-292). This
    // frame is not request/reply: nothing comes back for `relayFrom`'s poll to
    // wait on, and the `get` that follows is a DIFFERENT frame whose reply says
    // nothing about whether this one finished. Dropped, the read raced
    // `onExecResult`'s `executing → succeeded` store write and lost every time,
    // reading the pre-result row. `routeDaemonFrame` returns the catch-handled
    // completion precisely so a test can observe handler effects without timers
    // or polling — see `gateway/daemon-mux.ts`. Production ingress is the one
    // that deliberately does not wait.
    await registry.gateway.routeDaemonFrame(machineId, {
      type: 'approvalExecResult',
      requestId: id,
      ok: true,
      exitCode: 0,
      output: 'updated 0.1.0 -> 0.1.1',
    })
    const status = await relay('get', { id })
    expect(status.ok).toBe(true)
    expect(status.result).toMatchObject({ status: 'succeeded' })
    expect(await registry.modules.approvals.listPending(firstAdminMemberId())).toHaveLength(0)
  })

  it('approved current-session schedule creates an armed server-owned one-off', async () => {
    const runAt = '2099-07-17T02:00:00.000Z'
    const r = await relay('request', {
      op: {
        kind: 'automation-schedule',
        name: 'Overnight continuation',
        runAt,
        prompt: 'Continue during the quota window.',
        target: { kind: 'current' },
      },
    })
    expect(r.ok).toBe(true)
    const { id } = r.result as { id: string }

    const approved = await registry.modules.approvals.approve(id, firstAdminMemberId())
    expect(approved).toMatchObject({ status: 'succeeded' })
    expect(daemonInbox.some((message) => message.type === 'approvalExecRequest')).toBe(false)
    expect(await registry.modules.automations.list()).toEqual([
      expect.objectContaining({
        name: 'Overnight continuation',
        scheduleKind: 'once',
        runAt,
        nextRunAt: runAt,
        targetSessionId: sA,
        sessionMode: 'resume',
        enabled: true,
      }),
    ])
  })

  it('[POD-1107] a fresh schedule with no agent gets the configured default, not codex', async () => {
    await registry.modules.settings.setSettingsFor(firstAdminMemberId(), {
      ...await registry.modules.settings.getSettings(),
      roles: {
        ...(await registry.modules.settings.getSettings()).roles,
        coding: {
          ...(await registry.modules.settings.getSettings()).roles.coding,
          accountId: nativeAccountId('grok'),
          model: 'grok-4',
          effort: 'high',
        },
      },
    })
    const runAt = '2099-07-17T02:00:00.000Z'
    const r = await relay('request', {
      op: {
        kind: 'automation-schedule',
        name: 'Overnight sweep',
        runAt,
        prompt: 'Sweep the repo.',
        target: { kind: 'fresh', repoPath: '/r' },
      },
    })
    expect(r.ok).toBe(true)

    await registry.modules.approvals.approve((r.result as { id: string }).id, firstAdminMemberId())
    expect(await registry.modules.automations.list()).toEqual([
      expect.objectContaining({
        name: 'Overnight sweep',
        repoPath: '/r',
        // The operator's configured harness — the hardcoded 'codex'/'auto' that
        // stood here ignored it entirely.
        agentKind: 'grok',
        model: 'grok-4',
        effort: 'high',
      }),
    ])
  })

  it('the relay cannot approve/deny — only request and get are reachable', async () => {
    const r = await relay('approve', { id: 'apr_x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not permitted/)
  })

  /**
   * THE OTHER DIRECTION OF THE FIXTURE REPAIR (PDM-404), and the reason that
   * repair is not a weakening.
   *
   * Pairing this fixture's machine is what let the five tests around it reach
   * their assertions — so the obvious worry about that change is that it greened
   * them by removing an authorization check from the path. It did not: the check
   * is B5's enqueue gate (PDM-137) and it is still the thing deciding, as this
   * test shows over the SAME transport, with the SAME session, differing only in
   * which machine the frame arrives from. `pair` grants use to the machine's
   * OWNER, not to everybody.
   *
   * ENQUEUE, NOT DISPATCH. B5 asks this question twice and they are different
   * questions; only the enqueue half is reachable from this transport, because
   * the dispatch half runs inside an operator's `approve`. What this pins is that
   * the operator's pending queue never fills with rows that could not run.
   *
   * The admin arm is deliberately not a hole here: `machineVerbsFor` gives an
   * admin `see` on an UNOWNED machine so it can be assigned an owner, and this
   * machine is owned — by somebody else — so the requester cannot even see it and
   * is refused before the verb is considered.
   */
  it("a request on another human's machine is refused at enqueue, over the same transport", async () => {
    const owner = asUserId('mem_3ZZZZZZZZZZZZZZZZZZZZZZZZZZ')
    await registry.sessionStore.users.create(
      {
        id: owner,
        displayName: 'Machine owner',
        role: 'member',
        createdAt: '2026-09-13T00:00:00.000Z',
        disabledAt: null,
      },
      'scrypt:hash',
    )
    const theirs = 'm2'
    registry.gateway.attachDaemon(theirs, (msg) => daemonInbox.push(msg))
    await pair(theirs, owner)

    const r = await relayVia(theirs, asSessionId(sA), 'request', { op: { kind: 'update' } })
    expect(r.ok).toBe(false)
    expect(r.error).toBe(
      `cannot request an approval on ${theirs}: that machine is not yours to run on`,
    )
    // Refused means NOT FILED, not "filed and hidden": the operator's queue is
    // what this gate exists to keep clean.
    expect(await registry.modules.approvals.listPending(firstAdminMemberId())).toHaveLength(0)

    // And the refusal is about the MACHINE, not about this session having lost
    // the ability to file at all — the same caller, same proc, same op, on its
    // own machine, still succeeds.
    const mine = await relay('request', { op: { kind: 'update' } })
    expect(mine.ok).toBe(true)
  })

  it('a forged sessionId/machineId in the input is overwritten by the relay context', async () => {
    const r = await relay('request', {
      op: { kind: 'stop' },
      sessionId: asSessionId('someone-else'),
      machineId: 'evil',
    })
    expect(r.ok).toBe(true)
    const pending = await registry.modules.approvals.listPending(firstAdminMemberId())
    expect(pending[0]).toMatchObject({ sessionId: sA, machineId })
  })

  /**
   * THE RELAY ARM PASSES THE CALLER (PDM-278) — the transport half of the fix.
   *
   * `relay-dispatch.ts`'s `approvals.get` arm handed the service a caller-supplied
   * id and nothing else, so this frame returned another human's machine, session,
   * issue and operation to whoever sent it. The service could not refuse it: there
   * was nothing to refuse on.
   *
   * WHAT THIS TEST IS FOR, since it is not the discriminating one. Whether a
   * DIFFERENT HUMAN is told apart from the same one is decided in
   * `modules/approvals/service.test.ts`, which runs in the SERVICES shard — and
   * that is SERVICE-LEVEL ISOLATION, proved separately from anything here.
   *
   * What belongs HERE is HUMAN-ATTRIBUTION PROPAGATION: that the caller's human
   * reaches the service across the real gate, rather than the arm passing an
   * empty caller — which would refuse everybody, or, gated on the payload
   * instead, admit anybody. THE SESSION ARM IS REDUNDANT AT THIS LAYER and this
   * file does not discriminate it (PDM-404) — see the `mine` read below for the
   * measurement. Saying "both identity halves reach the service" overstates what
   * these assertions can distinguish; only the `onBehalfOf` half is pinned here.
   *
   * Until PDM-289 renamed this file that half was proved only by the integration
   * lane; it is now in the boundary shard, so it runs whenever the server suite
   * does.
   *
   * THE SECOND SESSION HAS A REAL SECOND OWNER, not no owner. An unowned session
   * is refused too, by the other arm of the gate, so a fixture built that way
   * would pass with the cross-human check deleted (false-green catalogue 14).
   */
  it("another human's agent is refused the same id this one may read", async () => {
    const r = await relay('request', { op: { kind: 'update' } })
    expect(r.ok).toBe(true)
    const { id } = r.result as { id: string }

    // `createSession` defaults the owner to the first admin, so sA is theirs.
    const store = registry.sessionStore
    const stranger = asUserId('mem_2ZZZZZZZZZZZZZZZZZZZZZZZZZZ')
    await store.users.create(
      {
        id: stranger,
        displayName: 'Second member',
        role: 'member',
        createdAt: '2026-09-13T00:00:00.000Z',
        disabledAt: null,
      },
      'scrypt:hash',
    )
    const sB = (
      await registry.modules.sessions.createSession({
        cwd: wtA,
        agentKind: 'shell',
        ownerUserId: stranger,
      })
    ).sessionId

    const refused = await relayFrom(asSessionId(sB), 'get', { id })
    expect(refused.ok).toBe(false)
    // The same words an id that does not exist gets: a distinct refusal would
    // confirm the row exists and name a session this caller cannot see.
    expect(refused.error).toBe(`unknown approval request: ${id}`)

    // Not "the id stopped working": the session that filed it still reads it,
    // over the same transport, in the same test.
    //
    // WHAT THIS PINS, AND WHAT IT DOES NOT (PDM-404). It used to say "this is the
    // `actorSessionId` half — drop it from the arm and this refuses", and that is
    // FALSE; deleting `sessionId: capability.actorSessionId` from the arm leaves
    // every assertion in this file green. `mayRead` admits on EITHER arm, and at
    // this layer the `onBehalfOf` arm subsumes the session one: the row's session
    // is owned by the caller's own human, so `mayDecide` says yes without the
    // session id ever being consulted. The isolating case — a row whose session
    // has NO resolvable owner — is not reachable through the SESSION-CREATION
    // APIS THIS FIXTURE USES: `session-start.ts` refuses to create such a session
    // ("a session must belong to a human") and `upsertSession` refuses to persist
    // one. THAT BOUNDS THE FIXTURE, NOT THE SYSTEM — those are two creation
    // paths rejecting an omitted owner, which is not the same as no-owner states
    // being impossible. Whether a durable row can BECOME unowned later (deletion,
    // an unowned lifecycle path, a restore) is a separate audit, and this file
    // does not make it.
    //
    // Where the arm IS pinned, against a fake `sessionOwner`:
    // `modules/approvals/service.test.ts`'s "the requesting agent reads the
    // request it filed, even with no resolvable owner", in the SERVICES shard.
    //
    // What this line is therefore worth, which is not nothing: the arm passes a
    // caller the service ACCEPTS. An arm that passed an empty reader would refuse
    // everybody, and the refusal above would then be indistinguishable from a
    // transport that had simply stopped working for everyone. The `onBehalfOf`
    // half is the one this file discriminates — see the sibling read below.
    const mine = await relay('get', { id })
    expect(mine.ok).toBe(true)
    expect(mine.result).toMatchObject({ id, status: 'pending' })

    // And the `onBehalfOf` half, which nothing above would catch: a DIFFERENT
    // session of the SAME human. It is not the row's session, so only the
    // capability's human can admit it — pass just `actorSessionId` from the arm
    // and this one refuses while every other assertion here still passes.
    // VERIFIED BY DELIBERATE BREAK (PDM-404): dropping `user: capability.onBehalfOf`
    // reddens THIS assertion and only this one, across the whole file.
    const sC = (
      await registry.modules.sessions.createSession({ ownerUserId: firstAdminMemberId(), cwd: wtA, agentKind: 'shell' })
    ).sessionId
    const sibling = await relayFrom(asSessionId(sC), 'get', { id })
    expect(sibling.ok).toBe(true)
    expect(sibling.result).toMatchObject({ id, status: 'pending' })
  })
})
