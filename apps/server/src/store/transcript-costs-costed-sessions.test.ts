/**
 * GOLDEN TEST FOR `costedSessionIds` [POD-3395].
 *
 * The coverage census (POD-3244) measured this method as never executed by any
 * lane, and recorded something sharper beside it: the declaration is the ONLY
 * occurrence of the name in the tree, so it has no production caller either. A
 * method with no caller and no test is one nothing would notice breaking, which
 * is exactly why its behaviour is pinned here before the drizzle conversion
 * touches it.
 *
 * Its two predicates are the whole method — a session id that is present, and a
 * transcript that actually holds messages — and `messages` is DERIVED at write
 * time (the sum of the per-model message counts), not supplied. Both facts are
 * pinned, because a conversion that reads `messages >= 0`, or that drops the
 * DISTINCT, returns a superset that no caller exists to complain about.
 */

import type { CostModelTotalWire, MachineId, SessionId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { syncQueriesOver } from './executor/sync-drizzle'
import { type TranscriptCostRecord, TranscriptCostsRepository } from './transcript-costs'

let costs: TranscriptCostsRepository

const model = (messages: number): CostModelTotalWire => ({
  model: 'claude-opus-5',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation1hTokens: 0,
  messages,
})

const record = (over: Partial<TranscriptCostRecord> = {}): TranscriptCostRecord => ({
  machineId: 'machine-1' as MachineId,
  nativeId: 'native-1',
  path: '/transcripts/native-1.jsonl',
  harness: 'claude-code',
  sessionId: 'session-1' as SessionId,
  issueId: null,
  scannedBytes: 1_024,
  firstTsMs: 1,
  lastTsMs: 2,
  models: [model(3)],
  windowModels: [model(3)],
  windowSinceMs: 0,
  ...over,
})

beforeEach(() => {
  costs = new TranscriptCostsRepository(syncQueriesOver(openMigratedTestDatabase()))
})

describe('TranscriptCostsRepository.costedSessionIds', () => {
  it('is empty when nothing has been harvested', () => {
    expect(costs.costedSessionIds()).toEqual(new Set())
  })

  it('reports the session of a transcript that holds messages', () => {
    costs.record([record()], '2026-01-01T00:00:00.000Z')

    expect(costs.costedSessionIds()).toEqual(new Set(['session-1']))
  })

  it('excludes a transcript that resolved to no session', () => {
    costs.record([record({ nativeId: 'native-2', sessionId: null })], '2026-01-01T00:00:00.000Z')

    // The row exists and was counted as read — it just cannot name a session.
    expect(costs.countAll()).toBe(1)
    expect(costs.costedSessionIds()).toEqual(new Set())
  })

  it('excludes a transcript whose fold holds no messages', () => {
    costs.record(
      [record({ nativeId: 'native-3', sessionId: 'session-empty' as SessionId, models: [] })],
      '2026-01-01T00:00:00.000Z',
    )

    // `messages > 0`, not `>= 0`: a walked-but-empty transcript is not a fold.
    expect(costs.countAll()).toBe(1)
    expect(costs.costedSessionIds()).toEqual(new Set())
  })

  it('names a session once however many of its transcripts were harvested', () => {
    costs.record(
      [
        record({ nativeId: 'native-a' }),
        record({ nativeId: 'native-b' }),
        record({ nativeId: 'native-c', sessionId: 'session-2' as SessionId }),
      ],
      '2026-01-01T00:00:00.000Z',
    )

    expect(costs.countAll()).toBe(3)
    expect(costs.costedSessionIds()).toEqual(new Set(['session-1', 'session-2']))
  })

  it('drops a session whose re-harvest folded to nothing', () => {
    costs.record([record()], '2026-01-01T00:00:00.000Z')
    expect(costs.costedSessionIds()).toEqual(new Set(['session-1']))

    // The upsert REPLACES the measurement — `messages = excluded.messages` — so
    // a re-read that found an empty file takes the session back out. This is the
    // arm a single-write test never walks.
    costs.record([record({ models: [] })], '2026-01-02T00:00:00.000Z')

    expect(costs.costedSessionIds()).toEqual(new Set())
  })
})
