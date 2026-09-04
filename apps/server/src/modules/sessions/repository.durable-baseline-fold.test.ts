/**
 * THE SESSION'S COMMITTED DURABLE BASELINE IS A COMMIT APPLICATION, NOT A
 * SAVEPOINT RELEASE (POD-3361, spec §3.3 mechanism 1).
 *
 * `SessionRepository.persist` writes through the ledger, whose `transact`
 * degrades to a SAVEPOINT whenever the caller already has a span open —
 * `IssueAttachOrchestrator` wraps a whole attach in one, and the write funnel
 * opens one around every `mutateSessionMeta`. Releasing that savepoint is not a
 * commit: the enclosing span can still roll back and take the sessions row with
 * it. Installing the draft as "the committed baseline" at release therefore
 * makes process memory claim a state the database threw away — and the next
 * failed persist restores the live `Session` to it, which is the "state no
 * commit ever saw" the persist path exists to prevent.
 *
 * WHAT THESE TESTS ASSERT ON, deliberately: the baseline itself, and the live
 * object a rollback restores from it. The store, the ledger and the span
 * machinery are REAL — the ports object carries only what this path touches —
 * and nothing between the rollback and the assertion reloads the store,
 * re-reads the row or re-captures a baseline. A fixture that did any of those
 * would hide the state these tests exist to observe.
 */

import { asMachineId, asSessionId } from '@podium/model'
import { Ledger } from '@podium/sync'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { applyAfterCommit, spanOpen } from '../../store/executor/synchronous-span'
import { SessionRepository } from './repository'
import { Session } from './session'

const MACHINE = asMachineId('fold-machine')

async function fixture() {
  const store = await openTestStore(':memory:')
  const session = new Session({
    sessionId: asSessionId('fold-1'),
    durableLabel: 'podium-fold-1',
    agentKind: 'claude-code',
    cwd: '/work',
    title: 'committed title',
    origin: { kind: 'spawn' },
    createdAt: '2026-09-04T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: MACHINE,
    toDaemon: vi.fn(),
  })
  const sessions = new Map([[session.sessionId, session]])
  const ledger = new Ledger({
    repo: store.sync,
    now: () => 1_000,
    transact: (fn) => store.transact(fn),
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
  })
  const repo = new SessionRepository({
    sessions,
    store,
    ledger,
    // The composition root's wiring (`session-wiring.ts`), which is the whole
    // subject here.
    applyCommit: { spanOpen, onCommit: applyAfterCommit },
    view: { wire: (s: Session) => ({ sessionId: s.sessionId, title: s.title }) },
    now: () => Date.now(),
    broadcastSessions: vi.fn(),
    flushBroadcasts: vi.fn(),
    runScheduledBroadcast: vi.fn(),
    listSessions: vi.fn(() => []),
  } as never)
  return { store, session, repo }
}

const rowTitle = (store: SessionStore, id: string): string | null | undefined =>
  store.sessions.loadSessions().find((row) => row.id === id)?.title

describe('the session durable baseline waits for the outermost commit (POD-3361)', () => {
  it('drops a baseline the enclosing span rolled back', async () => {
    const f = await fixture()
    f.repo.persist(f.session) // no span open: 'committed title' installs at once

    f.session.title = 'rolled back'
    expect(() =>
      f.store.transact(() => {
        // A NESTED persist: the ledger's span degrades to a savepoint and
        // releases when this returns.
        f.repo.persist(f.session)
        // …and the enclosing span fails afterwards.
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    // The database forgot the row write.
    expect(rowTitle(f.store, 'fold-1')).toBe('committed title')
    // THE MECHANISM: so must the baseline, or it reports a state no commit kept.
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('committed title')
  })

  it('does not restore the live session to a state the rollback threw away', async () => {
    // The second consequence, and the reachable one: after the rollback the
    // NEXT failed persist restores the live object from the baseline. If the
    // baseline kept the rolled-back draft, the live session is restored to a
    // state no commit ever saw — and the next successful persist writes it back.
    const f = await fixture()
    f.repo.persist(f.session)

    f.session.title = 'rolled back'
    expect(() =>
      f.store.transact(() => {
        f.repo.persist(f.session)
        throw new Error('enclosing span failed')
      }),
    ).toThrow('enclosing span failed')

    f.session.title = 'doomed'
    expect(() =>
      f.repo.persist(f.session, () => {
        throw new Error('write failed')
      }),
    ).toThrow('write failed')

    expect(f.session.title).toBe('committed title')
  })

  it('still installs the baseline when the enclosing span commits', async () => {
    const f = await fixture()
    f.repo.persist(f.session)

    f.session.title = 'kept'
    f.store.transact(() => {
      f.repo.persist(f.session)
    })

    expect(rowTitle(f.store, 'fold-1')).toBe('kept')
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('kept')
  })

  it('a second nested persist in the same span sees the first one (the in-window reader)', async () => {
    // WHY THIS TEST EXISTS. Deferring is only free if nothing reads the baseline
    // between the savepoint release and the outermost commit. Something does:
    // `persist`'s own catch arm restores the live object from it. A bare
    // deferral would restore the state from BEFORE the span — undoing the first
    // nested write's fields on a live object whose row the enclosing span may
    // still commit, so the next persist would write the stale title back over
    // it. The staged layer keeps that reader seeing what it sees today.
    const f = await fixture()
    f.repo.persist(f.session)

    f.store.transact(() => {
      f.session.title = 'first nested write'
      f.repo.persist(f.session)

      f.session.title = 'doomed'
      expect(() =>
        f.repo.persist(f.session, () => {
          throw new Error('write failed')
        }),
      ).toThrow('write failed')

      // The span's own earlier write, not the state from before the span.
      expect(f.session.title).toBe('first nested write')
    })

    expect(rowTitle(f.store, 'fold-1')).toBe('first nested write')
    expect(f.repo.committedDurableState(f.session.sessionId)?.title).toBe('first nested write')
  })
})
