import type { Capabilities } from '@podium/identity'
import { UserId } from '@podium/model'
import { NativeClientLoginResponse } from '@podium/protocol'
import { z } from 'zod'
import { parseReplicaNamespaceKey } from '../replica/principal-storage'
import {
  classifyAuthStatus,
  type ReplicaFailure,
  ReplicaGateError,
} from '../replica-assembly/failure'
import { type WorkspaceSelector, workspaceRequestInit } from '../transport'
import type { ServerProfile } from './server-profiles'
import type { AccountCredentials } from './storage'

export interface AuthStatus {
  needsAuth: boolean
  authed: boolean
  userId: UserId | null
  syncBoundaryId?: string
  memberId?: string
  capabilities?: AuthCapabilities
  prompt?: SignInPrompt
  denied?: 'not_workspace_member'
}

export type AuthCapabilities = Capabilities
export type SignInPrompt = 'password' | 'email-password'

const capabilitiesSchema: z.ZodType<AuthCapabilities> = z.object({
  version: z.literal(1),
  passwordSignIn: z.boolean(),
  providers: z.array(z.enum(['google', 'github'])),
  selfSignUp: z.boolean(),
  invitationDelivery: z.enum(['link', 'mail']),
  passwordReset: z.enum(['admin-link', 'mail']),
  emailVerification: z.boolean(),
  organisations: z.boolean(),
  sameMachineSignIn: z.boolean(),
  adminSignOutEverywhere: z.boolean(),
  adminEndDeviceSignIn: z.boolean(),
  accountUrl: z
    .string()
    .url()
    .refine((url) => new URL(url).protocol === 'https:')
    .nullable(),
})

/**
 * An invitation secret is in the requested page's fragment. Encoding that
 * fragment inside a query parameter would put the token in the account page's
 * request URL, its logs, the edge and any Referer, so the whole return value
 * travels in the account page's fragment instead. Other return paths keep the
 * query form they have always used.
 */
