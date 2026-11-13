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
 *  - `local`: the peer is this computer and no proxy was involved.
 *  - `trusted`: the client address is inside `daemonLink.trustedNetworks`, a
 *    private encrypted network such as a VPN.
 *  - `plain`: anything else. Credentials are never sent over it.
 *
 * The FACTS are kept per connection and the kind is worked out when asked, so a
 * change to the trusted networks applies to daemons already connected.
 */

import { cidrContains, type MachineId } from '@podium/model'
import { isSecureRequest } from '../auth-route'
import { isLoopbackAddress, PROXY_ONLY_HEADERS } from '../readiness-boundary'
import { clientAddressForRequest } from '../request-scheme'

export type DaemonLinkKind = 'encrypted' | 'local' | 'trusted' | 'plain'

/** What the server knows about how a daemon's request reached it. */
export interface DaemonLinkFacts {
  readonly url: string
  readonly forwardedProto?: string
  readonly hasProxyHeaders: boolean
  /** Resolved with `clientAddressForRequest`; undefined when it cannot be. */
  readonly clientAddress: string | undefined
  readonly trustedProxyHops: number
}

/** Any of these marks a request as having passed a proxy. */
const PROXY_HEADERS = [...PROXY_ONLY_HEADERS, 'x-forwarded-for', 'x-forwarded-host'] as const

export function classifyDaemonLink(
  i: DaemonLinkFacts & { readonly trustedNetworks: readonly string[] },
): DaemonLinkKind {
  if (isSecureRequest(i.url, i.forwardedProto, i.trustedProxyHops)) return 'encrypted'
  if (!i.hasProxyHeaders && isLoopbackAddress(i.clientAddress)) return 'local'
  const address = i.clientAddress
  if (address !== undefined && i.trustedNetworks.some((range) => cidrContains(range, address))) {
    return 'trusted'
  }
  return 'plain'
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
  /** The admin's trusted ranges as the instance holds them now. */
  readonly trustedNetworks: () => readonly string[]
  /** A connected machine's kind moved (its `machine.condition` changed). */
  readonly kindChanged: (machineId: MachineId) => void
}

/**
 * The link of every daemon connected to this server. Connection state, in
 * process only, kept for exactly as long as the socket that recorded it.
 */
export class DaemonLinks {
  private readonly links = new Map<MachineId, { link: DaemonLink; owner: object }>()
  private readonly lastKind = new Map<MachineId, DaemonLinkKind>()

  constructor(private readonly deps: DaemonLinksDeps) {}

  kindOf(link: DaemonLink): DaemonLinkKind {
    if (link === IN_PROCESS_DAEMON_LINK) return 'local'
    return classifyDaemonLink({ ...link, trustedNetworks: this.deps.trustedNetworks() })
  }

  /** Record the link of the socket `owner` that now speaks for `machineId`. */
  connected(machineId: MachineId, link: DaemonLink, owner: object): void {
    this.links.set(machineId, { link, owner })
    this.lastKind.set(machineId, this.kindOf(link))
  }

  /** Forget it, unless a newer socket has replaced `owner` meanwhile. */
  disconnected(machineId: MachineId, owner: object): boolean {
    if (this.links.get(machineId)?.owner !== owner) return false
    this.links.delete(machineId)
    this.lastKind.delete(machineId)
    return true
  }

  /** The connected daemon's kind now; undefined when it is not connected. */
  daemonLinkKind(machineId: MachineId): DaemonLinkKind | undefined {
    const entry = this.links.get(machineId)
    return entry === undefined ? undefined : this.kindOf(entry.link)
  }

  /** The trusted networks may have changed: tell whoever shows a moved kind. */
  settingsChanged(): void {
    for (const [machineId, { link }] of this.links) {
      const kind = this.kindOf(link)
      if (this.lastKind.get(machineId) === kind) continue
      this.lastKind.set(machineId, kind)
      this.deps.kindChanged(machineId)
    }
  }
}
