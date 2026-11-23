/**
 * THE WORKSPACE EDGE (POD-7309; POD-6954 design 4.2, ADR 13).
 *
 * Every HTTP request and every socket upgrade is tied to one workspace here,
 * before any handler runs, and a handler never reads a workspace from the
 * request again: it asks {@link boundWorkspaceOf}.
 *
 * 1. The entry point is looked up in {@link WORKSPACE_ENTRY_POINTS}. A route
 *    that belongs to no workspace (`/health`, `/version`, `/.well-known/*`,
 *    the web shell, ...) is passed through unbound, and says why.
 * 2. The selector is read in the order the hosted router reads it
 *    (podium-cloud apps/hosted-server/src/workspace-router.ts):
 *    `Podium-Workspace-Id`, `Podium-Workspace`, `?workspace=`, then the
 *    `/files/artifact/workspace/<segment>/` path. Every selector present must
 *    name the same workspace.
 * 3. The selector names a workspace by id or by slug, among the workspaces
 *    this process has loaded. A process holds one registry per loaded
 *    workspace until the stateless Core lands (POD-6954 design 4.2); a
 *    workspace it has not loaded is refused with `workspace_not_served`, and
 *    nothing here loads one.
 * 4. Membership is verified in the bound workspace, through that workspace's
 *    own `memberOfRequest` (identity/member-of-request.ts): the device
 *    sign-in, its account, and an active membership OF THIS WORKSPACE. A
 *    sign-in is account-wide on hosted, so a sign-in made for workspace A
 *    resolves to "not a member" in workspace B. The check runs where each
 *    entry point already admits its caller (the client guard on `/trpc`,
 *    `/sync` and `/files`, the socket upgrade, {@link WorkspaceEdge.signedInGate}
 *    on the people routes), after CORS and the readiness gate, so a refusal
 *    reaches a cross-origin client in a form it can read.
 *
 * A self-hosted server holds exactly one workspace and needs no selector. It
 * reads none: a self-hosted server behind an outer router (today's per-tenant
 * hosted machines) gets requests whose selector that router already consumed.
 *
 * The binding is kept per `Request` object, so it ends with the request.
 */
import { asWorkspaceId, type WorkspaceId } from '@podium/model'
import type { Context, MiddlewareHandler } from 'hono'
import { getPath } from 'hono/utils/url'
import {
  type MemberOfRequest,
  type MemberResolution,
  refusalAnswer,
} from './identity/member-of-request'
import type { ServerMode } from './server-mode'

/**
 * The workspace a hosted composition root names for its process to load. One
 * of the three places a `WorkspaceId` is minted (POD-6959 design 2.4): here at
 * the edge, the self-hosted composition, and test support.
 */
export function hostedWorkspaceId(named: string | undefined): WorkspaceId {
  const id = named?.trim()
  if (!id) {
    throw new Error(
      'a hosted server names the workspace it loads: startServer({ mode: "hosted", workspaceId })',
    )
  }
  return asWorkspaceId(id)
}

// ---------------------------------------------------------------------------
// The entry points
// ---------------------------------------------------------------------------

/**
 * How an entry point is tied to a workspace.
 *
 * - `member`: bound, and only an active member of the bound workspace is
 *   admitted: the client guard (auth-route.ts `clientAuthGuard`) or the socket
 *   upgrade refuses anybody else, resolving them in the bound workspace.
 * - `signed-in`: bound; a signed-in account that is not a member of the bound
 *   workspace is refused by {@link WorkspaceEdge.signedInGate}. Nobody signed
 *   in is left to the route, which asks for a sign-in in its own words.
 * - `credential`: bound; the route proves its own credential against the bound
 *   workspace (a password, an invitation, a pairing code, a machine key, an
 *   MCP thread token). A non-member must reach it, so the edge checks no
 *   membership.
 * - `unbound`: belongs to no workspace.
 */
export type EntryBinding = 'member' | 'signed-in' | 'credential' | 'unbound'

export interface EntryPoint {
  /**
   * `http` and `socket` rows are matched against requests. A `hook` (code that
   * sees a request before the edge) and a `unix` socket (a local channel with no
   * URL) are rows of the table so that it names every way in; nothing matches
   * them.
   */
  readonly transport: 'http' | 'socket' | 'hook' | 'unix'
  /** The path, or the path prefix when it ends in `/` or `*`. */
  readonly path: string
  readonly binding: EntryBinding
  /** How it is bound, or why it is not. */
  readonly why: string
}

