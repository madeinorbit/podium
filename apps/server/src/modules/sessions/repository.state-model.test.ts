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
 * HOW AN INTERLEAVING IS PRODUCED HERE. The async ledger fixture awaits the
 * row write and a one-shot hook before returning or rejecting the commit.
 * A racing hook awaits the winning persist before the losing commit rejects,
 * so rollback must observe the winner's installed baseline. Tests await every
 * persist/write and assert rejected promises, matching the repository contract.
 *
 * The ports object follows the idiom of `repository.single-flight.test.ts` next
 * door: only the ports this path touches are real.
 */

import { asMachineId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { asCapabilityRef, asDeviceId } from '@podium/protocol'
import { SessionDaemonLifecycle } from './daemon-lifecycle'
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
  const upserted: { id: string; title: string | null; name: string | null }[] = []
  let during: { fn: () => void | Promise<void>; when: 'before' | 'after' } | null = null
  let fail = false
  const repo = new SessionRepository({
    sessions,
    store: {
      sessions: {
        upsertSession: (row: { id: string; title: string | null; name: string | null }) =>
          upserted.push({ id: row.id, title: row.title, name: row.name }),
      },
    },
    ledger: {
      commit: async ({ write }: { write: () => Promise<void> }) => {
        const hook = during
        during = null
        const shouldFail = fail
        fail = false
        if (hook?.when === 'before') await hook.fn()
        await write()
        if (hook?.when === 'after') await hook.fn()
        if (shouldFail) throw new Error('commit failed')
        return { changes: [] }
      },
      capture: () => [],
    },
    view: {
      wire: (s: Session, _p: unknown, _m: unknown, d: { title: string; name: string } = s) => ({
        sessionId: s.sessionId,
        title: d.title,
        name: d.name,
      }),
    },
    now: () => Date.now(),
    broadcastSessions: vi.fn(),
    flushBroadcasts: vi.fn(),
    runScheduledBroadcast: vi.fn(),
    listSessions: vi.fn(async () => []),
  } as never)
  return {
    repo,
    session,
    upserted,
    duringNextWrite(fn: () => void | Promise<void>, when: 'before' | 'after' = 'after') {
      during = { fn, when }
    },
    failNextWrite() {
      fail = true
    },
  }
}

describe('the committed baseline is the draft, not a later re-capture', () => {
  it('installs what was written, even when the live object moves during the write', async () => {
    // Re-reading the session AFTER the commit — which is what this did before
    // POD-3259 — bakes whatever changed during the write into the baseline. The
    // next rollback then restores a state no commit ever saw.
    const f = fixture()
    f.session.title = 'written title'
    f.duringNextWrite(() => {
      f.session.title = 'changed mid-write'
    })
    await f.repo.persist(f.session)

    expect(f.upserted).toEqual([{ id: 'model-1', title: 'written title', name: null }])
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('written title')
  })

  it('does not move the baseline until the commit returns', async () => {
    const f = fixture()
    await f.repo.persist(f.session)
    f.session.title = 'second write'

    let observed: string | undefined
    f.duringNextWrite(() => {
      observed = f.repo.committedDurableState(f.session.sessionId)?.title
    })
    await f.repo.persist(f.session)

    expect(observed, 'a reader inside the span sees the previous baseline').toBe(
      'committed title',
    )
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('second write')
  })
})

