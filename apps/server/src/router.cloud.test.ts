import { asMachineId, asSessionId, asUserId } from '@podium/model'
import type { Capability, SessionId, UserId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { CloudAgentRequest, CloudRuntime, CloudRuntimeProvider } from './cloud-runtime'
import { resolvePrincipal } from './command-principal'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { OPERATOR } from './test-support/capabilities'

const geometry = { cols: 80, rows: 24 }

const bind = (sessionId: SessionId, cwd: string, agentKind: 'claude-code' | 'codex') =>
  ({
    type: 'bind',
    sessionId,
    cmd: agentKind === 'codex' ? 'codex' : 'claude',
    cwd,
    agentKind,
    geometry,
  }) as const

async function caller(
  cloud?: CloudRuntimeProvider,
  onDaemon: (message: ControlMessage) => void = () => {},
) {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, onDaemon)
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const as = (capability: Capability) =>
    appRouter.createCaller({
      registry,
      repos,
      superagent,
      cloud,
      capability,
      principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
    })
  return { call: as(OPERATOR), as, registry }
}

/**
 * A SECOND HUMAN, holding an ADMIN capability with scope `all` (PDM-290).
 *
 * The unconstrained scope is the point and not an accident. `assertMayCommandSession`
 * admits `scope: 'all'` outright, so this capability passes the SCOPE half of the
 * gate and the only thing left that can refuse it is the ownership half — which
 * is the defect under test. A narrower capability would refuse for two reasons
 * at once and the test could not say which one fired.
 */
const humanCapability = (user: UserId): Capability => ({
  role: 'admin',
  scope: { kind: 'all' },
  actorUser: user,
  onBehalfOf: user,
})

/** A thrown refusal and a returned value, reduced to one comparable shape. */
const settle = async (run: () => unknown): Promise<unknown> => {
  try {
    return { ok: await run() }
  } catch (error) {
    return { err: error instanceof Error ? error.message : String(error) }
  }
}

function captureCloudProvider(): {
  provider: CloudRuntimeProvider
  createdAgents: CloudAgentRequest[]
} {
  const createdAgents: CloudAgentRequest[] = []
  const runtime = (request: CloudAgentRequest): CloudRuntime => ({
    id: 'cloud-runtime-1',
    kind: 'cloud-agent',
    tenantId: request.tenantId,
    state: 'running',
    provider: 'test-cloud',
    displayName: request.displayName,
    machineId: asMachineId('sprite:podium-test'),
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    metadata: { request },
  })

  return {
    createdAgents,
    provider: {
      capabilities: async () => ({
        provider: 'test-cloud',
        cloudMachines: true,
        cloudAgents: true,
        previews: true,
        artifacts: false,
        wake: true,
        suspend: true,
        destroy: false,
      }),
      createCloudMachine: async () => {
        throw new Error('not used')
      },
      createCloudAgent: async (request) => {
        createdAgents.push(request)
        return runtime(request)
      },
      getRuntime: async () => null,
      stopRuntime: async () => {
        throw new Error('not used')
      },
      wakeRuntime: async () => {
        throw new Error('not used')
      },
    },
  }
}

