/**
 * THE BOARD PROJECTION DRAIN RUNS A FIXED NUMBER OF STATEMENTS (POD-6216).
 *
 * Every accepted runtime event schedules a drain of the runtime log through the
 * board's durable cursor. The server-data bench put it at 40% of the server's
 * SQL wall: two list calls per event (the second always empty) and a cursor
 * write after every record, one write transaction per event even when the
 * record had no board effect. Pinned through the real gate and the real events
 * repository, one drain run over a backlog of 5 and of 100 records, with the
 * board port stubbed so only the drain's own statements count.
 *
 * - Records with a board effect (closing turns): 3 statements, the cursor
 *   read, one list call (a batch shorter than the limit reached the end of the
 *   log, so no empty call follows) and one cursor write through the last
 *   record. Before POD-6216 it was 3 + the backlog: 8 and 103.
 * - Records without one (activity states, most of the stream): 2, no cursor
 *   write. The write waits for a record with an effect or a full batch, so a
 *   restart replays fewer than one batch of them, doing nothing.
 */
import { asSessionId, type SessionId } from '@podium/model'
import type { RuntimeEvent } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { RUNTIME_EVENT_LOG_KIND } from '../../store/events'
import { openTestStore } from '../../test-support/open-test-store'
import { expectConstantStatements } from '../../test-support/statement-count'
import { RuntimeEventGate } from './runtime-event-gate'

interface Fixture {
  store: SessionStore
  gate: RuntimeEventGate
  lastId: number
  effects: number
}

const at = '2026-10-17T12:00:00.000Z'
const sessionId: SessionId = asSessionId('board-drain')

const runtime = { at, provenance: 'live', observerGeneration: 1, turnEpoch: 1 } as const

/** A live activity state: the board projects nothing for it. */
function activity(seq: number): RuntimeEvent {
  return { ...runtime, t: 'state', change: { kind: 'activity' }, cursor: { segmentId: 'runtime-segment', components: { seq } } }
}

/** A completed turn: the board's turn-end effect. */
function closing(seq: number): RuntimeEvent {
  return {
    ...runtime,
    t: 'turn',
    ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' },
    cursor: { segmentId: 'runtime-segment', components: { seq } },
  }
}

function fixtureOf(event: (seq: number) => RuntimeEvent) {
  return async (size: number): Promise<Fixture> => {
    const store = await openTestStore(':memory:')
    let lastId = 0
    for (let seq = 1; seq <= size; seq++) {
      lastId = await store.events.appendEvent(
        { ts: at, kind: RUNTIME_EVENT_LOG_KIND, subject: sessionId, payload: event(seq) },
        { announce: false },
      )
    }
    const unexpected = async (): Promise<void> => {
      throw new Error('the drain calls only the board')
    }
    const fixture: Fixture = { store, lastId, effects: 0, gate: undefined as unknown as RuntimeEventGate }
    fixture.gate = new RuntimeEventGate({
      events: store.events,
      session: () => undefined,
      persist: unexpected,
      write: unexpected,
      board: async () => {
        fixture.effects++
      },
      delivery: unexpected,
      now: () => Date.parse(at),
    })
    return fixture
  }
}

describe('board projection drain statement count (POD-6216)', () => {
  it('drains records with an effect with one list call and one cursor write', async () => {
    await expectConstantStatements<Fixture>(
      {
        name: 'board projection drain, records with an effect',
        sizes: [5, 100],
        setup: fixtureOf(closing),
        target: (f) => f.store,
        run: async (f) => await f.gate.replayBoardProjection(),
        check: async (_result, f, size) => {
          expect(f.effects).toBe(size)
          expect(await f.store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBe(f.lastId)
        },
        teardown: async (f) => await f.store.close(),
      },
      3,
    )
  })

  it('drains records without an effect with one list call and no cursor write', async () => {
    await expectConstantStatements<Fixture>(
      {
        name: 'board projection drain, records without an effect',
        sizes: [5, 100],
        setup: fixtureOf(activity),
        target: (f) => f.store,
        run: async (f) => await f.gate.replayBoardProjection(),
        check: async (_result, f) => {
          expect(f.effects).toBe(0)
          expect(await f.store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBe(0)
        },
        teardown: async (f) => await f.store.close(),
      },
      2,
    )
  })
})