/**
 * EVERY ENTRY POINT OF THE SERVER, and how each is tied to a workspace. The
 * first match wins, so a narrower path comes before its prefix. A path no row
 * names falls to {@link FALLBACK_ENTRY}.
 */
export const WORKSPACE_ENTRY_POINTS: readonly EntryPoint[] = [
  // Sockets.
  {
    transport: 'socket',
    path: '/client',
    binding: 'member',
    why: 'client sync socket; the member is resolved in the bound workspace at upgrade and revalidated on every heartbeat',
  },
  {
    transport: 'socket',
    path: '/daemon',
    binding: 'credential',
    why: "daemon link; the machine-key handshake is checked against the machine rows of the bound workspace's registry",
  },
  {
    transport: 'socket',
    path: '/machine',
    binding: 'credential',
    why: "machine link; same handshake as /daemon, against the bound workspace's machine rows",
  },
  // The human client's data plane.
  {
    transport: 'http',
    path: '/trpc/',
    binding: 'member',
    why: 'commands and queries; the context carries the bound workspace and the member resolved in it',
  },
  {
    transport: 'http',
    path: '/sync/',
    binding: 'member',
    why: "bootstrap, delta and collections read only the bound workspace's log",
  },
  {
    transport: 'http',
    path: '/live/',
    binding: 'member',
    why: "live grants; the grant's audience is the bound workspace and it names only what the member resolved in it may see",
  },
  {
    transport: 'http',
    path: '/files/',
    binding: 'member',
    why: "assets and artifacts are read from the bound workspace's stores; an artifact path segment must name the bound workspace",
  },
  // Sign-in and the people routes.
  {
    transport: 'http',
    path: '/auth/status',
    binding: 'credential',
    why: "reports the caller's membership in the bound workspace, so a non-member is told so",
  },
  {
    transport: 'http',
    path: '/auth/login',
    binding: 'credential',
    why: 'password sign-in; refused unless the account holds an active membership of the bound workspace',
  },
  {
    transport: 'http',
    path: '/auth/logout',
    binding: 'credential',
    why: 'ends the device sign-in the request carries; a non-member may sign out',
  },
  {
    transport: 'http',
    path: '/auth/members/inspect',
    binding: 'credential',
    why: "invitation link; the token is looked up in the bound workspace's invitations",
  },
  {
    transport: 'http',
    path: '/auth/members/complete',
    binding: 'credential',
    why: 'invitation acceptance by an account that is not a member yet',
  },
  {
    transport: 'http',
    path: '/auth/members/',
    binding: 'signed-in',
    why: 'people management; the caller is resolved in the bound workspace',
  },
  {
    transport: 'http',
    path: '/auth/admin/',
    binding: 'signed-in',
    why: 'admin area and sign-in list; the caller is resolved in the bound workspace',
  },
  {
    transport: 'http',
    path: '/auth/client-sessions',
    binding: 'signed-in',
    why: "the caller's own device sign-ins, as a member of the bound workspace",
  },
  {
    transport: 'http',
    path: '/auth/mobile-pair/start',
    binding: 'signed-in',
    why: 'a signed-in member starts pairing a phone to the bound workspace',
  },
  {
    transport: 'http',
    path: '/auth/mobile-pair/approve',
    binding: 'signed-in',
    why: 'a signed-in member approves a phone for the bound workspace',
  },
  {
    transport: 'http',
    path: '/auth/mobile-pair/deny',
    binding: 'signed-in',
    why: 'a signed-in member denies a phone for the bound workspace',
  },
  {
    transport: 'http',
    path: '/auth/mobile-pair/',
    binding: 'credential',
    why: 'the phone proves the pairing code the bound workspace issued',
  },
  {
    transport: 'http',
    path: '/auth/',
    binding: 'credential',
    why: 'the identity library and the server-transfer claim prove their own token in the bound workspace',
  },
  {
    transport: 'http',
    path: '/mcp',
    binding: 'credential',
    why: "the superagent's tools; the per-thread token was issued by the bound workspace's superagent",
  },
  // Belongs to no workspace.
  {
    transport: 'http',
    path: '/platform/',
    binding: 'unbound',
    why: "the hosted edition's platform routes (its identity library, sign-up, workspace creation, billing webhooks): account-wide, authenticated by the edition itself",
  },
  {
    transport: 'hook',
    path: 'plugin onRequest',
    binding: 'unbound',
    why: "a plugin's router hop, which runs before the edge (server.ts native fetch): it may forward a request to the process that serves its workspace; a plugin route that serves data is a Hono route and is bound like any other",
  },
  {
    transport: 'unix',
    path: 'control socket',
    binding: 'unbound',
    why: "the self-hosted user's own unix socket (file permissions are its credential); it acts on the install's one workspace, and a hosted server creates none",
  },
  { transport: 'http', path: '/health', binding: 'unbound', why: 'process liveness' },
  {
    transport: 'http',
    path: '/version',
    binding: 'unbound',
    why: "this binary's build, the same for every workspace",
  },
  {
    transport: 'http',
    path: '/.well-known/',
    binding: 'unbound',
    why: 'the installation reachability and locate proofs; they name the installation',
  },
  {
    transport: 'http',
    path: '/readiness',
    binding: 'unbound',
    why: "the process's own readiness, read before a workspace is chosen",
  },
  {
    transport: 'http',
    path: '/setup/',
    binding: 'unbound',
    why: "the installation's first-run setup; not registered on a hosted server",
  },
  {
    transport: 'http',
    path: '/maintenance/',
    binding: 'unbound',
    why: "the process's janitor worker, with a token that never leaves the process",
  },
  {
    transport: 'http',
    path: '/updates/',
    binding: 'unbound',
    why: "the installation's development release feed; off on a hosted server",
  },
]

