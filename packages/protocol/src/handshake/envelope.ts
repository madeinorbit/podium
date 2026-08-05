/**
 * THE COMMON PEER FRAMING ENVELOPE — ADR 5 D3, with the reserved node surface of
 * ADR 5 D4.
 *
 * One envelope for every peer role. Roles differ in AUTHENTICATION (D5, the
 * strategy modules under `./strategies`), never in framing: the version
 * negotiation, the hello/ack shapes, the capability list and the codec are the
 * same bytes for a console, a machine daemon and (when H2 lands) a node. ADR 5
 * D3 forbids the alternative in as many words — no single conditional god state
 * machine that mixes auth, identity and feature dispatch.
 *
 * PERMANENT, NOT A SCAFFOLD (POD-308). The mechanism in this file is the peer
 * handshake from here on: a versioned envelope, an additive open capability
 * list, and a closed set of refusal reasons. Any N/N−1 legacy adapter — today
 * the `pair`/`hello` frames of `../messages/daemon-handshake.ts` — is a
 * separately expiring deletion-audit item layered ON this mechanism
 * (`./legacy-daemon-frames.ts`), never a second protocol.
 *
 * WHAT THE ENVELOPE MAY NOT DO: assert identity. ADR 3 D7, strengthened by ADR 3
 * Amendment 1 D14.3, requires the principal to be stamped from the authenticated
 * transport ONLY. Every identity-shaped field a peer can write is collected in
 * {@link PeerIdentityClaims} and is INERT: it is carried for logs and for
 * operator-facing naming, and no strategy in this package reads it when
 * resolving a principal. The tests that prove it are the payload-inert cases in
 * `./strategies/*.test.ts` — a hello that claims a different user, machine or
 * agent changes nothing about the resolved principal.
 */

import { z } from 'zod'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '../version'

/**
 * Peer roles — ADR 5 D2's closed set. `authority` is the server itself and never
 * dials, so it never sends a hello; `node` is RESERVED (D4) and has no acceptor
 * in H1.
 */
export const PEER_ROLES = ['console', 'machine', 'node'] as const
export type PeerRole = (typeof PEER_ROLES)[number]
export const PeerRoleSchema = z.enum(PEER_ROLES)

/**
 * The reserved role. Present in the schema so a future node can announce itself
 * without a flag day (ADR 5 D4.3), inert in H1: the registry has no acceptor for
 * it and the acceptor refuses it without crashing (D4.4).
 */
export const RESERVED_PEER_ROLE: PeerRole = 'node'

/**
 * Ingresses that carry a principal but are NOT peer roles under ADR 5 D2.
 *
 * ADR 3 Amendment 1 D14.2's table names them: the agent command relay and the
 * in-process operator channel (`cli` / `mcp`) each authenticate differently and
 * each resolve a different principal class. They are kept as separate strategy
 * keys rather than folded into `machine` precisely because ADR 5 D7 forbids
 * collapsing peer auth into the agent command relay — a shared key is how that
 * collapse would start. Adding a fourth PEER role would need an ADR 5 amendment;
 * these are not that.
 */
export const NON_PEER_INGRESSES = ['agent-relay', 'operator-channel', 'system'] as const
export type NonPeerIngress = (typeof NON_PEER_INGRESSES)[number]

/** Everything the strategy registry can be keyed on. */
export type AuthRole = PeerRole | NonPeerIngress
export const AUTH_ROLES = [...PEER_ROLES, ...NON_PEER_INGRESSES] as const

/**
 * Credential material, discriminated by kind — ADR 5 D5's role table, one member
 * per row plus the two non-peer ingresses of ADR 3 Amendment 1 D14.
 *
 * `kind` selects the strategy; it is NOT identity. Where a member carries a
 * `*Hint` field, that hint may only narrow the directory lookup: the resolved
 * principal's identity comes from the record the directory VERIFIED, never from
 * the hint (see `./strategies/machine-token.ts` and its hint-mismatch test).
 */
