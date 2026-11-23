/**
 * FROM A REQUEST TO A MEMBER: THE ONE FUNCTION (POD-6746;
 * docs/design/people-and-sign-in.md, section 5).
 *
 * Every transport of a human client asks the same question the same way: HTTP,
 * tRPC, the file routes, sync, the socket upgrade and the auth routes. The
 * path is always device sign-in, account, active membership, member. There is
 * no second way from a cookie to a member and nothing to fall through to.
 *
 * The server contributes two things the identity package cannot know:
 *
 * - the three connection facts, worked out at the server's trust boundary
 *   (section 2.3). The package never reads a host or a forwarding header;
 * - the member row. A membership names a member; the row says whether that
 *   member may act. A resolution whose row is missing or disabled is treated
 *   as "not a member" (in a hosted workspace that is the short time before a
 *   new membership is applied).
 *
 * One resolution per `Request` object (POD-6220): the guard resolves it and
 * everything behind it on the same request reads the same answer.
 */
import type { ConnectionFacts, DeviceKind, WorkspaceIdentity } from '@podium/identity'
import { createLogger } from '@podium/logger'
import { asUserId, type UserId, type UserRole } from '@podium/model'
import { type HttpsRequiredRefusal, httpsRequiredRefusal, signInHttpsUrl } from '@podium/protocol'
import { type UserCommandPrincipal, userCommandPrincipal } from '../command-principal'
import type { HostMachine } from '../host-machine'
import { isHostLocalRequest } from '../readiness-boundary'
import { clientAddressForRequest, isSecureRequest } from '../request-scheme'

const log = createLogger('server:identity')

/** Headers a reverse proxy adds when it forwards a request for somebody else. */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
] as const

/**
 * The client's address for throttling, or null when it cannot be known.
 *
 * Forwarding headers are the client's own word unless a proxy wrote them, so
 * they change the answer only where a proxy is the likely writer (POD-6754
 * finding F1, review):
 * - Podium ended TLS itself (the URL is https): the peer is budgeted, headers
 *   or not. Behind a re-encrypting proxy with no trusted hop, every client then
 *   shares the proxy's budget; the operator is told to set the hops.
 * - Plain HTTP, no trusted hop, forwarding headers and a peer that can only be
 *   a nearby proxy (private, unique-local, link-local, carrier-grade NAT or
 *   loopback): the peer is shared by every client, so the source is unknown and
 *   only the per-identifier budget applies.
 * - A public peer is budgeted by itself, whatever headers it sends.
 */
function throttlingAddress(
  request: Request,
  trustedProxyHops: number,
  sameMachine: boolean,
  warnUntrustedProxy: () => void,
): string | null {
  const peer = request.headers.get('x-podium-peer-address') ?? undefined
  if (
    trustedProxyHops <= 0 &&
    !sameMachine &&
    FORWARDING_HEADERS.some((name) => request.headers.has(name)) &&
    isNearbyProxyAddress(peer)
  ) {
    warnUntrustedProxy()
    if (!request.url.startsWith('https:')) return null
  }
  return clientAddressForRequest(request, peer, trustedProxyHops) ?? null
}

/**
 * An address only a proxy near this server would connect from: loopback,
 * RFC 1918, carrier-grade NAT (100.64/10), link-local, or IPv6 unique-local
 * (fc00::/7) and link-local (fe80::/10).
 */
export function isNearbyProxyAddress(address: string | undefined): boolean {
  if (!address) return false
  const bare = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }
  if (!bare.includes(':')) return false
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  // The first group, written in full: fc00-fdff, or fe80-febf.
  return /^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare)
}

export type MemberResolution =
  | {
      kind: 'member'
      memberId: UserId
      role: UserRole
      principal: UserCommandPrincipal
      accountId: string
      /** null: admitted by the same-machine rule; no device signed in. */
      deviceSignIn: { id: string; kind: DeviceKind; expiresAt: Date } | null
      /** The sign-in is due for its daily renewal. */
      renewDue: boolean
    }
  | { kind: 'not-a-member'; accountId: string }
  | { kind: 'unauthenticated' }
  | { kind: 'https_required'; httpsUrl?: string }

export type MemberRefusal = Exclude<MemberResolution, { kind: 'member' }>