describe('a rollback racing a successful persist', () => {
  it('restores the LATEST baseline, so the winner survives the loser rolling back', async () => {
    // spec §2.5 item 9's session half, and the case that settles which baseline
    // a rollback restores. The tempting answer — stand down when another
    // persist committed while this one was in flight — loses here: the failed
    // write's own uncommitted fields would stay on the live object. Restoring
    // the latest committed state undoes them AND keeps the winner's.
    const f = fixture()
    await f.repo.persist(f.session) // baseline: 'committed title'

    f.session.title = 'loser'
    f.duringNextWrite(async () => {
      // The winner runs inside the loser's span and commits first.
      f.session.title = 'winner'
      await f.repo.persist(f.session)
    })
    f.failNextWrite()
    await expect(f.repo.persist(f.session)).rejects.toThrow('commit failed')

    expect(f.session.title, 'the winner survives the loser rolling back').toBe('winner')
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('winner')
  })

  it("a winner writes only its OWN fields, not the loser's uncommitted ones", async () => {
    // THE CASE POD-3330 EXISTS FOR, and until POD-3330 this test stood here as a
    // named CHARACTERIZATION of the opposite behaviour.
    //
    // POD-3259 converted the SNAPSHOT half of this registry: the baseline is the
    // draft that was written, and a rollback restores the latest baseline. The
    // MUTATION half is what this pins. Writer A sets `name`, writer B sets
    // `title` and commits inside A's span, and A then fails. While both writers
    // assigned onto the LIVE `Session`, B's draft was captured from an object
    // already carrying A's uncommitted `name`: B durably wrote a field nobody
    // asked it to write, and A's rollback restored it because it had become part
    // of the committed baseline. Now each writer mutates its OWN draft, so B's
    // write is B's alone and A's rollback has nothing of A's to put back.
    //
    // Two writers touching DIFFERENT fields is what makes this visible; on the
    // same field the two behaviours are indistinguishable, which is why it took
    // this arm to find it.
    const f = fixture()
    await f.repo.persist(f.session) // baseline: title 'committed title', name ''

    f.duringNextWrite(async () => {
      // The winner runs inside the loser's span and commits first.
      await f.repo.write(f.session, (draft) => {
        draft.title = 'winner'
      })
    })
    f.failNextWrite()
    await expect(
      f.repo.write(f.session, (draft) => {
        draft.name = 'loser name'
      }),
    ).rejects.toThrow('commit failed')

    expect(f.session.title, "the winner's field survives").toBe('winner')
    expect(
      f.session.name,
      "the loser never committed, so nothing of the loser's is on the session",
    ).toBe('')
    expect(
      f.repo.committedDurableState(f.session.sessionId)?.name,
      'and the committed baseline never carried it either',
    ).toBe('')
  })

  it('still rolls the durable half back when nothing else committed', async () => {
    // The arm the case above does not walk: with no racing write, the rollback
    // must still happen, or the guard would be indistinguishable from deleting
    // the restore altogether.
    const f = fixture()
    await f.repo.persist(f.session) // baseline: 'committed title'

    f.session.title = 'never committed'
    f.failNextWrite()
    await expect(f.repo.persist(f.session)).rejects.toThrow('commit failed')

    expect(f.session.title).toBe('committed title')
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('committed title')
  })
})

describe('a drafted write is invisible until its commit returns [POD-3330]', () => {
  it('the row and the declared change describe the DRAFT, not the live object', async () => {
    // The row is built from the draft, so a write that assigns inside the
    // TRANSACTION has to assign into the draft too — that is what the ref
    // allocation, the observation rebind and the runtime state projection all
    // do. If `toRow` read the live object instead, this row would be written
    // with the previous name and nothing would fail anywhere else.
    const f = fixture()
    await f.repo.write(
      f.session,
      (draft) => {
        draft.title = 'drafted title'
      },
      // stands in for an allocation the store decides inside the span
      undefined,
    )

    expect(f.upserted).toEqual([{ id: 'model-1', title: 'drafted title', name: null }])
  })

  it('a reader inside the span still sees the previous state on the live session', async () => {
    // The whole point of the draft: between the write and its commit, the
    // shared object says what the last commit said. A second writer entering
    // here — which is what the interleaving above does — captures that, and not
    // this writer's half-finished change.
    const f = fixture()
    await f.repo.persist(f.session)

    let observedLive: string | undefined
    f.duringNextWrite(() => {
      observedLive = f.session.title
    })
    await f.repo.write(f.session, (draft) => {
      draft.title = 'in flight'
    })

    expect(observedLive, 'the live object still carried the committed title').toBe(
      'committed title',
    )
    expect(f.session.title, 'and carries the new one once the commit returned').toBe('in flight')
  })
})

describe('the live terminal half may change while persistence is awaiting', () => {
  it('is not rolled back with the durable metadata', async () => {
    // The field classification, asserted rather than only documented: activity
    // recorded while the write was open survives the rollback that undoes the
    // metadata beside it.
    const f = fixture()
    await f.repo.persist(f.session)

    f.session.title = 'never committed'
    f.duringNextWrite(() => {
      f.session.terminal.recordResumeActivity()
    })
    f.failNextWrite()
    await expect(f.repo.persist(f.session)).rejects.toThrow('commit failed')

    expect(f.session.title, 'the durable half rolled back').toBe('committed title')
    expect(
      f.session.terminal.activityDirty,
      'the live half kept what happened during the write',
    ).toBe(true)
  })
})


