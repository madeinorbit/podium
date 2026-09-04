/**
 * Golden tests for the events aggregate, written BEFORE its drizzle conversion
 * [POD-3397, execution method §3 Stage A item 10].
 *
 * WHAT THESE ARE FOR. The coverage census (docs/internal/pod-3244) found one
 * method of `EventsRepository` that no test executes at all
 * (`listKindSubjectSinceWithPrior`) and five that are executed only as a side
 * effect of something else, never named by an assertion:
 * `saveRuntimeEventCheckpoint`, `listRuntimeEventsAfter`,
 * `saveRuntimeEventProjectionCursor`, `announceEvent` and
 * `activateJanitorSteward`. A method in either group has no oracle, so a
 * conversion could change its behaviour and the suite would stay green. These
 * pin today's behaviour against today's synchronous implementation, so the
 * conversion has something to be judged against.
 *
 * WHAT IS PINNED IS THE PART A CONVERSION CAN LOSE, not the happy path alone:
 * the SQL-level guard on the projection cursor's upsert, the ordering and
 * tie-breakers the two "with prior" reads depend on, the subject narrowing, and
 * the two deliberately distinct announcement paths POD-3331 found (an append
 * that announces itself, and a silent append announced later by its caller).
 */

import { asSessionId } from '@podium/model'
import type { ProviderCursor } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { openTestStore } from '../test-support/open-test-store'
import { RUNTIME_EVENT_LOG_KIND } from './events'

const CURSOR: ProviderCursor = { segmentId: 'seg-1', components: { seq: 7 } }

