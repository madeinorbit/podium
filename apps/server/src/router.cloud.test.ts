import { describe, expect, it } from 'vitest'
import type { CloudAgentRequest, CloudRuntime, CloudRuntimeProvider } from './cloud-runtime'
import { OPERATOR } from './issue-authz'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { SuperagentService } from './superagent'

function caller(cloud?: CloudRuntimeProvider) {
  const registry = new SessionRegistry()
  registry.attachDaemon('local', () => {})
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = new SuperagentService(registry, repos, registry.sessionStore)
  const call = appRouter.createCaller({ registry, repos, superagent, cloud, capability: OPERATOR })
  return { call, registry }
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
    machineId: 'sprite:podium-test',
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
    const { call } = caller()

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
    const { call } = caller()

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
    const { call, registry } = caller(cloud.provider)
    registry.sessionStore.addRepo(
      '/workspace/podium',
      'local',
      'git@github.com:madeinorbit/podium.git',
    )
    const { sessionId } = registry.resumeSession({
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
          machineId: 'local',
        },
      },
    ])
  })

  it('rejects moving a session without a resume ref', async () => {
    const cloud = captureCloudProvider()
    const { call, registry } = caller(cloud.provider)
    const { sessionId } = registry.createSession({
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