describe('driver columns participate in draft commits', () => {
  it.each(['selection', 'bind', 'spawn error'] as const)(
    '%s stays invisible until commit and survives a failed commit unchanged',
    async (operation) => {
      const session = makeSession()
      session.selectedDriverId = 'opencode-server'
      const sessions = new Map([[session.sessionId, session]])
      let fail = false
      let inspect = () => {}
      let row = session.toRow()
      const repo = new SessionRepository({
        sessions,
        store: { sessions: { upsertSession: (next: typeof row) => { row = next } } },
        ledger: {
          commit: async ({ write }: { write: () => Promise<void> }) => {
            const previous = row
            await write()
            inspect()
            if (fail) {
              row = previous
              throw new Error('commit failed')
            }
            return { changes: [] }
          },
        },
        view: { wire: () => ({}) },
      } as never)
      await repo.persist(session)
      const lifecycle = new SessionDaemonLifecycle({
        sessions,
        persist: repo.persist.bind(repo),
        write: repo.write.bind(repo),
        broadcastSessions: vi.fn(),
        emitSessionExited: vi.fn(),
        autoContinue: { onSessionLive: vi.fn() },
        inbox: { markSessionBound: vi.fn(), drain: vi.fn() },
      } as never)
      const principal = {
        kind: 'machine' as const,
        machine: MACHINE,
        device: asDeviceId('driver-test'),
        capability: asCapabilityRef('driver-test'),
      }
      const send = () => lifecycle.handle(principal, operation === 'spawn error'
        ? { type: 'spawnError', sessionId: session.sessionId, message: 'refused' }
        : operation === 'selection'
          ? { type: 'driverSelected', sessionId: session.sessionId, driverId: 'generic-pty' }
          : {
              type: 'bind', sessionId: session.sessionId, driverId: 'generic-pty',
              requestedDriverId: 'opencode-server', cmd: 'agent', cwd: '/work',
              agentKind: 'claude-code', geometry: { cols: 80, rows: 24 },
            })
      const expected = operation === 'spawn error' ? undefined : 'generic-pty'
      inspect = () => {
        expect(session.selectedDriverId).toBe('opencode-server')
        expect(session.requestedDriverId).toBeUndefined()
        expect(row.selectedDriverId).toBe(expected ?? null)
        expect(row.requestedDriverId).toBe(operation === 'bind' ? 'opencode-server' : null)
      }
      fail = true
      await expect(send()).rejects.toThrow('commit failed')
      expect(session.selectedDriverId).toBe('opencode-server')
      expect(session.requestedDriverId).toBeUndefined()
      expect(row.selectedDriverId).toBe('opencode-server')
      expect(row.requestedDriverId).toBeNull()
      fail = false
      await send()
      expect(session.selectedDriverId).toBe(expected)
      expect(session.requestedDriverId).toBe(operation === 'bind' ? 'opencode-server' : undefined)
    },
  )
})

