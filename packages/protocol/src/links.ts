/**
 * The Podium address space: one grammar for naming a thing inside Podium, and
 * one resolver that says whether a URL names it (POD-1606).
 *
 * WHY THIS EXISTS. Four places used to decide "is this link ours?" and all four
 * asked the same wrong question — how does this URL compare to
 * `window.location.origin`? In the packaged macOS app in all-in-one mode the
 * page is served from `tauri://localhost` while the server it talks to is
 * `http://127.0.0.1:<port>`, so a link to the reader's OWN Podium was
 * cross-origin and left for Safari. Launch the same app in client mode, where
 * the window navigates to the server origin, and the identical URL stayed
 * in-app. The page origin is an accident of packaging; what makes a link ours is
 * whether its origin is a Podium server this client KNOWS. That is the question
 * `parsePodiumLink` asks, and the reason its origins arrive as an argument.
 *
 * ONE GRAMMAR, MANY ROUTERS. The path forms below are the wire format — what an
 * agent writes, what a human copies, what arrives from Mail. They deliberately
 * do NOT have to match any client's internal routes: the phone's screens are
 * `app/issue/[issueId]`, the web's are `/issues/:id`, and an artifact is not a
 * route on either. Parsing yields a TARGET — the thing named — and each surface
 * maps that target onto its own navigation.
 *
 *   /issues/<issue>                                  an issue
 *   /sessions/<session>                              a session
 *   /issues/<issue>/artifacts/<artifactId>[/<entry>] an artifact of an issue
 *   /file?path=<abs>[&root=<root>][&machineId=<id>]  a file in a worktree
 *   anything else                                    a plain in-app view
 *
 * `<issue>` and `<session>` accept BOTH the internal id (`iss_…`, a session
 * uuid) and the human-facing ref (`POD-1606`, `POD-1606-A`, `POD-DRAFT-3`),
 * because the ref is what a person has in their hand — see ./refs.
 *
 * `/file` is singular on purpose: `/files` is a backend route prefix on the
 * server (apps/server/src/static-web.ts BACKEND_PREFIXES), so a page there would
 * never reach the SPA. The path is carried in the query because file paths
 * contain slashes and a path segment would have to be double-encoded.
 *
 * This module is pure and dependency-free — no DOM, no zod — so the server, the
 * web client, the Tauri shell's test and React Native/Hermes can all share it
 * verbatim, exactly like ./refs and ./pairing.
 */

/** Minimal URL declaration keeps this L0 package free of DOM typings while using the RN global. */
declare const URL: {
  new (
    input: string,
  ): {
    protocol: string
    username: string
    password: string
    hostname: string
    port: string
    pathname: string
    search: string
    hash: string
    href: string
  }
}
declare const URLSearchParams: {
  new (init: string): { get(name: string): string | null }
}

/** The custom scheme the OS hands back to the app (`podium://issues/POD-1606`). */
export const PODIUM_SCHEME = 'podium:'

/**
 * Schemes a link may use and still be worth rendering as a link at all.
 * Anything else — `javascript:`, `data:`, `vbscript:` — parses to null, so no
 * caller needs an allowlist of its own.
 */
const LINKABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** The thing a Podium address names. */
export type PodiumTarget =
  | { kind: 'issue'; issue: string; search?: string; hash?: string }
  | { kind: 'session'; session: string; search?: string; hash?: string }
  /** `entry` is a slash-separated relpath INSIDE the artifact bundle. Its
   *  segments cannot themselves contain a slash — the address has no way to say
   *  so, and no filesystem has such a name either. */
  | {
      kind: 'artifact'
      issue: string
      artifactId: string
      entry: string | null
      search?: string
      hash?: string
    }
  | {
      kind: 'file'
      path: string
      root: string | null
      machineId: string | null
      hash?: string
    }
  /** An ordinary in-app page (`/settings/general`, `/usage`, `/`). The client's
   *  own router owns the meaning; this only says it is inside Podium. The
   *  fragment rides along: `#advanced` is which part of the page the writer
   *  meant, and dropping it lands the reader at the top of the right page. */
  | { kind: 'view'; path: string; search: string; hash: string }

/**
 * What a URL turned out to be.
 *
 * `origin` is the Podium origin the link named, or null when the address is
 * host-less — a relative href in a transcript, or a `podium://` link from the
 * OS, both of which mean "this Podium".
 */
