/**
 * The `sessions.rename` contract and the FIRST optimistic reducer (POD-351).
 *
 * What these tests are for, beyond "it works": this contract and this reducer are
 * the template POD-311 copies across the command surface and the port POD-372's
 * overlay consumes. So the assertions below are mostly about SHAPE — that the
 * classification is total, that the principal is unforgeable, that the schema is
 * the shared instance rather than a lookalike — because a shape defect here is
 * copied N times rather than hit once.
 */

// The model's constructors, not the Outbox's projection of them: `@podium/sync`
// depends on this package, so importing back the other way would be a cycle.
// POD-1148 is what makes that a non-issue — there is one `ActorRef`, and the
// Outbox's `OutboxActor` is an `Extract` over it, so an actor built here is the
// same value the Outbox would have stored.
import { actorAgent, actorUser, agentIdentityFromSessionId, asUserId } from '@podium/model'
import { asSessionId } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { classificationErrors } from '../contract'
import {
  RENAME_REJECTIONS,
  sessionRenameContract,
  sessionRenameInput,
  sessionRenameReducer,
} from './rename'
import { sessionStateCommands } from './session-state-commands'

const agentActorOfSession = (id: string) => actorAgent(agentIdentityFromSessionId(asSessionId(id)))

const agent = { onBehalfOf: 'user-mike', actor: agentActorOfSession('sess-9') }
const human = { onBehalfOf: 'user-mike', actor: actorUser(asUserId('user-mike')) }

const reduce = (local: unknown, name: string, authored?: { onBehalfOf: string; actor: unknown }) =>
  sessionRenameReducer({
    input: { sessionId: 's1', name },
    local,
    now: '2026-07-30T00:00:00.000Z',
    authored,
  })

describe('the contract is total and default-closed', () => {
  it('has no classification errors', () => {
    // The same lint a registry-wide gate runs, so this cannot pass here and fail
    // there. It is the check that a required facet was not merely present but
    // CONSISTENT — e.g. `outbox` exposure demands an offline-eligible class.
    expect(classificationErrors(sessionRenameContract)).toEqual([])
  })

  it('is exposed on trpc and outbox, and NOT on relay', () => {
    // The absence of `relay` is a decision (agents rename through sessions.title),
    // so it is asserted rather than left to be re-derived. An exact-set assertion,
    // because a widened exposure is exactly the drift that would go unnoticed.
    expect([...sessionRenameContract.exposure].sort()).toEqual(['outbox', 'trpc'])
  })

  it('declares the offline path it is exposed on, with apply-time re-authorization', () => {
    expect(sessionRenameContract.delivery.class).toBe('offline-eligible')
    // Not an emptiness check: the classification lint already refuses an empty
    // string. This pins that the reasoning names the LIVE resolution, because a
    // snapshot is the one answer ADR 3 D8 refuses.
    expect(sessionRenameContract.delivery.applyTimeReauthorization).toMatch(/LIVE/)
    expect(sessionRenameContract.delivery.applyTimeReauthorization).toMatch(/delegation chain/)
  })

  it('makes an invisible target indistinguishable from a nonexistent one', () => {
    const ec = sessionRenameContract.errorConsistency
    expect(ec.callerSuppliedTargetId).toBe(true)
    // Narrowed by the assertion above, so this reads the arm that has the field.
    if (!ec.callerSuppliedTargetId) throw new Error('unreachable')
    expect(ec.invisibleFailsAs).toBe('nonexistent')
    // Rename places no work on compute, so M5's unreachable-vs-unauthorized
    // carve-out does not apply and the general D20.2 rule holds.
    expect(ec.distinguishesUnauthorizedFromUnreachable).toBe(false)
  })

  it('carries the attribution PAIR on its own wire keys, from the transport', () => {
    const a = sessionRenameContract.attribution
    expect(a.actor).toBe('from-capability')
    expect(a.onBehalfOf).toBe('from-delegation')
    expect(a.wirePlacement).toBe('separate-field')
    expect([...a.reservedWireKeys].sort()).toEqual(['actor', 'onBehalfOf'])
  })

  it('creates nothing, and says so rather than leaving the field off', () => {
    expect(sessionRenameContract.ownership.creates).toEqual([])
  })
})

