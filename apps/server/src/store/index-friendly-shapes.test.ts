/**
 * QUERY SHAPES AN INDEX CAN SERVE [POD-6173].
 *
 * The query-plan audit (query-plan-audit.test.ts) proves each rewritten lookup
 * now seeks an index. This file proves each one still selects exactly the rows
 * the old shape did, at the edges the new shape introduced: the upper bound of
 * a prefix range, and FTS rows written before their key table existed.
 */

import { asMachineId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { TranscriptIndexRepository } from './conversations/transcript-index'
import { syncQueriesOver } from './executor/sync-drizzle'
import { NotificationFactsRepository } from './notification-facts'
import { prefixUpperBound } from './prefix-range'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T01:00:00.000Z'

describe('prefixUpperBound', () => {
  it('raises the last character by one', () => {
    expect(prefixUpperBound('/root/')).toBe('/root0')
    expect(prefixUpperBound('nudge:settle:s1:')).toBe('nudge:settle:s1;')
  })

  it('refuses a prefix that is empty or does not end in ASCII', () => {
    expect(() => prefixUpperBound('')).toThrow(/ASCII/)
    expect(() => prefixUpperBound('café')).toThrow(/ASCII/)
  })
})

describe('NotificationFactsRepository.retireFactKeyPrefix', () => {
  let facts: NotificationFactsRepository

  beforeEach(() => {
    facts = new NotificationFactsRepository(syncQueriesOver(openMigratedTestDatabase()))
  })

  const claim = async (factKey: string) =>
    expect(
      await facts.claim({
        factKey,
        target: 'target-a',
        source: null,
        issueId: null,
        createdAt: T0,
        expiresAt: null,
      }),
    ).toBe(true)

  it('retires exactly the keys that start with the prefix', async () => {
    const inside = ['settle:s1:', 'settle:s1:a', 'settle:s1:zzz', 'settle:s1:~']
    // Just below the range, just at its upper bound, a sibling that shares
    // the prefix as text without the separator, and a different case: the old
    // LIKE matched the last one, an equality never does.
    const outside = ['settle:s1', 'settle:s1;', 'settle:s10:a', 'SETTLE:s1:a']
    for (const key of [...inside, ...outside]) await claim(key)

    expect(await facts.retireFactKeyPrefix('settle:s1:', T1)).toBe(inside.length)
    for (const key of inside) expect(await facts.hasActive(key, 'target-a', T1)).toBe(false)
    for (const key of outside) expect(await facts.hasActive(key, 'target-a', T1)).toBe(true)
  })
})

describe('TranscriptIndexRepository keys', () => {
  const m1 = asMachineId('m1')
  let database: SqlDatabase
  let index: TranscriptIndexRepository

  beforeEach(() => {
    database = openMigratedTestDatabase()
    index = new TranscriptIndexRepository(syncQueriesOver(database))
  })

  /** An FTS row as a build from before the key table wrote it: no key. */
  const writeUnkeyed = (nativeId: string, content: string) =>
    database
      .prepare('INSERT INTO transcript_fts (content, machine_id, native_id) VALUES (?, ?, ?)')
      .run(content, 'm1', nativeId)

  const contents = async (nativeId: string) =>
    (await index.rows(m1, nativeId)).map((row) => row.content)

  it('reads, drops and keeps segments apart through the keys', async () => {
    await index.enableFts()
    await index.append(m1, 'a', [{ content: 'a1' }, { content: 'a2' }], 10)
    await index.append(m1, 'b', [{ content: 'b1' }], 10)
    await index.append(m1, 'a', [{ content: 'a3' }], 20)

    expect(await contents('a')).toEqual(['a1', 'a2', 'a3'])
    expect(await contents('b')).toEqual(['b1'])

    await index.drop(m1, 'a')
    expect(await contents('a')).toEqual([])
    expect(await contents('b')).toEqual(['b1'])
    // The FTS rows went with their keys: nothing of `a` is left to search.
    expect(database.prepare('SELECT count(*) AS n FROM transcript_fts').get()).toEqual({ n: 1 })
    expect(database.prepare('SELECT count(*) AS n FROM transcript_fts_keys').get()).toEqual({ n: 1 })
  })

  it('keys the rows a table from before the keys holds when search opens', async () => {
    database.exec(`CREATE VIRTUAL TABLE transcript_fts USING fts5(
      content, machine_id UNINDEXED, native_id UNINDEXED, item_uuid UNINDEXED, ts UNINDEXED)`)
    writeUnkeyed('old', 'o1')
    writeUnkeyed('other', 'x1')
    writeUnkeyed('old', 'o2')

    await index.enableFts()
    expect(await contents('old')).toEqual(['o1', 'o2'])

    await index.drop(m1, 'old')
    expect(await contents('old')).toEqual([])
    expect(await contents('other')).toEqual(['x1'])
  })

  it('keys rows an older build appended after the keys existed, the next time search opens', async () => {
    await index.enableFts()
    await index.append(m1, 'seg', [{ content: 's1' }], 10)
    writeUnkeyed('seg', 's2')
    expect(await contents('seg')).toEqual(['s1'])

    await index.enableFts()
    expect(await contents('seg')).toEqual(['s1', 's2'])
  })
})