export type PodiumLink =
  | { kind: 'internal'; origin: string | null; target: PodiumTarget }
  | { kind: 'external'; href: string }

export interface PodiumLinkOptions {
  /**
   * Every origin that IS this Podium, as the client knows them: the server's
   * `httpOrigin`, and on the phone every paired server profile. A page origin
   * may name a different server when the client uses `?server=`, so callers
   * must not add it merely because it hosts the web bundle. Order does not matter; entries are
   * canonicalized, and `ws://`/`wss://` forms are accepted so a caller can pass
   * a relay URL straight through.
   */
  knownOrigins?: readonly string[]
}

/** Canonical `scheme//host[:port]`, or null when the value is not an http(s)/ws(s) origin. */
export function canonicalPodiumOrigin(value: string): string | null {
  let parsed: InstanceType<typeof URL>
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  const protocol =
    parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol
  if (protocol !== 'http:' && protocol !== 'https:') return null
  if (!parsed.hostname) return null
  return `${protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Map a path + query onto the thing it names. Total: an unrecognised path is a
 * `view`, never a failure — an address this build does not know yet is still
 * inside Podium, and handing it to the client's router is the right answer.
 */
export function podiumTargetForPath(pathname: string, search = '', hash = ''): PodiumTarget {
  const segments = pathname.split('/').filter(Boolean).map(decodeSegment)
  const [head, second, third, fourth, ...rest] = segments
  // Every `view` answer hands back the path AS WRITTEN, for the client's own
  // router to parse. Re-encoding a decoded copy would be a second opinion about
  // escaping in the one branch that has no opinion about the path at all.
  const view = { kind: 'view', path: pathname === '' ? '/' : pathname, search, hash } as const
  const detail = {
    ...(search ? { search } : {}),
    ...(hash ? { hash } : {}),
  }

  if ((head === 'issues' || head === 'issue') && second) {
    if (third === 'artifacts' || third === 'artifact') {
      if (!fourth) return view
      const entry = rest.length > 0 ? rest.join('/') : null
      return { kind: 'artifact', issue: second, artifactId: fourth, entry, ...detail }
    }
    if (third === undefined) return { kind: 'issue', issue: second, ...detail }
    return view
  }

  if ((head === 'sessions' || head === 'session') && second && third === undefined) {
    return { kind: 'session', session: second, ...detail }
  }

  if (head === 'file' && second === undefined) {
    const params = new URLSearchParams(search)
    const path = params.get('path')
    if (path) {
      return {
        kind: 'file',
        path,
        root: params.get('root'),
        machineId: params.get('machineId'),
        ...(hash ? { hash } : {}),
      }
    }
  }

  return view
}

/**
 * Classify one href.
 *
 * Returns null when the link is not something to follow at all: an unsafe
 * scheme, or a `podium://pair…` URL, which carries a pairing credential and
 * belongs to `parseMobilePairingUrl` rather than to navigation.
 *
 * A ROOT-RELATIVE HREF IS ALWAYS INTERNAL. `/issues/POD-1606` written in a
 * transcript cannot mean anyone else's server, so it needs no origin at all —
 * which is also why this takes no page URL to resolve against.
 */
export function parsePodiumLink(href: string, options: PodiumLinkOptions = {}): PodiumLink | null {
  // Tab, LF and CR are STRIPPED by every URL parser before it looks at the
  // string, so `/<TAB>/evil.example` is `//evil.example` to a browser and would
  // be a relative path to a naive reader of the raw text. Removing them here
  // makes this function see what the browser will see.
  const raw = href.replace(/[\t\n\r]/g, '').trim()
  if (!raw) return null

  // Protocol-relative is a cross-origin address wearing a relative link's
  // clothes. It is never ours, and its scheme is not knowable here, so it goes
  // back out as written for the page to resolve. A BACKSLASH COUNTS: URL parsers
  // treat `/\evil.example/x` exactly like `//evil.example/x`.
  if (/^[/\\][/\\]/.test(raw)) return { kind: 'external', href: raw }

  if (raw.startsWith('/')) {
    const query = raw.indexOf('?')
    const fragment = raw.indexOf('#')
    const end = fragment === -1 ? raw.length : fragment
    const path = query === -1 || query > end ? raw.slice(0, end) : raw.slice(0, query)
    const search = query === -1 || query > end ? '' : raw.slice(query, end)
    const hash = fragment === -1 ? '' : raw.slice(fragment)
    return { kind: 'internal', origin: null, target: podiumTargetForPath(path, search, hash) }
  }

  let parsed: InstanceType<typeof URL>
  try {
    parsed = new URL(raw)
  } catch {
    // NULL IS RESERVED FOR SCHEMES WE REFUSE TO FOLLOW. A malformed http(s)
    // address — `http://host.:80/x`, which the IPv4 path rejects — is still a
    // link the browser can try, and returning null here made the phone drop the
    // tap entirely rather than hand it to the OS.
    return /^https?:\/\//i.test(raw) ? { kind: 'external', href: raw } : null
  }

  if (parsed.protocol === PODIUM_SCHEME) {
    if (parsed.username || parsed.password) return null
    const path = parsed.hostname ? `/${parsed.hostname}${parsed.pathname}` : parsed.pathname
    // Credentialed pairing keeps its own parser; navigation must not touch it.
    // `podium:` is not a special scheme, so the parser does NOT lowercase its
    // host — and `podium:///pair` puts the same word in the path instead. Both
    // spellings reach parseMobilePairingUrl, so both are refused here.
    const head = path.split('/').filter(Boolean)[0]
    if (head?.toLowerCase() === 'pair') return null
    return {
      kind: 'internal',
      origin: null,
      target: podiumTargetForPath(path, parsed.search, parsed.hash),
    }
  }

  if (!LINKABLE_PROTOCOLS.has(parsed.protocol)) return null
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'external', href: parsed.href }
  }
  // Userinfo in an http(s) URL is how a link disguises its real host; never ours.
  if (parsed.username || parsed.password) return { kind: 'external', href: parsed.href }

  const origin = canonicalPodiumOrigin(raw)
  const known = new Set<string>()
  for (const candidate of options.knownOrigins ?? []) {
    const canonical = canonicalPodiumOrigin(candidate)
    if (canonical) known.add(canonical)
  }
  if (origin && known.has(origin)) {
    return {
      kind: 'internal',
      origin,
      target: podiumTargetForPath(parsed.pathname, parsed.search, parsed.hash),
    }
  }
  return { kind: 'external', href: parsed.href }
}