describe('the input schema IS the shipped instance, not a lookalike', () => {
  it('is the same object as the session-state contract’s input', () => {
    // THE assertion this file exists for. Branding and composition are
    // compile-time, so a restatement — z.object({ sessionId: z.string(), name:
    // z.string().max(120), mutationId }) — would parse identically, encode
    // identically, and pass every golden fixture and every differential test in
    // this repo. Only object identity sees the fork.
    expect(sessionRenameInput).toBe(sessionStateCommands.defs.rename.input)
    expect(sessionRenameContract.input).toBe(sessionStateCommands.defs.rename.input)
  })

  it('is the reason the shadow comparison measures HANDLERS and not schemas', () => {
    // A divergence in the schemas would surface as a handler divergence and be
    // diagnosed in the wrong place. There is one schema object, so that class of
    // false signal is unrepresentable rather than merely unobserved.
    const input = { sessionId: 's1', name: 'x' }
    expect(sessionRenameInput.parse(input)).toEqual(
      sessionStateCommands.defs.rename.input.parse(input),
    )
  })
})

describe('identity is unforgeable from the payload (ADR 3 D7 / ADR 9 D1)', () => {
  it('strips every identity-shaped key a caller could put on the wire', () => {
    // The assertion is on the PARSED OUTPUT, not on the absence of a field in the
    // type: a type says what the author intended, and parsed output says what a
    // hostile caller actually gets through.
    const parsed = sessionRenameInput.parse({
      sessionId: 's1',
      name: 'legit',
      actor: 'user-attacker',
      onBehalfOf: 'user-victim',
      userId: 'user-victim',
      nameSource: 'user',
      capability: { role: 'admin', scope: { kind: 'all' } },
      owner: 'user-victim',
    })

    expect(parsed).toEqual({ sessionId: 's1', name: 'legit' })
    for (const forged of ['actor', 'onBehalfOf', 'userId', 'nameSource', 'capability', 'owner']) {
      expect(forged in parsed).toBe(false)
    }
  })

  it('the reducer ignores a payload-supplied nameSource and derives it from the actor', () => {
    // The counterfactual: the SAME forged payload under the two actor kinds. If
    // the payload had any influence, both would answer 'user'.
    const forged = { sessionId: 's1', name: 'n', nameSource: 'user' } as never
    const asAgent = sessionRenameReducer({ input: forged, local: {}, now: '', authored: agent })
    const asHuman = sessionRenameReducer({ input: forged, local: {}, now: '', authored: human })

    expect(asAgent).toEqual({ kind: 'value', value: { name: 'n', nameSource: 'agent' } })
    expect(asHuman).toEqual({ kind: 'value', value: { name: 'n', nameSource: 'user' } })
  })
})

describe('the reducer derives nameSource from the actor half of the pair', () => {
  it('a human-issued rename yields nameSource user', () => {
    expect(reduce({ name: 'old' }, 'mine', human)).toEqual({
      kind: 'value',
      value: { name: 'mine', nameSource: 'user' },
    })
  })

  it('an agent-delegated rename yields nameSource agent', () => {
    expect(reduce({ name: 'old' }, 'agent pick', agent)).toEqual({
      kind: 'value',
      value: { name: 'agent pick', nameSource: 'agent' },
    })
  })

  it('an agent name is trimmed AND whitespace-collapsed; a human name is only trimmed', () => {
    // The asymmetry is the shipped service's (normalizeAgentName collapses runs of
    // whitespace, renameSession does not). It is pinned here because the shadow
    // comparison would otherwise be the first place to discover it, and a
    // migration that "tidied" it would be changing product behaviour.
    expect(reduce({}, '  two   words  ', agent)).toEqual({
      kind: 'value',
      value: { name: 'two words', nameSource: 'agent' },
    })
    expect(reduce({}, '  two   words  ', human)).toEqual({
      kind: 'value',
      value: { name: 'two   words', nameSource: 'user' },
    })
  })

  it('clearing the name clears the source, so an agent may name it again', () => {
    const cleared = reduce({ name: 'old', nameSource: 'user' }, '   ', human)
    if (cleared.kind !== 'value') throw new Error(`expected value, got ${cleared.kind}`)
    const value = cleared.value as { name: string; nameSource?: string }

    expect(value.name).toBe('')
    // NOT `toEqual({ nameSource: undefined })`: vitest's toEqual ignores undefined
    // properties, so that spelling would pass against a reducer that left
    // `nameSource: 'user'` off the spread entirely AND against one that carried it
    // through unchanged. Read the field.
    expect(value.nameSource).toBeUndefined()

    // And the consequence that makes the clear meaningful — the agent rename that
    // this same row would have refused a moment ago is now accepted.
    expect(reduce(value, 'agent may name it now', agent)).toEqual({
      kind: 'value',
      value: { name: 'agent may name it now', nameSource: 'agent' },
    })
  })

  it('accepts a name at exactly the 120-character cap on both actor kinds', () => {
    // The boundary the unreachable `tooLong` rejection would sit just past. Both
    // caps are 120, so a parsing value can never exceed it after normalisation —
    // this pins that rather than leaving a dead branch to imply otherwise.
    const at = 'a'.repeat(120)
    expect(sessionRenameInput.safeParse({ sessionId: 's1', name: at }).success).toBe(true)
    expect(sessionRenameInput.safeParse({ sessionId: 's1', name: 'a'.repeat(121) }).success).toBe(
      false,
    )
    expect(reduce({}, at, agent)).toEqual({
      kind: 'value',
      value: { name: at, nameSource: 'agent' },
    })
    expect(reduce({}, at, human)).toEqual({
      kind: 'value',
      value: { name: at, nameSource: 'user' },
    })
  })
})

