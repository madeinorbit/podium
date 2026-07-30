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

export type CloudRuntimeSize = 'small' | 'medium' | 'large'
export type CloudAgentKind = 'claude-code' | 'codex'

/**
 * The session half of an outbound `/v1/cloud-agents` body — an EXTERNAL EGRESS
 * DTO, not one of our session representations.
 *
 * POD-366 deviation from `docs/rearch-field-schema-inventory.md`, recorded
 * because the inventory asks for the opposite. §2.1 #16 marks this a drifted
 * duplicate and §6.4 says its "renames deleted" (`agent`→`agentKind`,
 * `resumeRef: string`→`resume: ResumeRef`, D-1/D-3). Those keys are NOT ours to
 * rename: `createHostedCloudRuntimeProvider` JSON-stringifies the whole
 * `CloudAgentRequest` and POSTs it to a third-party control plane, so `agent`
 * and `resumeRef` are that service's spelling. Renaming them would send a body
 * the remote cannot read, and nothing in this repo would notice — the default
 * provider throws `CloudRuntimeUnavailableError` and the hosted one is only ever
 * exercised through a mocked `fetch`.
 *
 * The inventory's own rule for this category is in the issue table, which
 * excludes `LinearIssue` as "an external system's shape, deliberately not
 * ours". Same category, same treatment.
 *
 * What POD-366 *does* owe here is §6.5's two rules: the field list must not be
 * hand-restated at the call site, and each encoding difference must live in
 * exactly one named mapper. {@link toCloudAgentSourceSession} is that mapper —
 * it is the one place the two external spellings are written.
 */
export interface CloudAgentSourceSession {
  sessionId: string
  agent: CloudAgentKind
  resumeRef?: string | undefined
  cwd?: string | undefined
  machineId?: string | undefined
}

/**
 * The one documented session → cloud-egress encoding (inventory §6.5 rule 2).
 *
 * Owns both external spellings and nothing else: `agentKind` is narrowed to the
 * provider's two-value `CloudAgentKind` by the caller (not every harness has a
 * cloud counterpart), and `resume` is flattened to `ResumeRef.value` because the
 * remote takes a bare string. Callers pass a session-shaped value; they must not
 * rebuild this object literal.
 */
export function toCloudAgentSourceSession(source: {
  sessionId: string
  agent: CloudAgentKind
  resume?: { value?: string | undefined } | undefined
  cwd?: string | undefined
  machineId?: string | undefined
}): CloudAgentSourceSession {
  return {
    sessionId: source.sessionId,
    agent: source.agent,
    ...(source.resume?.value ? { resumeRef: source.resume.value } : {}),
    ...(source.cwd ? { cwd: source.cwd } : {}),
    ...(source.machineId ? { machineId: source.machineId } : {}),
  }
}

export interface CloudMachineRequest {
  tenantId: string
  displayName: string
  size: CloudRuntimeSize
  repo?: CloudRepoRequest | undefined
  purpose?: string | undefined
}

export interface CloudAgentRequest {
  tenantId: string
  displayName: string
  size?: CloudRuntimeSize | undefined
  repo: CloudRepoRequest
  issueId?: string | undefined
  purpose?: string | undefined
  sourceSession?: CloudAgentSourceSession | undefined
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