/**
 * The page loads and static files a hosted server serves to anybody: the web
 * shell, `/w/<slug>` pages, the phone site, and files with a static extension.
 */
const STATIC_EXACT = new Set(['/', '/index.html', '/desktop', '/workspace', '/mobile'])
const STATIC_PREFIXES = ['/w/', '/mobile/', '/assets/']
const STATIC_EXTENSION =
  /\.(?:js|mjs|css|svg|png|jpg|jpeg|gif|webp|ico|webmanifest|woff2?|ttf|map|wasm|txt)$/

/** Whether a hosted server may answer this GET path unbound. */
export function isStaticPath(pathname: string): boolean {
  return (
    STATIC_EXACT.has(pathname) ||
    STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    STATIC_EXTENSION.test(pathname)
  )
}

/**
 * A path no row names.
 *
 * - Self-hosted: a page load or a static file belongs to no workspace; any
 *   other method is bound.
 * - Hosted: only the static paths ({@link isStaticPath}) are unbound. Every
 *   other request, a GET too, is bound, and the edge itself admits only a
 *   member of the bound workspace, so a route added without a row fails
 *   closed.
 */
export function fallbackEntry(
  method: string,
  mode: ServerMode = 'self-hosted',
  pathname = '*',
): EntryPoint {
  const read = method === 'GET' || method === 'HEAD'
  if (read && (mode === 'self-hosted' || isStaticPath(pathname))) {
    return {
      transport: 'http',
      path: '*',
      binding: 'unbound',
      why: 'the web shell and static files',
    }
  }
  return {
    transport: 'http',
    path: '*',
    binding: 'member',
    why: 'any other route (a route added without a row): bound; on hosted the edge itself admits only a member',
  }
}

const SOCKET_PATHS = new Set(
  WORKSPACE_ENTRY_POINTS.filter((entry) => entry.transport === 'socket').map((e) => e.path),
)

function matches(entry: EntryPoint, pathname: string): boolean {
  if (entry.path.endsWith('/')) {
    return pathname === entry.path.slice(0, -1) || pathname.startsWith(entry.path)
  }
  return pathname === entry.path || pathname.startsWith(`${entry.path}/`)
}

/**
 * The entry point a request reaches, by the path Hono routes: decoded, the
 * way `c.req.path` is (`hono/utils/url` `getPath`), so `/%66iles/asset` is the
 * `/files/` row. A plugin's own rows come after the server's, so they cannot
 * shadow one.
 */
