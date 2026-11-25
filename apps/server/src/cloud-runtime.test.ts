import { describe, expect, it, vi } from 'vitest'
import responses from './__fixtures__/cloud-provider-errors.json'
import {
  type CloudRuntimeProvider,
  CloudRuntimeUserError,
  createCloudRuntimeProviderFromEnv,
  createHostedCloudRuntimeProvider,
} from './cloud-runtime'

// The control-plane owner supplied the current response bodies. The proposed
// bodies exercise the extension documented in the adapter; they are not live
// captures or evidence that the control plane already emits those failures.
function providerResponse(response: { status: number; body: unknown }) {
  return createHostedCloudRuntimeProvider({
    baseUrl: 'https://cloud.example.com',
    token: 'secret-token',
    fetch: async () => Response.json(response.body, { status: response.status }),
  })
}

const agentRequest = {
  tenantId: 'tenant_1',
  displayName: 'Demo agent',
  repo: { provider: 'github', owner: 'example', name: 'project' },
} as const

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
      baseUrl: 'https://cloud.example.com/',
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
    expect(calls[0]?.url).toBe('https://cloud.example.com/v1/cloud-agents')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer secret-token')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      tenantId: 'tenant_1',
      displayName: 'Demo agent',
      repo: { provider: 'github', owner: 'madeinorbit', name: 'podium' },
    })
  })

  it('returns null when the internal control plane does not know a runtime', async () => {
    const provider = providerResponse(responses.current.notFound)

    await expect(provider.getRuntime('runtime_missing')).resolves.toBeNull()
  })

  const operations: Array<{
    method: keyof CloudRuntimeProvider
    invoke: (provider: CloudRuntimeProvider) => Promise<unknown>
  }> = [
    { method: 'capabilities', invoke: (provider) => provider.capabilities() },
    {
      method: 'createCloudMachine',
      invoke: (provider) =>
        provider.createCloudMachine({ tenantId: 'tenant_1', displayName: 'Demo', size: 'small' }),
    },
    { method: 'createCloudAgent', invoke: (provider) => provider.createCloudAgent(agentRequest) },
    { method: 'getRuntime', invoke: (provider) => provider.getRuntime('runtime_1') },
    { method: 'stopRuntime', invoke: (provider) => provider.stopRuntime('runtime_1') },
    { method: 'wakeRuntime', invoke: (provider) => provider.wakeRuntime('runtime_1') },
  ]

  it.each(operations)('explains rejected server credentials during $method', async ({ invoke }) => {
    const provider = providerResponse({
      ...responses.current.unauthorized,
      body: { error: 'unauthorized', message: 'INTERNAL_PROVIDER_DETAIL' },
    })
    const error: unknown = await invoke(provider).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CloudRuntimeUserError)
    expect(error).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message:
        "The cloud service rejected this server's credentials; ask your admin to check the cloud settings.",
    })
    expect(error).not.toHaveProperty('cause')
  })

  it.each(responses.proposed)('maps the proposed $body.error response', async (response) => {
    const provider = providerResponse(response)
    const error: unknown = await provider
      .createCloudAgent(agentRequest)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CloudRuntimeUserError)
    expect(error).toMatchObject({
      code: response.expectedCode,
      message: response.body.message,
    })
    expect(error).not.toHaveProperty('cause')
  })

  it.each(
    responses.proposed,
  )('keeps $body.error generic when looking up a runtime with an unverified owner', async (response) => {
    const provider = providerResponse(response)
    const error: unknown = await provider
      .getRuntime('runtime_foreign')
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CloudRuntimeUserError)
    expect(error).toMatchObject({
      message: `cloud control plane request failed: ${response.status} (${response.body.error})`,
    })
    expect(error).not.toHaveProperty('code')
  })

  it.each([
    400, 401, 404, 422, 499,
  ])('selects proposed user errors by body code at any 4xx status (%s)', async (status) => {
    for (const response of responses.proposed) {
      const provider = providerResponse({ ...response, status })
      await expect(provider.createCloudAgent(agentRequest)).rejects.toMatchObject({
        code: response.expectedCode,
        message: response.body.message,
      })
    }
  })

  it.each([
    undefined,
    null,
    false,
    42,
    {},
    [],
    '',
    '   ',
    'x'.repeat(241),
    'Quota reached\nINTERNAL_PROVIDER_DETAIL',
    'Quota reached\rINTERNAL_PROVIDER_DETAIL',
    'Quota\treached',
    'Quota\u0000reached',
    'Quota\u007freached',
    'Quota\u0085reached',
    'Quota\u2028reached',
    'Quota\u2029reached',
    'Quota\u202ereached',
    'Quota\u200breached',
    'Quota\ud800reached',
    'Quota\udfffreached',
    '<script>INTERNAL_PROVIDER_DETAIL</script>',
  ])('keeps a malformed user message generic (%j)', async (message) => {
    const provider = providerResponse({
      status: 429,
      body: { error: 'quota_exceeded', message },
    })
    const error: unknown = await provider
      .createCloudAgent(agentRequest)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CloudRuntimeUserError)
    expect(error).toMatchObject({
      message: 'cloud control plane request failed: 429 (quota_exceeded)',
    })
  })

  it.each([
    'X',
    'x'.repeat(240),
    'Réglez votre quota cloud.',
    'Cloud quota reached 🚀.',
    '  Cloud quota reached.  ',
  ])('accepts bounded plain-text guidance (%s)', async (message) => {
    const provider = providerResponse({
      status: 429,
      body: { error: 'quota_exceeded', message },
    })
    await expect(provider.createCloudAgent(agentRequest)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: message.trim(),
    })
  })

  it.each([
    responses.current.invalidRequest,
    { status: 401, body: { error: 'invalid_token', message: 'Reconnect your account.' } },
    { status: 403, body: { error: 'unauthorized' } },
    { status: 403, body: { error: 'unknown', message: 'INTERNAL_PROVIDER_DETAIL' } },
    { status: 403, body: { error: { code: 'repo_access_denied' }, message: 'Grant access.' } },
    { status: 403, body: [{ error: 'repo_access_denied', message: 'Grant access.' }] },
    { status: 403, body: 'repo_access_denied' },
    { status: 403, body: null },
    { status: 403, body: {} },
    ...responses.proposed.flatMap((response) =>
      [300, 500].map((status) => ({ ...response, status })),
    ),
  ])('keeps an undocumented $status response generic ($body)', async (response) => {
    const provider = providerResponse(response)
    const error: unknown = await provider
      .createCloudAgent(agentRequest)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(CloudRuntimeUserError)
    expect(error).toMatchObject({ status: response.status })
    expect(error).not.toHaveProperty('code')
  })

  it.each([
    '',
    '<html>INTERNAL_PROVIDER_DETAIL</html>',
    '{invalid json',
  ])('keeps a non-JSON provider response generic (%s)', async (body) => {
    const provider = createHostedCloudRuntimeProvider({
      baseUrl: 'https://cloud.example.com',
      token: 'secret-token',
      fetch: async () => new Response(body, { status: 401 }),
    })
    await expect(provider.capabilities()).rejects.toMatchObject({
      message: 'cloud control plane request failed: 401',
    })
  })

  it('does not turn an undocumented 404 body into an absent runtime', async () => {
    const provider = providerResponse({
      status: 404,
      body: { error: 'unknown', message: 'INTERNAL_PROVIDER_DETAIL' },
    })
    await expect(provider.getRuntime('runtime_1')).rejects.toThrow(
      'cloud control plane request failed: 404 (unknown)',
    )
  })

  it('does not infer an absent runtime from an exception message', async () => {
    const detail = new Error('transport failed: 404')
    const provider = createHostedCloudRuntimeProvider({
      baseUrl: 'https://cloud.example.com',
      token: 'secret-token',
      fetch: async () => {
        throw detail
      },
    })
    await expect(provider.getRuntime('runtime_1')).rejects.toBe(detail)
  })

  it('times out and cancels a stalled error body instead of exposing partial guidance', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // A complete JSON object without EOF: headers and bytes are not enough
        // to trust a response whose body never finishes.
        controller.enqueue(new TextEncoder().encode(JSON.stringify(responses.proposed[0]?.body)))
      },
      cancel,
    })
    const response = new Response(stream, { status: 429 })
    try {
      const provider = createHostedCloudRuntimeProvider({
        baseUrl: 'https://cloud.example.com',
        token: 'secret-token',
        fetch: async () => response,
      })
      const settled = vi.fn()
      const pending = provider.capabilities().catch((error: unknown) => error)
      void pending.then(settled)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toHaveBeenCalledOnce()
      expect(cancel).toHaveBeenCalledOnce()
      const error: unknown = await pending
      expect(error).not.toBeInstanceOf(CloudRuntimeUserError)
      expect(error).toMatchObject({ message: 'cloud control plane request failed: 429' })
      expect(response.body?.locked).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      void stream.cancel().catch(() => {})
    }
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
        PODIUM_CLOUD_API_URL: 'https://cloud.example.com',
        PODIUM_CLOUD_INTERNAL_TOKEN: 'secret-token',
      },
      async () => Response.json({ provider: 'stub' }),
    )

    await expect(provider.capabilities()).resolves.toEqual({ provider: 'stub' })
  })
})
