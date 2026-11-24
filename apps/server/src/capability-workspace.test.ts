/**
 * A CAPABILITY ACTS ONLY IN THE WORKSPACE IT WAS ISSUED IN (POD-7558).
 *
 * One server process will serve many workspaces. A capability crosses the
 * transport seam on its own: the daemon relay, the in-process MCP tools and
 * effect runs all hand a bare capability to a registry, which used to resolve
 * it as a principal of whichever store received it. Now the capability names
 * the workspace where it was minted, and every one of those paths refuses a
 * capability of another workspace before anything runs.
 *
 * The routing defect each test stands in for: a call made in workspace B
 * reaches workspace A's services. The fixture is A's registry. On the relay
 * the defect is real input today: a daemon socket bound to B delivering a
 * frame to A, and the relay stamps its capability from that binding. On MCP,
 * effects and the dispatcher, the foreign capability is A's own re-stamped
 * with B: those paths still mint from the receiving store, so production
 * cannot produce it until POD-7290 stamps them from the request's binding,
 * and these tests pin the checks that will then guard them.
 */

import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  asWorkspaceId,
  type Capability,
  firstAdminMemberId,
  type IssueId,
  type SessionId,
  type WorkspaceId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { agentCommandPrincipal } from './modules/effects/writer'
import { issueRegistry } from './modules/issues/registry'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { memberFacts } from './store/fixtures/test-support'
import { seedAgentSessions } from './test-support/agent-session-rows'
import { confirmingRetirement } from './test-support/host-daemon'
import { addMember } from './test-support/live-grant-fixture'
import { openTestStore } from './test-support/open-test-store'

type RelayResult = Extract<ControlMessage, { type: 'agentRelayResult' }>

const OTHER = asWorkspaceId('ws_other')
const machineId = 'm1'
const repoPath = '/r'
const NOT_A_MEMBER = { code: 'FORBIDDEN', message: 'not_workspace_member' }

let registry: SessionRegistry
let store: SessionStore
let issueId: IssueId
let session: SessionId
let replies: RelayResult[] = []

/** The same capability, as if minted in workspace B. */
const foreign = (capability: Capability): Capability => ({ ...capability, workspaceId: OTHER })

beforeAll(async () => {
  store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: machineId,
    name: 'host',
    hostname: 'host.local',
    tokenHash: 'hash-1',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  await store.repos.addRepo(repoPath, machineId as never)
  registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await registry.gateway.attachDaemon(
    machineId,
    confirmingRetirement(registry, machineId, (msg) => {
      if (msg.type === 'agentRelayResult') replies.push(msg)
    }),
  )
  const issue = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
    repoPath,
    title: 'subject',
    startNow: false,
  })
  issueId = asIssueId(issue.id)
  await registry.issues.crud.update(registry.issues.reports.store.serverWriter, issueId, {
    worktreePath: '/r/.worktrees/issue-1-subject',
  })
  session = asSessionId(
    (
      await registry.modules.sessions.createSession({
        cwd: '/r/.worktrees/issue-1-subject',
        agentKind: 'shell',
      })
    ).sessionId,
  )
})

afterAll(async () => {
  await registry.dispose()
})

/**
 * Send one relay frame from the session's machine and wait for its answer.
 * `bound` is the workspace the sending socket was bound to; absent, the frame
 * comes over the in-process link, which is the registry's own.
 */
async function relay(
  router: string,
  proc: string,
  input: unknown,
  from: { session?: SessionId; bound?: WorkspaceId } = {},
): Promise<RelayResult> {
  replies = []
  const requestId = `r-${router}-${proc}-${Math.random()}`
  registry.gateway.routeDaemonFrame(
    machineId,
    {
      type: 'agentRelayRequest',
      requestId,
      sessionId: from.session ?? session,
      router,
      proc,
      input,
    },
    from.bound,
  )
  await vi.waitFor(() => {
    if (!replies.some((r) => r.requestId === requestId)) throw new Error('no reply yet')
  })
  return replies.find((r) => r.requestId === requestId) as RelayResult
}

