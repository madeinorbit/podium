import {
  readServerJson,
  ServerUnavailableError,
} from '@podium/client-core/replica-assembly/server-calls'
import { workspaceFetch } from '@/lib/workspace-request'

/**
 * One `/auth/members/*` call. A connection failure (WebKit's bare "Load failed")
 * or a body that is not Podium's JSON (a stopped server's proxy page) becomes
 * the server-unavailable message rather than the engine's own wording.
 */
export async function memberRequest<T>(origin: string, action: string, body?: unknown): Promise<T> {
  return await authRequest<T>(origin, `members/${action}`, body)
}

/**
 * One `/auth/<path>` call, GET without a body and POST with one. The server's
 * own refusal message (the last admin, a password to confirm) is the error.
 */
export async function authRequest<T>(origin: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await workspaceFetch(`${origin}/auth/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new ServerUnavailableError(error)
  }
  const data = await readServerJson<{ error?: unknown } | null>(response)
  if (!response.ok) {
    throw new Error(
      typeof data?.error === 'string' && data.error !== ''
        ? data.error
        : `The server refused this request (${response.status}).`,
    )
  }
  return data as T
}
