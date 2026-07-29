/**
 * In-memory implementations of the Outbox ports (ADR 6 D1: "Tests / private mode
 * / hard quota session — in-memory adapter of the same port"). They are shipped
 * from the package, not hidden in a test file, because POD-373's conformance
 * suite is parameterised by instantiation and this is the instantiation CI runs.
 */

import type { MutationId } from '@podium/protocol'
import type {
  OutboxEnvelope,
  OutboxStorePort,
  OutboxSubmitOutcome,
  OutboxSubmitPort,
} from './ports'
import type { OutboxRecord } from './records'

/**
 * A durable store you can crash and reopen.
 *
 * Records go in and out through a JSON round-trip on purpose: a real adapter
 * stores bytes, so anything that only survives by object identity (a class
 * instance, a `Map`, an `undefined`-valued key) fails here the same way it would
 * fail on device — which is the class of bug ADR 6 D4 exists to catch.
 */
export class InMemoryOutboxStore implements OutboxStorePort {
  private snapshot: string
  /** Flip to make `read` reject: ADR 2 D7's "genuinely unreadable" store, the
   *  one case where user work is lost and the loss must be loud. */
  failRead: unknown | undefined
  /** Flip to make `write` reject — ADR 6 D4.4's quota denial, which must not
   *  partially apply. */
  failWrite: unknown | undefined
  writes = 0

  constructor(initial: readonly OutboxRecord[] = []) {
    this.snapshot = JSON.stringify(initial)
  }

  async read(): Promise<readonly OutboxRecord[]> {
    if (this.failRead !== undefined) throw this.failRead
    return JSON.parse(this.snapshot) as OutboxRecord[]
  }

  async write(records: readonly OutboxRecord[]): Promise<void> {
    if (this.failWrite !== undefined) throw this.failWrite
    this.snapshot = JSON.stringify(records)
    this.writes += 1
  }

  /** What a cold start would find — i.e. what actually survived. */
  durable(): readonly OutboxRecord[] {
    return JSON.parse(this.snapshot) as OutboxRecord[]
  }
}

/**
 * A scripted Authority.
 *
 * `respond` is a FUNCTION of the envelope and the attempt count, and the fake
 * holds no capability from the client: that is how the double mirrors ADR 3 D8 /
 * amendment D16 — rights are resolved live, at apply time, by the Authority, and
 * the envelope the client sends carries nothing that could pre-empt the
 * decision. A test revokes rights simply by changing the responder's mind
 * between drains.
 */
export class ScriptedAuthority implements OutboxSubmitPort {
  readonly envelopes: OutboxEnvelope[] = []
  private readonly attemptsById = new Map<string, number>()

  constructor(
    private respond: (
      envelope: OutboxEnvelope,
      attempt: number,
    ) => OutboxSubmitOutcome | Promise<OutboxSubmitOutcome>,
  ) {}

  /** Swap the policy mid-test — e.g. un-share a collaborator while a client is
   *  offline with queued writes (readiness §2, the central multi-user risk). */
  reprogram(
    respond: (
      envelope: OutboxEnvelope,
      attempt: number,
    ) => OutboxSubmitOutcome | Promise<OutboxSubmitOutcome>,
  ): void {
    this.respond = respond
  }

  attempts(mutationId: MutationId): number {
    return this.attemptsById.get(mutationId) ?? 0
  }

  async submit(envelope: OutboxEnvelope): Promise<OutboxSubmitOutcome> {
    this.envelopes.push(envelope)
    const attempt = (this.attemptsById.get(envelope.mutationId) ?? 0) + 1
    this.attemptsById.set(envelope.mutationId, attempt)
    return await this.respond(envelope, attempt)
  }
}

/** A hand-cranked clock. Fixed sleeps flake; advancing time explicitly does not. */
export class ManualClock {
  constructor(private t = 1_700_000_000_000) {}
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}

/** Sequential ids, so a test can assert on an exact re-issued id. */
export const sequentialMutationIds = (prefix = 'm'): (() => MutationId) => {
  let n = 0
  return () => {
    n += 1
    return `${prefix}${n}` as MutationId
  }
}
