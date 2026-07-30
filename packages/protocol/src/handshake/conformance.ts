/**
 * THE SHARED HANDSHAKE CONFORMANCE SUITE — ADR 5 D8 S5 ("cross-hop tests written
 * against roles + ports so a future node–hub binding can run the same suite"),
 * and the reason POD-388's acceptance criteria say the shared protocol tests must
 * run against the GATEWAY END and the DAEMON END rather than only the server.
 *
 * The scenarios below are the HANDSHAKE-ORDER REGRESSION CLASS. They are written
 * once, against a tiny probe interface, and executed against both ends
 * (`./conformance.test.ts`). An end that regresses — delivers a frame before a
 * principal exists, accepts a second handshake on a live connection, treats
 * out-of-order traffic as ordinary input — fails the same named case at whichever
 * end broke, which is what makes "the daemon mirrors the gateway contract"
 * (POD-327) a tested claim rather than a comment.
 *
 * The suite is shipped source, not a test file, so POD-327 and a future H2 node
 * binding can run it without copying it. Copies drift; that is the whole lesson
 * of this file's existence.
 */

/** What an end did with a frame. Deliberately coarse: this is about ORDER. */
export type HandshakeObservation =
  | 'established'
  /** Refused and the connection is finished — the fail-closed answer. */
  | 'refused'
  /** Handed to the planes, stamped with a principal. Only legal post-handshake. */
  | 'delivered'
  /** The end detected an ordering violation on ITS side (the dialer's half). */
  | 'protocol-error'
  /**
   * Dropped on the floor pre-auth: not delivered, no principal, connection still
   * waiting. A weaker answer than `refused` and still fail-closed on identity.
   */
  | 'ignored'

export interface HandshakeEndSession {
  readonly state: 'pending' | 'established' | 'closed'
  /** Drive a complete, valid handshake from this end's point of view. */
  handshake(): HandshakeObservation
  feed(raw: string): HandshakeObservation
  /** A well-formed HANDSHAKE frame for this end (a hello, or an ok reply). */
  helloLike(): string
  /** A well-formed APPLICATION frame — legal only after the handshake. */
  appTraffic(): string
  /** Unparseable bytes. */
  junk(): string
  /**
   * A handshake frame this end must refuse for VERSION reasons, before any
   * credential is examined. The daemon end's version refusal arrives as a
   * rejection reply, so both ends have one.
   */
  versionMismatch(): string
}

export interface HandshakeEndProbe {
  readonly end: 'gateway' | 'daemon'
  readonly name: string
  /** A fresh, un-handshaken session. */
  fresh(): HandshakeEndSession
  /**
   * Did any auth strategy run since `fresh()`? The version-ordering case asserts
   * this stays false, which is the only way to prove "version before credentials"
   * instead of merely observing a refusal. The daemon end has no strategies and
   * reports `null`, and the case skips that assertion there.
   */
  authWasConsulted?(): boolean | null
}

export interface ConformanceCase {
  readonly name: string
  readonly why: string
  run(probe: HandshakeEndProbe): ConformanceResult
}

export interface ConformanceResult {
  readonly name: string
  readonly end: 'gateway' | 'daemon'
  readonly ok: boolean
  readonly detail?: string
}

const pass = (name: string, probe: HandshakeEndProbe): ConformanceResult => ({
  name,
  end: probe.end,
  ok: true,
})
const fail = (name: string, probe: HandshakeEndProbe, detail: string): ConformanceResult => ({
  name,
  end: probe.end,
  ok: false,
  detail,
})

/** Refusal, a detected ordering violation, and a pre-auth drop all mean "did not proceed". */
const isRefusal = (o: HandshakeObservation): boolean =>
  o === 'refused' || o === 'protocol-error' || o === 'ignored'

export const HANDSHAKE_CONFORMANCE_CASES: readonly ConformanceCase[] = [
  {
    name: 'a valid handshake establishes exactly once',
    why: 'the baseline: if this fails, every negative case below is vacuous',
    run(probe) {
      const session = probe.fresh()
      const observed = session.handshake()
      if (observed !== 'established')
        return fail(this.name, probe, `handshake observed ${observed}`)
      if (session.state !== 'established')
        return fail(this.name, probe, `state after handshake: ${session.state}`)
      return pass(this.name, probe)
    },
  },
  {
    name: 'application traffic before the handshake is refused, never delivered',
    why: 'delivering a frame with no principal is the confused-deputy shape ADR 3 D7 forbids',
    run(probe) {
      const session = probe.fresh()
      const observed = session.feed(session.appTraffic())
      if (observed === 'delivered')
        return fail(this.name, probe, 'pre-handshake traffic was delivered to the planes')
      if (!isRefusal(observed)) return fail(this.name, probe, `observed ${observed}`)
      if (session.state === 'established')
        return fail(this.name, probe, 'end established itself on application traffic')
      return pass(this.name, probe)
    },
  },
  {
    name: 'unparseable bytes before the handshake are refused',
    why: 'an unknown input must fail CLOSED — never be tolerated into the next state',
    run(probe) {
      const session = probe.fresh()
      const observed = session.feed(session.junk())
      if (!isRefusal(observed)) return fail(this.name, probe, `observed ${observed}`)
      if (session.state === 'established') return fail(this.name, probe, 'established on junk')
      return pass(this.name, probe)
    },
  },
  {
    name: 'a second handshake frame on a live connection is refused',
    why: 're-handshaking a live connection would be a principal-swap primitive (ADR 3 D7 TOCTOU)',
    run(probe) {
      const session = probe.fresh()
      if (session.handshake() !== 'established')
        return fail(this.name, probe, 'baseline handshake did not establish')
      const observed = session.feed(session.helloLike())
      if (!isRefusal(observed))
        return fail(this.name, probe, `second handshake frame observed ${observed}`)
      return pass(this.name, probe)
    },
  },
  {
    name: 'application traffic after the handshake is delivered',
    why: 'the positive half — order enforcement must not break the working path',
    run(probe) {
      const session = probe.fresh()
      if (session.handshake() !== 'established')
        return fail(this.name, probe, 'baseline handshake did not establish')
      const observed = session.feed(session.appTraffic())
      if (observed !== 'delivered') return fail(this.name, probe, `observed ${observed}`)
      return pass(this.name, probe)
    },
  },
  {
    name: 'an out-of-window version is refused before any credential is examined',
    why: 'ADR 5 D3.1 fails closed on version, and auth must not run for a peer that cannot be understood',
    run(probe) {
      const session = probe.fresh()
      const observed = session.feed(session.versionMismatch())
      if (!isRefusal(observed)) return fail(this.name, probe, `observed ${observed}`)
      const consulted = probe.authWasConsulted?.() ?? null
      if (consulted === true)
        return fail(this.name, probe, 'an auth strategy ran for an incompatible peer')
      return pass(this.name, probe)
    },
  },
  {
    name: 'a refused end stays refused',
    why: 'a peer must not be able to retry into a usable connection after a refusal',
    run(probe) {
      const session = probe.fresh()
      session.feed(session.junk())
      const observed = session.feed(session.helloLike())
      if (observed === 'established' || observed === 'delivered')
        return fail(this.name, probe, `a refused end accepted a later frame: ${observed}`)
      return pass(this.name, probe)
    },
  },
]

/** Run every case against one end. The caller asserts on the results. */
export const runHandshakeConformance = (probe: HandshakeEndProbe): ConformanceResult[] =>
  HANDSHAKE_CONFORMANCE_CASES.map((c) => c.run(probe))