function carriesInvitationToken(value: string): boolean {
  if (/(?:^|[#&])invite=/.test(value)) return true
  try {
    const url = new URL(value, 'https://account.invalid')
    return url.pathname === '/workspace-invitation' && url.hash.length > 1
  } catch {
    return false
  }
}

/** Account pages are rooted at the server-reported URL, including its path. */
export function accountPageUrl(
  capabilities: AuthCapabilities,
  page: 'sign-in' | 'sign-up' | 'forgot-password' | 'workspaces' | 'devices' | '',
  returnTo?: string,
): string | undefined {
  if (!capabilities.accountUrl) return undefined
  const base = capabilities.accountUrl.replace(/\/$/, '')
  const url = new URL(page ? `${base}/${page}` : base)
  if (returnTo) {
    if (carriesInvitationToken(returnTo))
      url.hash = new URLSearchParams({ returnTo }).toString()
    else url.searchParams.set('returnTo', returnTo)
  }
  return url.href
}

export type AuthBootstrap =
  | { readonly kind: 'principal'; readonly principal: string }
  | { readonly kind: 'provisional-failure' }
  | { readonly kind: 'failure'; readonly message: string; readonly failure: ReplicaFailure }

export type AccountDecision =
  | { kind: 'login'; status: AuthStatus }
  | { kind: 'membership-denied'; status: AuthStatus; reason: string }
  | { kind: 'ready'; auth: AuthBootstrap; status?: AuthStatus }

export type LiveAuthCheck =
  | { kind: 'valid'; status: AuthStatus }
  | { kind: 'expired'; status: AuthStatus }
  | { kind: 'unreachable'; cause: unknown }

export type LoginResult =
  | { ok: true; bearer: string | null; principal?: string }
  | { ok: false; error: string }

export const MEMBERSHIP_DENIED_COPY = {
  title: 'Workspace access is missing',
  body: 'Use another account, or accept an invitation to this workspace in your browser.',
  action: 'Use another account',
} as const

function timeoutSignal(timeoutMs: number | null): AbortSignal | undefined {
  return timeoutMs !== null &&
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
}

class UnreadableAuthResponse extends ReplicaGateError {
  constructor() {
    super('auth status response was invalid', { kind: 'auth-intercepted' })
  }
}

function failure(failure: ReplicaFailure): AccountDecision {
  return {
    kind: 'ready',
    auth: { kind: 'failure', message: 'authenticated account is unavailable', failure },
  }
}

/** Validate the unauthenticated envelope before allowing it to select a screen or replica. */
export function parseAuthStatus(body: unknown): AuthStatus {
  if (body === null || typeof body !== 'object')
    throw new ReplicaGateError('auth status response was invalid', { kind: 'auth-intercepted' })
  const row = body as Record<string, unknown>
  if (
    typeof row.needsAuth !== 'boolean' ||
    typeof row.authed !== 'boolean' ||
    !(
      row.userId === undefined ||
      row.userId === null ||
      (typeof row.userId === 'string' && row.userId.length > 0)
    )
  )
    throw new ReplicaGateError('auth status response was invalid', { kind: 'auth-intercepted' })
  const decision = classifyAuthStatus(row)
  if (!('principal' in decision) && decision.kind === 'server-starting')
    throw new ReplicaGateError('authenticated replica identity is unavailable', decision)
  return projectAuthStatus(row)
}

function readCapabilities(value: unknown): AuthCapabilities {
  const parsed = capabilitiesSchema.safeParse(value)
  if (!parsed.success)
    throw new ReplicaGateError('auth capabilities response was invalid', {
      kind: 'auth-intercepted',
    })
  return parsed.data
}

function projectAuthStatus(row: Record<string, unknown>): AuthStatus {
  return {
    needsAuth: row.needsAuth === true,
    authed: row.authed === true,
    userId: typeof row.userId === 'string' ? UserId.parse(row.userId) : null,
    ...(row.capabilities === undefined ? {} : { capabilities: readCapabilities(row.capabilities) }),
    ...(row.prompt === 'password' || row.prompt === 'email-password' ? { prompt: row.prompt } : {}),
    ...(typeof row.syncBoundaryId === 'string' && row.syncBoundaryId
      ? { syncBoundaryId: row.syncBoundaryId }
      : {}),
    ...(typeof row.memberId === 'string' && row.memberId ? { memberId: row.memberId } : {}),
    ...(row.denied === 'not_workspace_member' ? { denied: row.denied } : {}),
  }
}

export function decideAccount(status: AuthStatus): AccountDecision {
  if (!status.authed && status.denied === 'not_workspace_member')
    return {
      kind: 'membership-denied',
      reason: 'This account is not a member of this workspace.',
      status,
    }
  if (status.needsAuth && !status.authed) return { kind: 'login', status }
  const outcome = classifyAuthStatus(status)
  return 'principal' in outcome
    ? { kind: 'ready', status, auth: { kind: 'principal', principal: outcome.principal } }
    : { ...failure(outcome), status }
}

/** Preserve the browser gate's existing partial envelopes and login-before-readiness order. */
function browserProbeDecision(body: unknown): AccountDecision {
  const row = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const status = projectAuthStatus(row)
  if (status.needsAuth && !status.authed) {
    return decideAccount(status)
  }
  const outcome = classifyAuthStatus(body as Parameters<typeof classifyAuthStatus>[0])
  return 'principal' in outcome
    ? { kind: 'ready', status, auth: { kind: 'principal', principal: outcome.principal } }
    : { ...failure(outcome), status }
}

/** Only previously verified, server-authored identity can open a native offline profile. */
export function offlineProfileStatus(profile: ServerProfile): AuthStatus | undefined {
  if (
    profile.signedOut ||
    !profile.instanceId ||
    !profile.userId ||
    !profile.syncBoundaryId ||
    !profile.memberId
  )
    return undefined
  return {
    needsAuth: profile.mode === 'protected',
    authed: true,
    userId: UserId.parse(profile.memberId),
    syncBoundaryId: profile.syncBoundaryId,
    memberId: profile.memberId,
  }
}

/** Browser offline fallback must remain unambiguous; a local "last user" is not authority. */
export function resolveOfflinePrincipal(namespaces: readonly string[]): string {
  const principals = [...new Set(namespaces)].filter(
    (key) => parseReplicaNamespaceKey(key) !== undefined,
  )
  if (principals.length === 1) return principals[0]!
  throw new ReplicaGateError(
    principals.length === 0
      ? 'offline replica has no authenticated principal namespace'
      : 'offline replica principal is ambiguous on this shared device',
    principals.length === 0
      ? { kind: 'offline-unknown' }
      : { kind: 'offline-ambiguous', count: principals.length },
  )
}

/** A recovery probe may use cached identity only when no server answer arrived. */
export async function resolveAccountPrincipal(args: {
  fetchStatus(): Promise<Response>
  inspectNamespaces(): readonly string[]
}): Promise<string> {
  let response: Response
  try {
    response = await args.fetchStatus()
  } catch {
    return resolveOfflinePrincipal(args.inspectNamespaces())
  }
  if (!response.ok)
    throw new ReplicaGateError(
      'authenticated account is unavailable',
      response.status === 400
        ? { kind: 'auth-insecure' }
        : { kind: 'auth-refused', status: response.status },
    )
  const body = await response.json().catch(() => {
    throw new ReplicaGateError('authenticated account is unavailable', { kind: 'auth-intercepted' })
  })
  // Recovery accepts the minimal authenticated identity envelope too. It does
  // not use profile metadata or a URL to name the account.
  const outcome = classifyAuthStatus(body)
  if ('principal' in outcome) return outcome.principal
  throw new ReplicaGateError('authenticated account is unavailable', outcome)
}

export function createAuthClient(options: {
  credentials: AccountCredentials
  platform?: string
  fetch?: typeof fetch
  loginRefusalMessage?(status: number): string
  /** Native/mobile require the full DTO; the existing web gate also accepts partial envelopes. */
  validateProbeEnvelope?: boolean
  /** Mobile keeps its ten-second deadline; null preserves an adapter's unbounded requests. */
  timeoutMs?: number | null
}) {
  const browser = options.credentials.delivery === 'browser'
  const request = (url: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(url, init)
  const init = (
    origin: string,
    path: string,
    bearer: string | null,
    workspace?: WorkspaceSelector,
    extra: RequestInit = {},
  ): RequestInit => {
    if (bearer && !origin.startsWith('https://'))
      throw new ReplicaGateError('refusing to send a bearer over cleartext HTTP', {
        kind: 'auth-insecure',
      })
    const headers = new Headers(extra.headers)
    if (!browser && bearer) headers.set('Authorization', `Bearer ${bearer}`)
    return (
      workspaceRequestInit(
        origin + path,
        {
          credentials: browser ? 'include' : 'omit',
          signal: timeoutSignal(options.timeoutMs === undefined ? 10_000 : options.timeoutMs),
          ...extra,
          headers,
        },
        workspace,
      ) ?? {}
    )
  }

  async function fetchStatusBody(
    origin: string,
    bearer: string | null = null,
    workspaceId?: string,
  ): Promise<unknown> {
    const response = await request(
      origin + '/auth/status',
      init(origin, '/auth/status', bearer, workspaceId ? { workspaceId } : undefined),
    )
    if (!response.ok)
      throw new ReplicaGateError(
        'auth status failed: ' + response.status,
        response.status === 400
          ? { kind: 'auth-insecure' }
          : { kind: 'auth-refused', status: response.status },
      )
    return response.json().catch(() => {
      throw new UnreadableAuthResponse()
    })
  }

  async function fetchAuthStatus(
    origin: string,
    bearer: string | null = null,
    workspaceId?: string,
  ): Promise<AuthStatus> {
    return parseAuthStatus(await fetchStatusBody(origin, bearer, workspaceId))
  }

  async function probeAuth(
    origin: string,
    bearer: string | null = null,
    workspaceId?: string,
  ): Promise<AccountDecision> {
    try {
      const body = await fetchStatusBody(origin, bearer, workspaceId)
      return options.validateProbeEnvelope === false
        ? browserProbeDecision(body)
        : decideAccount(parseAuthStatus(body))
    } catch (cause) {
      // A status 4xx/readiness answer is authoritative. A network/proxy failure
      // gets one recovery probe in replica boot before retained data may be used.
      if (
        cause instanceof ReplicaGateError &&
        !(cause instanceof UnreadableAuthResponse) &&
        !(
          cause.failure.kind === 'auth-refused' &&
          (cause.failure.status < 400 || cause.failure.status >= 500)
        )
      )
        return failure(cause.failure)
      return { kind: 'ready', auth: { kind: 'provisional-failure' } }
    }
  }

  async function checkLiveAuth(
    origin: string,
    bearer: string | null,
    workspaceId?: string,
  ): Promise<LiveAuthCheck> {
    try {
      const status = await fetchAuthStatus(origin, bearer, workspaceId)
      return status.needsAuth && !status.authed
        ? { kind: 'expired', status }
        : { kind: 'valid', status }
    } catch (cause) {
      return { kind: 'unreachable', cause }
    }
  }

  async function login(
    origin: string,
    password: string,
    device?: { id: string; name: string },
    email = '',
    workspaceId?: string,
    deviceKind?: 'desktop',
  ): Promise<LoginResult> {
    if (!browser && !origin.startsWith('https://'))
      return { ok: false, error: 'Native sign-in requires trusted HTTPS. No password was sent.' }
    const platform = options.platform ?? 'unknown'
    const response = await request(
      origin + '/auth/login',
      init(origin, '/auth/login', null, workspaceId ? { workspaceId } : undefined, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(email.trim() ? { email: email.trim() } : {}),
          password,
          ...(!browser
            ? {
                delivery: 'native',
                deviceId: device?.id ?? 'mobile-manual-login',
                deviceName: device?.name ?? `${platform} phone`,
                platform: platform === 'ios' || platform === 'android' ? platform : 'unknown',
              }
            : deviceKind
              ? { deviceKind }
              : {}),
        }),
      }),
    )
    if (response.ok) {
      const body: unknown = await response.json().catch(() => null)
      if (browser) {
        const outcome = classifyAuthStatus(body as Parameters<typeof classifyAuthStatus>[0])
        return 'principal' in outcome
          ? { ok: true, bearer: null, principal: outcome.principal }
          : { ok: false, error: "couldn't verify the signed-in account" }
      }
      const parsed = NativeClientLoginResponse.safeParse(body)
      return parsed.success
        ? { ok: true, bearer: parsed.data.token }
        : { ok: false, error: 'Server did not return a native session. Update the server.' }
    }
    if (options.loginRefusalMessage)
      return { ok: false, error: options.loginRefusalMessage(response.status) }
    if (response.status === 401) return { ok: false, error: 'Wrong email or password.' }
    if (response.status === 429)
      return { ok: false, error: 'Too many attempts — try again in a few minutes.' }
    return { ok: false, error: 'Login failed (' + response.status + ').' }
  }

  async function logout(
    origin: string,
    bearer: string | null = null,
    workspaceId?: string,
  ): Promise<void> {
    const response = await request(
      origin + '/auth/logout',
      init(origin, '/auth/logout', bearer, workspaceId ? { workspaceId } : undefined, {
        method: 'POST',
      }),
    )
    if (!response.ok) throw new Error(`logout failed: ${response.status}`)
  }

  return { fetchAuthStatus, probeAuth, checkLiveAuth, login, logout }
}
