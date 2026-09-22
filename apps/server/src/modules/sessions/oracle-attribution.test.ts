/**
 * ORACLE — attribution stamped by session writes (POD-379 for POD-312).
 *
 * Under §3.1.3 A3 attribution becomes a PAIR: actor (which agent) AND
 * on-behalf-of (which human), both taken from the authenticated transport
 * principal, never from payload. This file records which fields exist TODAY and
 * what each one holds, so the migration can show exactly which fields grow a
 * second half, which are replaced, and which are absent and must be added.
 *
 * The single-valued fields recorded here — `spawnedBy`, `nameSource`,
 * `deletion_source`, `stopReason`, `inputOrigin`, `humanQuestionAskedBy` — are
 * all ROLE-level or DEVICE-level today. None of them names a person, because
 * there are no people in the model (docs/multi-user-readiness.md §3.2).
 */

import { firstAdminMemberId, type SessionId } from '@podium/model'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { attachTestClient } from '../../test-support/client-transport'
import {
  disposeOracles,
  MUST_NOT_CHANGE,
  makeOracle,
  PASTE_END,
  PASTE_START,
  ptyFrames,
  willChange,
} from './oracle-support'

afterEach(() => disposeOracles())

type Oracle = Awaited<ReturnType<typeof makeOracle>>

/**
 * The posture a real boot leaves behind, which makeOracle does not: the host
 * row itself (nothing provisions it on construction — the store is empty until
 * a test writes), assigned for agent execution, owned by the instance owner,
 * and reporting the /p and /r checkouts the tests below place work into.
 * Without the row the placement path answers "unknown machine"; without the
 * assignment it answers "no assigned and available daemon" (POD-2700's
 * structural axis); without the owner the host is quarantined (usable by
 * nobody, POD-3960); without the checkouts no repo path resolves to a repo id
 * (POD-4165). The daemon socket and its inventory report are already attached
 * by makeOracle, and presence/availability derive from that socket live, so no
 * re-attach is needed after the row appears. Gap-fill only: if a future
 * makeOracle provisions the host itself, its row, assignment and owner stand.
 * (POD-4544's shape, extended with /r for this file's issue-repo tests.)
 */
async function provisionHost(o: Oracle): Promise<void> {
  const host = o.store.hostMachineId
  if (!(await o.store.machines.getMachine(host))) {
    await o.store.machines.upsertMachine({
      id: host,
      name: 'Test Host',
      hostname: 'test-host',
      tokenHash: 'test',
      ownerUserId: firstAdminMemberId(),
      assignment: { server: true, agentExecution: true },
    })
  }
  if ((await o.reg.modules.machines.serviceAssignment(host)).agentExecution !== true) {
    await o.store.machines.setServiceAssignment(host, { server: true, agentExecution: true })
  }
  if ((await o.store.machines.custodian(host)) === null) {
    await o.store.machines.setMachineOwner(host, firstAdminMemberId())
  }
  for (const path of ['/p', '/r']) await o.store.repos.addRepo(path, host)
}

/**
 * Answer the lifecycle RPC a stop/park makes of its daemon (POD-4302): `kill`
 * retires the process through the daemon, and without the confirmation the
 * kill fails after the tombstone committed. makeOracle's send arm answers
 * only `repoOpRequest`, so this re-attach replicates that arm (not drops it)
 * and adds the retirement confirmation.
 */
async function answerLifecycle(o: Oracle): Promise<void> {
  const host = o.store.hostMachineId
  await o.reg.gateway.attachDaemon(host, (msg) => {
    o.daemon.push(msg)
    if (msg.type === 'repoOpRequest') {
      o.reg.gateway.routeDaemonFrame(host, {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: true,
        output: '',
      })
    }
    if (msg.type === 'runtimeLifecycleRequest') {
      o.reg.gateway.routeDaemonFrame(host, {
        type: 'runtimeLifecycleResult',
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        result: { ok: true, retirement: 'confirmed' },
      })
    }
  })
}

