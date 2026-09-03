/**
 * THE STICKY POLICY SURVIVES A SERVER RESTART — through SQLite, not through a
 * `structuredClone` (POD-3081 review).
 *
 * The first version of this evidence drove `captureDurableState` /
 * `restoreDurableState`, and the reviewer was right that it proves nothing about
 * a reload: that pair is the volatile-capture path, both halves live in one
 * process, and it would keep passing with no column, no migration, no SQL and no
 * hydration behind it. Which is exactly what it was passing over.
 *
 * So this drives the whole durable path and nothing simulated:
 *
 *   Session.setRequestedModel  →  toRow()  →  real INSERT into a MIGRATED
 *   database  →  getSession() back out of SQLite  →  sessionFromStoredRow(),
 *   the same hydration the repository runs at boot  →  a live Session again.
 *
 * A missing column, a missed placeholder in the 55-wide upsert, a forgotten
 * mapSession decode, or a forgotten spread in the hydration each break a
 * different assertion below.
 *
 * WHY THIS PAIR IS DURABLE AT ALL, since its sibling `observedModel` is not: the
 * observed pair is re-learned from the transcript tail on reattach. Nothing
 * re-learns a REQUEST — no harness stamps "the operator asked for this" anywhere
 * a reader could find it — so left transient it lived exactly as long as the
 * server process, and the session came back showing the model it was LAUNCHED
 * with while its driver, whose own journal did survive, answered as the one it
 * was configured to.
 */

import { asMachineId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createBunStoreExecutor } from '../../store/executor'
import { SessionsRepository } from '../../store/sessions'
import type { SessionRow } from '../../store/types'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { SessionRepository } from './repository'
import { Session } from './session'

/** The stored row, asserted present rather than assumed. A `getSession` that
 *  answered undefined would otherwise reach `sessionFromStoredRow` as a
 *  non-null assertion and fail somewhere less informative than here. */
const storedRow = (row: SessionRow | undefined): SessionRow => {
  expect(row, 'the session was not written to the database at all').toBeDefined()
  return row as SessionRow
}

const MACHINE = asMachineId('reload-machine')
const SID = asSessionId('session-reload-configure')

/** A session launched on one model, as a spawn would leave it. */
const launched = (): Session =>
  new Session({
    sessionId: SID,
    durableLabel: 'podium-session-reload-configure',
    agentKind: 'codex',
    cwd: '/w',
    title: 'w',
    origin: { kind: 'spawn' },
    createdAt: '2026-08-28T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: MACHINE,
    model: 'gpt-5-codex',
    effort: 'medium',
    toDaemon: vi.fn(),
  })

/** The repository, for its hydration function only — the ports it does not use
 *  here are not stubbed into existence. */
const hydrator = (): SessionRepository =>
  new SessionRepository({
    sessions: new Map(),
    ledger: { capture: vi.fn(() => []) },
    view: { wire: vi.fn() },
    now: () => Date.now(),
    runScheduledBroadcast: vi.fn(),
    broadcastSessions: vi.fn(),
    flushBroadcasts: vi.fn(),
    listSessions: vi.fn(() => []),
    toPtyInput: vi.fn(),
    toMachine: vi.fn(),
  } as never)

describe('a runtime model change survives a server restart', () => {
  it('round-trips through the sessions table and comes back on the rehydrated session', () => {
    const db = openMigratedTestDatabase()
    try {
      const store = new SessionsRepository(createBunStoreExecutor({ database: db }))
      const session = launched()
      expect(session.setRequestedModel({ model: 'gpt-5.1-codex-max', effort: 'high' })).toBe(true)

      store.upsertSession(session.toRow())

      // (1) IT REACHED THE DISK. A missing column or a mis-counted placeholder in
      // the 55-wide upsert fails here, against real SQLite and the real migration
      // chain rather than an object that remembered itself.
      const stored = store.getSession(SID)
      expect(stored).toMatchObject({
        requestedModel: 'gpt-5.1-codex-max',
        requestedEffort: 'high',
        // …and the LAUNCH pair is still its own fact on the same row. Collapsing
        // the two would make this row pass every assertion above while losing
        // the only durable answer to "what was this started as".
        model: 'gpt-5-codex',
        effort: 'medium',
      })

      // (2) IT CAME BACK. Writing columns nothing reads is worse than not having
      // them: the value is durable and invisible, which looks identical to the
      // bug it was supposed to fix.
      const rehydrated = hydrator().sessionFromStoredRow(storedRow(stored), 'boot')
      expect(rehydrated?.requestedModel).toBe('gpt-5.1-codex-max')
      expect(rehydrated?.requestedEffort).toBe('high')
      expect(rehydrated?.model).toBe('gpt-5-codex')
      expect(rehydrated?.effort).toBe('medium')
    } finally {
      db.close()
    }
  })

  it('leaves a never-configured session with no runtime request at all', () => {
    const db = openMigratedTestDatabase()
    try {
      const store = new SessionsRepository(createBunStoreExecutor({ database: db }))
      store.upsertSession(launched().toRow())

      const stored = store.getSession(SID)
      const rehydrated = hydrator().sessionFromStoredRow(storedRow(stored), 'boot')

      /**
       * ABSENT, NOT BACKFILLED FROM THE LAUNCH VALUE. "Launched as gpt-5-codex"
       * and "asked for gpt-5-codex" are different claims and only the first was
       * ever made; a row that asserts the second would put a decision nobody
       * took into the record, and every read that prefers the requested arm
       * would then be quoting it.
       */
      expect(stored?.requestedModel ?? null).toBeNull()
      expect(rehydrated?.requestedModel).toBeUndefined()
      expect(rehydrated?.requestedEffort).toBeUndefined()
      expect(rehydrated?.model).toBe('gpt-5-codex')
    } finally {
      db.close()
    }
  })

  it('carries a LATER change over the earlier one, one field at a time', () => {
    const db = openMigratedTestDatabase()
    try {
      const store = new SessionsRepository(createBunStoreExecutor({ database: db }))
      const session = launched()
      session.setRequestedModel({ model: 'gpt-5.1-codex-max' })
      store.upsertSession(session.toRow())
      session.setRequestedModel({ effort: 'high' })
      store.upsertSession(session.toRow())

      // The upsert's ON CONFLICT arm has to carry BOTH columns; a set-list that
      // named only one would leave the second at whatever the first INSERT wrote
      // and the drift would only show on the second change to a live session.
      const rehydrated = hydrator().sessionFromStoredRow(storedRow(store.getSession(SID)), 'boot')
      expect(rehydrated?.requestedModel).toBe('gpt-5.1-codex-max')
      expect(rehydrated?.requestedEffort).toBe('high')
    } finally {
      db.close()
    }
  })
})