export const SessionCookieCredential = z.object({
  /**
   * The console credential carries NO material in the frame. The session cookie
   * rides the HTTP upgrade, so the strategy reads it from the transport facts —
   * which is exactly why a forged hello cannot present one.
   */
  kind: z.literal('sessionCookie'),
})

export const DaemonSecretCredential = z.object({
  /** ADR 5 D5, machine (local): the shared host secret from `readOrCreateDaemonSecret`. */
  kind: z.literal('daemonSecret'),
  secret: z.string().min(1),
})

export const PairCodeCredential = z.object({
  /** ADR 5 D5, machine (remote): one-shot pair code from the join token. */
  kind: z.literal('pairCode'),
  code: z.string().min(1),
})

export const MachineTokenCredential = z.object({
  /** ADR 5 D5, machine (remote reconnect): the long-lived machine token. */
  kind: z.literal('machineToken'),
  token: z.string().min(1),
  /** Lookup hint only — see the note on {@link PeerCredential}. */
  machineHint: z.string().min(1).optional(),
})

export const DelegationRefCredential = z.object({
  /**
   * ADR 3 Amendment 1 D14.3: the relay presents a server-minted DELEGATION
   * REFERENCE, never a free-string identity. The chain behind it is resolved
   * live at every apply (D16); nothing is copied into the connection.
   */
  kind: z.literal('delegationRef'),
  ref: z.string().min(1),
})

export const OperatorChannelCredential = z.object({
  /**
   * ADR 3 Amendment 1 D14.2, `cli` / `mcp` row: "In-process binding or the local
   * operator's client session; never client-supplied". Both are modelled — an
   * in-process binding proves itself by transport (`inProcess`), a CLI riding the
   * local operator's session presents that session's token.
   */
  kind: z.literal('operatorChannel'),
  sessionToken: z.string().min(1).optional(),
})

export const NodeCredentialReserved = z.object({
  /** ADR 5 D5, node row: reserved credential CLASS, not implemented in H1. */
  kind: z.literal('nodeCredential'),
})

export const PeerCredential = z.discriminatedUnion('kind', [
  SessionCookieCredential,
  DaemonSecretCredential,
  PairCodeCredential,
  MachineTokenCredential,
  DelegationRefCredential,
  OperatorChannelCredential,
  NodeCredentialReserved,
])
export type PeerCredential = z.infer<typeof PeerCredential>
export type CredentialKind = PeerCredential['kind']

/**
 * INERT identity-shaped fields. Everything a peer can say about who it is lives
 * here, in one place, so "does anything read a claim?" is a grep with one answer
 * (ADR 3 D7.1 / D14.3). Kept for logs, for the operator-facing machine name, and
 * for the pairing ceremony's requested name — never for a principal.
 */
export const PeerIdentityClaims = z
  .object({
    user: z.string().optional(),
    machineId: z.string().optional(),
    agentIdentity: z.string().optional(),
    onBehalfOf: z.string().optional(),
    hostname: z.string().optional(),
    /** Operator-facing display name a pairing peer requests for itself. */
    name: z.string().optional(),
  })
  .passthrough()
export type PeerIdentityClaims = z.infer<typeof PeerIdentityClaims>

/** Peer-asserted build metadata; advisory, never authorization. */
/** Fields are optional and unknown fields are preserved for compatibility. */
export const PeerBuild = z
  .object({
    appVersion: z.string().optional(),
    wireSchemaDigest: z.string().optional(),
    installKind: z.enum(['installed', 'source']).optional(),
  })
  .passthrough()
export type PeerBuild = z.infer<typeof PeerBuild>

export const DELIVERY_CAPS = [
/** Delivery methods offered through the additive capability surface. */
  'update.delivery.feed',
  'update.delivery.bundle',
  'update.delivery.git',
] as const
export type DeliveryCap = (typeof DELIVERY_CAPS)[number]

/**
 * The hello envelope. Field-for-field ADR 5 D4.3's shape (`peerRole?`, `caps`,
 * `feedId?`) plus the credential and the inert claims bag.
 */