const NO_PERSON = willChange(
  'POD-1075',
  'attribution becomes (actor, on-behalf-of); today no field names a person',
)

describe('oracle: who created this session', () => {
  it(`${MUST_NOT_CHANGE}: tRPC creation stamps user provenance and durable human ownership`, async () => {
    const o = await makeOracle()
    await provisionHost(o)

    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    expect((await o.meta(sessionId)).spawnedBy).toBe('user')
    expect((await o.store.sessions.loadSessions()).find((r) => r.id === sessionId)).toMatchObject({
      spawnedBy: 'user',
      ownerUserId: firstAdminMemberId(),
    })
  })

  it(`${NO_PERSON}: a resume through the tRPC seam stamps 'user' on its fresh-spawn fallback`, async () => {
    const o = await makeOracle()
    await provisionHost(o)

    const { sessionId } = await o.call.sessions.resume({
      agentKind: 'claude-code',
      cwd: '/p',
      resume: { kind: 'claude-session', value: 'n1' },
      conversationId: 'n1',
    })

    expect((await o.meta(sessionId)).spawnedBy).toBe('user')
  })

  it(`${MUST_NOT_CHANGE}: an agent-spawned child is stamped 'session:<parent>' — the actor half already exists, from the capability`, async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const issue = await o.reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    await o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/a' })
    const parent = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })

    const spawned = await o.relay({
      requestId: 'spawn-child',
      sessionId: parent.sessionId,
      router: 'messages',
      proc: 'spawnAgent',
      input: { issue: issue.id, harness: 'shell', prompt: 'do the thing' },
    })

    expect(spawned.ok).toBe(true)
    const childId = (spawned.result as { sessionId: SessionId }).sessionId
    // Actor = the calling session, resolved from the relay capability. There is
    // no second field recording WHICH HUMAN that agent is acting for.
    expect((await o.meta(childId)).spawnedBy).toBe(`session:${parent.sessionId}`)
  })
})

describe('oracle: who named this session', () => {
  it(`${NO_PERSON}: nameSource records the CLASS of writer ('user' | 'agent'), never which user or which agent`, async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const issue = await o.reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    await o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/a' })
    const agent = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })
    const human = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.relay({
      requestId: 'self-title',
      sessionId: agent.sessionId,
      router: 'sessions',
      proc: 'title',
      input: { name: 'named by me' },
    })
    await o.call.sessions.rename({ sessionId: human.sessionId, name: 'named by the operator' })

    expect((await o.meta(agent.sessionId)).nameSource).toBe('agent')
    expect((await o.meta(human.sessionId)).nameSource).toBe('user')
    // Two different agents would both stamp the identical 'agent' — the actor
    // half of the pair is NOT recorded on the row.
    const rows = await o.store.sessions.loadSessions()
    expect(rows.map((r) => r.nameSource).sort()).toEqual(['agent', 'user'])
  })
})

describe('oracle: who ended this session', () => {
  it(`${NO_PERSON}: a kill records deletion_source 'standalone' — the CAUSE class, with no actor at all`, async () => {
    const o = await makeOracle()
    await provisionHost(o)
    await answerLifecycle(o)
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.kill({ sessionId })

    const tombstone = (await o.store.sessions.loadDeletedSessions()).find((r) => r.id === sessionId)
    expect(tombstone?.deletionSource).toBe('standalone')
    expect(tombstone?.deletedByIssueId).toBeNull()
  })

  it(`${NO_PERSON}: archive's park records stopReason 'parent' — again a cause, not an actor`, async () => {
    const o = await makeOracle()
    await provisionHost(o)
    await answerLifecycle(o)
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/p',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })

    await o.call.sessions.setArchived({ sessionId, archived: true })

    expect(
      (await o.store.sessions.loadSessions()).find((r) => r.id === sessionId)?.stopReason,
    ).toBe('parent')
  })
})

