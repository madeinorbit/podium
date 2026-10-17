/**
 * THE BOARD PROJECTION DRAIN RUNS A FIXED NUMBER OF STATEMENTS (POD-6216).
 *
 * Every accepted runtime event schedules a drain of the runtime log through the
 * board's durable cursor. The server-data bench put it at 40% of the server's
 * SQL wall: two list calls per event (the second always empty) and a cursor
 * write after every record, one write transaction per event even when the
 * record had no board effect. Pinned through the real gate and the real events
 * repository, one drain run over a backlog of 5 and of 100 records that have no
 * board effect, so only the drain's own statements count.
 *
 * 3 statements: the cursor read, one list call (a batch shorter than the limit
 * reached the end of the log, so no empty call follows), and one cursor write
 * through the last record. Before POD-6216 it was 3 + the backlog: 8 and 103.
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
}

const at = '2026-10-17T12:00:00.000Z'
const sessionId: SessionId = asSessionId('board-drain')

/** A live activity state: the board projects nothing for it. */
function activity(seq: number): RuntimeEvent {
  return {
    t: 'state',
    change: { kind: 'activity' },
    at,
    provenance: 'live',
    cursor: { segmentId: 'runtime-segment', components: { seq } },
    observerGeneration: 1,
    turnEpoch: 1,
  }
}

async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  let lastId = 0
  for (let seq = 1; seq <= size; seq++) {
    lastId = await store.events.appendEvent(
      { ts: at, kind: RUNTIME_EVENT_LOG_KIND, subject: sessionId, payload: activity(seq) },
      { announce: false },
    )
  }
  const unexpected = async (): Promise<void> => {
    throw new Error('an activity state has no board effect')
  }
  const gate = new RuntimeEventGate({
    events: store.events,
    session: () => undefined,
    persist: unexpected,
    write: unexpected,
    board: unexpected,
    delivery: unexpected,
    now: () => Date.parse(at),
  })
  return { store, gate, lastId }
}

describe('board projection drain statement count (POD-6216)', () => {
  it('drains a backlog with one list call and one cursor write', async () => {
    await expectConstantStatements<Fixture>(
      {
        name: 'board projection drain',
        sizes: [5, 100],
        setup: fixture,
        target: (f) => f.store,
        run: async (f) => await f.gate.replayBoardProjection(),
        check: async (_result, f) => {
          expect(await f.store.events.runtimeEventProjectionCursor('runtime.board.v1')).toBe(f.lastId)
        },
        teardown: async (f) => await f.store.close(),
      },
      3,
    )
  })
})
