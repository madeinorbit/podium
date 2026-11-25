import type { CLOUD_HARNESS_KINDS, IssueId, MachineId, SessionId } from '@podium/model'

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
/** Harnesses with a cloud counterpart — derived from the one closed set
 *  (CLOUD_HARNESS_KINDS beside HarnessAgent), not retyped. */
export type CloudAgentKind = (typeof CLOUD_HARNESS_KINDS)[number]

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
  sessionId: SessionId
  agent: CloudAgentKind
  resumeRef?: string | undefined
  cwd?: string | undefined
  machineId?: MachineId | undefined
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
  sessionId: SessionId
  agent: CloudAgentKind
  resume?: { value?: string | undefined } | undefined
  cwd?: string | undefined
  machineId?: MachineId | undefined
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
  issueId?: IssueId | undefined
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
  machineId: MachineId
  createdAt: string
  updatedAt: string
  previewBaseUrl?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

/** Expected provider refusals use CloudRuntimeUserError with authored user
 * guidance, never raw response bodies or exception text. Other errors retain
 * their internal detail for server logs. */
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

/** A provider's deliberate, actionable refusal. The message is authored for the
 * user, locally or in a documented provider user-message field, never arbitrary
 * response text, a stack or a driver error. Only these explicit refusals may
 * keep their text at the cloud service boundary. Provider token problems use
 * PRECONDITION_FAILED; UNAUTHORIZED means Podium's login expired. */
export class CloudRuntimeUserError extends Error {
  constructor(
    readonly code: 'BAD_REQUEST' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'TOO_MANY_REQUESTS',
    message: string,
  ) {
    super(message)
    this.name = 'CloudRuntimeUserError'
  }
}

/** A server-wide credential failure, independent of any runtime's owner. */
export class CloudRuntimeCredentialError extends CloudRuntimeUserError {
  readonly status = 401

  constructor() {
    super(
      'PRECONDITION_FAILED',
      "The cloud service rejected this server's credentials; ask your admin to check the cloud settings.",
    )
    this.name = 'CloudRuntimeCredentialError'
  }
}

export class CloudRuntimeUnavailableError extends CloudRuntimeUserError {
  constructor() {
    super('PRECONDITION_FAILED', 'cloud runtime provider is not configured')
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

/**
 * Hosted control-plane error contract (all bodies are JSON):
 * - 401 {error: 'unauthorized'}: this server's control-plane token was rejected.
 * - 400 {error: 'invalid_request', issues: [...]}: an adapter bug, not user input.
 * - 404 {error: 'not_found'}: an unknown runtime, absent on getRuntime only.
 *
 * Proposed user-actionable extension, pending control-plane support:
 * {error: '<code>', message: '<authored user guidance>'}, with one of the codes
 * below and any 4xx status (the control plane has not chosen statuses yet).
 * The message must be 1–240 characters of single-line plain text, without HTML
 * delimiters, controls, invisible formatting or lone surrogates. Consumers must
 * render it as plain text, never Markdown or HTML. Runtime lookups suppress this
 * guidance because the runtime's tenant is not yet verified. Error-body reads
 * have a five-second deadline. A missing/invalid message,
 * unknown code or non-4xx status remains a logged internal fault. Never show
 * other response fields (issues, debug, etc.) or guess a refusal from its status.
 */
const hostedCloudUserFailures = [
  { error: 'quota_exceeded', code: 'TOO_MANY_REQUESTS' },
  { error: 'billing_required', code: 'PRECONDITION_FAILED' },
  { error: 'region_unavailable', code: 'BAD_REQUEST' },
  { error: 'plan_unavailable', code: 'PRECONDITION_FAILED' },
  { error: 'repo_access_denied', code: 'FORBIDDEN' },
] as const satisfies ReadonlyArray<{
  error: string
  code: CloudRuntimeUserError['code']
}>

class HostedCloudRuntimeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode: unknown,
  ) {
    // A bounded machine code helps correlate undocumented failures in the server
    // log. Arbitrary body text is neither needed there nor safe for the caller.
    const detail =
      typeof providerCode === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(providerCode)
        ? ` (${providerCode})`
        : ''
    super(`cloud control plane request failed: ${status}${detail}`)
    this.name = 'HostedCloudRuntimeHttpError'
  }
}

function hostedCloudError(status: number, body: unknown, allowUserErrors: boolean): Error {
  const envelope =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined
  const providerCode = envelope?.error
  if (status === 401 && providerCode === 'unauthorized') {
    return new CloudRuntimeCredentialError()
  }

  const refusal = hostedCloudUserFailures.find((failure) => failure.error === providerCode)
  const message = envelope?.message
  if (
    allowUserErrors &&
    refusal &&
    status >= 400 &&
    status < 500 &&
    typeof message === 'string' &&
    message.length <= 240 &&
    message.trim().length > 0 &&
    !/[<>\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(message)
  ) {
    return new CloudRuntimeUserError(refusal.code, message.trim())
  }
  return new HostedCloudRuntimeHttpError(status, providerCode)
}

/** A stalled body must not hold the caller open after the error headers arrive.
 * Cancel via the reader, so the deadline also works with injected fetches that
 * do not implement AbortSignal. Cancellation itself is not awaited. */
async function readHostedCloudErrorBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined)
      void reader.cancel().catch(() => {})
    }, 5_000)
  })
  const read = async (): Promise<unknown> => {
    try {
      const decoder = new TextDecoder()
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return JSON.parse(text + decoder.decode()) as unknown
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      return undefined
    }
  }
  try {
    return await Promise.race([read(), timeout])
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}

export function createHostedCloudRuntimeProvider({
  baseUrl,
  token,
  fetch: fetchImpl = fetch,
}: HostedCloudRuntimeProviderOptions): CloudRuntimeProvider {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`

  async function request<T>(
    path: string,
    init: RequestInit = {},
    { allowUserErrors = true } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await fetchImpl(new URL(path.replace(/^\//, ''), root), { ...init, headers })
    if (!response.ok) {
      const body = await readHostedCloudErrorBody(response)
      throw hostedCloudError(response.status, body, allowUserErrors)
    }
    return (await response.json()) as T
  }

  async function post<T>(path: string, body?: unknown): Promise<T> {
    return await request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  return {
    capabilities: async () => await request<CloudProviderCapabilities>('/v1/capabilities'),
    createCloudMachine: async (body) => await post<CloudRuntime>('/v1/cloud-machines', body),
    createCloudAgent: async (body) => await post<CloudRuntime>('/v1/cloud-agents', body),
    async getRuntime(id) {
      try {
        // The service cannot check this runtime's tenant until it gets a record.
        // A proposed refusal here could expose a foreign runtime's billing state.
        return await request<CloudRuntime>(
          `/v1/runtimes/${encodeURIComponent(id)}`,
          {},
          { allowUserErrors: false },
        )
      } catch (error) {
        if (
          error instanceof HostedCloudRuntimeHttpError &&
          error.status === 404 &&
          error.providerCode === 'not_found'
        ) {
          return null
        }
        throw error
      }
    },
    stopRuntime: async (id) =>
      await post<CloudRuntime>(`/v1/runtimes/${encodeURIComponent(id)}/stop`),
    wakeRuntime: async (id) =>
      await post<CloudRuntime>(`/v1/runtimes/${encodeURIComponent(id)}/wake`),
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