describe('oracle: who typed into this session', () => {
  it(`${NO_PERSON}: PTY frames carry inputOrigin — 'human' for direct terminal input, 'controller' for a chat send`, async () => {
    const o = await makeOracle()
    await provisionHost(o)
    // Shells keep the raw PTY transport (POD-4427): harness sends ride the
    // runtime gateway and never produce input frames, so the wire attribution
    // is pinned here, where the bytes still exist. The property is unchanged:
    // direct keystrokes stamp human, chat sends stamp controller.
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const clientId = attachTestClient(o.reg.clientGateway, () => {})
    await o.reg.clientGateway.routeClientFrame(clientId, {
      type: 'hello',
      wireVersion: CLIENT_WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
    await o.reg.clientGateway.routeClientFrame(clientId, { type: 'attach', sessionId })
    await o.reg.clientGateway.routeClientFrame(clientId, { type: 'requestControl', sessionId })
    o.daemon.length = 0

    await o.reg.clientGateway.routeClientFrame(clientId, {
      type: 'input',
      sessionId,
      data: Buffer.from('x').toString('base64'),
    })
    await o.call.sessions.sendText({ sessionId, text: 'via the substrate' })

    // Both are the SAME operator; the field distinguishes direct terminal input
    // from controller-mediated user input. Agent/system delivery remains 'mail'.
    // EXACT sequence, not a substring: one human keystroke, one bracketed-paste
    // controller frame carrying the text and nothing else, plus its submit CR.
    expect(ptyFrames(o.daemon)).toEqual([
      { inputOrigin: 'human', data: 'x' },
      { inputOrigin: 'controller', data: `${PASTE_START}via the substrate${PASTE_END}` },
      { inputOrigin: 'controller', data: '\r' },
    ])
  })
})

describe('oracle: who asked the human a question', () => {
  it(`${NO_PERSON}: humanQuestionAskedBy is stamped from the transport principal, and an agent cannot attribute a question to another session`, async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const issue = await o.reg.issues.create({ repoPath: '/r', title: 'A', startNow: false })
    await o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/a' })
    const agent = await o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: issue.id,
    })

    const asked = await o.relay({
      requestId: 'needs-human',
      sessionId: agent.sessionId,
      router: 'issues',
      proc: 'setNeedsHuman',
      input: { id: issue.id, question: 'which way?' },
    })
    expect(asked.ok).toBe(true)

    // Stamped from the capability's actorSessionId — a bare session id, and the
    // only attribution the answer-routing path has to work with.
    expect((await o.reg.issues.getMeta(issue.id))?.humanQuestionAskedBy).toBe(agent.sessionId)

    // Payload identity is inert (ADR 3 D7): claiming to be someone else is refused.
    const spoofed = await o.relay({
      requestId: 'needs-human-spoof',
      sessionId: agent.sessionId,
      router: 'issues',
      proc: 'setNeedsHuman',
      input: { id: issue.id, question: 'and now?', askedBy: 'some-other-session' },
    })
    expect(spoofed.ok).toBe(false)
    expect(spoofed.error).toBe(
      'askedBy is server-authoritative: agents may only attribute a question to their own session (omit askedBy)',
    )
  })
})

describe('oracle: who moved this session between machines', () => {
  it(`${MUST_NOT_CHANGE}: handoff preserves the durable per-user session owner`, async () => {
    const o = await makeOracle()
    await provisionHost(o)
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })

    const row = (await o.store.sessions.loadSessions()).find((r) => r.id === sessionId)
    // Handoff changes placement without changing the durable human owner.
    expect(row?.ownerUserId).toBe(firstAdminMemberId())
    expect(
      Object.keys(row ?? {})
        .filter((k) => /source|by|actor|owner|user/i.test(k))
        .sort(),
    ).toEqual([
      // POD-1516: the session now carries its attribution PAIR, and this oracle
      // pins that handoff does not touch it — a move is not a re-creation.
      'createdBy',
      'deletedByIssueId',
      'deletionSource',
      'nameSource',
      'ownerUserId',
      'spawnedBy',
    ])
  })
})
