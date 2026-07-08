import { createTRPCClient, httpBatchLink } from '@trpc/client'

/** One issue procedure endpoint. Query and mutate are the same call over both
 *  transports (HTTP tRPC routes by procedure type; the daemon relay POSTs
 *  {router, proc, input} either way), so the shape carries both. */
export interface IssueProc {
  query(input?: unknown): Promise<unknown>
  mutate(input?: unknown): Promise<unknown>
}

/**
 * The issue-tracker client seam: `client.<router>.<proc>.query|mutate(input)`.
 * STRUCTURAL on purpose — this package must not import the server's AppRouter
 * (packages never import apps), so the command bodies treat results as unknown
 * and cast at the use site (they always have). Server-side implementations
 * (the typed tRPC client, IssueCommandService.asIssueTrpc, callerAsIssueTrpc)
 * are proxy-shaped and cast themselves to this seam.
 */
type IssueProcName =
  | 'action'
  | 'addComment'
  | 'addSession'
  | 'addShell'
  | 'archive'
  | 'attachSession'
  | 'blocked'
  | 'children'
  | 'claim'
  | 'cleanup'
  | 'clearNeedsHuman'
  | 'close'
  // Lazy comment fetch (#175): bodies no longer ride IssueWire.
  | 'comments'
  | 'count'
  | 'create'
  | 'defer'
  | 'delete'
  | 'depAdd'
  | 'depRemove'
  | 'depReport'
  | 'doctor'
  | 'duplicate'
  | 'epicStatus'
  | 'events'
  | 'findDuplicates'
  | 'get'
  | 'graph'
  | 'integrate'
  | 'lint'
  | 'list'
  | 'mailClaim'
  | 'mailInbox'
  | 'mailPending'
  | 'mailSend'
  | 'orphans'
  | 'panelApply'
  | 'preflight'
  | 'prime'
  | 'ready'
  | 'reparent'
  | 'search'
  | 'setLabels'
  | 'setNeedsHuman'
  | 'setState'
  | 'stale'
  | 'start'
  | 'stats'
  | 'subscriptionAdd'
  | 'subscriptionList'
  | 'subscriptionRemove'
  | 'subscriptionSetEnabled'
  | 'supersede'
  | 'tree'
  | 'undefer'
  | 'update'

/** The specs router (pspec v1, #135) — `podium spec` drives these. */
type SpecProcName = 'list' | 'get' | 'create' | 'save' | 'remove' | 'search'

export interface IssueTrpc {
  issues: Record<IssueProcName, IssueProc>
  repos: { inferFromPath: IssueProc }
  specs: Record<SpecProcName, IssueProc>
}

/** Typed-transport tRPC client for the issue tracker. baseUrl e.g. http://localhost:18787
 *  (no trailing /trpc). Authorization isn't carried here: a caller who reaches /trpc is the
 *  operator (the login session gates that surface); constrained agents are relayed via their
 *  daemon. The wire shape is the server's AppRouter; this client is deliberately untyped
 *  against it (see IssueTrpc) — procedure names route by path exactly as before. */
export function makeIssueClient(baseUrl: string): IssueTrpc {
  return createTRPCClient({
    links: [httpBatchLink({ url: `${baseUrl}/trpc` })],
  }) as unknown as IssueTrpc
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
