import { asMachineId, type ConversationId } from '@podium/model'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from './store'
import { openTestStore } from './test-support/open-test-store'
import { countStatements } from './test-support/statement-count'
import { storeSql, updateCounter } from './test-support/store-sql'

// The conversation registry (docs/spec/conversation-registry.md §3.1): Podium ids
// are minted once, native ids map to them forever, and a live-roll attaches a new
// native file as the next SEGMENT of the same identity — never a new conversation.
describe('conversation registry store', () => {
  it('mints once and resolves the same podium id forever', async () => {
    const store = await openTestStore(':memory:')
    const a = await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
    })
    expect(a).toMatch(/^conv_/)
    expect(
      await store.conversations.registry.ensure({
        machineId: asMachineId('m1'),
        nativeId: 'native-a',
        providerId: 'claude-code-jsonl',
      }),
    ).toBe(a)
    expect(await store.conversations.registry.podiumId(asMachineId('m1'), 'native-a')).toBe(a)
    // Machine-scoped: the same native id on another machine is a different row.
    const other = await store.conversations.registry.ensure({
      machineId: asMachineId('m2'),
      nativeId: 'native-a',
      providerId: 'claude-code-jsonl',
    })
    expect(other).not.toBe(a)
  })

  it('live-roll links the new native id as segment 2 of the same identity', async () => {
    const store = await openTestStore(':memory:')
    const podium = await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'old-file',
      providerId: 'claude-code',
    })
    const linked = await store.conversations.registry.linkSegment({
      machineId: asMachineId('m1'),
      newNativeId: 'new-file',
      priorNativeId: 'old-file',
      providerId: 'claude-code',
    })
    expect(linked).toBe(podium)
    expect(await store.conversations.registry.podiumId(asMachineId('m1'), 'new-file')).toBe(podium)
    // Rolling again chains a third segment onto the same identity.
    const linked2 = await store.conversations.registry.linkSegment({
      machineId: asMachineId('m1'),
      newNativeId: 'newest-file',
      priorNativeId: 'new-file',
      providerId: 'claude-code',
    })
    expect(linked2).toBe(podium)
    // Idempotent re-observation (e.g. after a restart) never re-links.
    expect(
      await store.conversations.registry.linkSegment({
        machineId: asMachineId('m1'),
        newNativeId: 'new-file',
        priorNativeId: 'old-file',
        providerId: 'claude-code',
      }),
    ).toBe(podium)
  })

  it('live-roll with an unseen prior mints the identity on the spot', async () => {
    const store = await openTestStore(':memory:')
    const podium = await store.conversations.registry.linkSegment({
      machineId: asMachineId('m1'),
      newNativeId: 'roll-b',
      priorNativeId: 'roll-a',
      providerId: 'claude-code',
    })
    expect(await store.conversations.registry.podiumId(asMachineId('m1'), 'roll-a')).toBe(podium)
    expect(await store.conversations.registry.podiumId(asMachineId('m1'), 'roll-b')).toBe(podium)
  })

  it('answers siblingSegmentsMany key by key, as siblingSegments does for one', async () => {
    const store = await openTestStore(':memory:')
    const registry = store.conversations.registry
    await registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'a-1',
      providerId: 'claude-code',
    })
    await registry.linkSegment({
      machineId: asMachineId('m1'),
      newNativeId: 'a-2',
      priorNativeId: 'a-1',
      providerId: 'claude-code',
    })
    await registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'b-1',
      providerId: 'claude-code',
    })
    // The same native id on another machine is another segment.
    await registry.ensure({
      machineId: asMachineId('m2'),
      nativeId: 'a-1',
      providerId: 'claude-code',
    })
    const keys = [
      { machineId: asMachineId('m1'), nativeId: 'a-2' },
      { machineId: asMachineId('m2'), nativeId: 'a-1' },
      { machineId: asMachineId('m1'), nativeId: 'missing' },
      { machineId: asMachineId('m1'), nativeId: 'b-1' },
      { machineId: asMachineId('m1'), nativeId: 'a-1' },
    ]
    const many = await registry.siblingSegmentsMany(keys)
    const one = await Promise.all(
      keys.map((key) => registry.siblingSegments(key.machineId, key.nativeId)),
    )
    expect(many).toEqual(one)
    expect(many[0]).toEqual([
      { machineId: 'm1', nativeId: 'a-1' },
      { machineId: 'm1', nativeId: 'a-2' },
    ])
    expect(many[1]).toEqual([{ machineId: 'm2', nativeId: 'a-1' }])
    expect(many[2]).toEqual([])
    expect(await registry.siblingSegmentsMany([])).toEqual([])
  })

  it('records and refreshes transcript-path evidence on the segment', async () => {
    const store = await openTestStore(':memory:')
    await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'n1',
      providerId: 'p',
      path: '/home/u/.claude/projects/-old-spot/n1.jsonl',
    })
    expect(await store.conversations.registry.segmentPath(asMachineId('m1'), 'n1')).toBe(
      '/home/u/.claude/projects/-old-spot/n1.jsonl',
    )
    // A later scan re-observes the same conversation: evidence refreshes in place.
    await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'n1',
      providerId: 'p',
      path: '/home/u/.claude/projects/-new-spot/n1.jsonl',
    })
    expect(await store.conversations.registry.segmentPath(asMachineId('m1'), 'n1')).toBe(
      '/home/u/.claude/projects/-new-spot/n1.jsonl',
    )
    expect(
      await store.conversations.registry.segmentPath(asMachineId('m1'), 'unseen'),
    ).toBeUndefined()
  })

  it('fills a null parent later but never overwrites a set one', async () => {
    const store = await openTestStore(':memory:')
    const child = await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'child',
      providerId: 'p',
    })
    const parentA = await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'parent-a',
      providerId: 'p',
    })
    // Parent learned on a later scan: fills the NULL.
    await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'child',
      providerId: 'p',
      parentPodiumId: parentA,
    })
    const parentB = await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'parent-b',
      providerId: 'p',
    })
    // A conflicting parent must NOT clobber (mis-parenting bias, spec §3.1).
    await store.conversations.registry.ensure({
      machineId: asMachineId('m1'),
      nativeId: 'child',
      providerId: 'p',
      parentPodiumId: parentB,
    })
    const batch = await store.conversations.registry.podiumIds(asMachineId('m1'), [
      'child',
      'parent-a',
      'parent-b',
    ])
    expect(batch.get('child')).toBe(child)
    expect(batch.size).toBe(3)
  })

  // The repair of subagent paths poisoned onto other identities is a one-shot
  // migration since sync-without-boot-reconcile (POD-6253); its test covers it.

  // ensureMany is the batch form a discovery uses [POD-6227]: whatever it is
  // given, the rows it leaves are the ones one ensure per entry, in order, leaves.
  describe('ensureMany', () => {
    const M = asMachineId('m1')
    type Offer = { nativeId: string; parent?: string; path?: string; sizeBytes?: number }
    /** Every segment with its file evidence and its identity's parent, by native ids. */
    const rows = async (store: SessionStore) =>
      await storeSql(store).all(
        sql`SELECT s.native_id, s.provider_id, s.path, s.reported_bytes, s.seq_in_conv, s.linked_by,
             (SELECT p.native_id FROM conversation_segments p WHERE p.podium_id = i.parent_podium_id AND p.seq_in_conv = 1) AS parent
           FROM conversation_segments s JOIN conversation_identities i ON i.podium_id = s.podium_id
           ORDER BY s.native_id`,
      )
    const seeded = async () => {
      const store = await openTestStore(':memory:')
      const r = store.conversations.registry
      await r.ensure({
        machineId: M,
        nativeId: 'old-a',
        providerId: 'p',
        path: '/a1',
        sizeBytes: 10,
      })
      await r.ensure({ machineId: M, nativeId: 'old-b', providerId: 'p' })
      const a = await r.ensure({ machineId: M, nativeId: 'old-parent', providerId: 'p' })
      await r.ensure({ machineId: M, nativeId: 'old-c', providerId: 'p', parentPodiumId: a })
      return store
    }
    const offers: Offer[] = [
      { nativeId: 'n1', path: '/n1', sizeBytes: 1 },
      { nativeId: 'old-a', path: '/a2' },
      { nativeId: 'old-a', sizeBytes: 20 },
      { nativeId: 'old-b', parent: 'old-a' },
      { nativeId: 'old-b', parent: 'old-c' },
      { nativeId: 'old-c', parent: 'old-b' },
      { nativeId: 'n2' },
      { nativeId: 'n2', path: '/n2', parent: 'old-a' },
      { nativeId: 'n2', parent: 'old-c', sizeBytes: 5 },
    ]
    const resolve = async (store: SessionStore, offer: Offer) => ({
      nativeId: offer.nativeId,
      providerId: 'p',
      ...(offer.parent
        ? {
            parentPodiumId: (await store.conversations.registry.podiumId(
              M,
              offer.parent,
            )) as ConversationId,
          }
        : {}),
      ...(offer.path !== undefined ? { path: offer.path } : {}),
      ...(offer.sizeBytes !== undefined ? { sizeBytes: offer.sizeBytes } : {}),
    })

    it('leaves the rows one ensure per entry leaves, and answers their ids', async () => {
      const one = await seeded()
      const many = await seeded()
      for (const offer of offers)
        await one.conversations.registry.ensure({ machineId: M, ...(await resolve(one, offer)) })
      const entries = await Promise.all(offers.map((offer) => resolve(many, offer)))
      const ids = await many.conversations.registry.ensureMany(M, entries)
      expect(await rows(many)).toEqual(await rows(one))
      expect(ids).toEqual(
        await many.conversations.registry.podiumIds(
          M,
          offers.map((offer) => offer.nativeId),
        ),
      )
      expect(ids.size).toBe(new Set(offers.map((offer) => offer.nativeId)).size)
    })

    it('rewrites no unchanged segment when the same report comes again', async () => {
      const store = await seeded()
      const entries = await Promise.all(offers.map((offer) => resolve(store, offer)))
      await store.conversations.registry.ensureMany(M, entries)
      const before = await rows(store)
      const writes = await updateCounter(store, [
        'conversation_segments',
        'conversation_identities',
      ])
      await store.conversations.registry.ensureMany(M, entries)
      expect(await writes()).toBe(0)
      expect(await rows(store)).toEqual(before)
    })

    it('refreshes a large unchanged scan in bounded batches of distinct native ids', async () => {
      // POD-7414 finding 5: the startup corpus had 11,347 segments. Include
      // both sides of the 500-row boundary so a per-row read cannot hide in
      // the large scan, and duplicate every offer without increasing batches.
      for (const size of [5, 500, 501, 11_347]) {
        const store = await openTestStore(':memory:')
        try {
          const entries = Array.from({ length: size }, (_, i) => ({
            nativeId: `scan-${i}`,
            providerId: 'p',
            path: `/transcripts/scan-${i}.jsonl`,
            sizeBytes: i * 1024,
          }))
          const registry = store.conversations.registry
          const ids = await registry.ensureMany(M, entries)
          const writes = await updateCounter(store, ['conversation_segments'])
          const scan = await countStatements(store, () =>
            registry.ensureMany(M, [...entries, ...entries]),
          )
          expect(scan.result).toEqual(ids)
          expect(scan.statements).toBe(2 * Math.ceil(size / 500))
          expect(await writes()).toBe(0)
          // Prove the no-op counter sees real changes, including zero bytes.
          const lastNativeId = `scan-${size - 1}`
          await registry.ensureMany(M, [{ nativeId: lastNativeId, providerId: 'p', sizeBytes: 0 }])
          expect(await writes()).toBe(1)
          expect(
            await storeSql(store).get(sql`SELECT reported_bytes FROM conversation_segments
              WHERE machine_id = ${M} AND native_id = ${lastNativeId}`),
          ).toEqual({ reported_bytes: 0 })
        } finally {
          await store.close()
        }
      }
    })

    it('folds duplicate file fields and first parents across refresh batch boundaries', async () => {
      const store = await openTestStore(':memory:')
      try {
        const registry = store.conversations.registry
        const parentA = await registry.ensure({
          machineId: M,
          nativeId: 'parent-a',
          providerId: 'p',
        })
        const parentB = await registry.ensure({
          machineId: M,
          nativeId: 'parent-b',
          providerId: 'p',
        })
        const entries = Array.from({ length: 501 }, (_, i) => ({
          nativeId: `file-${i}`,
          providerId: 'p',
          path: `/before/${i}`,
          sizeBytes: 100,
        }))
        const ids = await registry.ensureMany(M, entries)
        // Same native id on a different machine must keep its own evidence.
        const otherMachine = asMachineId('other-machine')
        await registry.ensure({
          machineId: otherMachine,
          nativeId: 'file-0',
          providerId: 'p',
          path: '/before/0',
          sizeBytes: 100,
        })
        await registry.ensureMany(M, [
          {
            nativeId: 'file-0',
            providerId: 'p',
            parentPodiumId: parentA,
            path: '/first',
            sizeBytes: 200,
          },
          ...entries.slice(1),
          { nativeId: 'file-0', providerId: 'ignored', parentPodiumId: parentB, path: '/last' },
          { nativeId: 'file-0', providerId: 'ignored', sizeBytes: 0 },
          // Omitted fields keep earlier offers. An empty path alone is ignored;
          // offered alongside a size it remains a legitimate file value.
          { nativeId: 'file-0', providerId: 'ignored', path: '' },
          { nativeId: 'file-500', providerId: 'p', path: '', sizeBytes: 0 },
        ])
        expect([...(await registry.parentPodiumIds([...ids.values()]))]).toEqual([
          [ids.get('file-0'), parentA],
        ])
        await registry.ensureMany(M, [
          { nativeId: 'file-0', providerId: 'p', parentPodiumId: parentB },
        ])
        expect([...(await registry.parentPodiumIds([...ids.values()]))]).toEqual([
          [ids.get('file-0'), parentA],
        ])
        expect(
          await storeSql(
            store,
          ).all(sql`SELECT machine_id, native_id, provider_id, path, reported_bytes
            FROM conversation_segments WHERE native_id IN ('file-0', 'file-500')
            ORDER BY machine_id, native_id`),
        ).toEqual([
          {
            machine_id: M,
            native_id: 'file-0',
            provider_id: 'p',
            path: '/last',
            reported_bytes: 0,
          },
          { machine_id: M, native_id: 'file-500', provider_id: 'p', path: '', reported_bytes: 0 },
          {
            machine_id: otherMachine,
            native_id: 'file-0',
            provider_id: 'p',
            path: '/before/0',
            reported_bytes: 100,
          },
        ])
      } finally {
        await store.close()
      }
    })
  })
})