describe('a capability names the workspace whose store minted it', () => {
  it("stamps a relayed session's capability from its socket's binding, and a member's", async () => {
    const minted = await registry.modules.sessions.capabilityForSession(
      session,
      asMachineId(machineId),
      registry.workspaceId,
    )
    expect(minted.workspaceId).toBe(registry.workspaceId)
    // The in-process link has no socket: it is this store's own.
    expect((await registry.modules.sessions.capabilityForSession(session)).workspaceId).toBe(
      registry.workspaceId,
    )
    expect(
      userCommandPrincipal(registry.workspaceId, firstAdminMemberId(), 'admin').capability
        .workspaceId,
    ).toBe(registry.workspaceId)
  })
})

describe("another workspace's capability is refused", () => {
  // Built when a test runs: the issue id is set in `beforeAll`.
  const relayArms = () =>
    [
      ['issues', 'get', { id: issueId }],
      ['issues', 'mailInbox', {}],
      ['messages', 'inbox', {}],
      ['lock', 'status', { repoPath }],
      ['machines', 'list', {}],
      ['repos', 'inferFromPath', { path: repoPath }],
      ['sessions', 'status', {}],
    ] as const

  it('on the relay, from a daemon socket bound to another workspace, on every arm', async () => {
    const own = await relay('issues', 'get', { id: issueId }, { bound: registry.workspaceId })
    expect(own.ok).toBe(true)
    for (const [router, proc, input] of relayArms()) {
      const answer = await relay(router, proc, input, { bound: OTHER })
      expect({ router, proc, ok: answer.ok, error: answer.error }).toEqual({
        router,
        proc,
        ok: false,
        error: NOT_A_MEMBER.message,
      })
    }
  })

  it('on the relay, for a capability minted elsewhere that still reaches the dispatch', async () => {
    const own = await relay('issues', 'get', { id: issueId })
    expect(own.ok).toBe(true)

    const sessions = registry.modules.sessions
    const mint = sessions.capabilityForSession.bind(sessions)
    const spy = vi
      .spyOn(sessions, 'capabilityForSession')
      .mockImplementation(async (id, sender, bound) => foreign(await mint(id, sender, bound)))
    try {
      for (const [router, proc, input] of relayArms()) {
        const answer = await relay(router, proc, input)
        expect({ router, proc, ok: answer.ok, error: answer.error }).toEqual({
          router,
          proc,
          ok: false,
          error: NOT_A_MEMBER.message,
        })
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('on the MCP tools, reads and writes alike', async () => {
    const own = registry.issueCommands.asIssueTrpc(
      userCommandPrincipal(registry.workspaceId, firstAdminMemberId(), 'admin').capability,
    )
    await expect(own.issues.get.query({ id: issueId })).resolves.toMatchObject({ id: issueId })

    const tools = registry.issueCommands.asIssueTrpc(
      foreign(userCommandPrincipal(registry.workspaceId, firstAdminMemberId(), 'admin').capability),
    )
    await expect(tools.issues.get.query({ id: issueId })).rejects.toMatchObject(NOT_A_MEMBER)
    await expect(
      tools.issues.update.mutate({ id: issueId, patch: { brief: 'from another workspace' } }),
    ).rejects.toMatchObject(NOT_A_MEMBER)
    await expect(tools.repos.inferFromPath.query({ path: repoPath })).rejects.toMatchObject(
      NOT_A_MEMBER,
    )
    expect((await registry.issues.reports.get(issueId))?.brief ?? '').not.toContain(
      'another workspace',
    )
  })

  it('by the issue dispatcher, for a bare capability and for a principal of this workspace holding one', async () => {
    const member = userCommandPrincipal(registry.workspaceId, firstAdminMemberId(), 'admin')
    const dispatcher = registry.issueCommands
    await expect(
      dispatcher.dispatch({ capability: foreign(member.capability) }, 'issues', 'get', {
        id: issueId,
      }),
    ).rejects.toMatchObject(NOT_A_MEMBER)
    // The principal says this workspace; the capability it carries says
    // another. The check compares what the edge stamped, so it refuses.
    const mixed = { ...member, capability: foreign(member.capability) }
    await expect(
      dispatcher.dispatch({ capability: member.capability, principal: mixed }, 'issues', 'get', {
        id: issueId,
      }),
    ).rejects.toMatchObject(NOT_A_MEMBER)
    await expect(
      dispatcher.dispatch(
        { capability: member.capability, principal: { ...member, workspaceId: OTHER } },
        'issues',
        'get',
        { id: issueId },
      ),
    ).rejects.toMatchObject(NOT_A_MEMBER)
  })

  it("by an effect record's run, and by the resolver effects use for an agent", async () => {
    const member = userCommandPrincipal(registry.workspaceId, firstAdminMemberId(), 'admin')
    const run = registry.issueCommands.forEffectRun()
    const def = issueRegistry.defs.get
    await expect(
      run.run({ capability: foreign(member.capability), principal: member }, 'get', def, {
        id: issueId,
      }),
    ).rejects.toMatchObject(NOT_A_MEMBER)
    await expect(
      run.run(
        { capability: member.capability, principal: { ...member, workspaceId: OTHER } },
        'get',
        def,
        { id: issueId },
      ),
    ).rejects.toMatchObject(NOT_A_MEMBER)

    // An effect re-derives its agent's principal from this store at every
    // run; the same resolver refuses a capability minted elsewhere.
    expect(await agentCommandPrincipal(registry.modules, session)).toMatchObject({
      kind: 'agent',
      workspaceId: registry.workspaceId,
    })
    const minted = await registry.modules.sessions.capabilityForSession(session)
    await expect(registry.modules.sessions.principalFor(foreign(minted))).rejects.toMatchObject(
      NOT_A_MEMBER,
    )
  })
})

describe('a member who can no longer act is refused through the served resolver', () => {
  const BOB = asUserId('user:bob-7558')
  const notAMember = NOT_A_MEMBER

  beforeAll(async () => {
    await addMember(store, BOB, 'member')
    // Bob's agent on the relaying machine, and a sub-agent it spawned. The
    // sub-agent's own row names the first admin, so only the walk to its root
    // finds Bob: the root's owner is the human, not the leaf's.
    await seedAgentSessions(store, ['bob-root'], BOB, { machineId })
    await seedAgentSessions(store, ['bob-child'], firstAdminMemberId(), {
      machineId,
      spawnedBy: 'bob-root',
    })
  })

  it('resolves the agent and its sub-agent to Bob while he is a member, and refuses both once he is disabled', async () => {
    const sessions = registry.modules.sessions
    const rootCap = await sessions.capabilityForSession(asSessionId('bob-root'))
    const childCap = await sessions.capabilityForSession(asSessionId('bob-child'))
    expect(await sessions.principalFor(rootCap)).toMatchObject({ kind: 'agent', onBehalfOf: BOB })
    expect(await sessions.principalFor(childCap)).toMatchObject({
      kind: 'agent',
      onBehalfOf: BOB,
      chain: ['bob-root'],
    })

    await memberFacts(store).disable(BOB)

    // A capability minted before the change is re-checked at apply.
    await expect(sessions.principalFor(rootCap)).rejects.toMatchObject(notAMember)
    // The sub-agent's own owner is still a member; its root's is not.
    await expect(
      sessions.principalFor(await sessions.capabilityForSession(asSessionId('bob-child'))),
    ).rejects.toMatchObject(notAMember)
    // Minted after: the session's capability names nobody, and that is the
    // same refusal, never an internal error.
    await expect(
      sessions.principalFor(await sessions.capabilityForSession(asSessionId('bob-root'))),
    ).rejects.toMatchObject(notAMember)

    for (const [router, proc, input] of [
      ['issues', 'get', { id: issueId }],
      ['messages', 'send', { to: issueId, body: 'from a departed member' }],
    ] as const) {
      const answer = await relay(router, proc, input, {
        session: asSessionId('bob-root'),
        bound: registry.workspaceId,
      })
      expect({ router, proc, ok: answer.ok, error: answer.error }).toEqual({
        router,
        proc,
        ok: false,
        error: notAMember.message,
      })
    }
  })
})
