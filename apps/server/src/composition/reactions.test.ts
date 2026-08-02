import { describe, expect, it } from 'vitest'
import { assertReactionRegistryTotal, REACTIONS } from './reactions'

const systemReaction = () => REACTIONS.find((reaction) => reaction.id === 'startup.boot-reconcile')!

describe('reaction registry totality', () => {
  it('declares every operational and principal property', () => {
    expect(() => assertReactionRegistryTotal(REACTIONS)).not.toThrow()
    expect(new Set(REACTIONS.map((reaction) => reaction.id)).size).toBe(REACTIONS.length)
  })

  for (const field of ['replay', 'idempotency', 'failureOwner', 'principal'] as const) {
    it(`rejects a reaction with no ${field}`, () => {
      const incomplete = { ...REACTIONS[0] } as Record<string, unknown>
      delete incomplete[field]
      expect(() => assertReactionRegistryTotal([incomplete])).toThrow(field)
    })
  }

  it('rejects durable replay that does not re-authorize', () => {
    const incomplete = {
      ...REACTIONS.find((reaction) => reaction.id === 'automations.scheduled-runs')!,
      replay: {
        mode: 'startup-reconcile',
        sourceOfTruth: 'persisted occurrence',
      },
    }
    expect(() => assertReactionRegistryTotal([incomplete])).toThrow('reauthorize')
  })

  // Each fixture violates exactly ONE clause, so the message it throws names which
  // clause refused it. The previous single fixture set actor AND writeScope at once;
  // the actor check fired first, and deleting the writeScope check changed nothing
  // any test could see (POD-1470, mutant N5b).
  it('rejects a system reaction that stamps a human, and only that', () => {
    const invalid = {
      ...systemReaction(),
      principal: { class: 'system', actor: 'human', writeScope: 'acted-on-entity' },
    }
    expect(() => assertReactionRegistryTotal([invalid])).toThrow(
      'system reactions must preserve system attribution',
    )
  })

  it('rejects a system reaction that widens write scope, and only that', () => {
    const invalid = {
      ...systemReaction(),
      principal: { class: 'system', actor: 'system', writeScope: 'all' },
    }
    expect(() => assertReactionRegistryTotal([invalid])).toThrow(
      'system reactions must not widen write scope beyond the acted-on entity',
    )
  })

  it('pins post-freeze reactions and their multi-user invariants', () => {
    const ids = new Set<string>(REACTIONS.map((reaction) => reaction.id))
    for (const id of [
      'messaging.telegram-outbound',
      'messaging.ambient-typing',
      'messaging.topic-entry-recap',
      'automations.scheduled-runs',
    ]) {
      expect(ids.has(id), id).toBe(true)
    }

    const indexing = REACTIONS.find((reaction) => reaction.id === 'conversations.discovery-index')!
    expect(indexing.principal.class).toBe('system')
    expect(indexing.scopeInvariant).toContain('inherits')

    const automation = REACTIONS.find((reaction) => reaction.id === 'automations.scheduled-runs')!
    expect(automation.principal).toMatchObject({
      class: 'delegated',
      delegation: 'live-reference',
      reauthorizeAtApply: true,
    })
  })
})
