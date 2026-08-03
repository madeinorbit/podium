/**
 * The overlay as a pure function (POD-372).
 *
 * These tests exercise `computeOverlay` DIRECTLY rather than through the Replica,
 * because purity is the property under test and a state machine in the middle
 * would hide it. The Replica-level wiring — that it hands its own slice, its own
 * exits and the outbox's pending list to this function — is proved in
 * `replica.test.ts`, where a real store and a real outbox exist.
 */

import { actorAgent, actorUser, asAgentIdentityId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'

/**
 * An agent actor, built from `@podium/model` and NOT from the Outbox's
 * `agentActorOfSession`. The direction lint forbids the Replica role reaching
 * into `../outbox/` — the same rule that keeps `PendingAttribution.actor` typed
 * `unknown` — and it applies to this test too. POD-1148 is what makes the
 * detour harmless: there is one `ActorRef`, so an actor built here is the value
 * the Outbox would have stored. The id is a session id because POD-1164 says
 * the two brands name one string.
 */
const agentActor = (sessionId: string) => actorAgent(asAgentIdentityId(sessionId))

import type { OptimisticEffect, PendingMutation } from './overlay'
import { computeOverlay, type OverlayInputs } from './overlay-projection'
import type { EntityRecord, ExitKind } from './types'

const row = (value: unknown): EntityRecord => ({
  entity: 'session',
  entityId: 's1',
  value,
  provenance: { seq: 7 },
})

const cmd = (
  mutationId: string,
  command: unknown,
  attribution?: PendingMutation['attribution'],
): PendingMutation => ({
  mutationId,
  entity: 'session',
  entityId: 's1',
  command,
  ...(attribution === undefined ? {} : { attribution }),
})

/** A rename reducer, shaped like the one POD-351 ships through the port. */
const rename = (base: unknown | undefined, command: unknown): OptimisticEffect => {
  const c = command as { readonly kind?: string; readonly name?: string }
  if (c.kind === 'session.rename') {
    return { kind: 'value', value: { ...(base as object | undefined), name: c.name } }
  }
  if (c.kind === 'session.delete') return { kind: 'absent' }
  if (c.kind === 'session.create') return { kind: 'value', value: { name: c.name } }
  // Everything POD-311 has not populated yet.
  return { kind: 'no-reducer' }
}

const overlay = (partial: Partial<OverlayInputs>) =>
  computeOverlay({ base: undefined, exit: undefined, pending: [], reduce: rename, ...partial })

describe('computeOverlay — the overlay is f(replica row, pending commands)', () => {
  it('returns the authoritative row unchanged when nothing is pending', () => {
    expect(overlay({ base: row({ name: 'server' }) })).toEqual({
      present: true,
      value: { name: 'server' },
      origin: 'authority',
      pending: [],
      unapplied: [],
      rejected: [],
    })
  })

  it('projects pending commands over the base in author order, last write on top', () => {
    const result = overlay({
      base: row({ name: 'server', pinned: true }),
      pending: [
        cmd('m1', { kind: 'session.rename', name: 'first' }),
        cmd('m2', { kind: 'session.rename', name: 'second' }),
      ],
    })

    // Author order, not reverse order and not set order: 'first' is a value the
    // fold really produced and then overwrote, so a reversed fold reads 'first'.
    expect(result.value).toEqual({ name: 'second', pinned: true })
    expect(result.origin).toBe('optimistic')
    expect(result.pending).toEqual(['m1', 'm2'])
    expect(result.unapplied).toEqual([])
  })

  it('is pure: repeated calls over the same inputs return equal rows and mutate nothing', () => {
    const base = row({ name: 'server' })
    const pending = [cmd('m1', { kind: 'session.rename', name: 'typed' })]
    const inputs = { base, exit: undefined, pending, reduce: rename }

    const first = computeOverlay(inputs)
    const second = computeOverlay(inputs)

    expect(first).toEqual(second)
    // Derived, never stored twice (ADR 4 D7): the inputs are untouched.
    expect(base.value).toEqual({ name: 'server' })
    expect(pending).toHaveLength(1)
  })

  it('renders an optimistic removal as absent rather than as a stale base', () => {
    const result = overlay({
      base: row({ name: 'server' }),
      pending: [cmd('m1', { kind: 'session.delete' })],
    })

    expect(result.present).toBe(false)
    expect(result.value).toBeUndefined()
    expect(result.origin).toBe('optimistic')
    expect(result.unapplied).toEqual([])
  })

  it('reports nothing to render, and no pending work, for an id the slice never held', () => {
    expect(overlay({})).toEqual({
      present: false,
      value: undefined,
      origin: 'none',
      pending: [],
      unapplied: [],
      rejected: [],
    })
  })
})

describe('reducer-less commands render as pending without guessing effects', () => {
  it('leaves the value at the base and names the command in `unapplied`', () => {
    const result = overlay({
      base: row({ name: 'server' }),
      pending: [cmd('m1', { kind: 'session.share', with: 'someone' })],
    })

    // The rule is "no guess", and the counterfactual is the reduced command
    // beside it: m2 moves the value, m1 does not, from ONE fold.
    expect(result.value).toEqual({ name: 'server' })
    expect(result.origin).toBe('authority')
    expect(result.pending).toEqual(['m1'])
    expect(result.unapplied).toEqual(['m1'])
  })

  it('does not stop the fold: reducible commands after it still apply', () => {
    const result = overlay({
      base: row({ name: 'server' }),
      pending: [
        cmd('m1', { kind: 'session.share', with: 'someone' }),
        cmd('m2', { kind: 'session.rename', name: 'typed' }),
      ],
    })

    expect(result.value).toEqual({ name: 'typed' })
    expect(result.pending).toEqual(['m1', 'm2'])
    expect(result.unapplied).toEqual(['m1'])
  })

  it('never materialises a row for a reducer-less command over an id with no base', () => {
    // A `share` cannot make an entity appear: the effect of an authorization
    // command is not client-derivable, and rendering one would be the Replica
    // asserting a right it cannot evaluate.
    const result = overlay({ pending: [cmd('m1', { kind: 'session.share', with: 'me' })] })

    expect(result.present).toBe(false)
    expect(result.value).toBeUndefined()
    expect(result.unapplied).toEqual(['m1'])
  })

  it('renders every command as pending when the replica was given no reducers at all', () => {
    const result = computeOverlay({
      base: row({ name: 'server' }),
      exit: undefined,
      pending: [cmd('m1', { kind: 'session.rename', name: 'typed' })],
      reduce: () => ({ kind: 'no-reducer' }),
    })

    expect(result.value).toEqual({ name: 'server' })
    expect(result.unapplied).toEqual(['m1'])
  })
})

describe('an entity that left the view takes its overlay with it', () => {
  const exits: readonly ExitKind[] = ['evicted', 'removed']

  for (const exit of exits) {
    it(`drops the overlay when the entity was ${exit}, base still cached or not`, () => {
      // The base is deliberately still present: this asserts the exit decides,
      // not the absence of a row. A store that has not yet dropped its row must
      // not be enough to keep revoked content on screen.
      const result = overlay({
        base: row({ name: 'secret', body: 'revoked content' }),
        exit,
        pending: [cmd('m1', { kind: 'session.rename', name: 'typed' })],
      })

      expect(result.present).toBe(false)
      expect(result.value).toBeUndefined()
      expect(result.origin).toBe('none')
      // The command is still IN FLIGHT — the outbox keeps it and apply-time
      // re-authorization (ADR 3 D8) decides it — but nothing of it is rendered.
      expect(result.pending).toEqual(['m1'])
      expect(result.unapplied).toEqual(['m1'])
    })
  }

  it('does not resurrect an EVICTED entity through a pending create', () => {
    // The leak this closes: a revoked share drops the row, a queued create/upsert
    // for the same id sees `base === undefined`, and a reducer that treats that as
    // "create" re-renders content the principal may no longer see. It must not
    // even reach the reducer.
    let reducerCalls = 0
    const result = computeOverlay({
      base: undefined,
      exit: 'evicted',
      pending: [cmd('m1', { kind: 'session.create', name: 'resurrected' })],
      reduce: (base, command) => {
        reducerCalls += 1
        return rename(base, command)
      },
    })

    expect(result.present).toBe(false)
    expect(result.value).toBeUndefined()
    expect(reducerCalls).toBe(0)
  })

  it('proves that same create WOULD have rendered without the eviction', () => {
    // The counterfactual for the test above: without `exit` the reducer runs and
    // materialises the row, so the drop is the eviction's doing and not a create
    // path that never worked.
    const result = overlay({ pending: [cmd('m1', { kind: 'session.create', name: 'fresh' })] })

    expect(result.present).toBe(true)
    expect(result.value).toEqual({ name: 'fresh' })
  })
})

describe('provisional attribution for an optimistic create (readiness §3.1.3 A4)', () => {
  const agentCreate = cmd(
    'm1',
    { kind: 'session.create', name: 'fresh' },
    { onBehalfOf: 'user-mike', actor: agentActor('sess-9') },
  )

  it('owns the row by the ON-BEHALF-OF HUMAN with the agent as actor', () => {
    const result = overlay({ pending: [agentCreate] })

    // A4: owner is the delegating human, NOT the agent that issued the command.
    // If these were collapsed the row would flicker owners when the authoritative
    // row landed, which is the whole reason the pair is carried.
    expect(result.provisionalOwner).toBe('user-mike')
    expect(result.provisionalActor).toEqual(agentActor('sess-9'))
  })

  it('renders no visibility class and no grant — the type cannot express one', () => {
    const result = overlay({ pending: [agentCreate] })

    // Default-closed (readiness §3.1.1): an unclassified class is personal/private,
    // so there must be nowhere here for "tenant-visible" to appear. Asserting the
    // exact key set is the assertion — a new optional key would fail this.
    //
    // `rejected` was added by POD-351 and this list was updated DELIBERATELY, which
    // is the only honest way past a guard like this one. It is admissible because it
    // carries an ARBITRATION reason derived from the authoritative row (see the
    // reducer port's note on `rejected`), not a visibility class, an owner or a
    // grant. The test below pins that distinction rather than leaving this comment
    // to carry it.
    expect(Object.keys(result).sort()).toEqual([
      'origin',
      'pending',
      'present',
      'provisionalActor',
      'provisionalOwner',
      'rejected',
      'unapplied',
      'value',
    ])
  })

  it('attaches no provisional owner when the AUTHORITY already owns the row', () => {
    // The base came from the slice, so its owner is an authoritative fact with a
    // home; echoing a provisional one here would be a second home for it (ADR 4).
    const result = overlay({
      base: row({ name: 'server' }),
      pending: [
        cmd(
          'm1',
          { kind: 'session.rename', name: 'typed' },
          { onBehalfOf: 'user-mike', actor: actorUser(asUserId('user-mike')) },
        ),
      ],
    })

    expect(result.provisionalOwner).toBeUndefined()
    expect('provisionalOwner' in result).toBe(false)
  })

  it('invents nothing when the command carried no attribution', () => {
    const result = overlay({ pending: [cmd('m1', { kind: 'session.create', name: 'fresh' })] })

    expect(result.present).toBe(true)
    expect('provisionalOwner' in result).toBe(false)
    expect('provisionalActor' in result).toBe(false)
  })

  it('credits the command that MATERIALISED the row, not the ones around it', () => {
    const other = (id: string, human: string) =>
      cmd(
        id,
        { kind: 'session.share', with: 'someone' },
        { onBehalfOf: human, actor: actorUser(asUserId(human)) },
      )
    const followUp = cmd(
      'm3',
      { kind: 'session.rename', name: 'renamed' },
      { onBehalfOf: 'later-human', actor: actorUser(asUserId('later-human')) },
    )
    const result = overlay({
      pending: [other('m0', 'before-human'), agentCreate, other('m2', 'after-human'), followUp],
    })

    // Decoys on BOTH sides, and one of them (m3) is REDUCIBLE and lands after the
    // create. That is the counterfactual that matters: without it, "credit
    // whoever is last" produces the same answer as "credit the materialiser",
    // because the reducer-less decoys never reach the credit at all.
    expect(result.value).toEqual({ name: 'renamed' })
    expect(result.provisionalOwner).toBe('user-mike')
    expect(result.unapplied).toEqual(['m0', 'm2'])
  })

  it('re-credits after an optimistic delete followed by a re-create', () => {
    const result = overlay({
      base: row({ name: 'server' }),
      pending: [
        cmd('m1', { kind: 'session.delete' }),
        cmd(
          'm2',
          { kind: 'session.create', name: 'again' },
          { onBehalfOf: 'user-ada', actor: agentActor('sess-2') },
        ),
      ],
    })

    // The row is optimistic again, so it is optimistically owned again — by the
    // command that brought it back, not by the authority that used to own it.
    expect(result.value).toEqual({ name: 'again' })
    expect(result.provisionalOwner).toBe('user-ada')
  })
})

/**
 * THE PREDICTED-REFUSAL PATH (POD-351) — the member POD-372 left the port without
 * and POD-311 will populate broadly.
 *
 * The reducer here is deliberately CLOSER to the real one than the stub at the top
 * of this file: it reads the authored actor's KIND, because the arbitration
 * [spec:SP-eb60] governs turns on human-versus-agent and a reducer that could not
 * see that could never return `rejected` at all. That is the difference between a
 * member with a caller and a member with none.
 */
describe('a reducer may PREDICT a refusal, and the projection must not swallow it', () => {
  /** Rename with SP-eb60's arbitration: a user-set name is sovereign. */
  const arbitrating = (
    base: unknown | undefined,
    command: unknown,
    authored?: PendingMutation['attribution'],
  ): OptimisticEffect => {
    const c = command as { kind?: string; name?: string }
    if (c.kind !== 'session.rename') return { kind: 'no-reducer' }
    const row = base as { name?: string; nameSource?: string } | undefined
    const actor = authored?.actor as { kind?: string } | undefined
    const byAgent = actor?.kind === 'agent'
    if (byAgent && row?.nameSource === 'user') {
      return { kind: 'rejected', reason: `named by the user ("${row.name}")` }
    }
    // Clearing the name clears the source, exactly as the shipped service does:
    // an unnamed session is namable by an agent again. Modelling this faithfully in
    // the fixture is what makes the "keeps folding" case below a real sequence
    // rather than one contrived to pass.
    const cleared = (c.name ?? '').trim() === ''
    return {
      kind: 'value',
      value: {
        ...(row ?? {}),
        name: c.name,
        nameSource: cleared ? undefined : byAgent ? 'agent' : 'user',
      },
    }
  }

  const byAgent = (id: string, name: string) =>
    cmd(
      id,
      { kind: 'session.rename', name },
      {
        onBehalfOf: 'user-mike',
        actor: agentActor('sess-9'),
      },
    )
  const byHuman = (id: string, name: string) =>
    cmd(
      id,
      { kind: 'session.rename', name },
      {
        onBehalfOf: 'user-mike',
        actor: actorUser(asUserId('user-mike')),
      },
    )

  const withArbitration = (partial: Partial<OverlayInputs>) =>
    computeOverlay({
      base: undefined,
      exit: undefined,
      pending: [],
      reduce: arbitrating,
      ...partial,
    })

  it('carries the reason out, and leaves the authoritative value exactly where it was', () => {
    const result = withArbitration({
      base: row({ name: 'chosen by me', nameSource: 'user' }),
      pending: [byAgent('m1', 'agent guess')],
    })

    // The value did NOT move: this is the whole point of a distinct member.
    expect(result.value).toEqual({ name: 'chosen by me', nameSource: 'user' })
    expect(result.origin).toBe('authority')
    expect(result.rejected).toEqual([
      { mutationId: 'm1', reason: 'named by the user ("chosen by me")' },
    ])
    // And it is reported as unapplied too, so a caller counting "not shown" is right.
    expect(result.unapplied).toEqual(['m1'])
  })

  /**
   * THE COUNTERFACTUAL for the name above. Every assertion in this describe would
   * also pass against a reducer that returned `no-reducer` for an agent rename —
   * the value would not move and `unapplied` would name m1 — EXCEPT that `rejected`
   * would be empty and no reason would reach the UI. So the claim "must not swallow
   * it" is only a claim if a no-reducer command in the SAME fixture produces an
   * empty `rejected`. It does, and that is what separates the two answers.
   */
  it('distinguishes a PREDICTED refusal from an unknown effect in one fold', () => {
    const result = withArbitration({
      base: row({ name: 'chosen by me', nameSource: 'user' }),
      pending: [
        byAgent('m1', 'agent guess'),
        cmd('m2', { kind: 'session.share', with: 'someone' }), // no reducer
      ],
    })

    expect(result.unapplied).toEqual(['m1', 'm2'])
    // Only m1 carries a reason. m2 is in flight with no guess — a spinner, not a
    // rejection — and conflating them is how the routine multi-user path (§3.3)
    // would get rendered as an indefinite pending state.
    expect(result.rejected).toEqual([
      { mutationId: 'm1', reason: 'named by the user ("chosen by me")' },
    ])
  })

  it('predicts nothing for the SAME command authored by a human — the actor kind decides', () => {
    // The vacuity check on the fixture above: if the reducer ignored `authored`,
    // this would reject too, and the previous test would prove nothing about the
    // arbitration. Same base, same name, same everything but the actor.
    const result = withArbitration({
      base: row({ name: 'chosen by me', nameSource: 'user' }),
      pending: [byHuman('m1', 'renamed by me')],
    })

    expect(result.rejected).toEqual([])
    expect(result.value).toEqual({ name: 'renamed by me', nameSource: 'user' })
    expect(result.origin).toBe('optimistic')
  })

  it('keeps folding after a prediction: a later command is judged on its own merits', () => {
    // Clearing the name clears `nameSource` (the shipped service does exactly
    // this), which unblocks the agent rename that follows it. A fold that stopped
    // at the first `rejected` would render a state the authority never reaches.
    const result = withArbitration({
      base: row({ name: 'chosen by me', nameSource: 'user' }),
      pending: [byAgent('m1', 'too early'), byHuman('m2', ''), byAgent('m3', 'now allowed')],
    })

    expect(result.rejected.map((r) => r.mutationId)).toEqual(['m1'])
    expect(result.value).toEqual({ name: 'now allowed', nameSource: 'agent' })
  })

  it('reports NO prediction for an entity that left the view — the row drops first', () => {
    // Rule 2 runs before any reducer, so there is no reason to report. Reporting
    // one would mean naming a cause, and for an `evict` the cause is a revoked
    // share — the visibility fact this projection is forbidden to know.
    const result = withArbitration({
      base: row({ name: 'chosen by me', nameSource: 'user' }),
      exit: 'evicted' as ExitKind,
      pending: [byAgent('m1', 'agent guess')],
    })

    expect(result.present).toBe(false)
    expect(result.rejected).toEqual([])
    expect(result.unapplied).toEqual(['m1'])
  })
})