export const PeerHello = z.object({
  type: z.literal('peerHello'),
  /** Wire version — negotiated against `WIRE_VERSION` / `MIN_SUPPORTED_VERSION`. */
  v: z.number().int(),
  /**
   * ADR 5 D4.3: absent means "infer from the endpoint" (H1 keeps `/client` →
   * console, `/daemon` → machine). H2 must not require H1 peers to set it.
   */
  peerRole: PeerRoleSchema.optional(),
  /** Open, additive tokens. Unknown ones are ignored (D3.3). */
  caps: z.array(z.string()).default([]),
  /** RESERVED (D4.2/D4.3): absent in H1, ignored if present, never granted. */
  feedId: z.string().optional(),
  credential: PeerCredential,
  claims: PeerIdentityClaims.optional(),
  build: PeerBuild.optional(),
})
export type PeerHello = z.infer<typeof PeerHello>

/**
 * Closed refusal vocabulary. `reason` is the only machine-readable half, and
 * every identity failure collapses to `auth-failed` on purpose: ADR 3
 * Amendment 1 D18.5/D20's consistent-error rule means a refusal must not tell an
 * unauthenticated peer WHICH check failed (unknown credential vs revoked user vs
 * disabled account vs missing owner). `message` is a human hint and is reserved
 * for failures that disclose nothing about identity — a version mismatch, or the
 * pairing ceremony's own "code expired" UX.
 */
export const HANDSHAKE_REJECT_REASONS = [
  'unsupported-version',
  'malformed-hello',
  'unexpected-frame',
  'unknown-role',
  'unsupported-credential',
  'role-not-implemented',
  'auth-failed',
] as const
export type HandshakeRejectReason = (typeof HANDSHAKE_REJECT_REASONS)[number]

export const PeerHelloOk = z.object({
  type: z.literal('peerHelloOk'),
  /** The version the ACCEPTOR speaks, so the dialer can log a compatible pair. */
  v: z.number().int(),
  /**
   * The capabilities the acceptor ACCEPTED — the intersection, never the offer
   * echoed back. A reserved or unknown token never appears here (D4.2).
   */
  caps: z.array(z.string()),
  /** Operator-facing name the acceptor settled on (machine name today). */
  name: z.string().optional(),
  /**
   * The identity the ACCEPTOR resolved for this peer, echoed back when the peer
   * has to persist it (a machine row today). It is the server's answer, not the
   * peer's claim — a pairing peer that proposed an id learns here which id it
   * actually got.
   */
  assignedId: z.string().optional(),
  /**
   * Set exactly once, on the pairing branch, when the acceptor mints a
   * long-lived machine token for the peer to persist (ADR 5 D5, remote row).
   */
  issuedToken: z.string().optional(),
  /** The server update-signing key, sent on pairing and every successful reconnect. */
  updatePubkey: z.string().min(1).optional(),
})
export type PeerHelloOk = z.infer<typeof PeerHelloOk>

export const PeerHelloRejected = z.object({
  type: z.literal('peerHelloRejected'),
  reason: z.enum(HANDSHAKE_REJECT_REASONS),
  message: z.string().optional(),
  /** Present on `unsupported-version` so the peer can tell the user what to install. */
  support: z.object({ wire: z.number().int(), min: z.number().int() }).optional(),
})
export type PeerHelloRejected = z.infer<typeof PeerHelloRejected>

export const PeerHelloReply = z.discriminatedUnion('type', [PeerHelloOk, PeerHelloRejected])
export type PeerHelloReply = z.infer<typeof PeerHelloReply>

export const parsePeerHello = (raw: string): PeerHello => PeerHello.parse(JSON.parse(raw))
export const parsePeerHelloReply = (raw: string): PeerHelloReply =>
  PeerHelloReply.parse(JSON.parse(raw))

/** The version pair this build offers. One place, so a dialer cannot drift. */
export const localVersionSupport = (): { wire: number; min: number } => ({
  wire: WIRE_VERSION,
  min: MIN_SUPPORTED_VERSION,
})
