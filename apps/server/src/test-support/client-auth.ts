import type { UserId } from '@podium/model'
import { SESSION_COOKIE } from '@podium/protocol'

export interface TestClientLogin {
  cookieHeader: string
  cookieName: string
  cookieValue: string
}

/**
 * Authenticate a real HTTP client and return the cookie accepted by the real
 * `/client` WebSocket upgrade. This deliberately goes through `/auth/login`:
 * tests do not reach into the private store or mint transport principals.
 */
export async function loginTestClient(input: {
  origin: string
  password: string
  userId?: UserId
  fetchImpl?: typeof fetch
}): Promise<TestClientLogin> {
  const response = await (input.fetchImpl ?? fetch)(new URL('/auth/login', input.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(input.userId ? { userId: input.userId } : {}),
      password: input.password,
    }),
  })
  if (!response.ok) {
    throw new Error(`client login failed (${response.status}): ${await response.text()}`)
  }

  const pair = response.headers.get('set-cookie')?.split(';', 1)[0]
  const separator = pair?.indexOf('=') ?? -1
  const cookieName = separator > 0 ? pair?.slice(0, separator) : undefined
  const cookieValue = separator > 0 ? pair?.slice(separator + 1) : undefined
  if (cookieName !== SESSION_COOKIE || !cookieValue) {
    throw new Error(`client login returned no ${SESSION_COOKIE} cookie`)
  }
  return { cookieHeader: `${cookieName}=${cookieValue}`, cookieName, cookieValue }
}
