import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../relay'
import { REACTIONS } from './reactions'

/**
 * ARM 2 of POD-1470: the invariant has to hold in the ASSEMBLED system, not only in
 * a unit fixture calling the assert directly. These drive a reaction through the
 * composition root — the same path that populates `modules.reactions` — and check
 * the runtime refuses a principal that would widen visibility.
 */
const registries: SessionRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
})

const boot = () => REACTIONS.find((reaction) => reaction.id === 'startup.boot-reconcile')!

describe('composition root reaction principals', () => {
  it('refuses to assemble with a system reaction that widens write scope', () => {
    // A distinct id: a clone of an existing one would be refused as a duplicate,
    // which is a different guard refusing first — the exact failure this issue is about.
    const widening = {
      ...boot(),
      id: 'test.widening-system-reaction',
      principal: { class: 'system', actor: 'system', writeScope: 'all' },
    }
    expect(
      () =>
        new SessionRegistry(undefined, undefined, {
          instanceId: 'default',
          reactions: [...REACTIONS, widening],
        }),
    ).toThrow('system reactions must not widen write scope beyond the acted-on entity')
  })

  it('publishes the declared registry when every principal is in scope', () => {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    expect(registry.modules.reactions).toHaveLength(REACTIONS.length)
    for (const reaction of registry.modules.reactions) {
      if (reaction.principal.class === 'system') {
        expect(reaction.principal.writeScope).toBe('acted-on-entity')
      }
    }
  })
})
