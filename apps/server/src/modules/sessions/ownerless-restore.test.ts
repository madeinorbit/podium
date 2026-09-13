/**
 * A PERSISTED SESSION WITH NO OWNER IS REFUSED, NEVER ADOPTED BY THE FIRST
 * ADMIN (PDM-428).
 *
 * WHAT WAS WRONG. `sessionFromStoredRow` — the one hydration used by boot
 * (`repository.loadFromStore`) and by restore
 * (`session-meta-ops.prepareIssueSessionRestore`) — read
 *
 *     ownerUserId: r.ownerUserId ?? (await firstAdminMemberId(this.store))
 *
 * so a row whose owner did not resolve came back owned by the earliest-enrolled
 * administrator. The hydrated `Session` is what the next `upsertSession`
 * persists, so the substitution did not stay in memory: it BECAME the stored
 * owner. That is an owner replacement — from nobody to the principal with the
 * most authority on the instance — performed silently during restore. The same
 * argument `fleet/handlers.ts` records for a machine (D19.4b declined to
 * auto-assign a quarantined machine to the first admin, because a database
 * restore would hand somebody's personal Mac to whoever is admin) applies to a
 * session's transcript and repo state.
 *
 * WHAT THIS FILE ESTABLISHES, AND WHAT IT DOES NOT.
 *
 *  - IT ESTABLISHES that the hydration function refuses an ownerless row in
 *    BOTH modes, and that the refusal is not "hydration is broken": a row that
 *    names an owner still hydrates, and comes back owned by the person the row
 *    names rather than by the admin.
 *  - IT ESTABLISHES that the row it refuses cannot arrive from the store today:
 *    `sessions.owner_user_id` is NOT NULL in the migrated schema. So this is a
 *    FAIL-CLOSED GUARD over a case the current schema forbids, not a repair to
 *    a live path, and the last test says so in a form that reddens if a future
 *    migration relaxes the column.
 *  - IT DOES NOT ESTABLISH that no unowned row can exist by any means. The
 *    migration chain is what was audited — `owner_user_id` arrived NOT NULL
 *    with a backfilling DEFAULT in `20260731195047_phase-3-policy-ownership`
 *    and every `__new_sessions` rebuild since has carried NOT NULL — and that
 *    says nothing about SQL issued outside drizzle, or about a database file
 *    swapped in beneath the migrator.
 *  - IT DOES NOT SPEAK for `session-revival.ts`, which keeps its own
 *    `firstAdminMemberId` fallback deliberately and for a documented reason
 *    (PDM-273). This file's claim is about hydration only.
 *
 * THE ROW THE TESTS BUILD IS REPRESENTABLE, WHICH IS THE WHOLE POINT.
 * `SessionRow.ownerUserId` is declared optional — "optional only at legacy
 * adapter boundaries" — so TypeScript admits the ownerless row while the
 * physical column forbids it. That gap is what made the fallback read as a
 * supported case, and it is why deleting the fallback needed a refusal in its
 * place rather than nothing at all.
 */