/** Whether `href` names something inside a Podium this client knows. */
export function isInternalPodiumLink(href: string, options: PodiumLinkOptions = {}): boolean {
  return parsePodiumLink(href, options)?.kind === 'internal'
}

/**
 * The canonical path for a target — the inverse of {@link podiumTargetForPath}.
 * Prefix it with a server origin to get a link a person can send.
 */
export function podiumTargetPath(target: PodiumTarget): string {
  const enc = encodeURIComponent
  const detail = (target: { search?: string; hash?: string }): string =>
    `${target.search ?? ''}${target.hash ?? ''}`
  switch (target.kind) {
    case 'issue':
      return `/issues/${enc(target.issue)}${detail(target)}`
    case 'session':
      return `/sessions/${enc(target.session)}${detail(target)}`
    case 'artifact': {
      const base = `/issues/${enc(target.issue)}/artifacts/${enc(target.artifactId)}`
      if (!target.entry) return `${base}${detail(target)}`
      return `${base}/${target.entry.split('/').map(enc).join('/')}${detail(target)}`
    }
    case 'file': {
      const parts = [`path=${enc(target.path)}`]
      if (target.root) parts.push(`root=${enc(target.root)}`)
      if (target.machineId) parts.push(`machineId=${enc(target.machineId)}`)
      return `/file?${parts.join('&')}${target.hash ?? ''}`
    }
    default:
      return `${target.path}${target.search}${target.hash}`
  }
}

/**
 * A shareable absolute address. `origin` is the server the reader should be
 * sent to — the client's own `httpOrigin`, not the page origin, so the macOS
 * shell hands out `http://127.0.0.1:<port>/…` rather than `tauri://localhost/…`.
 */
export function formatPodiumLink(origin: string, target: PodiumTarget): string {
  return `${origin.replace(/\/+$/, '')}${podiumTargetPath(target)}`
}
