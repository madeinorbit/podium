import { asMachineId } from '@podium/model'
import type { ConversationSummaryWire } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from '../../relay'
import { openTestStore } from '../../test-support/open-test-store'

/**
 * THE CONVERSATION LIST WAITS FOR THE OUTERMOST COMMIT [POD-3366, sites 9 and
 * 10 of POD-3361's audit].
 *
 * `MemoryService` installed `latestConversations` on the statement after a
 * `ledger.commit`. Nested inside a caller's span that commit is a SAVEPOINT,
 * and its release is not a commit — so the list could end up serving clients a
 * conversation set the database rolled back.
 *
 * WHAT THESE TESTS ASSERT ON. `allConversations()` — the accessor the wire
 * actually serves — read AFTER the rollback and with nothing in between that
 * re-reads the database. A fixture that called `onDiscovery` again, or
 * reconciled, would repopulate the list from durable truth and report a pass
 * for a projection that was wrong the whole time.
 *
 * The full registry is used rather than a hand-built service precisely because
 * the fold port is COMPOSITION: a service constructed without it installs
 * immediately and every assertion below would be vacuous.
 */
describe('the memory conversation list waits for the outermost commit (POD-3366)', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose()
  })

  async function build() {
    const store = await openTestStore(':memory:')
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(registry)
    return { store, registry, memory: registry.modules.memory }
  }

  const machine = asMachineId('m1')
  const SYSTEM_READER = { kind: 'system' as const, id: 'pod-3366-test' }

  const conversation = (id: string, title: string): ConversationSummaryWire =>
    ({
      id,
      agentKind: 'claude-code',
      providerId: 'p',
      title,
    }) as ConversationSummaryWire

  const idsOf = (rows: readonly ConversationSummaryWire[]) => rows.map((row) => row.id)

  it('does not serve a discovery the enclosing span rolled back (site 9)', async () => {
    const { store, memory } = await build()

    expect(() =>
      store.transact(() => {
        memory.onDiscovery(machine, [conversation('c-rolled-back', 'draft')], [])
        // The savepoint has been released and the list is already installed
        // today. Read it here, inside the window the bug lived in: the staged
        // layer must show it to its own writer…
        expect(idsOf(memory.allConversations())).toContain('c-rolled-back')
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // …and the database forgot the row, so the served list must have too.
    expect(store.conversations.index.search({}).map((row) => row.id)).not.toContain(
      'c-rolled-back',
    )
    expect(idsOf(memory.allConversations())).not.toContain('c-rolled-back')
  })

  it('keeps a discovery whose enclosing span commits (site 9)', async () => {
    const { store, memory } = await build()

    await store.transact(() => {
      memory.onDiscovery(machine, [conversation('c-kept', 'draft')], [])
    })

    expect(idsOf(memory.allConversations())).toContain('c-kept')
  })

  it('does not serve a meta edit the enclosing span rolled back (site 10)', async () => {
    const { store, memory } = await build()
    memory.onDiscovery(machine, [conversation('c-meta', 'original')], [])

    expect(() =>
      store.transact(() => {
        memory.setConversationMeta(SYSTEM_READER, { id: 'c-meta', name: 'renamed' })
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    const served = memory.allConversations().find((row) => row.id === 'c-meta')
    expect(served?.name).toBeUndefined()
  })

  it('a second meta edit in the same span sees the first (the in-window reader)', async () => {
    // WHY THIS TEST EXISTS, and it is site 10's own argument rather than a copy
    // of POD-3328's. `setConversationMeta` reads the list as its OWN
    // precondition and builds `next` by spreading what it finds. With a bare
    // deferral the second edit would spread the PRE-span entry, and the name
    // the first edit set would be silently dropped from the value that finally
    // commits. The read-through staged layer is what keeps that honest.
    const { store, memory } = await build()
    memory.onDiscovery(machine, [conversation('c-two', 'original')], [])

    await store.transact(() => {
      memory.setConversationMeta(SYSTEM_READER, { id: 'c-two', name: 'renamed' })
      memory.setConversationMeta(SYSTEM_READER, { id: 'c-two', summary: 'a summary' })
    })

    const served = memory.allConversations().find((row) => row.id === 'c-two')
    expect(served?.name).toBe('renamed')
    expect(served?.summary).toBe('a summary')
  })
})
