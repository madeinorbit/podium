import { isServerReadiness, type ServerReadiness } from '@podium/model'

const READINESS_TIMEOUT_MS = 10_000

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined
}

export async function fetchServerReadiness(httpOrigin: string): Promise<ServerReadiness> {
  const response = await fetch(`${httpOrigin}/readiness`, {
    credentials: 'include',
    signal: timeoutSignal(READINESS_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`readiness failed: ${response.status}`)
  const body: unknown = await response.json()
  if (!isServerReadiness(body)) throw new Error('readiness response was invalid')
  return body
}
