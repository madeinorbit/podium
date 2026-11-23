/**
 * WHAT KIND OF CONNECTION A DAEMON IS ON (credential management §8, "What
 * crosses the wire").
 *
 * A Podium-held secret reaches a daemon only over a connection the SERVER
 * judged safe. The judgement is made once, when the daemon's socket is accepted,
 * from facts the server holds about the request: its scheme, the proxy chain it
 * was told to trust, the peer address, and the networks an admin declared
 * trusted. Nothing the daemon says about itself takes part: a header it adds is
 * read only through the same proxy-hop rule sign-in tokens use (zero hops by
 * default, so it is ignored), and no field of its hello is read here at all.
 *
 *  - `encrypted`: the request reached the server over TLS, directly or through
 *    a trusted proxy that saw https (`isSecureRequest`, as for sign-in).
 *  - `local`: the peer is this computer and no proxy was involved. When the
 *    server trusts a proxy hop, the request must also have been addressed to a
 *    loopback name, as for sign-in (`isHostLocalRequest`): a proxy on this
 *    computer that strips the forwarding headers connects from loopback too,
 *    but it keeps the public Host it was reached on.
 *  - `trusted`: the client address is inside `daemonLink.trustedNetworks`, a
 *    private encrypted network such as a VPN.
 *  - `plain`: anything else. Credentials are never sent over it.
 *
 * The FACTS are kept per connection and the kind is worked out when asked, so a
 * change to the trusted networks applies to daemons already connected.
 */

import { cidrContains, type MachineId } from '@podium/model'
import { isSecureRequest } from '../auth-route'
import { isLoopbackAddress, isLoopbackHost, PROXY_ONLY_HEADERS } from '../readiness-boundary'
import { clientAddressForRequest } from '../request-scheme'

export type DaemonLinkKind = 'encrypted' | 'local' | 'trusted' | 'plain'

/** What the server knows about how a daemon's request reached it. */
export interface DaemonLinkFacts {
  readonly url: string
  readonly forwardedProto?: string
  readonly hasProxyHeaders: boolean
  /** Resolved with `clientAddressForRequest`; undefined when it cannot be. */
  readonly clientAddress: string | undefined
  /**
   * The socket's own peer, as the native server reports it, before any proxy
   * header is read. A server bound to loopback trusts one proxy hop by
   * default, so `clientAddress` is read from `x-forwarded-for`; a daemon on the
   * same computer dials it directly and sends none, and only this says where
   * it came from.
   */
  readonly peerAddress?: string
  readonly trustedProxyHops: number
}

/** Any of these marks a request as having passed a proxy. */
const PROXY_HEADERS = [...PROXY_ONLY_HEADERS, 'x-forwarded-for', 'x-forwarded-host'] as const

export function classifyDaemonLink(
  i: DaemonLinkFacts & { readonly trustedNetworks: readonly string[] },
): DaemonLinkKind {
  if (isSecureRequest(i.url, i.forwardedProto, i.trustedProxyHops)) return 'encrypted'
  // Never left the computer: a loopback peer that no proxy spoke for. With a
  // trusted proxy hop the client is read from its header, so a direct
  // same-computer daemon (no header) is known only by its socket's peer. That
  // peer is also what a same-computer proxy that forwards no X-Forwarded-*
  // header looks like (POD-7041), so with a trusted hop the request must also
  // name this computer: such a proxy passes on the public Host it was reached
  // on. One that rewrites Host to its loopback upstream is not supported.
  if (
    !i.hasProxyHeaders &&
    (isLoopbackAddress(i.clientAddress) || isLoopbackAddress(i.peerAddress)) &&
    (i.trustedProxyHops === 0 || isLoopbackUrl(i.url))
  ) {
    return 'local'
  }
  const address = i.clientAddress
  if (address !== undefined && i.trustedNetworks.some((range) => cidrContains(range, address))) {
    return 'trusted'
  }
  return 'plain'
}

/** Whether a request URL was addressed to this computer by name; unreadable is not. */
function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).host)
  } catch {
    return false
  }
}

/** The facts of one upgrade request, read the way sign-in reads them. */
export function daemonLinkFactsOf(
  request: Request,
  peerAddress: string | undefined,
  trustedProxyHops: number,
): DaemonLinkFacts {
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? undefined
  return {
    url: request.url,
    ...(forwardedProto !== undefined ? { forwardedProto } : {}),
    hasProxyHeaders: PROXY_HEADERS.some((name) => request.headers.has(name)),
    clientAddress: clientAddressForRequest(request, peerAddress, trustedProxyHops),
    ...(peerAddress !== undefined && peerAddress.length <= 128 ? { peerAddress } : {}),
    trustedProxyHops,
  }
}

