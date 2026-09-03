/**
 * THE SESSION REGISTRY'S MUTABLE-STATE MODEL [POD-3259, spec §3.6].
 *
 * A `Session` is process-owned mutable state with two halves, and the model for
 * this registry is the line between them:
 *
 *  - the DURABLE METADATA half — everything `captureDurableState()` returns — is
 *    snapshotted before the write that persists it, and that snapshot becomes
 *    the committed baseline once the commit returns. It is what a rollback puts
 *    back, and it may not be treated as settled while a persist is in flight.
 *  - the LIVE TERMINAL half — frames, the cursor, geometry, the activity
 *    counters, and the four `SessionVolatileField`s a rollback preserves — MAY
 *    change while persistence is awaiting, and does: a pty does not stop
 *    producing output because a metadata row is being written.
 *
 * HOW AN INTERLEAVING IS PRODUCED HERE. `persist` is synchronous top to bottom,
 * so there is no await to park on. The ledger port is the seam: re-entering the
 * repository from inside an open `commit` is the window an awaited commit will
 * open, and it is the only one available today. Same technique, and same
 * reason, as POD-3258's guard tests.
 *
 * The ports object follows the idiom of `repository.single-flight.test.ts` next
 * door: only the ports this path touches are real.
 */

import { asMachineId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionRepository } from './repository'
import { Session } from './session'

const MACHINE = asMachineId('model-machine')

const makeSession = (): Session =>
  new Session({
    sessionId: asSessionId('model-1'),
    durableLabel: 'podium-model-1',
    agentKind: 'claude-code',
    cwd: '/work',
    title: 'committed title',
    origin: { kind: 'spawn' },
    createdAt: '2026-09-03T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: MACHINE,
    toDaemon: vi.fn(),
  })

function fixture() {
  const session = makeSession()
  const sessions = new Map([[session.sessionId, session]])
  const upserted: { id: string; title: string | null }[] = []
  let during: { fn: () => void; when: 'before' | 'after' } | null = null
  let fail = false
  const repo = new SessionRepository({
    sessions,
    store: {
      sessions: {
        upsertSession: (row: { id: string; title: string | null }) =>
          upserted.push({ id: row.id, title: row.title }),
      },
    },
    ledger: {
      commit: ({ write }: { write: () => void }) => {
        const hook = during
        during = null
        const shouldFail = fail
        fail = false
        if (hook?.when === 'before') hook.fn()
        write()
        if (hook?.when === 'after') hook.fn()
        if (shouldFail) throw new Error('commit failed')
        return { changes: [] }
      },
      capture: () => [],
    },
    view: { wire: (s: Session) => ({ sessionId: s.sessionId, title: s.title }) },
    now: () => Date.now(),
    broadcastSessions: vi.fn(),
    flushBroadcasts: vi.fn(),
    runScheduledBroadcast: vi.fn(),
    listSessions: vi.fn(() => []),
  } as never)
  return {
    repo,
    session,
    upserted,
    duringNextWrite(fn: () => void, when: 'before' | 'after' = 'after') {
      during = { fn, when }
    },
    failNextWrite() {
      fail = true
    },
  }
}

describe('the committed baseline is the draft, not a later re-capture', () => {
  it('installs what was written, even when the live object moves during the write', () => {
    // Re-reading the session AFTER the commit — which is what this did before
    // POD-3259 — bakes whatever changed during the write into the baseline. The
    // next rollback then restores a state no commit ever saw.
    const f = fixture()
    f.session.title = 'written title'
    f.duringNextWrite(() => {
      f.session.title = 'changed mid-write'
    })
    f.repo.persist(f.session)

    expect(f.upserted).toEqual([{ id: 'model-1', title: 'written title' }])
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('written title')
  })

  it('does not move the baseline until the commit returns', () => {
    const f = fixture()
    f.repo.persist(f.session)
    f.session.title = 'second write'

    let observed: string | undefined
    f.duringNextWrite(() => {
      observed = f.repo.committedDurableState(f.session.sessionId)?.title
    })
    f.repo.persist(f.session)

    expect(observed, 'a reader inside the span sees the previous baseline').toBe(
      'committed title',
    )
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('second write')
  })
})