describe('the reducer models the WRITER-AUTHORIZATION OUTCOME, not just the effect', () => {
  it('predicts a refusal when an agent renames over a user-set name', () => {
    expect(reduce({ name: 'chosen by me', nameSource: 'user' }, 'agent guess', agent)).toEqual({
      kind: 'rejected',
      reason: RENAME_REJECTIONS.namedByUser('chosen by me'),
    })
  })

  it('does NOT refuse the same write from a human — the arbitration protects the human', () => {
    // The counterfactual for the test above. Same base, same name, only the actor
    // kind differs: without this, "predicts a refusal" could be passing because the
    // reducer refuses every rename over a named row.
    expect(reduce({ name: 'chosen by me', nameSource: 'user' }, 'renamed by me', human)).toEqual({
      kind: 'value',
      value: { name: 'renamed by me', nameSource: 'user' },
    })
  })

  it('does NOT refuse an agent renaming over its OWN earlier agent-set name', () => {
    // Second counterfactual: the refusal turns on nameSource === 'user', not on
    // "the row already has a name". An agent retitling as the work becomes clear
    // is explicitly allowed by [spec:SP-eb60].
    expect(reduce({ name: 'first guess', nameSource: 'agent' }, 'better name', agent)).toEqual({
      kind: 'value',
      value: { name: 'better name', nameSource: 'agent' },
    })
  })

  it('predicts a refusal for an empty agent name', () => {
    expect(reduce({}, '   ', agent)).toEqual({
      kind: 'rejected',
      reason: RENAME_REJECTIONS.empty,
    })
  })

  it('never answers no-reducer: every input to the decision is on the row', () => {
    // A fact about rename, NOT a template — the doc comment says so for POD-311.
    // Asserted because a `no-reducer` creeping in would silently turn the whole
    // optimistic path into a spinner with no test noticing.
    const cases: Array<[unknown, string, typeof agent | typeof human | undefined]> = [
      [undefined, 'x', agent],
      [undefined, 'x', human],
      [{}, '', agent],
      [{ name: 'n', nameSource: 'user' }, 'y', agent],
      [{ name: 'n', nameSource: 'agent' }, 'y', human],
      [{ name: 'n' }, 'y', undefined],
    ]
    for (const [local, name, authored] of cases) {
      expect(reduce(local, name, authored).kind).not.toBe('no-reducer')
    }
  })

  it('treats a write with NO authored attribution as a human write', () => {
    // The default matters and is not arbitrary: an unattributed write on this path
    // is the operator cookie (§3.2's sole human today), and treating it as an agent
    // would let a missing pair SILENTLY strip a human's sovereign nameSource. It
    // fails toward the human, which is the direction [spec:SP-eb60] protects.
    expect(reduce({ name: 'chosen', nameSource: 'user' }, 'still mine', undefined)).toEqual({
      kind: 'value',
      value: { name: 'still mine', nameSource: 'user' },
    })
  })
})

describe('the reducer is pure and consults no principal', () => {
  it('is a function of (base, command, actor kind) only — same inputs, same answer', () => {
    const base = { name: 'old', nameSource: 'agent' as const }
    const a = reduce(base, 'new', agent)
    const b = reduce(base, 'new', agent)
    expect(a).toEqual(b)
    // The base is not mutated: the overlay is derived, never stored twice (ADR 4 D7).
    expect(base).toEqual({ name: 'old', nameSource: 'agent' })
  })

  it('ignores the actor IDENTITY, reading only the kind', () => {
    // Two different agents, two different humans, one answer. This is what makes
    // "the reducer cannot evaluate authorization" a property rather than a promise:
    // it has no way to tell one principal from another.
    const a1 = reduce({ name: 'n', nameSource: 'user' }, 'x', {
      onBehalfOf: 'user-mike',
      actor: agentActorOfSession('sess-1'),
    })
    const a2 = reduce({ name: 'n', nameSource: 'user' }, 'x', {
      onBehalfOf: 'user-ada',
      actor: agentActorOfSession('sess-2'),
    })
    expect(a1).toEqual(a2)
  })
})
