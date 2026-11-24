import type { SessionId } from '@podium/model'
import { asMachineId, asUserId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CloudAgentRequest,
  CloudMachineRequest,
  CloudRuntime,
  CloudRuntimeProvider,
} from './cloud-runtime'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import type { SessionStore } from './store'
import { memberFacts } from './store/fixtures/test-support'
import { OPERATOR, permissiveFixturePrincipal } from './test-support/capabilities'
import { attachHostDaemon } from './test-support/host-daemon'
import { openWorkspaceStores } from './test-support/workspace-stores'

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
  options: { store?: SessionStore; bound?: 'store' | 'none' } = {},
) {
  const registry = await SessionRegistry.create(options.store, undefined, {
    instanceId: 'default',
  })
  await attachHostDaemon(registry, onDaemon)
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  // The operator as the edge of this registry's workspace mints it (POD-7558).
  const operator = { ...OPERATOR, workspaceId: registry.workspaceId }
  const call = appRouter.createCaller({
    registry,
    repos,
    // The edge binds every request to the registry's workspace (server.ts
    // createContext); `none` stands for a caller that is not a request.
    ...(options.bound === 'none' ? {} : { boundWorkspace: registry.sessionStore.workspaceId }),
    superagent,
    cloud,
    capability: operator,
    principal: permissiveFixturePrincipal(registry.workspaceId, operator),
  })
  return { call, registry }
}

/** An older client's input: it still sends the `tenantId` the contracts no
 *  longer declare. The cast is the point, since the type now has no such field. */
const fromOlderClient = <T extends object>(input: T, tenantId: string): T =>
  ({ ...input, tenantId }) as T

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
      registry.sessionStore.hostMachine!.id,
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

    const runtime = await call.cloud.moveSession({ sessionId, size: 'medium' })

    expect(runtime.id).toBe('cloud-runtime-1')
    expect(cloud.createdAgents).toEqual([
      {
        // The tenant is the bound workspace; no input names one.
        tenantId: registry.sessionStore.workspaceId,
        displayName: 'Continue Sprite integration',
        size: 'medium',
        repo: { provider: 'github', owner: 'madeinorbit', name: 'podium' },
        purpose: 'move-session',
        sourceSession: {
          sessionId,
          agent: 'codex',
          resumeRef: 'thread-1',
          cwd: '/workspace/podium',
          machineId: registry.sessionStore.hostMachine!.id,
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
      registry.sessionStore.hostMachine!.id,
      'https://github.com/madeinorbit/podium.git',
    )
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/workspace/podium',
      spawnedBy: 'user',
    })
    await registry.gateway.routeDaemonFrame(
      registry.sessionStore.hostMachine!.id,
      bind(sessionId, '/workspace/podium', 'claude-code'),
    )
    await registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachine!.id, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'claude-resume-1' },
    })

    const runtime = await call.cloud.moveSession({ sessionId, hibernateLocal: true })

    expect(runtime.id).toBe('cloud-runtime-1')
    // The park retires the local process through the driver lifecycle and waits
    // for the daemon's confirmation (722704624, POD-4302); it used to be a raw
    // `kill` frame. The fixture daemon confirms like a real one, so the legacy
    // `kill` escalation for an unconfirmed retirement is not sent.
    expect(
      daemon.filter((m) => m.type === 'runtimeLifecycleRequest' && m.sessionId === sessionId),
    ).toEqual([
      { type: 'runtimeLifecycleRequest', requestId: expect.any(String), sessionId, verb: 'stop' },
    ])
    expect(daemon.filter((m) => m.type === 'kill')).toEqual([])
    expect(
      (await registry.modules.sessions.listSessions(undefined, 'rpc')).find(
        (s) => s.sessionId === sessionId,
      )?.status,
    ).toBe('hibernated')
    expect(cloud.createdAgents.at(-1)).toMatchObject({
      sourceSession: {
        sessionId,
        agent: 'claude-code',
        resumeRef: 'claude-resume-1',
        cwd: '/workspace/podium',
        machineId: registry.sessionStore.hostMachine!.id,
      },
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
        repo: { provider: 'github', owner: 'madeinorbit', name: 'podium' },
      }),
    ).rejects.toThrow('session has no resume ref')
  })
})

/**
 * TWO WORKSPACES, ONE PROVIDER (POD-7310). The provider holds one credential for
 * every tenant, so it answers any runtime id it knows; the server is what keeps
 * a member of A off B's runtimes. A and B share one database, as on hosted.
 */
