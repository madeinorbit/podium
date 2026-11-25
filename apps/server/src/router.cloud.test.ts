import type { SessionId, UserId } from '@podium/model'
import { asMachineId, asUserId, firstAdminMemberId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudAgentRequest,
  CloudMachineRequest,
  CloudRuntime,
  CloudRuntimeProvider,
} from './cloud-runtime'
import { userCommandPrincipal } from './command-principal'
import type { Capability } from './issue-authz'
import { CLOUD_SESSION_READ_FAILED } from './modules/cloud/service'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import type { SessionStore } from './store'
import { memberFacts } from './store/fixtures/test-support'
import { permissiveFixturePrincipal } from './test-support/capabilities'
import { attachDaemonWithInventory } from './test-support/daemon-inventory'
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
  // The operator as the edge of this registry's workspace mints it (POD-7558):
  // its first admin, who owns the sessions a test starts without naming an owner.
  const admin = asUserId(
    (await registry.sessionStore.users.earliestAdmin())?.id ?? firstAdminMemberId(),
  )
  const operator = userCommandPrincipal(registry.workspaceId, admin, 'admin').capability
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

/**
 * A MOVE REACHES THE CALLER'S OWN SESSIONS ONLY (POD-7606). The contract's row
 * gate is the machine; the session is gated by the session commands' own target
 * check: its owner, and nobody else's, admin or not (design §2.3). A refusal
 * reads exactly like a session that does not exist, and nothing is provisioned.
 */