export function entryPointOf(
  method: string,
  pathname: string,
  upgrade: boolean,
  mode: ServerMode = 'self-hosted',
  pluginRows: readonly EntryPoint[] = [],
): EntryPoint {
  const transport = upgrade && SOCKET_PATHS.has(pathname) ? 'socket' : 'http'
  for (const entry of [...WORKSPACE_ENTRY_POINTS, ...pluginRows]) {
    if (entry.transport === transport && matches(entry, pathname)) return entry
  }
  return fallbackEntry(method, mode, pathname)
}

/** The path a request is routed by: Hono's decoded path. */
export function routedPath(request: Request): string {
  return getPath(request)
}

// ---------------------------------------------------------------------------
// The selector
// ---------------------------------------------------------------------------

export const WORKSPACE_ID_HEADER = 'Podium-Workspace-Id'
export const WORKSPACE_HEADER = 'Podium-Workspace'
export const WORKSPACE_QUERY = 'workspace'
const ARTIFACT_WORKSPACE_PREFIX = '/files/artifact/workspace/'

export interface WorkspaceSelector {
  readonly source: 'id-header' | 'header' | 'query' | 'artifact-path'
  readonly value: string
}

export type SelectorRead =
  | { kind: 'selectors'; selectors: readonly WorkspaceSelector[] }
  | { kind: 'invalid'; source: WorkspaceSelector['source'] }

/** Every selector the request carries, highest priority first. */
export function readWorkspaceSelectors(request: Request): SelectorRead {
  const url = new URL(request.url)
  const selectors: WorkspaceSelector[] = []
  const add = (source: WorkspaceSelector['source'], value: string | null) => {
    if (value === null) return true
    if (!value.trim()) return false
    selectors.push({ source, value })
    return true
  }
  if (!add('id-header', request.headers.get(WORKSPACE_ID_HEADER))) {
    return { kind: 'invalid', source: 'id-header' }
  }
  if (!add('header', request.headers.get(WORKSPACE_HEADER))) {
    return { kind: 'invalid', source: 'header' }
  }
  const queries = url.searchParams.getAll(WORKSPACE_QUERY)
  if (queries.length > 1) return { kind: 'invalid', source: 'query' }
  if (!add('query', queries[0] ?? null)) return { kind: 'invalid', source: 'query' }
  if (url.pathname.startsWith(ARTIFACT_WORKSPACE_PREFIX)) {
    const encoded = url.pathname.slice(ARTIFACT_WORKSPACE_PREFIX.length).split('/')[0] ?? ''
    let decoded = ''
    try {
      decoded = decodeURIComponent(encoded)
    } catch {
      decoded = ''
    }
    if (!add('artifact-path', decoded)) return { kind: 'invalid', source: 'artifact-path' }
  }
  return { kind: 'selectors', selectors }
}

// ---------------------------------------------------------------------------
// The edge
// ---------------------------------------------------------------------------

/** A workspace this process has loaded, and its own member resolver. */
export interface ServedWorkspace {
  readonly id: WorkspaceId
  /** The workspace's slug, when it has one (hosted); a selector may name it. */
  readonly slug: string | null
  /** Resolves a request to a member of THIS workspace. */
  readonly memberOfRequest: MemberOfRequest
}

export type EdgeRefusalCode =
  | 'workspace_required'
  | 'workspace_selector_invalid'
  | 'workspace_selector_conflict'
  | 'workspace_not_served'

export interface EdgeRefusal {
  readonly status: 400 | 401 | 403 | 404
  readonly body: { error: string; message?: string }
}

export type EdgeAnswer =
  | { kind: 'unbound'; entry: EntryPoint }
  | { kind: 'bound'; entry: EntryPoint; workspace: ServedWorkspace }
  | { kind: 'refused'; entry: EntryPoint; refusal: EdgeRefusal }

export interface WorkspaceEdgeOptions {
  readonly mode: ServerMode
  /** The workspaces this process has loaded. Self-hosted: exactly one. */
  readonly served: readonly ServedWorkspace[]
  /**
   * Answers a refusal of the HTTP middleware. The server passes its CORS
   * handling here, so a cross-origin client can read the refusal.
   * Absent: plain JSON.
   */
  readonly respond?: (c: Context, refusal: EdgeRefusal) => Response | Promise<Response>
  /**
   * The entry points plugins declare for the routes they register
   * (`PodiumPlugin.entryPoints`). Matched after the server's own rows.
   */
  readonly pluginEntryPoints?: readonly EntryPoint[]
}