describe('cloud commands act on the bound workspace only', () => {
  const open: SessionStore[] = []
  afterEach(async () => {
    await open[0]?.close()
    open.length = 0
  })

  /** A provider that knows a runtime in each workspace and records every act. */
  function sharedProvider(tenants: { a: string; b: string }) {
    const at = '2026-11-23T10:00:00.000Z'
    const runtimes = new Map<string, CloudRuntime>()
    const make = (id: string, tenantId: string, kind: CloudRuntime['kind']): CloudRuntime => ({
      id,
      kind,
      tenantId,
      state: 'running',
      provider: 'test-cloud',
      displayName: id,
      machineId: asMachineId(`sprite:${id}`),
      createdAt: at,
      updatedAt: at,
    })
    runtimes.set('rt_a', make('rt_a', tenants.a, 'cloud-machine'))
    runtimes.set('rt_b', make('rt_b', tenants.b, 'cloud-machine'))
    const acts: string[] = []
    const machines: CloudMachineRequest[] = []
    const agents: CloudAgentRequest[] = []
    const provider: CloudRuntimeProvider = {
      capabilities: async () => ({
        provider: 'test-cloud',
        cloudMachines: true,
        cloudAgents: true,
        previews: false,
        artifacts: false,
        wake: true,
        suspend: true,
        destroy: false,
      }),
      createCloudMachine: async (request) => {
        machines.push(request)
        return make(`rt_new_${machines.length}`, request.tenantId, 'cloud-machine')
      },
      createCloudAgent: async (request) => {
        agents.push(request)
        return make(`rt_agent_${agents.length}`, request.tenantId, 'cloud-agent')
      },
      getRuntime: async (id) => runtimes.get(id) ?? null,
      stopRuntime: async (id) => {
        acts.push(`stop ${id}`)
        return { ...runtimes.get(id)!, state: 'stopped' }
      },
      wakeRuntime: async (id) => {
        acts.push(`wake ${id}`)
        return runtimes.get(id)!
      },
    }
    return { provider, acts, machines, agents }
  }

  /** A workspace's own first admin: its people are its own (POD-7019), so a
   *  workspace provisioned in a shared database starts with none. */
  async function withAdmin(store: SessionStore): Promise<SessionStore> {
    if (await store.users.earliestAdmin()) return store
    await memberFacts(store).create({
      id: asUserId(`usr_admin_${store.workspaceId}`),
      displayName: 'Admin',
      email: null,
      role: 'admin',
      createdAt: '2026-11-23T10:00:00.000Z',
      disabledAt: null,
    })
    return store
  }

  async function workspaceStores<const Ids extends readonly [string, ...string[]]>(ids: Ids) {
    const stores = await openWorkspaceStores(ids, { path: ':memory:' })
    open.push(...stores)
    for (const store of stores) await withAdmin(store)
    return stores
  }

  async function twoWorkspaces() {
    const [storeA, storeB] = await workspaceStores(['ws_cloud_a', 'ws_cloud_b'])
    const cloud = sharedProvider({ a: storeA.workspaceId, b: storeB.workspaceId })
    const a = await caller(cloud.provider, () => {}, { store: storeA })
    const b = await caller(cloud.provider, () => {}, { store: storeB })
    return { cloud, a, b, A: storeA.workspaceId, B: storeB.workspaceId }
  }

  it('a member of A cannot get, stop or wake a runtime of B', async () => {
    const { cloud, a, b } = await twoWorkspaces()

    // Another workspace's runtime reads like an unknown id.
    await expect(a.call.cloud.runtime({ id: 'rt_b' })).resolves.toBeNull()
    await expect(a.call.cloud.runtime({ id: 'rt_unknown' })).resolves.toBeNull()
    await expect(a.call.cloud.runtime({ id: 'rt_a' })).resolves.toMatchObject({ id: 'rt_a' })

    // Stop and wake of B's runtime are refused BEFORE the provider is asked to act,
    // with the same answer as an unknown id.
    await expect(a.call.cloud.stop({ id: 'rt_b' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'cloud runtime not found',
    })
    await expect(a.call.cloud.wake({ id: 'rt_b' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'cloud runtime not found',
    })
    await expect(a.call.cloud.stop({ id: 'rt_unknown' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'cloud runtime not found',
    })
    expect(cloud.acts).toEqual([])

    // Each workspace still acts on its own runtime.
    await expect(a.call.cloud.stop({ id: 'rt_a' })).resolves.toMatchObject({ state: 'stopped' })
    await expect(b.call.cloud.wake({ id: 'rt_b' })).resolves.toMatchObject({ id: 'rt_b' })
    expect(cloud.acts).toEqual(['stop rt_a', 'wake rt_b'])
  })

  it('a member of A cannot move a session of B, and a move lands in A', async () => {
    const { cloud, a, b, A } = await twoWorkspaces()
    const resumable = async (registry: SessionRegistry) =>
      (
        await registry.modules.issueSessionLifecycle.resumeSession({
          agentKind: 'codex',
          cwd: '/workspace/podium',
          resume: { kind: 'codex-thread', value: 'thread-1' },
          conversationId: 'conversation-1',
          title: 'Move me',
          spawnedBy: 'user',
        })
      ).sessionId
    const repo = { provider: 'github', owner: 'madeinorbit', name: 'podium' } as const
    const sessionOfB = await resumable(b.registry)

    // B's session does not exist in A's workspace.
    await expect(a.call.cloud.moveSession({ sessionId: sessionOfB, repo })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'session not found',
    })
    expect(cloud.agents).toEqual([])

    const sessionOfA = await resumable(a.registry)
    await a.call.cloud.moveSession({ sessionId: sessionOfA, repo })
    expect(cloud.agents.map((request) => request.tenantId)).toEqual([A])
  })

  it('an older client sending another workspace’s tenantId acts on its own bound workspace only', async () => {
    const { cloud, a, A, B } = await twoWorkspaces()
    const repo = { provider: 'github', owner: 'madeinorbit', name: 'podium' } as const

    // The field is IGNORED: the parse strips it, and the bound workspace is the tenant.
    const machine = await a.call.cloud.createMachine(
      fromOlderClient({ displayName: 'Old client machine', size: 'small' }, B),
    )
    const agent = await a.call.cloud.createAgent(
      fromOlderClient({ displayName: 'Old client agent', repo }, B),
    )
    expect(machine.tenantId).toBe(A)
    expect(agent.tenantId).toBe(A)
    expect(cloud.machines).toEqual([
      { displayName: 'Old client machine', size: 'small', tenantId: A },
    ])
    expect(cloud.agents).toEqual([{ displayName: 'Old client agent', repo, tenantId: A }])

    const { sessionId } = await a.registry.modules.issueSessionLifecycle.resumeSession({
      agentKind: 'codex',
      cwd: '/workspace/podium',
      resume: { kind: 'codex-thread', value: 'thread-1' },
      conversationId: 'conversation-1',
      title: 'Old client move',
      spawnedBy: 'user',
    })
    await a.call.cloud.moveSession(fromOlderClient({ sessionId, repo }, B))
    expect(cloud.agents.at(-1)?.tenantId).toBe(A)

    // Naming B as the tenant opens none of B's runtimes either.
    await expect(a.call.cloud.stop(fromOlderClient({ id: 'rt_b' }, B))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(cloud.acts).toEqual([])
  })

  it('refuses a cloud command with no bound workspace rather than guess one', async () => {
    const [store] = await workspaceStores(['ws_cloud_unbound'])
    const cloud = sharedProvider({ a: store.workspaceId, b: 'ws_other' })
    const { call } = await caller(cloud.provider, () => {}, { store, bound: 'none' })
    await expect(
      call.cloud.createMachine({ displayName: 'Unbound', size: 'small' }),
    ).rejects.toThrow('cloud commands need a request bound to a workspace')
    await expect(call.cloud.stop({ id: 'rt_a' })).rejects.toThrow(
      'cloud commands need a request bound to a workspace',
    )
    expect(cloud.machines).toEqual([])
    expect(cloud.acts).toEqual([])
  })

  it('refuses a provider answer that names another workspace', async () => {
    const [store] = await workspaceStores(['ws_cloud_answer'])
    const cloud = sharedProvider({ a: store.workspaceId, b: 'ws_other' })
    const misrouting: CloudRuntimeProvider = {
      ...cloud.provider,
      createCloudMachine: async (request) => ({
        ...(await cloud.provider.createCloudMachine(request)),
        tenantId: 'ws_other',
      }),
    }
    const { call } = await caller(misrouting, () => {}, { store })
    await expect(
      call.cloud.createMachine({ displayName: 'Misrouted', size: 'small' }),
    ).rejects.toThrow('cloud provider answered with a runtime of another workspace')
  })
})
