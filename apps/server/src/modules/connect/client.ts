/**
 * The SIGNED HTTP CLIENT for Podium Connect (PDM-51). Four calls, one
 * signature scheme: every write carries `Podium-Installation`,
 * `Podium-Timestamp` and `Podium-Signature`, the last an Ed25519 signature by
 * the installation key over `METHOD\nPATH\nTIMESTAMP\nhex(sha256(body))` under
 * the request prefix. Connect verifies against the key registered for the id.
 *
 * Pure over its inputs: `fetch`, the clock and the identity are injected, so
 * the test proves the bytes on the wire against the shared vectors rather than
 * against a copy of this code.
 */
import { createHash } from 'node:crypto'
import {
  CONNECT_REQUEST_PREFIX,
  connectRequestMessage,
  type InstallationIdentity,
  installationPublicKeyWire,
  signWithInstallation,
} from '@podium/runtime/installation-identity'

export interface LocatorEndpoint {
  url: string
  priority: number
}

export interface LocatorRecord {
  generation: number
  issuedAt: string
  expiresAt: string | null
  endpoints: LocatorEndpoint[]
}

export type CheckError =
  | 'INVALID_URL'
  | 'DNS_FAILED'
  | 'PRIVATE_ADDRESS'
  | 'REDIRECTED'
  | 'TLS_INVALID'
  | 'PORT_NOT_REACHABLE'
  | 'UNREACHABLE'
  | 'NOT_PODIUM'
  | 'IDENTITY_MISMATCH'
  /** Connect itself could not be reached or refused the request. */
  | 'CONNECT_UNAVAILABLE'

export type CheckResult =
  | { ok: true; url: string; resolvedTo: string[] }
  | { ok: false; error: CheckError; detail: string }

export type ConnectFailure =
  | { kind: 'http'; status: number; code: string; message: string }
  | { kind: 'network'; message: string }

export type ConnectOutcome = { ok: true } | { ok: false; failure: ConnectFailure }

export interface ConnectClientDeps {
  /** A bare origin, e.g. https://connect.meetpodium.com. */
  baseUrl: string
  identity: () => InstallationIdentity
  fetch?: typeof fetch
  /** Unix seconds. */
  now?: () => number
  timeoutMs?: number
}

export interface ConnectClient {
  register(): Promise<ConnectOutcome>
  publish(record: LocatorRecord): Promise<ConnectOutcome>
  clear(): Promise<ConnectOutcome>
  check(url: string): Promise<CheckResult>
}

const failure = async (res: Response): Promise<ConnectOutcome> => {
  let code = 'HTTP_ERROR'
  let message = `${res.status}`
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown }
    if (typeof body.error === 'string') code = body.error
    if (typeof body.message === 'string') message = body.message
  } catch {
    // no JSON body: the status is the whole story
  }
  return { ok: false, failure: { kind: 'http', status: res.status, code, message } }
}

export function connectClient(deps: ConnectClientDeps): ConnectClient {
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const timeoutMs = deps.timeoutMs ?? 10_000
  const base = deps.baseUrl.replace(/\/+$/, '')

  const send = async (
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: string | undefined,
    signed: boolean,
  ): Promise<Response> => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (signed) {
      const identity = deps.identity()
      const ts = now()
      const hash = createHash('sha256')
        .update(body ?? '')
        .digest('hex')
      headers['podium-installation'] = identity.installationId
      headers['podium-timestamp'] = String(ts)
      headers['podium-signature'] = signWithInstallation(
        identity,
        CONNECT_REQUEST_PREFIX,
        connectRequestMessage(method, path, ts, hash),
      )
    }
    return fetchImpl(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  const attempt = async (run: () => Promise<Response>): Promise<ConnectOutcome> => {
    let res: Response
    try {
      res = await run()
    } catch (error) {
      return {
        ok: false,
        failure: {
          kind: 'network',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    return res.ok ? { ok: true } : failure(res)
  }

  return {
    register: () =>
      attempt(() => {
        const identity = deps.identity()
        return send(
          'POST',
          '/v1/installations',
          JSON.stringify({
            installationId: identity.installationId,
            publicKey: installationPublicKeyWire(identity),
          }),
          false,
        )
      }),
    publish: (record) =>
      attempt(() =>
        send(
          'PUT',
          `/v1/installations/${deps.identity().installationId}`,
          JSON.stringify(record),
          true,
        ),
      ),
    clear: () =>
      attempt(() =>
        send('DELETE', `/v1/installations/${deps.identity().installationId}`, undefined, true),
      ),
    async check(url) {
      let res: Response
      try {
        res = await send(
          'POST',
          `/v1/installations/${deps.identity().installationId}/check`,
          JSON.stringify({ url }),
          true,
        )
      } catch (error) {
        return {
          ok: false,
          error: 'CONNECT_UNAVAILABLE',
          detail: error instanceof Error ? error.message : String(error),
        }
      }
      if (!res.ok) {
        const f = await failure(res)
        const detail = f.ok ? '' : f.failure.kind === 'http' ? f.failure.code : f.failure.message
        return { ok: false, error: 'CONNECT_UNAVAILABLE', detail }
      }
      try {
        return (await res.json()) as CheckResult
      } catch {
        return { ok: false, error: 'CONNECT_UNAVAILABLE', detail: 'answer is not JSON' }
      }
    },
  }
}