export interface WorkspaceEdge {
  /**
   * Binds `request` (an HTTP request, or a socket upgrade when `upgrade`) and
   * records the result for {@link boundWorkspaceOf}. Asked again for the same
   * `Request`, it answers the same.
   */
  bind(request: Request, upgrade?: boolean): Promise<EdgeAnswer>
  /** The Hono middleware that binds every HTTP request and refuses what it must. */
  readonly middleware: MiddlewareHandler
  /**
   * For `signed-in` entry points: refuses a signed-in account that is not a
   * member of the bound workspace (403 `not_workspace_member`). Registered
   * after the routes' CORS and readiness middleware.
   */
  readonly signedInGate: MiddlewareHandler
  /** The workspaces this process serves. */
  readonly served: readonly ServedWorkspace[]
  readonly mode: ServerMode
}

const bindings = new WeakMap<Request, ServedWorkspace>()

/**
 * THE WORKSPACE A REQUEST IS BOUND TO. Every handler behind the edge reads its
 * workspace here and nowhere else. Throws for a request the edge did not bind:
 * that is a route registered outside the entry-point table, a defect.
 */
export function boundWorkspaceOf(request: Request): WorkspaceId {
  return boundServedWorkspaceOf(request).id
}

/** The bound workspace's whole entry, for the resolver that belongs to it. */
export function boundServedWorkspaceOf(request: Request): ServedWorkspace {
  const bound = bindings.get(request)
  if (!bound) {
    throw new Error(
      `${new URL(request.url).pathname} reached a workspace handler without a workspace binding`,
    )
  }
  return bound
}

/** The bound workspace, or undefined for an unbound request. */
export function maybeBoundServedWorkspaceOf(request: Request): ServedWorkspace | undefined {
  return bindings.get(request)
}

/** Test support and compositions without the edge: record a binding directly. */
export function recordWorkspaceBinding(request: Request, workspace: ServedWorkspace): void {
  bindings.set(request, workspace)
}

function refusal(
  status: EdgeRefusal['status'],
  error: EdgeRefusalCode,
  message: string,
): EdgeRefusal {
  return { status, body: { error, message } }
}