/** The HTTP answer for a caller who is not admitted (specification, section 5.2). */
export function refusalAnswer(refusal: MemberRefusal): {
  status: 400 | 401 | 403
  body: { error: string } | HttpsRequiredRefusal
} {
  switch (refusal.kind) {
    case 'unauthenticated':
      return { status: 401, body: { error: 'unauthorized' } }
    case 'not-a-member':
      return { status: 403, body: { error: 'not_workspace_member' } }
    case 'https_required':
      return { status: 400, body: httpsRequiredRefusal(refusal.httpsUrl) }
  }
}

export interface MemberOfRequest {
  /** The three facts about this request's connection. */
  factsOf(request: Request): ConnectionFacts
  /** Who this request is, resolved once per `Request` object. */
  (request: Request): Promise<MemberResolution>
}

export function createMemberOfRequest(deps: {
  identity: WorkspaceIdentity
  /** The member row, undefined for a missing or disabled member. */
  users: { get(id: UserId): Promise<{ role: UserRole } | undefined> }
  /** Reverse-proxy hops whose forwarding values the operator declared trusted. */
  trustedProxyHops: number
  /** Omitted only by legacy fixtures; null disables same-machine trust. */
  hostMachine?: HostMachine
  /** The server's advertised address, read per refusal so tunnel changes take effect. */
  publicUrl?: () => string | undefined
}): MemberOfRequest {
  /**
   * `request` is the request as the HTTP app sees it: `x-podium-peer-address`
   * is the peer the native server reported, never a value the client sent.
   */
  let warnedUntrustedProxy = false
  const warnUntrustedProxy = () => {
    if (warnedUntrustedProxy) return
    warnedUntrustedProxy = true
    log.warn(
      'A request came through a reverse proxy, but PODIUM_TRUSTED_PROXY_HOPS is 0, so ' +
        'Podium cannot tell the clients behind it apart: they share one sign-in limit ' +
        'per address, or have none. Per-account limits still apply. Set ' +
        'PODIUM_TRUSTED_PROXY_HOPS to the number of proxies in front of Podium.',
    )
  }
  const factsOf = (request: Request): ConnectionFacts => {
    const sameMachine = deps.hostMachine !== null && isHostLocalRequest(request)
    return {
      scheme: isSecureRequest(
        request.url,
        request.headers.get('x-forwarded-proto') ?? undefined,
        deps.trustedProxyHops,
      )
        ? 'https'
        : 'http',
      sameMachine,
      clientAddress: throttlingAddress(
        request,
        deps.trustedProxyHops,
        sameMachine,
        warnUntrustedProxy,
      ),
    }
  }

  const resolve = async (request: Request): Promise<MemberResolution> => {
    const httpsRequired = (): MemberResolution => {
      const httpsUrl = signInHttpsUrl(deps.publicUrl?.())
      return { kind: 'https_required', ...(httpsUrl ? { httpsUrl } : {}) }
    }
    const facts = factsOf(request)
    // An explicit bearer requires HTTPS, even on loopback. It must not
    // disappear from the request and allow a different cookie to take over.
    if (
      facts.scheme === 'http' &&
      /^Bearer(?: |$)/i.test(request.headers.get('authorization') ?? '')
    ) {
      return httpsRequired()
    }
    const resolution = await deps.identity.resolve(request, facts)
    if (resolution.kind === 'https_required') return httpsRequired()
    if (resolution.kind !== 'member') {
      return resolution.kind === 'not-a-member'
        ? { kind: 'not-a-member', accountId: resolution.accountId }
        : resolution
    }
    const memberId = asUserId(resolution.memberId)
    const row = await deps.users.get(memberId)
    if (!row) return { kind: 'not-a-member', accountId: resolution.accountId }
    return {
      kind: 'member',
      memberId,
      // The row's role: it is what every gate behind this reads.
      role: row.role,
      principal: userCommandPrincipal(memberId, row.role),
      accountId: resolution.accountId,
      deviceSignIn: resolution.deviceSignIn,
      renewDue: resolution.renewDue,
    }
  }

  const resolved = new WeakMap<Request, Promise<MemberResolution>>()
  const memberOfRequest = (request: Request): Promise<MemberResolution> => {
    let resolution = resolved.get(request)
    if (!resolution) {
      resolution = resolve(request)
      resolved.set(request, resolution)
    }
    return resolution
  }
  return Object.assign(memberOfRequest, { factsOf })
}