describe('two successful overlapping writes of different fields [POD-3720]', () => {
  /**
   * Sibling operations, not a nested-in-span writer. Both `write()` calls cut
   * their drafts before either commit returns, which is the lost-update the
   * whole-state draft still permits after POD-3330 and POD-3717: each caller
   * awaits its own persist, and two awaits still interleave.
   */
  function overlapFixture() {
    const session = makeSession()
    const sessions = new Map([[session.sessionId, session]])
    const upserted: { id: string; title: string | null; name: string | null }[] = []
    let hold = false
    const waiting: Array<() => void> = []
    let inFlight = 0
    let maxInFlight = 0
    const repo = new SessionRepository({
      sessions,
      store: {
        sessions: {
          upsertSession: (row: { id: string; title: string | null; name: string | null }) =>
            upserted.push({ id: row.id, title: row.title, name: row.name }),
        },
      },
      ledger: {
        commit: async ({ write }: { write: () => Promise<void> }) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          try {
            if (hold) await new Promise<void>((resolve) => waiting.push(resolve))
            await write()
            return { changes: [] }
          } finally {
            inFlight -= 1
          }
        },
        capture: () => [],
      },
      view: {
        wire: (s: Session, _p: unknown, _m: unknown, d: { title: string; name: string } = s) => ({
          sessionId: s.sessionId,
          title: d.title,
          name: d.name,
        }),
      },
      now: () => Date.now(),
      broadcastSessions: vi.fn(),
      flushBroadcasts: vi.fn(),
      runScheduledBroadcast: vi.fn(),
      listSessions: vi.fn(async () => []),
    } as never)
    return {
      repo,
      session,
      upserted,
      holdNextCommits() {
        hold = true
      },
      releaseCommits() {
        hold = false
        for (const resolve of waiting) resolve()
        waiting.length = 0
      },
      /** Let exactly one held commit through, keeping the hold on for the rest. */
      releaseOne() {
        waiting.shift()?.()
      },
      /** Spin microtasks until `n` commits are parked, so ordering is not guessed at. */
      async untilWaiting(n: number) {
        for (let i = 0; i < 200 && waiting.length < n; i += 1) await Promise.resolve()
        expect(waiting.length, `expected ${n} parked commit(s)`).toBe(n)
      },
      maxInFlight: () => maxInFlight,
    }
  }

  it('keeps both fields when two write() calls overlap on one session', async () => {
    const f = overlapFixture()
    await f.repo.persist(f.session)
    f.holdNextCommits()

    const first = f.repo.write(f.session, (draft) => {
      draft.name = 'A name'
    })
    const second = f.repo.write(f.session, (draft) => {
      draft.title = 'B title'
    })
    f.releaseCommits()
    await Promise.all([first, second])

    expect(f.session.name, "the first write's field is still on the session").toBe('A name')
    expect(f.session.title, "the second write's field is still on the session").toBe('B title')
  })

  it('keeps both fields when two persistDrafts overlap on already-cut drafts', async () => {
    // persistDraft-direct: both drafts are cut from the same live state, then
    // persisted. A write() lease that recuts inside the lock does not cover
    // this; the stale whole-state draft has to overlay only what it changed.
    const f = overlapFixture()
    await f.repo.persist(f.session)
    const firstDraft = f.repo.draft(f.session)
    firstDraft.name = 'A name'
    const secondDraft = f.repo.draft(f.session)
    secondDraft.title = 'B title'
    f.holdNextCommits()
    const first = f.repo.persistDraft(f.session, firstDraft)
    const second = f.repo.persistDraft(f.session, secondDraft)
    f.releaseCommits()
    await Promise.all([first, second])

    expect(f.session.name, "the first draft's field is still on the session").toBe('A name')
    expect(f.session.title, "the second draft's field is still on the session").toBe('B title')
  })

  it('still serializes a third write arriving after the first drains its tail', async () => {
    // THE CASE THE TWO-WRITER TESTS CANNOT SEE. Draining the tail when the
    // first write settles must not clear an entry a SECOND writer has already
    // queued behind it — a third writer would then find no tail and run
    // concurrently with the second. Asserted on the lease's own guarantee
    // rather than on a lost field: the overlay resolves inside the commit, so
    // whether an overlapping write loses a value depends on interleaving, but
    // whether it overlaps at all does not.
    const f = overlapFixture()
    await f.repo.persist(f.session)
    f.holdNextCommits()

    const first = f.repo.write(f.session, (draft) => {
      draft.name = 'A name'
    })
    await f.untilWaiting(1)
    const second = f.repo.write(f.session, (draft) => {
      draft.title = 'B title'
    })
    f.releaseOne()
    await first
    await f.untilWaiting(1)

    // Arrives once the first write has settled and drained.
    const third = f.repo.write(f.session, (draft) => {
      draft.name = 'C name'
    })
    f.releaseCommits()
    await Promise.all([second, third])

    expect(f.maxInFlight(), 'one session commits one write at a time').toBe(1)
    expect(f.session.title, "the second write's field survived the third").toBe('B title')
    expect(f.session.name, 'the third write is the last name writer').toBe('C name')
  })

  it('drops the write tail once a session has no writes queued behind it', async () => {
    // The tail is keyed by every session ever written, and unlike the other
    // per-session maps here nothing removes a session from it. Left alone it
    // grows for the life of the process. This case pins the drain; the
    // three-writer case above pins the identity check that makes the drain
    // safe. Neither covers the other.
    const f = overlapFixture()
    const tail = (f.repo as unknown as { sessionWriteTail: Map<string, Promise<void>> })
      .sessionWriteTail

    const first = f.repo.write(f.session, (draft) => {
      draft.name = 'A name'
    })
    const second = f.repo.write(f.session, (draft) => {
      draft.title = 'B title'
    })
    expect(tail.has(f.session.sessionId), 'a write in flight holds its tail').toBe(true)
    await Promise.all([first, second])
    await Promise.resolve()

    expect(tail.has(f.session.sessionId), 'the settled tail is dropped').toBe(false)
    expect(tail.size, 'no other session leaked an entry').toBe(0)
  })
})