describe('cloud.moveSession acts on the caller’s own sessions only', () => {
  const open: SessionStore[] = []
  afterEach(async () => {
    await open[0]?.close()
    open.length = 0
  })

  const ADMIN = asUserId('usr_move_admin')
  const ALICE = asUserId('usr_move_alice')
  const BOB = asUserId('usr_move_bob')
  const repo = { provider: 'github', owner: 'madeinorbit', name: 'podium' } as const

  async function world() {
    const [store] = await openWorkspaceStores(['ws_cloud_move'], { path: ':memory:' })
    open.push(store)
    const people = [
      [ADMIN, 'admin'],
      [ALICE, 'member'],
      [BOB, 'member'],
    ] as const
    for (const [id, role] of people) {
      await memberFacts(store).create({
        id,
        displayName: id,
        email: null,
        role,
        createdAt: '2026-11-25T10:00:00.000Z',
        disabledAt: null,
      })
    }
    const cloud = captureCloudProvider()
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(
      registry.modules,
      repos,
      registry.sessionStore,
    )

    // Each person on a machine of their own: custody grants them `use` there.
    const sessionOf = new Map<UserId, SessionId>()
    for (const [id] of people) {
      const machineId = asMachineId(`machine-${id}`)
      await store.machines.upsertMachine({
        id: machineId,
        name: machineId,
        hostname: machineId,
        tokenHash: `${machineId}-token`,
        ownerUserId: id,
        assignment: { server: false, agentExecution: true },
      })
      await attachDaemonWithInventory(registry, machineId)
      const { sessionId } = await registry.modules.issueSessionLifecycle.resumeSession({
        ownerUserId: id,
        agentKind: 'codex',
        cwd: '/workspace/podium',
        resume: { kind: 'codex-thread', value: `thread-${id}` },
        conversationId: `conversation-${id}`,
        title: `${id}'s session`,
        machineId,
        spawnedBy: 'user',
      })
      sessionOf.set(id, sessionId)
    }

    /** A caller holding `capability`, resolved as the served edge resolves it. */
    const holding = async (capability: Capability) =>
      appRouter.createCaller({
        registry,
        repos,
        boundWorkspace: registry.sessionStore.workspaceId,
        superagent,
        cloud: cloud.provider,
        capability,
        // The served resolver, over this store's member rows (POD-7558).
        principal: await registry.modules.sessions.principalFor(capability),
      })
    // As the edge mints a signed-in person's capability.
    const as = async (user: UserId, role: 'admin' | 'member') =>
      await holding(userCommandPrincipal(registry.workspaceId, user, role).capability)
    const session = (owner: UserId) => sessionOf.get(owner)!
    /** Another resumable session of `owner`'s, on their own machine. */
    const another = async (owner: UserId) =>
      (
        await registry.modules.issueSessionLifecycle.resumeSession({
          ownerUserId: owner,
          agentKind: 'codex',
          cwd: '/workspace/podium',
          resume: { kind: 'codex-thread', value: `thread-${crypto.randomUUID()}` },
          conversationId: `conversation-${crypto.randomUUID()}`,
          title: `another of ${owner}`,
          machineId: asMachineId(`machine-${owner}`),
          spawnedBy: 'user',
        })
      ).sessionId
    return { cloud, registry, store, as, holding, session, another }
  }

  const notFound = { code: 'NOT_FOUND', message: 'session not found' }

  it('a member cannot move another member’s session, and learns nothing about it', async () => {
    const { cloud, registry, as, session } = await world()
    const bob = await as(BOB, 'member')

    await expect(bob.cloud.moveSession({ sessionId: session(ALICE), repo })).rejects.toMatchObject(
      notFound,
    )
    // With hibernateLocal too: Alice's session is neither provisioned nor parked.
    await expect(
      bob.cloud.moveSession({ sessionId: session(ALICE), repo, hibernateLocal: true }),
    ).rejects.toMatchObject(notFound)
    // The same answer as an id that names no session at all.
    await expect(
      bob.cloud.moveSession({ sessionId: 'ses_missing' as SessionId, repo }),
    ).rejects.toMatchObject(notFound)
    expect(cloud.createdAgents).toEqual([])
    expect((await registry.modules.sessions.sessionById(session(ALICE)))?.status).not.toBe(
      'hibernated',
    )
  })

  it('an admin cannot move a member’s session either', async () => {
    const { cloud, as, session } = await world()
    const admin = await as(ADMIN, 'admin')
    await expect(
      admin.cloud.moveSession({ sessionId: session(ALICE), repo }),
    ).rejects.toMatchObject(notFound)
    expect(cloud.createdAgents).toEqual([])
  })

  it('the owner moves their own session, member or admin', async () => {
    const { cloud, as, session } = await world()
    await (await as(ALICE, 'member')).cloud.moveSession({ sessionId: session(ALICE), repo })
    await (await as(ADMIN, 'admin')).cloud.moveSession({ sessionId: session(ADMIN), repo })
    expect(cloud.createdAgents.map((request) => request.sourceSession?.sessionId)).toEqual([
      session(ALICE),
      session(ADMIN),
    ])
    expect(cloud.createdAgents.map((request) => request.sourceSession?.resumeRef)).toEqual([
      `thread-${ALICE}`,
      `thread-${ADMIN}`,
    ])
  })

  it('an agent moves its human’s sessions inside its issue scope only', async () => {
    const { cloud, registry, store, holding, session, another } = await world()
    // The tasks' repo, away from the sessions' cwd: each session is attached to
    // its task explicitly below.
    await store.repos.addRepo('/workspace/tasks', registry.sessionStore.hostMachine!.id)
    const writer = registry.issues.reports.store.serverWriter
    const create = async (title: string) =>
      await registry.issues.crud.create(writer, {
        repoPath: '/workspace/tasks',
        title,
        // Named, so create does not wait on a daemon to probe the repo's base.
        parentBranch: 'main',
        startNow: false,
      })
    const inScope = await create('the agent’s task')
    const elsewhere = await create('another task')
    const attach = async (sessionId: SessionId, issueId: string) =>
      await registry.modules.sessions.setSessionIssueId(
        registry.modules.sessions.serverWriter,
        sessionId,
        issueId as never,
      )
    // Alice's agent works on `inScope`; it acts for Alice and nobody else.
    const agentSession = await another(ALICE)
    await attach(agentSession, inScope.id)
    const sameTask = await another(ALICE)
    await attach(sameTask, inScope.id)
    const otherTask = await another(ALICE)
    await attach(otherTask, elsewhere.id)
    // The capability the relay mints for the agent's own calls.
    const capability = await registry.modules.sessions.capabilityForSession(agentSession)
    expect(await registry.modules.sessions.principalFor(capability)).toMatchObject({
      kind: 'agent',
      onBehalfOf: ALICE,
    })
    const agentCaller = await holding(capability)
    // Inside its scope: the move goes through.
    await agentCaller.cloud.moveSession({ sessionId: sameTask, repo })
    expect(cloud.createdAgents.map((request) => request.sourceSession?.sessionId)).toEqual([
      sameTask,
    ])
    // Its human's session on another task: refused by the scope rule, and the
    // agent cannot confirm through it, since a move takes no override.
    await expect(
      agentCaller.cloud.moveSession({ sessionId: otherTask, repo }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: /outside your subtree/ })
    // Another member's session reads as missing, as it does for a person.
    await expect(
      agentCaller.cloud.moveSession({ sessionId: session(BOB), repo }),
    ).rejects.toMatchObject(notFound)
    expect(cloud.createdAgents).toHaveLength(1)
  })

  it('the owner is refused once their use of the session’s machine is taken away', async () => {
    const { cloud, registry, as, session } = await world()
    const admin = await as(ADMIN, 'admin')
    const alice = await as(ALICE, 'member')
    // The admin takes custody of Alice's machine: Alice still owns her session
    // on it, but may no longer run agents there.
    await admin.machines.transferOwnership({
      id: asMachineId(`machine-${ALICE}`),
      newOwnerUserId: ADMIN,
    })
    const refused = alice.cloud.moveSession({
      sessionId: session(ALICE),
      repo,
      hibernateLocal: true,
    })
    // Her own session, so the refusal names its rule rather than hiding it.
    await expect(refused).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: /you do not have access to run agents on machine/,
    })
    expect(cloud.createdAgents).toEqual([])
    expect((await registry.modules.sessions.sessionById(session(ALICE)))?.status).not.toBe(
      'hibernated',
    )
    // And custody gives the admin no move of the session either.
    await expect(
      admin.cloud.moveSession({ sessionId: session(ALICE), repo }),
    ).rejects.toMatchObject(notFound)
    expect(cloud.createdAgents).toEqual([])
  })

  it('a failed read beneath the gate is a generic internal error, never the driver’s text', async () => {
    const { cloud, registry, as, session } = await world()
    const driverText = 'SQLITE_BUSY: database is locked (pool timeout on sessions_pkey)'
    const read = vi
      .spyOn(registry.modules.sessions, 'sessionById')
      .mockRejectedValue(new Error(driverText))
    try {
      const alice = await as(ALICE, 'member')
      const admin = await as(ADMIN, 'admin')
      const generic = { code: 'INTERNAL_SERVER_ERROR', message: CLOUD_SESSION_READ_FAILED }
      const moved = alice.cloud.moveSession({ sessionId: session(ALICE), repo })
      await expect(moved).rejects.toMatchObject(generic)
      const seeded = admin.cloud.createAgent({
        displayName: 'Seeded',
        repo,
        sourceSession: { sessionId: session(ADMIN), agent: 'codex' },
      })
      await expect(seeded).rejects.toMatchObject(generic)
      for (const attempt of [moved, seeded]) {
        const error = await attempt.catch((caught: unknown) => caught)
        expect(JSON.stringify(error)).not.toContain('SQLITE_BUSY')
        expect((error as { cause?: unknown }).cause).toBeUndefined()
      }
      expect(read).toHaveBeenCalled()
      expect(cloud.createdAgents).toEqual([])
    } finally {
      read.mockRestore()
    }
  })
})

