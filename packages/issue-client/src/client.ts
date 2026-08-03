import { type IssueContractName, type LockCommandName } from '@podium/commands'
import { SESSION_COOKIE } from '@podium/protocol'
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
 * (the typed tRPC client, IssueCommandDispatcher.asIssueTrpc) cast themselves
 * to this seam.
 *
 * The proc-name union is NOT hand-maintained any more (#248 [spec:SP-3fe2]): it
 * derives from @podium/commands' ISSUE_COMMAND_NAMES, which POD-311 made a DERIVATION
 * over the contract table (`Object.keys(ISSUE_CONTRACTS)`) rather than a hand-typed
 * array — so the client shape, the server registry and the contracts cannot drift
 * apart, because there is only one list. It is the same list
 * the server's command registry is `satisfies`-checked against — so a command
 * body calling an unknown or renamed proc breaks compilation, not runtime.
 */
type IssueProcName = IssueContractName

/** The specs router (pspec v1, #135) — `podium spec` drives these. */
type SpecProcName = 'list' | 'get' | 'create' | 'save' | 'remove' | 'search'

/** The lock router (advisory named lease locks [spec:SP-85d1]) — `podium lock`
 *  / `podium merge-lock` drive these; the union derives from the same protocol
 *  list the server registry is satisfies-checked against. */
type LockProcName = LockCommandName

/** Instruction-first workflow API used by `podium workflow`. Kept structural
 * for the same reason as issues: this leaf package never imports AppRouter. */
type WorkflowProcName =
  | 'list'
  | 'get'
  | 'create'
  | 'revise'
  | 'fork'
  | 'publish'
  | 'bindings'
  | 'assign'
  | 'profiles'
  | 'profileSave'
  | 'runs'
  | 'prime'
  | 'status'
  | 'checkpoint'
  | 'assignStep'
  | 'skip'
  | 'retry'
  | 'adopt'

export interface IssueTrpc {
  issues: Record<IssueProcName, IssueProc>
  repos: { inferFromPath: IssueProc }
  specs: Record<SpecProcName, IssueProc>
  lock: Record<LockProcName, IssueProc>
  features?: { state: IssueProc }
  workflows: Record<WorkflowProcName, IssueProc>
  /** Read-only, and here only so `--machine <name>` can be resolved to the id the
   *  issue contracts take. Optional because the operator-side HTTP client and the
   *  relay both reach it, but the drift/unit fakes have no reason to stub it. */
  machines?: { list: IssueProc }
}

/**
 * True when `text` is a tRPC response envelope (single or batched). tRPC answers an
 * ordinary procedure failure with a 4xx/5xx whose body IS an envelope — `{error:{message,
 * code,data}}` — and that message ("issue is not proposed") is the whole point, so those
 * must keep flowing to the link. What must NOT flow is a body from OUTSIDE tRPC, e.g. the
 * auth guard's `{"error":"unauthorized"}` (apps/server/src/auth-route.ts:101).
 *
 * The discriminator is the TYPE of `result`/`error`, not its presence: the auth guard's
 * `error` is a string, tRPC's is always an object.
 */
function isTrpcEnvelope(text: string): boolean {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return false
  }
  const items = Array.isArray(body) ? body : [body]
  if (items.length === 0) return false
  return items.every((item) => {
    if (!item || typeof item !== 'object') return false
    const { result, error } = item as { result?: unknown; error?: unknown }
    return (
      (typeof result === 'object' && result !== null) ||
      (typeof error === 'object' && error !== null)
    )
  })
}

/** The message for a response tRPC cannot parse. Names the status and the body, because
 *  the body is where the real cause is; a 401 also names the fix.
 *
 *  The 401 has TWO cases and they need different advice. "Mint a session" is actively
 *  misleading when a session was already sent — it tells the operator to do the thing they
 *  just did, and never says the credential was rejected. `carriedCredential` splits them. */
function describeNonEnvelope(status: number, text: string, carriedCredential: boolean): string {
  const detail = text.trim() ? `: ${text.trim().slice(0, 500)}` : ''
  if (status === 401 && carriedCredential)
    return (
      `HTTP 401 unauthorized${detail} — the session this CLI carried was rejected; it has ` +
      'expired or been revoked. Mint a fresh one with `podium auth mint-session` ' +
      '(`podium auth sessions` shows what the server still holds).'
    )
  if (status === 401)
    return (
      `HTTP 401 unauthorized${detail} — this Podium instance is password-protected and the ` +
      'CLI carried no session. Mint one with `podium auth mint-session`, or set ' +
      'PODIUM_SESSION_TOKEN to an existing session token.'
    )
  return `HTTP ${status} from the Podium server${detail}`
}

export interface IssueClientOptions {
  /** A `podium_session` token (the same credential the browser login issues) sent as a
   *  cookie on every call. Absent = no cookie, which is correct on an instance with no
   *  password configured: `clientAuthGuard` passes those through. */
  sessionToken?: string
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

/** Typed-transport tRPC client for the issue tracker. baseUrl e.g. http://localhost:18787
 *  (no trailing /trpc).
 *
 *  AUTHORIZATION (POD-1376): this used to carry none, on the assumption that "a caller who
 *  reaches /trpc is the operator (the login session gates that surface)". That assumption
 *  was false on a password-protected instance — the surface IS reachable and answers 401,
 *  so every direct/operator CLI call failed. `sessionToken` carries the operator's
 *  credential; constrained agents still go through their daemon relay, which applies scope.
 *
 *  The wire shape is the server's AppRouter; this client is deliberately untyped
 *  against it (see IssueTrpc) — procedure names route by path exactly as before. */
export function makeIssueClient(baseUrl: string, opts: IssueClientOptions = {}): IssueTrpc {
  const doFetch = opts.fetchImpl ?? fetch
  const guardedFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    if (opts.sessionToken)
      headers.set('cookie', `${SESSION_COOKIE}=${encodeURIComponent(opts.sessionToken)}`)
    const res = await doFetch(input as never, { ...init, headers })
    if (res.ok) return res
    // Read once: a Response body can only be consumed once, so hand the link a fresh
    // Response built from the same text rather than the drained original.
    const text = await res.text().catch(() => '')
    if (!isTrpcEnvelope(text))
      throw new Error(describeNonEnvelope(res.status, text, Boolean(opts.sessionToken)))
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
  return createTRPCClient({
    links: [httpBatchLink({ url: `${baseUrl}/trpc`, fetch: guardedFetch })],
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