describe('a rollback racing a successful persist', () => {
  it('restores the LATEST baseline, so the winner survives the loser rolling back', () => {
    // spec §2.5 item 9's session half, and the case that settles which baseline
    // a rollback restores. The tempting answer — stand down when another
    // persist committed while this one was in flight — loses here: the failed
    // write's own uncommitted fields would stay on the live object. Restoring
    // the latest committed state undoes them AND keeps the winner's.
    const f = fixture()
    f.repo.persist(f.session) // baseline: 'committed title'

    f.session.title = 'loser'
    f.duringNextWrite(() => {
      // The winner runs inside the loser's span and commits first.
      f.session.title = 'winner'
      f.repo.persist(f.session)
    })
    f.failNextWrite()
    expect(() => f.repo.persist(f.session)).toThrow('commit failed')

    expect(f.session.title, 'the winner survives the loser rolling back').toBe('winner')
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('winner')
  })

  it('CHARACTERIZATION: a winner still writes the loser\'s uncommitted field (POD-3330)', () => {
    // THIS PINS A DEFECT, DELIBERATELY, and it is the failing case POD-3330
    // exists to fix. Flip the assertions there rather than deleting this.
    //
    // POD-3259 converted the SNAPSHOT half of this registry: the baseline is the
    // draft that was written, and the rollback restores the latest baseline. The
    // MUTATION half is untouched — every write path still assigns onto the LIVE
    // `Session` before its commit — so two writers share one object. Here writer
    // A sets `name`, writer B sets `title` and commits inside A's span, and B's
    // draft is captured from an object already carrying A's uncommitted `name`.
    // B therefore durably writes a field nobody asked it to write, and A's
    // rollback restores it because it is now part of the committed baseline.
    //
    // Two writers touching DIFFERENT fields is what makes this visible; on the
    // same field the two behaviours are indistinguishable, which is why it took
    // this arm to find it.
    const f = fixture()
    f.repo.persist(f.session) // baseline: title 'committed title', name ''

    f.session.name = 'loser name'
    f.duringNextWrite(() => {
      f.session.title = 'winner'
      f.repo.persist(f.session)
    })
    f.failNextWrite()
    expect(() => f.repo.persist(f.session)).toThrow('commit failed')

    expect(f.session.title, "the winner's field survives — correct today").toBe('winner')
    expect(
      f.session.name,
      "POD-3330: should be '', because the loser never committed. The winner " +
        'captured it off the shared live object and made it durable.',
    ).toBe('loser name')
  })

  it('still rolls the durable half back when nothing else committed', () => {
    // The arm the case above does not walk: with no racing write, the rollback
    // must still happen, or the guard would be indistinguishable from deleting
    // the restore altogether.
    const f = fixture()
    f.repo.persist(f.session) // baseline: 'committed title'

    f.session.title = 'never committed'
    f.failNextWrite()
    expect(() => f.repo.persist(f.session)).toThrow('commit failed')

    expect(f.session.title).toBe('committed title')
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('committed title')
  })
})

describe('the live terminal half may change while persistence is awaiting', () => {
  it('is not rolled back with the durable metadata', () => {
    // The field classification, asserted rather than only documented: activity
    // recorded while the write was open survives the rollback that undoes the
    // metadata beside it.
    const f = fixture()
    f.repo.persist(f.session)

    f.session.title = 'never committed'
    f.duringNextWrite(() => {
      f.session.terminal.recordResumeActivity()
    })
    f.failNextWrite()
    expect(() => f.repo.persist(f.session)).toThrow('commit failed')

    expect(f.session.title, 'the durable half rolled back').toBe('committed title')
    expect(
      f.session.terminal.activityDirty,
      'the live half kept what happened during the write',
    ).toBe(true)
  })
})
