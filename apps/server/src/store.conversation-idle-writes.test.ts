import { asMachineId } from '@podium/model'
import { fixtureWriteScope } from '@podium/sync/testing'
import { describe, expect, it } from 'vitest'
import { openTestStore } from './test-support/open-test-store'
import { updateCounter } from './test-support/store-sql'

/**
 * A RE-DISCOVERY THAT CHANGES NOTHING MUST WRITE NOTHING [POD-1931].
 *
 * Discovery re-offers the whole conversation corpus every sweep, so the steady
 * state is thousands of upserts whose values already match the stored row. Each
 * such rewrite is not free: `conversations` carries the `conversations_au`
 * trigger, so one no-op UPDATE is an fts5 delete AND re-insert. Measured on the
 * live server before this guard: 1786 zero-change writes per 4 minutes, 1650 of
 * them inside a single 757ms event-loop stall.
 *
 * The conserved quantity is the NUMBER OF ROW WRITES, not a duration — these
 * assert it with the same mechanism whose cost is being avoided, a trigger that
 * records every UPDATE that actually fires (`updateCounter`, on either engine).
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'native-a',
  agentKind: 'claude-code',
  providerId: 'claude-code-jsonl',
  machineId: asMachineId('m1'),
  title: 'A conversation',
  projectPath: '/repo',
  messageCount: 12,
  ...over,
})

describe('idle re-discovery writes', () => {
  it('re-upserting an identical conversation row does not rewrite it', async () => {
    const store = await openTestStore(':memory:')
    await store.conversations.index.upsert(fixtureWriteScope(), [row()])
    const writes = await updateCounter(store, ['conversations'])
    expect(await writes()).toBe(0)

    await store.conversations.index.upsert(fixtureWriteScope(), [row()])
    await store.conversations.index.upsert(fixtureWriteScope(), [row()])
    expect(await writes()).toBe(0)

    // A real change still lands — the guard elides no-ops, not updates.
    await store.conversations.index.upsert(fixtureWriteScope(), [row({ title: 'Renamed' })])
    expect(await writes()).toBe(1)
    const found = await store.conversations.index.search({})
    expect(found.find((c) => c.id === 'native-a')?.title).toBe('Renamed')
  })

  it('an omitted field is not a change — COALESCE keeps the stored value', async () => {
    const store = await openTestStore(':memory:')
    await store.conversations.index.upsert(fixtureWriteScope(), [row()])
    const writes = await updateCounter(store, ['conversations'])

    const { title: _title, projectPath: _projectPath, ...withoutOptionals } = row()
    await store.conversations.index.upsert(fixtureWriteScope(), [withoutOptionals])
    expect(await writes()).toBe(0)
    const found = await store.conversations.index.search({})
    expect(found.find((c) => c.id === 'native-a')?.title).toBe('A conversation')
  })

  it('re-ensuring an unchanged segment does not rewrite it', async () => {
    const store = await openTestStore(':memory:')
    const opts = {
      machineId: asMachineId('m1'),
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
      path: '/transcripts/native-a.jsonl',
      sizeBytes: 4096,
    }
    const podiumId = await store.conversations.registry.ensure(opts)
    const writes = await updateCounter(store, ['conversation_segments'])

    expect(await store.conversations.registry.ensure(opts)).toBe(podiumId)
    expect(await store.conversations.registry.ensure(opts)).toBe(podiumId)
    expect(await writes()).toBe(0)

    // A grown transcript is a real change and still lands.
    expect(await store.conversations.registry.ensure({ ...opts, sizeBytes: 8192 })).toBe(podiumId)
    expect(await writes()).toBe(1)
    expect(await store.conversations.registry.segmentPath(asMachineId('m1'), 'native-a')).toBe(
      opts.path,
    )
  })
})