describe('cloud router', () => {
  it('reports cloud disabled when no hosted provider is configured', async () => {
    const { call } = await caller()

    await expect(call.cloud.capabilities()).resolves.toEqual({
      provider: 'disabled',
      cloudMachines: false,
      cloudAgents: false,
      previews: false,
      artifacts: false,
      wake: false,
      suspend: false,
      destroy: false,
    })
  })

  it('rejects cloud runtime creation when no hosted provider is configured', async () => {
    const { call } = await caller()

    await expect(
      call.cloud.createAgent({
        tenantId: 'tenant_1',
        displayName: 'Demo cloud agent',
        repo: { provider: 'github', owner: 'madeinorbit', name: 'podium' },
      }),
    ).rejects.toThrow('cloud runtime provider is not configured')
  })

  it('moves a resumable codex session to a cloud agent request', async () => {
    const cloud = captureCloudProvider()
    const { call, registry } = await caller(cloud.provider)
    await registry.sessionStore.repos.addRepo(
      '/workspace/podium',
      registry.sessionStore.hostMachineId,
      'git@github.com:madeinorbit/podium.git',
    )
    const { sessionId } = await registry.modules.issueSessionLifecycle.resumeSession({
      agentKind: 'codex',
      cwd: '/workspace/podium',
      resume: { kind: 'codex-thread', value: 'thread-1' },
      conversationId: 'conversation-1',
      title: 'Continue Sprite integration',
      spawnedBy: 'user',
    })

    const runtime = await call.cloud.moveSession({
      sessionId,
      tenantId: 'tenant_1',
      size: 'medium',
    })

    expect(runtime.id).toBe('cloud-runtime-1')
    expect(cloud.createdAgents).toEqual([
      {
        tenantId: 'tenant_1',
        displayName: 'Continue Sprite integration',
        size: 'medium',
        repo: { provider: 'github', owner: 'madeinorbit', name: 'podium' },
        purpose: 'move-session',
        sourceSession: {
          sessionId,
          agent: 'codex',
          resumeRef: 'thread-1',
          cwd: '/workspace/podium',
          machineId: registry.sessionStore.hostMachineId,
        },
      },
    ])
  })

  it('can hibernate the local session after creating the cloud agent', async () => {
    const cloud = captureCloudProvider()
    const daemon: ControlMessage[] = []
    const { call, registry } = await caller(cloud.provider, (message) => daemon.push(message))
    await registry.sessionStore.repos.addRepo(
      '/workspace/podium',
      registry.sessionStore.hostMachineId,
      'https://github.com/madeinorbit/podium.git',
    )
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/workspace/podium',
      spawnedBy: 'user',
    })
    await registry.gateway.routeDaemonFrame(
      registry.sessionStore.hostMachineId,
      bind(sessionId, '/workspace/podium', 'claude-code'),
    )
    await registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'claude-resume-1' },
    })

    const runtime = await call.cloud.moveSession({
      sessionId,
      tenantId: 'tenant_1',
      hibernateLocal: true,
    })

    expect(runtime.id).toBe('cloud-runtime-1')
    expect(daemon).toContainEqual({ type: 'kill', sessionId, durableLabel: 'podium-' + sessionId })
    expect(
      (await registry.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)?.status,
    ).toBe('hibernated')
    expect(cloud.createdAgents.at(-1)).toMatchObject({
      sourceSession: {
        sessionId,
        agent: 'claude-code',
        resumeRef: 'claude-resume-1',
        cwd: '/workspace/podium',
        machineId: registry.sessionStore.hostMachineId,
      },
    })
  })

  /**
   * THE OWNERSHIP GATE (PDM-290).
   *
   * `moveSession` resolved its caller-supplied `sessionId` through `sessionById`
   * with the optional `forPrincipal` argument omitted — the unscoped arm — and
   * ran neither `resolveSessionTarget` nor `assertMayCommandSession`. Any
   * authenticated principal could therefore name any session id and have the
   * server seed a hosted runtime from that session's resume ref and cwd, which
   * is another human's conversation reconstituted on a machine the caller
   * controls; with `hibernateLocal` it also parked that human's live session.
   *
   * ASSERTED ON THE PROVISIONING THAT DID NOT HAPPEN, not on the error text. A
   * refusal that lands AFTER `createCloudAgent` throws the same message and
   * bills the same runtime, so the message proves nothing about the order. The
   * empty driver does, and it is the property `moveSession`'s own header states:
   * a request that cannot be honoured must not create a billed runtime.
   */
  describe('a session belongs to the human who started it', () => {
    const OWNER = asUserId('user:owner')
    const STRANGER = asUserId('user:stranger')
    const GHOST = asSessionId('11111111-2222-3333-4444-555555555555')

    /** A resumable session, owned by OWNER, in a repo with a GitHub origin —
     *  everything `moveSession` needs to reach the provider. */
    async function movableSession(ownerUserId: UserId) {
      const cloud = captureCloudProvider()
      const made = await caller(cloud.provider)
      await made.registry.sessionStore.repos.addRepo(
        '/workspace/podium',
        made.registry.sessionStore.hostMachineId,
        'git@github.com:madeinorbit/podium.git',
      )
      const { sessionId } = await made.registry.modules.issueSessionLifecycle.resumeSession({
        ownerUserId,
        agentKind: 'codex',
        cwd: '/workspace/podium',
        resume: { kind: 'codex-thread', value: 'thread-1' },
        conversationId: 'conversation-1',
        title: 'Continue Sprite integration',
        spawnedBy: 'user',
      })
      expect(await made.registry.modules.sessions.sessionOwner(sessionId)).toEqual({
        owner: ownerUserId,
        grants: [],
      })
      return { ...made, cloud, sessionId }
    }

    it("refuses another human's session and provisions nothing", async () => {
      const { as, cloud, sessionId } = await movableSession(OWNER)

      const refusal = await settle(() =>
        as(humanCapability(STRANGER)).cloud.moveSession({
          sessionId,
          tenantId: 'tenant_1',
          size: 'medium',
        }),
      )

      expect(refusal).toEqual({ err: 'session not found' })
      // THE CLAIM. Nothing was provisioned, so the refusal landed before the
      // provider call rather than after it.
      expect(cloud.createdAgents).toEqual([])
    })

    it('answers exactly as it answers for a session that does not exist', async () => {
      const { as, sessionId } = await movableSession(OWNER)
      const stranger = as(humanCapability(STRANGER))

      const onOwned = await settle(() =>
        stranger.cloud.moveSession({ sessionId, tenantId: 'tenant_1' }),
      )
      const onGhost = await settle(() =>
        stranger.cloud.moveSession({ sessionId: GHOST, tenantId: 'tenant_1' }),
      )

      // ADR 3 Amendment 1 D20.2: invisible and nonexistent are ONE answer, or
      // the surface is an existence oracle for every session on the instance.
      expect(onOwned).toEqual(onGhost)
    })

    it('still moves a session for the human who owns it', async () => {
      const { as, cloud, sessionId } = await movableSession(STRANGER)

      // THE INSTRUMENT CAN SAY YES. Without this the two refusals above would
      // hold just as well in a build where the gate refused everybody, and the
      // owner here is NOT the first admin, so it cannot pass by the two
      // identities coinciding.
      const runtime = await as(humanCapability(STRANGER)).cloud.moveSession({
        sessionId,
        tenantId: 'tenant_1',
        size: 'medium',
      })

      expect(runtime.id).toBe('cloud-runtime-1')
      expect(cloud.createdAgents).toHaveLength(1)
      expect(cloud.createdAgents[0]?.sourceSession).toMatchObject({ sessionId, agent: 'codex' })
    })

    it('refuses to hibernate a session the caller does not own', async () => {
      const { as, cloud, registry, sessionId } = await movableSession(OWNER)

      const refusal = await settle(() =>
        as(humanCapability(STRANGER)).cloud.moveSession({
          sessionId,
          tenantId: 'tenant_1',
          hibernateLocal: true,
        }),
      )

      expect(refusal).toEqual({ err: 'session not found' })
      expect(cloud.createdAgents).toEqual([])
      // The second half of the consequence: the owner's session is untouched.
      expect(
        (await registry.modules.sessions.listSessions(undefined, 'rpc')).find(
          (session) => session.sessionId === sessionId,
        )?.status,
      ).not.toBe('hibernated')
    })
  })

  it('rejects moving a session without a resume ref', async () => {
    const cloud = captureCloudProvider()
    const { call, registry } = await caller(cloud.provider)
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/workspace/podium',
      spawnedBy: 'user',
    })

    await expect(
      call.cloud.moveSession({
        sessionId,
        tenantId: 'tenant_1',
        repo: { provider: 'github', owner: 'madeinorbit', name: 'podium' },
      }),
    ).rejects.toThrow('session has no resume ref')
  })
})
