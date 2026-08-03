/**
 * ONE ATTRIBUTION VOCABULARY — POD-1148's pins.
 *
 * The reconciliation is mostly a TYPE fact (`OutboxActor` is an `Extract` over
 * `@podium/model`'s `ActorRef`; `OutboxAttribution extends Attribution`), and a
 * type fact is not what this file tests — a `satisfies` in the source already
 * makes that a compile error, and asserting it again in a runtime test would be
 * mechanism presence.
 *
 * What IS testable, and is what would silently rot, is the RUNTIME edge of the
 * composition:
 *
 *  1. A pair the Outbox produced actually PARSES as the durable field schema.
 *     Structural assignability does not imply this: `Attribution` is a Zod
 *     object whose halves are `.min(1)` branded strings, so an outbox pair built
 *     from an empty id would type-check and fail to parse. If the two ever fork
 *     again — a renamed key, a re-added `agent-session` arm — this is the
 *     assertion that reddens, in this package, without waiting for a consumer.
 *  2. The agent-arm conversion is a RECLASSIFICATION and not a second mint.
 *     That is POD-1164's decision and its stated mutation bar: a helper that
 *     prefixed, suffixed, hashed or substituted the id would produce an actor
 *     that no session lookup could match, and every consumer walks sessions.
 */

import { Attribution, actorUser, asSessionId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  actorSessionIdOf,
  agentActorOfSession,
  isDelegated,
  type OutboxAttribution,
} from './records'

const ADA = asUserId('u-ada')
const SESSION = asSessionId('sess-7')

const human: OutboxAttribution = { actor: actorUser(ADA), onBehalfOf: ADA }
const delegated: OutboxAttribution = {
  actor: agentActorOfSession(SESSION),
  onBehalfOf: ADA,
}

describe('the outbox pair is the model field schema, narrowed', () => {
  it('parses a human-authored pair as the durable `Attribution`', () => {
    expect(Attribution.parse(human)).toEqual({
      actor: { kind: 'user', id: 'u-ada' },
      onBehalfOf: 'u-ada',
    })
  })

  it('parses a delegated pair as the durable `Attribution`, agent arm and all', () => {
    // The arm the two vocabularies used to disagree about. `kind: 'agent'` with
    // an `id`, not `kind: 'agent-session'` with a `sessionId` — and it reaches
    // the model's parser without a translation step, which is the whole point.
    expect(Attribution.parse(delegated)).toEqual({
      actor: { kind: 'agent', id: 'sess-7' },
      onBehalfOf: 'u-ada',
    })
  })

  it('refuses a pair carrying the retired `agent-session` spelling', () => {
    // The regression guard for a re-fork: were the old arm reintroduced anywhere,
    // a pair shaped like it would no longer be a valid `Attribution`.
    const stale = { actor: { kind: 'agent-session', sessionId: 'sess-7' }, onBehalfOf: 'u-ada' }
    expect(Attribution.safeParse(stale).success).toBe(false)
  })

  it('names the delegated arm as delegated, and the human arm as not', () => {
    expect(isDelegated(delegated)).toBe(true)
    expect(isDelegated(human)).toBe(false)
  })
})

describe('the agent arm reclassifies one id and never mints a second', () => {
  it('round-trips the session id through the actor brand unchanged', () => {
    // POD-1164's mutation bar: a prefix, suffix, hash or constant substitution
    // in either helper fails here. Compared as a raw string on purpose — the
    // brands are erased at runtime, so only the VALUE can carry the claim.
    expect(actorSessionIdOf(agentActorOfSession(SESSION))).toBe('sess-7')
    expect(agentActorOfSession(SESSION).id).toBe(String(SESSION))
  })

  it('has no session to report for a human actor', () => {
    // `null` and not a synthesised id: a person did not act in an agent session,
    // and inventing one here is how `Capability.actorSessionId` would start
    // matching a principal that never existed.
    expect(actorSessionIdOf(actorUser(ADA))).toBeNull()
  })
})
