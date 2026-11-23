import { changeLogPruneRunKey } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { ChangeLogPrunePlanner, type FeedBounds, type JanitorReadSource } from './janitor'

/**
 * The change-log prune PLAN over one workspace's feed [POD-6993]. The feed's bounds and
 * its highest aged sequence are the server's read (`store/janitor-reads.ts`, tested on
 * both engines, event times out of order included); this is the arithmetic the janitor
 * does with them. Each read is one workspace's, so a planner plans one feed (POD-7021).
 */

const input = { keepRows: 3, maxAgeMs: 1_000, batchSize: 2, nowMs: 2_000 }

function plannerOver(
  feed: () => FeedBounds | undefined,
  workspace = 'local',
): { planner: ChangeLogPrunePlanner; agedBefore: number[] } {
  const agedBefore: number[] = []
  const source: JanitorReadSource = {
    scan: async (fn) =>
      await fn({
        changeFeed: async (agedBeforeMs: number) => {
          agedBefore.push(agedBeforeMs)
          return feed()
        },
      } as never),
  }
  return { planner: new ChangeLogPrunePlanner(source, workspace), agedBefore }
}

describe('ChangeLogPrunePlanner bounds', () => {
  it("plans the workspace's head, floor and age threshold", async () => {
    const local = plannerOver(() => ({ headSeq: 12, floorSeq: 8, agedSeq: 8 }))
    expect(await local.planner.plan(input)).toEqual([
      {
        tenantId: 'local',
        keepRows: 3,
        maxAgeMs: 1_000,
        batchSize: 2,
        thresholdSeq: 9,
        fromSeq: 8,
      },
    ])
    // The age threshold is the plan's clock less the maximum age.
    expect(local.agedBefore).toEqual([1_000])
    const busy = plannerOver(() => ({ headSeq: 1_008, floorSeq: 1_001, agedSeq: 1_008 }))
    const batches = await busy.planner.plan(input)
    expect(batches.map((batch) => batch.fromSeq)).toEqual([1_001, 1_003, 1_005, 1_007])
    expect(batches.every((batch) => batch.thresholdSeq === 1_008)).toBe(true)
  })

  it('takes the aged sequence when it reaches past what the row count keeps', async () => {
    const { planner } = plannerOver(() => ({ headSeq: 12, floorSeq: 8, agedSeq: 9 }))
    expect(await planner.plan({ ...input, keepRows: 100 })).toEqual([
      {
        tenantId: 'local',
        keepRows: 100,
        maxAgeMs: 1_000,
        batchSize: 2,
        thresholdSeq: 9,
        fromSeq: 8,
      },
    ])
  })

  it.each([
    ['missing or empty', undefined],
    ['retained', { headSeq: 12, floorSeq: 11, agedSeq: null }],
  ] as const)('emits no work for a %s feed', async (_state, feed) => {
    const { planner } = plannerOver(() => feed)
    expect(await planner.plan(input)).toEqual([])
  })

  it('keeps replay keys distinct for workspaces with identical sequence bounds', async () => {
    const bounds = () => ({ headSeq: 5, floorSeq: 1, agedSeq: 5 })
    const one = await plannerOver(bounds, 'one/tenant').planner.plan(input)
    const two = await plannerOver(bounds, 'two').planner.plan(input)
    expect(one).toHaveLength(3)
    expect(new Set([...one, ...two].map(changeLogPruneRunKey)).size).toBe(6)
  })

  it('caps planning at 100 batches and resumes from the durable floor', async () => {
    let feed: FeedBounds = { headSeq: 250, floorSeq: 1, agedSeq: 250 }
    const { planner } = plannerOver(() => feed)
    const first = await planner.plan({ ...input, keepRows: 0 })
    expect(first).toHaveLength(100)
    expect(first[99]?.fromSeq).toBe(199)
    feed = { headSeq: 250, floorSeq: 201, agedSeq: 250 }
    const second = await planner.plan({ ...input, keepRows: 0 })
    expect(second).toHaveLength(25)
    expect(second[0]?.fromSeq).toBe(201)
    feed = { headSeq: 250, floorSeq: 251, agedSeq: 250 }
    expect(await planner.plan({ ...input, keepRows: 0 })).toEqual([])
  })
})
