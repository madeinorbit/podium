import { describe, expect, it } from 'vitest'
import {
  createCloudRuntimeProviderFromEnv,
  createHostedCloudRuntimeProvider,
} from './cloud-runtime'

describe('hosted cloud runtime provider', () => {
  it('posts cloud agent creation requests to the internal control plane', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init })
      return Response.json(
        {
          id: 'runtime_1',
          kind: 'cloud-agent',
          tenantId: 'tenant_1',
          state: 'running',
          provider: 'stub',
          displayName: 'Demo agent',
          machineId: 'cloud-runtime_1',
          createdAt: '2026-07-06T00:00:00.000Z',
          updatedAt: '2026-07-06T00:00:00.000Z',
        },
        { status: 201 },
      )
    }
    const provider = createHostedCloudRuntimeProvider({
      baseUrl: 'https://cloud.internal/',
      token: 'secret-token',
      fetch: fetchImpl,
    })

    const runtime = await provider.createCloudAgent({
      tenantId: 'tenant_1',
      displayName: 'Demo agent',
      repo: { provider: 'github', owner: 'madeinorbit', name: 'podium' },
    })

    expect(runtime.id).toBe('runtime_1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://cloud.internal/v1/cloud-agents')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer secret-token')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      tenantId: 'tenant_1',
      displayName: 'Demo agent',
      repo: { provider: 'github', owner: 'madeinorbit', name: 'podium' },
    })
  })

  it('returns null when the internal control plane does not know a runtime', async () => {
    const provider = createHostedCloudRuntimeProvider({
      baseUrl: 'https://cloud.internal',
      token: 'secret-token',
      fetch: async () => new Response('missing', { status: 404 }),
    })

    await expect(provider.getRuntime('runtime_missing')).resolves.toBeNull()
  })
})

describe('cloud runtime provider env wiring', () => {
  it('uses the disabled provider unless hosted cloud is explicitly configured', async () => {
    const provider = createCloudRuntimeProviderFromEnv({})

    await expect(provider.capabilities()).resolves.toMatchObject({ provider: 'disabled' })
  })

  it('builds a hosted provider from PODIUM_CLOUD_PROVIDER=hosted', async () => {
    const provider = createCloudRuntimeProviderFromEnv(
      {
        PODIUM_CLOUD_PROVIDER: 'hosted',
        PODIUM_CLOUD_API_URL: 'https://cloud.internal',
        PODIUM_CLOUD_INTERNAL_TOKEN: 'secret-token',
      },
      async () => Response.json({ provider: 'stub' }),
    )

    await expect(provider.capabilities()).resolves.toEqual({ provider: 'stub' })
  })
})