import { asMachineId, asSessionId, asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import type { SessionRow } from '../../store/types'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { openTestStore } from '../../test-support/open-test-store'
import { SessionRepository } from './repository'

/** Someone who is emphatically NOT the instance's first admin. Used as the
 *  owner in the positive control so "the stored owner survives" cannot be
 *  satisfied by the row happening to name the admin — the divergence is the
 *  assertion (false-green catalogue, shape 33). */
const STRANGER = asUserId('u_not_the_first_admin')

/** The repository, for its hydration function only. `store` is REAL and is the
 *  port the deleted fallback read: `firstAdminMemberId(this.store)` resolved
 *  through it, so a break that restores the fallback resolves the admin by the
 *  production route rather than through a test slot. The ports this function
 *  does not touch are not stubbed into existence. */
const hydrator = (store: SessionStore): SessionRepository =>
  new SessionRepository({
    store,
    sessions: new Map(),
    ledger: { capture: vi.fn(() => []) },
    view: { buildProjectionPass: async () => ({}), wire: vi.fn() },
    now: () => Date.now(),
    runScheduledBroadcast: vi.fn(),
    broadcastSessions: vi.fn(),
    flushBroadcasts: vi.fn(),
    listSessions: vi.fn(async () => []),
    toPtyInput: vi.fn(),
    toMachine: vi.fn(),
  } as never)

/** One persisted row. `owner` absent spells the case the fallback used to fill.
 *  Everything else is a perfectly ordinary session, so nothing but the owner can
 *  explain a refusal. */
const row = (owner?: UserId): SessionRow => ({
  id: asSessionId('sess_hydrated_without_an_owner'),
  ...(owner ? { ownerUserId: owner } : {}),
  agentKind: 'claude-code',
  cwd: '/home/u/repo',
  title: 'a session somebody started',
  name: null,
  nameSource: null,
  originKind: 'spawn',
  conversationId: null,
  resumeKind: null,
  resumeValue: null,
  status: 'exited',
  exitCode: 0,
  spawnFailure: null,
  durableLabel: 'podium-sess-hydrated-without-an-owner',
  createdAt: '2026-09-01T00:00:00.000Z',
  lastActiveAt: '2026-09-01T00:00:00.000Z',
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: asMachineId('machine-1'),
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
})

describe('an ownerless session row is refused at hydration', () => {
  it.each(['boot', 'restore'] as const)(
    'refuses it in %s mode rather than hydrating it as the first admin',
    async (mode) => {
      const store = await openTestStore(':memory:')
      try {
        // THE PRECONDITION, PINNED BESIDE THE CLAIM. The deleted fallback read
        // `firstAdminMemberId(this.store)`, so "it did not come back owned by
        // the admin" is only a claim if this store HAS an admin to substitute.
        // Without this line a store that resolved nobody would make both
        // assertions below pass for a reason that has nothing to do with the
        // repair (catalogue shape 19).
        const admin = await firstAdminMemberId(store)
        expect(admin, 'the store must resolve a first admin, or there is nothing to refuse').toEqual(
          expect.stringMatching(/\S/),
        )

        const hydrated = await hydrator(store).sessionFromStoredRow(row(), mode)

        // BOTH HALVES SOFT, so a break reports both rather than stopping at the
        // first. They fail in different directions: the first catches any
        // hydration at all, the second catches a hydration that names the admin
        // specifically — which is what the old code produced.
        expect.soft(hydrated, 'an ownerless row must not hydrate at all').toBeNull()
        expect
          .soft(hydrated?.ownerUserId, 'and it must certainly not come back owned by the first admin')
          .not.toBe(admin)
      } finally {
        await store.close()
      }
    },
  )

  it('still hydrates a row that names an owner, and keeps that owner', async () => {
    const store = await openTestStore(':memory:')
    try {
      // NON-VACUITY FOR THE WHOLE FILE. If hydration refused everything, the two
      // refusals above would be green and worthless. The owner here is a
      // STRANGER, asserted different from the admin, so "the stored owner
      // survives" cannot be satisfied by the substitution the repair removed.
      const admin = await firstAdminMemberId(store)
      expect(STRANGER).not.toBe(admin)

      const hydrated = await hydrator(store).sessionFromStoredRow(row(STRANGER), 'boot')

      expect(hydrated, 'a well-formed row must still hydrate').not.toBeNull()
      expect(hydrated?.ownerUserId).toBe(STRANGER)
    } finally {
      await store.close()
    }
  })

  it('cannot receive such a row from the store: owner_user_id is NOT NULL', () => {
    // WHY THE GUARD IS LATENT, stated as a check rather than as prose. This is
    // the premise the refusal rests on, and it is the one that can change under
    // it: the issue exists because a schema relaxation is all it would take. A
    // migration that made this column nullable reddens HERE, by name, which is
    // the notice a comment could not give.
    const db = openMigratedTestDatabase()
    try {
      const columns = db.prepare('PRAGMA table_info(sessions)').all() as {
        name: string
        notnull: number
      }[]
      const owner = columns.find((c) => c.name === 'owner_user_id')
      // Asserted present first: a `find` that answered undefined would make the
      // notnull assertion below read as a pass on an absent subject.
      expect(owner, 'the sessions table must still have an owner_user_id column').toBeDefined()
      expect(owner?.notnull).toBe(1)
    } finally {
      db.close()
    }
  })
})
