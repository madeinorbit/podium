import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from './router'

export type IssueTrpc = ReturnType<typeof makeIssueClient>

/** Typed tRPC client for the issue tracker. baseUrl e.g. http://localhost:18787 (no trailing
 *  /trpc). Authorization isn't carried here: a caller who reaches /trpc is the operator (the
 *  login session gates that surface); constrained agents are relayed via their daemon. */
export function makeIssueClient(baseUrl: string) {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${baseUrl}/trpc` })],
  })
}

/** IssueTrpc client that relays each call to the local daemon's issue endpoint (agent path).
 *  `client.<router>.<proc>.query|mutate(input)` → POST {router, proc, input, outsideScope?}. */
export function makeRelayIssueClient(
  endpoint: string,
  opts?: { outsideScope?: boolean; fetchImpl?: typeof fetch },
): IssueTrpc {
  const doFetch = opts?.fetchImpl ?? fetch
  const call =
    (router: string, proc: string) =>
    async (input: unknown): Promise<unknown> => {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          router,
          proc,
          ...(input !== undefined ? { input } : {}),
          ...(opts?.outsideScope ? { outsideScope: true } : {}),
        }),
      })
      // The daemon answers a rejected relay as 200 {ok:false,error}; non-2xx means a
      // transport-level failure (e.g. an empty-body 404/413) whose body isn't JSON.
      // Surface the status rather than letting `res.json()` throw "Unexpected end of
      // JSON input" and mask the real error.
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`issue relay HTTP ${res.status}${text ? `: ${text}` : ''}`)
      }
      const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string }
      if (!body.ok) throw new Error(body.error ?? 'issue relay failed')
      return body.result
    }
  const procProxy = (router: string) =>
    new Proxy(
      {},
      {
        get: (_t, proc) => {
          if (typeof proc !== 'string') return undefined
          const fn = call(router, proc)
          return { mutate: fn, query: fn }
        },
      },
    )
  return new Proxy(
    {},
    { get: (_t, router) => (typeof router === 'string' ? procProxy(router) : undefined) },
  ) as unknown as IssueTrpc
}