/**
 * The message a daemon on a `plain` connection is refused with, once the
 * branch below is removed.
 */
export const PLAIN_DAEMON_LINK_REFUSAL =
  "This machine's connection to the server is not encrypted and leaves its computer, so the " +
  'server refuses it. Connect it over wss, or ask an admin to add its network to Trusted ' +
  'networks in Settings, Machines.'

// LEGACY(remove-after: 2027-02): accepts a plain ws daemon connection from another computer so local-network installs survive the upgrade; removing it refuses such a daemon at connect
export const ACCEPT_PLAIN_DAEMON_LINKS = true

/** The daemon link built into the server process: it never leaves the computer. */
export const IN_PROCESS_DAEMON_LINK = 'in-process'

export type DaemonLink = DaemonLinkFacts | typeof IN_PROCESS_DAEMON_LINK

export interface DaemonLinksDeps {
  /**
   * The admin's trusted ranges, read from the bound workspace's settings at
   * each call (POD-7484; design 4.2: no settings object outlives a request).
   */
  readonly trustedNetworks: () => Promise<readonly string[]>
  /** A connected machine's kind may have moved (its `machine.condition` changed). */
  readonly kindChanged: (machineId: MachineId) => void
}

/** How often a judgement is retried when the machine's socket is replaced while it is read. */
const JUDGE_ATTEMPTS = 3

/**
 * The link of every daemon connected to this server. Connection state, in
 * process only, kept for exactly as long as the socket that recorded it.
 *
 * Only the FACTS are kept. A kind is worked out when asked, with the trusted
 * networks read from the store then, so an admin's change applies to the next
 * send without a restart or a reconnect, in every process serving the
 * workspace. A link that is encrypted or local whatever is trusted is judged
 * without a read.
 */
export class DaemonLinks {
  private readonly links = new Map<MachineId, { link: DaemonLink; owner: object }>()

  constructor(private readonly deps: DaemonLinksDeps) {}

  /** A link's kind, reading the trusted networks only when they decide it. */
  async kindOf(link: DaemonLink): Promise<DaemonLinkKind> {
    if (link === IN_PROCESS_DAEMON_LINK) return 'local'
    if (!dependsOnTrustedNetworks(link)) return classifyDaemonLink({ ...link, trustedNetworks: [] })
    return classifyDaemonLink({ ...link, trustedNetworks: await this.deps.trustedNetworks() })
  }

  /** Record the link of the socket `owner` that now speaks for `machineId`. */
  connected(machineId: MachineId, link: DaemonLink, owner: object): void {
    this.links.set(machineId, { link, owner })
  }

  /** Forget it, unless a newer socket has replaced `owner` meanwhile. */
  disconnected(machineId: MachineId, owner: object): boolean {
    if (this.links.get(machineId)?.owner !== owner) return false
    this.links.delete(machineId)
    return true
  }

  /**
   * The connected daemon's kind now; undefined when it is not connected. The
   * answer is for the socket connected when it returns: a socket that replaced
   * the judged one during the read is judged again, and one that keeps being
   * replaced reads `plain`, so no secret follows it.
   */
  async daemonLinkKind(machineId: MachineId): Promise<DaemonLinkKind | undefined> {
    for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt++) {
      const entry = this.links.get(machineId)
      if (entry === undefined) return undefined
      const kind = await this.kindOf(entry.link)
      if (this.links.get(machineId) === entry) return kind
    }
    return this.links.has(machineId) ? 'plain' : undefined
  }

  /**
   * The trusted networks may have changed: tell whoever shows the kind of a
   * daemon whose kind they decide. Nothing remembers the earlier kind; the
   * reader judges again.
   */
  settingsChanged(): void {
    for (const [machineId, { link }] of this.links) {
      if (link !== IN_PROCESS_DAEMON_LINK && dependsOnTrustedNetworks(link)) {
        this.deps.kindChanged(machineId)
      }
    }
  }
}

/** Whether the trusted networks decide this link's kind: it is neither encrypted nor local. */
function dependsOnTrustedNetworks(link: DaemonLinkFacts): boolean {
  return classifyDaemonLink({ ...link, trustedNetworks: [] }) === 'plain'
}
