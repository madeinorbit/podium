export type CloudRuntimeKind = 'cloud-machine' | 'cloud-agent'
export type CloudRuntimeState = 'provisioning' | 'running' | 'stopped' | 'failed'

export interface CloudProviderCapabilities {
  provider: string
  cloudMachines: boolean
  cloudAgents: boolean
  previews: boolean
  artifacts: boolean
  wake: boolean
  suspend: boolean
  destroy: boolean
}

export interface CloudRepoRequest {
  provider: 'github'
  owner: string
  name: string
  ref?: string | undefined
}

export interface CloudMachineRequest {
  tenantId: string
  displayName: string
  size: 'small' | 'medium' | 'large'
  repo?: CloudRepoRequest | undefined
  purpose?: string | undefined
}

export interface CloudAgentRequest {
  tenantId: string
  displayName: string
  repo: CloudRepoRequest
  issueId?: string | undefined
  purpose?: string | undefined
}

export interface CloudRuntime {
  id: string
  kind: CloudRuntimeKind
  tenantId: string
  state: CloudRuntimeState
  provider: string
  displayName: string
  machineId: string
  createdAt: string
  updatedAt: string
  previewBaseUrl?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface CloudRuntimeProvider {
  capabilities(): Promise<CloudProviderCapabilities>
  createCloudMachine(request: CloudMachineRequest): Promise<CloudRuntime>
  createCloudAgent(request: CloudAgentRequest): Promise<CloudRuntime>
  getRuntime(id: string): Promise<CloudRuntime | null>
  stopRuntime(id: string): Promise<CloudRuntime>
  wakeRuntime(id: string): Promise<CloudRuntime>
}

export interface HostedCloudRuntimeProviderOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
}

export class CloudRuntimeUnavailableError extends Error {
  constructor() {
    super('cloud runtime provider is not configured')
    this.name = 'CloudRuntimeUnavailableError'
  }
}

export const disabledCloudRuntimeProvider: CloudRuntimeProvider = {
  async capabilities() {
    return {
      provider: 'disabled',
      cloudMachines: false,
      cloudAgents: false,
      previews: false,
      artifacts: false,
      wake: false,
      suspend: false,
      destroy: false,
    }
  },
  async createCloudMachine() {
    throw new CloudRuntimeUnavailableError()
  },
  async createCloudAgent() {
    throw new CloudRuntimeUnavailableError()
  },
  async getRuntime() {
    return null
  },
  async stopRuntime() {
    throw new CloudRuntimeUnavailableError()
  },
  async wakeRuntime() {
    throw new CloudRuntimeUnavailableError()
  },
}

export function createHostedCloudRuntimeProvider({
  baseUrl,
  token,
  fetch: fetchImpl = fetch,
}: HostedCloudRuntimeProviderOptions): CloudRuntimeProvider {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await fetchImpl(new URL(path.replace(/^\//, ''), root), { ...init, headers })
    if (!response.ok) {
      throw new Error(`cloud control plane request failed: ${response.status}`)
    }
    return (await response.json()) as T
  }

  function post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  return {
    capabilities: () => request<CloudProviderCapabilities>('/v1/capabilities'),
    createCloudMachine: (body) => post<CloudRuntime>('/v1/cloud-machines', body),
    createCloudAgent: (body) => post<CloudRuntime>('/v1/cloud-agents', body),
    async getRuntime(id) {
      try {
        return await request<CloudRuntime>(`/v1/runtimes/${encodeURIComponent(id)}`)
      } catch (error) {
        if (error instanceof Error && error.message.endsWith(': 404')) return null
        throw error
      }
    },
    stopRuntime: (id) => post<CloudRuntime>(`/v1/runtimes/${encodeURIComponent(id)}/stop`),
    wakeRuntime: (id) => post<CloudRuntime>(`/v1/runtimes/${encodeURIComponent(id)}/wake`),
  }
}

export type CloudRuntimeEnv = Partial<Record<string, string | undefined>>

export function createCloudRuntimeProviderFromEnv(
  env: CloudRuntimeEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): CloudRuntimeProvider {
  if (env.PODIUM_CLOUD_PROVIDER !== 'hosted') return disabledCloudRuntimeProvider

  const baseUrl = env.PODIUM_CLOUD_API_URL
  const token = env.PODIUM_CLOUD_INTERNAL_TOKEN
  if (!baseUrl)
    throw new Error('PODIUM_CLOUD_API_URL is required when PODIUM_CLOUD_PROVIDER=hosted')
  if (!token) {
    throw new Error('PODIUM_CLOUD_INTERNAL_TOKEN is required when PODIUM_CLOUD_PROVIDER=hosted')
  }

  return createHostedCloudRuntimeProvider({ baseUrl, token, fetch: fetchImpl })
}