export function createWorkspaceEdge(options: WorkspaceEdgeOptions): WorkspaceEdge {
  const { mode, served } = options
  if (served.length === 0) throw new Error('a server serves at least one workspace')
  if (mode === 'self-hosted' && served.length !== 1) {
    throw new Error('a self-hosted server serves exactly one workspace')
  }
  const byId = new Map(served.map((workspace) => [workspace.id as string, workspace]))
  const bySlug = new Map(
    served.flatMap((workspace) => (workspace.slug ? [[workspace.slug, workspace] as const] : [])),
  )
  const resolveSelector = (selector: WorkspaceSelector): ServedWorkspace | undefined =>
    byId.get(selector.value) ??
    (selector.source === 'id-header' ? undefined : bySlug.get(selector.value))

  const workspaceOf = (
    request: Request,
  ): { workspace: ServedWorkspace } | { refusal: EdgeRefusal } => {
    // Self-hosted: the one workspace; a selector, if any, was an outer router's.
    const [only] = served
    if (mode === 'self-hosted' && only) return { workspace: only }
    const read = readWorkspaceSelectors(request)
    if (read.kind === 'invalid') {
      return {
        refusal: refusal(
          400,
          'workspace_selector_invalid',
          `The workspace selector (${read.source}) is empty, repeated or not decodable.`,
        ),
      }
    }
    const [first, ...rest] = read.selectors
    if (!first) {
      return {
        refusal: refusal(
          400,
          'workspace_required',
          'This server serves many workspaces: name one with the Podium-Workspace header or ?workspace=.',
        ),
      }
    }
    const workspace = resolveSelector(first)
    if (!workspace) {
      return {
        refusal: refusal(
          404,
          'workspace_not_served',
          `This server does not serve the workspace "${first.value}".`,
        ),
      }
    }
    if (rest.some((selector) => resolveSelector(selector) !== workspace)) {
      return {
        refusal: refusal(
          400,
          'workspace_selector_conflict',
          'The request names more than one workspace.',
        ),
      }
    }
    return { workspace }
  }

  const answers = new WeakMap<Request, Promise<EdgeAnswer>>()

  const decide = async (request: Request, upgrade: boolean): Promise<EdgeAnswer> => {
    const entry = entryPointOf(
      request.method,
      routedPath(request),
      upgrade,
      mode,
      options.pluginEntryPoints,
    )
    // A CORS preflight carries no selector and no credential; the request it
    // asks about is bound when it comes.
    if (entry.binding === 'unbound' || (request.method === 'OPTIONS' && !upgrade)) {
      return { kind: 'unbound', entry }
    }
    const found = workspaceOf(request)
    if ('refusal' in found) return { kind: 'refused', entry, refusal: found.refusal }
    bindings.set(request, found.workspace)
    // A route nobody listed has no admission step of its own the edge knows
    // of, so on hosted the edge admits only a member: it fails closed. A
    // self-hosted server's plugins keep admitting their own callers.
    if (mode === 'hosted' && entry.path === '*') {
      const member = await found.workspace.memberOfRequest(request)
      if (member.kind !== 'member')
        return { kind: 'refused', entry, refusal: refusalAnswer(member) }
    }
    return { kind: 'bound', entry, workspace: found.workspace }
  }

  const bind = (request: Request, upgrade = false): Promise<EdgeAnswer> => {
    let answer = answers.get(request)
    if (!answer) {
      answer = decide(request, upgrade)
      answers.set(request, answer)
    }
    return answer
  }

  const respond = async (c: Context, refused: EdgeRefusal): Promise<Response> => {
    c.header('cache-control', 'no-store')
    return options.respond
      ? await options.respond(c, refused)
      : c.json(refused.body, refused.status)
  }

  const middleware: MiddlewareHandler = async (c: Context, next) => {
    const answer = await bind(c.req.raw)
    if (answer.kind === 'refused') return await respond(c, answer.refusal)
    return await next()
  }

  const signedInGate: MiddlewareHandler = async (c: Context, next) => {
    const answer = await bind(c.req.raw)
    if (answer.kind !== 'bound' || answer.entry.binding !== 'signed-in') return await next()
    const member: MemberResolution = await answer.workspace.memberOfRequest(c.req.raw)
    // Signed in, not a member here: refused. Nobody signed in: the route asks.
    if (member.kind === 'not-a-member') return await respond(c, refusalAnswer(member))
    return await next()
  }

  return { bind, middleware, signedInGate, served, mode }
}

/**
 * The one member resolver of a server that serves `edge`: a bound request is
 * resolved in its workspace.
 *
 * An unbound request belongs to nobody on hosted: it is `unauthenticated`,
 * whatever it carries. On self-hosted it is resolved in the install's one
 * workspace (the HTTPS page check on a page load needs that).
 */
export function boundMemberOfRequest(
  edge: Pick<WorkspaceEdge, 'served' | 'mode'>,
): MemberOfRequest {
  const [only] = edge.served
  if (!only) throw new Error('a server serves at least one workspace')
  const fallback = edge.mode === 'self-hosted' ? only : undefined
  const memberOfRequest = async (request: Request): Promise<MemberResolution> => {
    const workspace = bindings.get(request) ?? fallback
    if (!workspace) return { kind: 'unauthenticated' }
    const resolution = await workspace.memberOfRequest(request)
    // A member is a member OF the workspace it was resolved in.
    return resolution.kind === 'member' ? { ...resolution, workspaceId: workspace.id } : resolution
  }
  // The connection facts are the server's, the same in every workspace.
  return Object.assign(memberOfRequest, {
    factsOf: (request: Request) => only.memberOfRequest.factsOf(request),
  })
}

/**
 * The URL of a call this server makes to itself for workspace `id`: on hosted
 * it carries the selector the edge reads (the in-process MCP endpoint).
 */
export function selfCallUrl(url: string, mode: ServerMode, id: WorkspaceId): string {
  if (mode !== 'hosted') return url
  const parsed = new URL(url)
  parsed.searchParams.set(WORKSPACE_QUERY, id)
  return parsed.href
}
