/**
 * A FAKE CREDENTIAL PROVIDER for tests (credential management §7, Task 13).
 *
 * Adding or renewing a pasted key asks its provider once whether it is
 * accepted. Tests never reach a real provider: they pass one of these as
 * `credentialProviderFetch` (a registry) or `fetch` (the health service).
 */

/** A provider that accepts every key it is asked about. */
export const acceptingProviderFetch = async (): Promise<Response> =>
  new Response(JSON.stringify({ data: [] }), { status: 200 })

/**
 * A provider that rejects the listed secrets with its own reason and accepts
 * everything else. `calls` records which URLs were asked, never the secret.
 */
export function fakeProvider(opts: {
  reject?: readonly string[]
  limit?: readonly string[]
  reason?: string
}) {
  const calls: string[] = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url)
    const headers = new Headers(init?.headers)
    const presented =
      headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    if (opts.reject?.includes(presented)) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: opts.reason ?? 'invalid x-api-key' },
        }),
        { status: 401 },
      )
    }
    if (opts.limit?.includes(presented)) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  return { fetch, calls }
}