describe('EventsRepository: listKindSubjectSinceWithPrior (no test executes this today)', () => {
  it('returns the last row before the window followed by the window, for one subject only', async () => {
    const store = await openTestStore(':memory:')
    // Two subjects with interleaved timestamps, so a read that forgets the
    // subject predicate returns rows in the same ORDER and is caught only by
    // which subjects come back.
    await store.events.appendEvent({ ts: '2026-01-01T00:00:00Z', kind: 'phase', subject: 'a' })
    await store.events.appendEvent({ ts: '2026-01-02T00:00:00Z', kind: 'phase', subject: 'b' })
    await store.events.appendEvent({ ts: '2026-01-03T00:00:00Z', kind: 'phase', subject: 'a' })
    await store.events.appendEvent({ ts: '2026-01-05T00:00:00Z', kind: 'phase', subject: 'b' })
    await store.events.appendEvent({ ts: '2026-01-06T00:00:00Z', kind: 'phase', subject: 'a' })
    await store.events.appendEvent({ ts: '2026-01-07T00:00:00Z', kind: 'phase', subject: 'a' })

    const rows = await store.events.listKindSubjectSinceWithPrior(
      'phase',
      'a',
      '2026-01-05T00:00:00Z',
    )

    expect(rows.map((r) => r.ts)).toEqual([
      // the carried-in value: subject a's newest row STRICTLY BEFORE the window
      '2026-01-03T00:00:00Z',
      '2026-01-06T00:00:00Z',
      '2026-01-07T00:00:00Z',
    ])
    expect(new Set(rows.map((r) => r.subject))).toEqual(new Set(['a']))
    store.close()
  })

  it('breaks a prior-row timestamp tie by the highest id', async () => {
    const store = await openTestStore(':memory:')
    // Same ts, so only the id tie-breaker decides which row is "the value
    // carried into the window". Both rows are the same subject and kind.
    const first = await store.events.appendEvent({
      ts: '2026-01-01T00:00:00Z',
      kind: 'phase',
      subject: 'a',
      payload: { which: 'first' },
    })
    const second = await store.events.appendEvent({
      ts: '2026-01-01T00:00:00Z',
      kind: 'phase',
      subject: 'a',
      payload: { which: 'second' },
    })
    expect(second).toBeGreaterThan(first)

    const rows = await store.events.listKindSubjectSinceWithPrior(
      'phase',
      'a',
      '2026-01-02T00:00:00Z',
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(second)
    store.close()
  })

  it('returns only the window when the subject has no row before it', async () => {
    const store = await openTestStore(':memory:')
    // The prior lookup is a separate statement whose miss must not remove the
    // window rows, and must not fall back to another subject's prior row.
    await store.events.appendEvent({ ts: '2026-01-01T00:00:00Z', kind: 'phase', subject: 'other' })
    await store.events.appendEvent({ ts: '2026-01-04T00:00:00Z', kind: 'phase', subject: 'a' })

    const rows = await store.events.listKindSubjectSinceWithPrior(
      'phase',
      'a',
      '2026-01-02T00:00:00Z',
    )

    expect(rows.map((r) => r.subject)).toEqual(['a'])
    store.close()
  })

  it('narrows by kind as well as subject', async () => {
    const store = await openTestStore(':memory:')
    await store.events.appendEvent({ ts: '2026-01-03T00:00:00Z', kind: 'other', subject: 'a' })
    await store.events.appendEvent({ ts: '2026-01-04T00:00:00Z', kind: 'phase', subject: 'a' })

    const rows = await store.events.listKindSubjectSinceWithPrior(
      'phase',
      'a',
      '2026-01-02T00:00:00Z',
    )

    expect(rows.map((r) => r.kind)).toEqual(['phase'])
    store.close()
  })
})

describe('EventsRepository: saveRuntimeEventProjectionCursor (executed, never named)', () => {
  it('advances the cursor forward', async () => {
    const store = await openTestStore(':memory:')
    await store.events.saveRuntimeEventProjectionCursor('runtime.board.v1', 10, 't1')
    expect(await store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBe(10)
    await store.events.saveRuntimeEventProjectionCursor('runtime.board.v1', 25, 't2')
    expect(await store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBe(25)
    store.close()
  })

  it('REFUSES to move the cursor backwards — the guard is in the upsert, not the caller', async () => {
    const store = await openTestStore(':memory:')
    await store.events.saveRuntimeEventProjectionCursor('runtime.board.v1', 25, 't1')
    // A projector that replays, or two projectors racing, must not rewind the
    // cursor: `pruneEventBatch` refuses to delete runtime events above it, so a
    // rewind would make already-projected rows undeletable rather than merely
    // re-projected. The condition lives in the ON CONFLICT clause, so a
    // conversion that keeps the upsert and drops its WHERE is silent here.
    await store.events.saveRuntimeEventProjectionCursor('runtime.board.v1', 5, 't2')
    expect(await store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBe(25)
    store.close()
  })

  it('keeps projectors independent', async () => {
    const store = await openTestStore(':memory:')
    // The equal case is deliberately NOT asserted here: writing 25 over 25
    // leaves 25 whether or not the guard fires, and the only column that would
    // tell them apart (`updated_at`) has no reader. A test of it would pass
    // against a dropped guard, which is worse than not having one.
    await store.events.saveRuntimeEventProjectionCursor('runtime.board.v1', 25, 't1')
    expect(await store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBe(25)
    expect(await store.events.runtimeEventProjectionCursor('other.projector')).toBe(0)
    store.close()
  })

  it('reads an unknown projector as 0 rather than refusing', async () => {
    const store = await openTestStore(':memory:')
    expect(await store.events.runtimeEventProjectionCursor('never-written')).toBe(0)
    store.close()
  })
})

describe('EventsRepository: saveRuntimeEventCheckpoint (executed, never named)', () => {
  it('inserts, then overwrites every column of the same session on conflict', async () => {
    const store = await openTestStore(':memory:')
    const sessionId = asSessionId('ses_1')
    await store.events.saveRuntimeEventCheckpoint({
      sessionId,
      observerGeneration: 1,
      cursor: CURSOR,
      turnEpoch: 4,
      closedTurnEpoch: null,
      updatedAt: 't1',
    })
    await store.events.saveRuntimeEventCheckpoint({
      sessionId,
      observerGeneration: 2,
      cursor: { segmentId: 'seg-2', components: { seq: 9 } },
      turnEpoch: 5,
      closedTurnEpoch: 4,
      updatedAt: 't2',
    })

    expect(await store.events.runtimeEventCheckpoint(sessionId)).toEqual({
      sessionId,
      observerGeneration: 2,
      cursor: { segmentId: 'seg-2', components: { seq: 9 } },
      turnEpoch: 5,
      closedTurnEpoch: 4,
      updatedAt: 't2',
    })
    store.close()
  })

  it('keeps a null closedTurnEpoch null rather than reading it as 0', async () => {
    const store = await openTestStore(':memory:')
    const sessionId = asSessionId('ses_2')
    await store.events.saveRuntimeEventCheckpoint({
      sessionId,
      observerGeneration: 1,
      cursor: CURSOR,
      turnEpoch: 1,
      closedTurnEpoch: null,
      updatedAt: 't1',
    })
    // `Number(null)` is 0, so the mapper's explicit null check is the only thing
    // standing between "no turn has closed" and "turn 0 closed".
    expect((await store.events.runtimeEventCheckpoint(sessionId))?.closedTurnEpoch).toBeNull()
    store.close()
  })

  it('keeps one checkpoint per session', async () => {
    const store = await openTestStore(':memory:')
    await store.events.saveRuntimeEventCheckpoint({
      sessionId: asSessionId('ses_a'),
      observerGeneration: 1,
      cursor: CURSOR,
      turnEpoch: 1,
      closedTurnEpoch: null,
      updatedAt: 't1',
    })
    await store.events.saveRuntimeEventCheckpoint({
      sessionId: asSessionId('ses_b'),
      observerGeneration: 9,
      cursor: CURSOR,
      turnEpoch: 2,
      closedTurnEpoch: null,
      updatedAt: 't2',
    })
    expect(
      (await store.events.runtimeEventCheckpoint(asSessionId('ses_a')))?.observerGeneration,
    ).toBe(1)
    expect(
      (await store.events.runtimeEventCheckpoint(asSessionId('ses_b')))?.observerGeneration,
    ).toBe(9)
    expect(await store.events.runtimeEventCheckpoint(asSessionId('ses_missing'))).toBeNull()
    store.close()
  })
})

describe('EventsRepository: listRuntimeEventsAfter (executed, never named)', () => {
  it('returns runtime rows strictly above the id, ascending, bounded by the limit', async () => {
    const store = await openTestStore(':memory:')
    const sessionId = asSessionId('ses_1')
    const ids: number[] = []
    for (let seq = 0; seq < 4; seq += 1) {
      ids.push(
        await store.events.appendEvent({
          ts: `2026-01-0${seq + 1}T00:00:00Z`,
          kind: RUNTIME_EVENT_LOG_KIND,
          subject: sessionId,
          payload: runtimeStateEvent(seq),
        }),
      )
    }

    const after = await store.events.listRuntimeEventsAfter(ids[0] as number, 2)

    expect(after.map((r) => r.id)).toEqual([ids[1], ids[2]])
    expect(after.every((r) => r.sessionId === sessionId)).toBe(true)
    store.close()
  })

  it('ignores rows of any other kind, whatever their id', async () => {
    const store = await openTestStore(':memory:')
    // The projection reads the log by id across all sessions, so the kind
    // predicate is the only thing keeping non-runtime rows out of a parse that
    // would throw on them.
    await store.events.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_1' })
    const runtimeId = await store.events.appendEvent({
      ts: 't',
      kind: RUNTIME_EVENT_LOG_KIND,
      subject: asSessionId('ses_1'),
      payload: runtimeStateEvent(0),
    })
    await store.events.appendEvent({ ts: 't', kind: 'issue.updated', subject: 'iss_1' })

    const after = await store.events.listRuntimeEventsAfter(0, 128)

    expect(after.map((r) => r.id)).toEqual([runtimeId])
    store.close()
  })
})

describe('EventsRepository: announceEvent and the two append paths (POD-3331)', () => {
  it('announces a silently-appended row when its caller asks, and not before', async () => {
    const store = await openTestStore(':memory:')
    const seen: number[] = []
    await store.events.onAppend((id) => {
      seen.push(id)
    })

    // Path one: the silent append. `persistManyWith` uses this so a batch's
    // announcement order is the caller's, not the insert's.
    const id = await store.events.appendEvent(
      { ts: 't', kind: 'issue.created', subject: 'iss_1' },
      { announce: false },
    )
    expect(seen).toEqual([])

    await store.events.announceEvent(id)
    expect(seen).toEqual([id])
    store.close()
  })

  it('announces an ordinary append by itself', async () => {
    const store = await openTestStore(':memory:')
    const seen: number[] = []
    await store.events.onAppend((id) => {
      seen.push(id)
    })

    // Path two: the default. Both paths reach one listener, and keeping them
    // distinct is what lets a caller inside a wider transaction defer the
    // announcement without the append growing a second listener.
    const id = await store.events.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_1' })
    expect(seen).toEqual([id])
    store.close()
  })

  it('hands the listener the stored row, not the caller argument', async () => {
    const store = await openTestStore(':memory:')
    const announced: { ts: string; kind: string; subject: string; repoPath: string | null }[] = []
    await store.events.onAppend((_id, event) => {
      announced.push({
        ts: event.ts,
        kind: event.kind,
        subject: event.subject,
        repoPath: event.repoPath,
      })
    })

    const id = await store.events.appendEvent(
      { ts: 'ts-1', kind: 'issue.created', subject: 'iss_1', repoPath: '/r' },
      { announce: false },
    )
    await store.events.announceEvent(id)

    expect(announced).toEqual([
      { ts: 'ts-1', kind: 'issue.created', subject: 'iss_1', repoPath: '/r' },
    ])
    store.close()
  })

  it('refuses an unknown id — but only once a listener is installed', async () => {
    const store = await openTestStore(':memory:')
    // The listener check comes FIRST, so with nothing wired the unknown id is
    // never looked up and nothing throws. That ordering is what keeps the
    // storage-only unit tests (and the window between construction and wiring)
    // from having to care about announcement at all.
    await expect((async () => await store.events.announceEvent(9999))()).resolves.toBeUndefined()

    await store.events.onAppend(() => {})
    await expect((async () => await store.events.announceEvent(9999))()).rejects.toThrow(
      /unknown podium event 9999/,
    )
    store.close()
  })
})

describe('EventsRepository: activateJanitorSteward (executed, never named)', () => {
  it('claims once, seeding both the cursor and its ownership watermark at the log head', async () => {
    const store = await openTestStore(':memory:')
    await store.events.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_1' })
    const head = await store.events.maxEventId()

    const claimed = await store.events.activateJanitorSteward()

    expect(claimed).toBe(head)
    expect(await store.events.getStewardState('cursor')).toBe(String(head))
    expect(await store.events.getStewardState('janitor-ownership-v1')).toBe(String(head))
    store.close()
  })

  it('a second activation returns undefined and does not rewind the cursor', async () => {
    const store = await openTestStore(':memory:')
    await store.events.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_1' })
    await store.events.activateJanitorSteward()
    // The steward has since advanced its own cursor. A second activation must
    // not reseed it at the (now much higher) head, or the events between are
    // skipped; and must not reseed at the old head either.
    await store.events.setStewardState('cursor', '1')
    await store.events.appendEvent({ ts: 't', kind: 'issue.created', subject: 'iss_2' })

    expect(await store.events.activateJanitorSteward()).toBeUndefined()
    expect(await store.events.getStewardState('cursor')).toBe('1')
    store.close()
  })

  it('seeds at 0 on an empty log', async () => {
    const store = await openTestStore(':memory:')
    expect(await store.events.activateJanitorSteward()).toBe(0)
    expect(await store.events.getStewardState('cursor')).toBe('0')
    store.close()
  })
})

/** A minimal well-formed `RuntimeEvent`, so the log rows parse on read. */
function runtimeStateEvent(seq: number) {
  return {
    t: 'state' as const,
    change: { kind: 'activity' as const },
    at: '2026-01-01T00:00:00Z',
    provenance: 'live' as const,
    cursor: { segmentId: 'runtime-segment', components: { seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  }
}