/**
 * A NEW AGENT IS SEEDED FROM THE CALLER'S OWN SESSION ONLY (POD-7612).
 * `cloud.createAgent` is admin-only, and on hosted a workspace has several
 * admins; sessions stay private from all of them (design §2.3). The source
 * goes through the same gate as a move, before anything is read, forwarded or
 * provisioned, and what reaches the provider is built from the session's row.
 */
describe('cloud.createAgent seeds from the caller’s own session only', () => {
  const open: SessionStore[] = []
  afterEach(async () => {
    await open[0]?.close()
    open.length = 0
  })

  const ADMIN = asUserId('usr_seed_admin')
  const ALICE = asUserId('usr_seed_alice')
  const repo = { provider: 'github', owner: 'madeinorbit', name: 'podium' } as const

  async function world() {
    const [store] = await openWorkspaceStores(['ws_cloud_seed'], { path: ':memory:' })
    open.push(store)
    for (const [id, role] of [
      [ADMIN, 'admin'],
      [ALICE, 'member'],
    ] as const) {
      await memberFacts(store).create({
        id,
        displayName: id,
        email: null,
        role,
        createdAt: '2026-11-25T10:00:00.000Z',
        disabledAt: null,
      })
    }
    const cloud = captureCloudProvider()
    const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(
      registry.modules,
      repos,
      registry.sessionStore,
    )
    const sessionOf = new Map<UserId, SessionId>()
    for (const id of [ADMIN, ALICE]) {
      const machineId = asMachineId(`machine-${id}`)
      await store.machines.upsertMachine({
        id: machineId,
        name: machineId,
        hostname: machineId,
        tokenHash: `${machineId}-token`,
        ownerUserId: id,
        assignment: { server: false, agentExecution: true },
      })
      await attachDaemonWithInventory(registry, machineId)
      const { sessionId } = await registry.modules.issueSessionLifecycle.resumeSession({
        ownerUserId: id,
        agentKind: 'codex',
        cwd: `/workspace/${id}`,
        resume: { kind: 'codex-thread', value: `thread-${id}` },
        conversationId: `conversation-${id}`,
        title: `${id}'s session`,
        machineId,
        spawnedBy: 'user',
      })
      sessionOf.set(id, sessionId)
    }
    const as = async (user: UserId, role: 'admin' | 'member') => {
      const { capability } = userCommandPrincipal(registry.workspaceId, user, role)
      return appRouter.createCaller({
        registry,
        repos,
        boundWorkspace: registry.sessionStore.workspaceId,
        superagent,
        cloud: cloud.provider,
        capability,
        principal: await registry.modules.sessions.principalFor(capability),
      })
    }
    return { cloud, as, session: (owner: UserId) => sessionOf.get(owner)! }
  }

  const notFound = { code: 'NOT_FOUND', message: 'session not found' }
  const seed = (sourceSession: {
    sessionId: SessionId
    agent: 'codex' | 'claude-code'
    resumeRef?: string
    cwd?: string
    machineId?: ReturnType<typeof asMachineId>
  }) => ({ displayName: 'Seeded agent', repo, sourceSession })

  it('an admin naming a member’s session is refused exactly like a missing one', async () => {
    const { cloud, as, session } = await world()
    const admin = await as(ADMIN, 'admin')
    // Even with every field the member's row holds, stated correctly.
    await expect(
      admin.cloud.createAgent(
        seed({
          sessionId: session(ALICE),
          agent: 'codex',
          resumeRef: `thread-${ALICE}`,
          cwd: `/workspace/${ALICE}`,
          machineId: asMachineId(`machine-${ALICE}`),
        }),
      ),
    ).rejects.toMatchObject(notFound)
    await expect(
      admin.cloud.createAgent(seed({ sessionId: 'ses_missing' as SessionId, agent: 'codex' })),
    ).rejects.toMatchObject(notFound)
    expect(cloud.createdAgents).toEqual([])
  })

  it('a member is refused the command, foreign source or missing alike', async () => {
    const { cloud, as, session } = await world()
    const alice = await as(ALICE, 'member')
    const foreign = await alice.cloud
      .createAgent(seed({ sessionId: session(ADMIN), agent: 'codex' }))
      .catch((error: unknown) => error)
    const missing = await alice.cloud
      .createAgent(seed({ sessionId: 'ses_missing' as SessionId, agent: 'codex' }))
      .catch((error: unknown) => error)
    expect(foreign).toMatchObject({ code: 'FORBIDDEN' })
    expect(missing).toMatchObject({
      code: (foreign as { code: string }).code,
      message: (foreign as { message: string }).message,
    })
    expect(cloud.createdAgents).toEqual([])
  })

  it('the owner seeds from their own session, and the row is what is forwarded', async () => {
    const { cloud, as, session } = await world()
    const admin = await as(ADMIN, 'admin')
    await admin.cloud.createAgent(seed({ sessionId: session(ADMIN), agent: 'codex' }))
    expect(cloud.createdAgents.at(-1)?.sourceSession).toEqual({
      sessionId: session(ADMIN),
      agent: 'codex',
      resumeRef: `thread-${ADMIN}`,
      cwd: `/workspace/${ADMIN}`,
      machineId: asMachineId(`machine-${ADMIN}`),
    })
  })

  it('the owner cannot pair their session with another machine or resume ref', async () => {
    const { cloud, as, session } = await world()
    const admin = await as(ADMIN, 'admin')
    await expect(
      admin.cloud.createAgent(
        seed({
          sessionId: session(ADMIN),
          agent: 'codex',
          machineId: asMachineId(`machine-${ALICE}`),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'sourceSession.machineId does not match the session',
    })
    await expect(
      admin.cloud.createAgent(
        seed({ sessionId: session(ADMIN), agent: 'codex', resumeRef: `thread-${ALICE}` }),
      ),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'sourceSession.resumeRef does not match the session',
    })
    expect(cloud.createdAgents).toEqual([])
  })
})
