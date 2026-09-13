/**
 * A PERSISTED SESSION WITH NO OWNER IS REFUSED, NEVER ADOPTED BY THE FIRST
 * ADMIN (PDM-428), AND THE REFUSED CLASSES ARE BOUNDED HERE (PDM-451).
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
 * THE REFUSAL IS WIDER THAN THE TERM IT REPLACED, AND THAT IS DELIBERATE.
 * `!r.ownerUserId` refuses a MISSING OR EMPTY owner value; `??` fired only on
 * null and undefined, so `''` used to hydrate a session owned by the empty
 * string. The spelling is `upsertSession`'s own guard, so read and write apply
 * the same falsy-value predicate. Note what that is NOT: the guard tests
 * TRUTHINESS only, so it does not resolve the id, does not verify the member
 * exists, and does not reject a nonempty string that names nobody.
 *
 * EXACTLY WHICH INPUTS THIS FILE EXECUTES, since "each class is tested" would
 * overstate it (PDM-451):
 *
 *  - ABSENT (`undefined`): `row()` omits the key, and that row goes through
 *    `sessionFromStoredRow` in BOTH modes. Executed.
 *  - EMPTY STRING: planted into a migrated database through raw SQL, read back
 *    through the ordinary store read, and put through hydration. Executed.
 *  - NULL: NOT executed, and it cannot be. `SessionRow.ownerUserId` is
 *    `UserId | undefined` — `null` is not in the type — and the only thing that
 *    could produce one is a NULL column, which `mapSession` reads off a NOT NULL
 *    column. The last test asserts THE CONSTRAINT, which is a fact about the
 *    table and NOT a hydration run: it says a null owner cannot arrive, not that
 *    hydration was driven with one. `!r.ownerUserId` would refuse it if it ever
 *    did, but no test in this file demonstrates that.
 *
 * THE TWO CLASSES HAVE DIFFERENT WARRANTS AND THIS FILE KEEPS THEM APART.
 *
 *  - NULL is excluded by the SCHEMA — a constraint, asserted as one. `owner_user_id`
 *    arrived NOT NULL with a backfilling DEFAULT in
 *    `20260731195047_phase-3-policy-ownership`, and every `__new_sessions` rebuild
 *    since has carried NOT NULL.
 *  - THE EMPTY STRING IS NOT EXCLUDED BY THE SCHEMA. `NOT NULL` permits `''`,
 *    and the test below inserts one into a migrated database and reads it back
 *    to SHOW that rather than arguing it. What excludes `''` is
 *    `upsertSession`'s RUNTIME guard — an API guarantee of the one production
 *    writer, which a raw INSERT, an import, or a future second writer simply
 *    does not go through. So for THAT value the read-side refusal is not
 *    redundant with the constraint, and that is the stronger half of the reason
 *    it exists.
 *
 * WHAT THIS FILE DOES NOT ESTABLISH. It bounds the input classes the guard
 * accepts and refuses, and the warrant for each; it does not establish that no
 * unowned row can exist by any means. The schema audit covers the migration
 * chain and says nothing about SQL issued outside drizzle beyond the one raw
 * INSERT performed here, nor about a database file swapped in beneath the
 * migrator. It also does not speak for `session-revival.ts`, which keeps its own
 * `firstAdminMemberId` fallback deliberately and for a documented reason
 * (PDM-273). The claim is about hydration only.
 *
 * `SessionRow.ownerUserId` is declared optional — "optional only at legacy
 * adapter boundaries" — so the absent case is representable in TypeScript while
 * the physical column forbids it. That gap is what made the fallback read as a
 * supported case.
 */

import { asMachineId, asSessionId, asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import type { SessionRow } from '../../store/types'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { openTestStore } from '../../test-support/open-test-store'
import { SessionRepository } from './repository'

/** Someone who is emphatically NOT the instance's first admin. Used as the
 *  owner in the positive controls so "the stored owner survives" cannot be
 *  satisfied by the row happening to name the admin — the divergence is the
 *  assertion (false-green catalogue, shape 33). */
const STRANGER = asUserId('u_not_the_first_admin')

/** The private handle, reached the way the store suites already reach it, so a
 *  row can be planted that no production writer would ever produce. */
const rawDb = (store: SessionStore): SqlDatabase => (store as unknown as { db: SqlDatabase }).db

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
  ...(owner !== undefined ? { ownerUserId: owner } : {}),
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

/** The columns a `sessions` INSERT must supply: NOT NULL with no default. Named
 *  rather than derived so the planted row is a deliberate shape — and checked
 *  AGAINST the derived set in the test that uses it, so a migration adding a
 *  required column reddens there instead of silently changing what is planted
 *  (catalogue shape 7: never compare two hand-kept lists). */
const REQUIRED_SESSION_COLUMNS = [
  'id',
  'owner_user_id',
  'agent_kind',
  'cwd',
  'title',
  'origin_kind',
  'status',
  'durable_label',
  'created_at',
  'last_active_at',
  'machine_id',
] as const

/** Plant a `sessions` row straight through SQLite, bypassing every write-side
 *  guard. `agent_kind` is VALID on purpose: an invalid one is refused by the
 *  guard ABOVE the owner check, which would make a passing refusal prove the
 *  wrong clause. */
const plantRow = (db: SqlDatabase, id: string, ownerUserId: string): void => {
  db.prepare(
    `INSERT INTO sessions (${REQUIRED_SESSION_COLUMNS.join(', ')})
     VALUES (?, ?, 'claude-code', '/home/u/repo', 'a planted session', 'spawn', 'exited',
       ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'machine-1')`,
  ).run(id, ownerUserId, `podium-${id}`)
}

type ColumnInfo = { name: string; notnull: number; dflt_value: unknown; pk: number }

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

  it('refuses an EMPTY-STRING owner that a migrated database really does accept', async () => {
    const store = await openTestStore(':memory:')
    try {
      const db = rawDb(store)

      // (1) THE WIDENING, PINNED AS A COUNTERFACTUAL RATHER THAN DESCRIBED.
      // `??` fires only on null and undefined, so the term this guard replaced
      // passed the empty string straight through to the Session. Refusing it is
      // therefore a deliberate widening, not an accident of writing `!`.
      const EMPTY = '' as UserId
      expect(EMPTY ?? asUserId('substituted-by-the-old-term')).toBe('')

      // (2) THE COLUMN LIST IS CHECKED AGAINST THE SCHEMA, not against a second
      // copy of my own assumption: if a migration adds a required column, this
      // reddens here rather than letting the plant below insert a shape the real
      // table no longer has. It caught my first list on its first run — SQLite
      // reports `notnull = 0` for a TEXT PRIMARY KEY, so `id` is demanded by the
      // table without appearing in the derived set, and the two directions below
      // say that rather than papering over it.
      const columns = db.prepare('PRAGMA table_info(sessions)').all() as ColumnInfo[]
      const demandedByTable = columns
        .filter((c) => c.notnull === 1 && c.dflt_value == null)
        .map((c) => c.name)
      // Every column the table demands IS supplied by the plant…
      expect([...REQUIRED_SESSION_COLUMNS]).toEqual(expect.arrayContaining(demandedByTable))
      // …and the only thing the plant supplies beyond them is the primary key,
      // asserted to BE the primary key so its absence from the derived set is
      // explained rather than silently absorbed.
      expect(
        [...REQUIRED_SESSION_COLUMNS].filter((c) => !demandedByTable.includes(c)),
      ).toEqual(['id'])
      expect(columns.find((c) => c.name === 'id')?.pk).toBe(1)

      // (3) NOT NULL DOES NOT EXCLUDE THE EMPTY STRING. Shown, not argued: the
      // insert succeeds against the real migrated table and the value comes back
      // through the ordinary store read.
      plantRow(db, 'sess_planted_empty_owner', '')
      const stored = await store.sessions.getSession(asSessionId('sess_planted_empty_owner'))
      expect(stored, 'the plant must have landed, or nothing below is about hydration').toBeDefined()
      expect(stored?.ownerUserId, 'the schema accepted an empty owner').toBe('')

      // (4) AND HYDRATION REFUSES THAT REAL STORED ROW.
      const hydrated = await hydrator(store).sessionFromStoredRow(stored as SessionRow, 'boot')
      expect(hydrated, 'an empty-string owner must be refused too').toBeNull()

      // (5) WHICH CLAUSE REFUSED IT. The same plant with a real owner hydrates,
      // so the refusal above is the OWNER check and not the agentKind check
      // above it, nor anything else about a planted row.
      plantRow(db, 'sess_planted_real_owner', STRANGER)
      const sibling = await store.sessions.getSession(asSessionId('sess_planted_real_owner'))
      const hydratedSibling = await hydrator(store).sessionFromStoredRow(
        sibling as SessionRow,
        'boot',
      )
      expect(hydratedSibling, 'the identical plant with an owner must hydrate').not.toBeNull()
      expect(hydratedSibling?.ownerUserId).toBe(STRANGER)
    } finally {
      await store.close()
    }
  })

  it('the empty string is excluded by upsertSession, an API guarantee and not the schema', async () => {
    const store = await openTestStore(':memory:')
    try {
      // The distinction PDM-451 asked be kept: the production writer refuses a
      // falsy owner, and that is a property of this FUNCTION rather than of the
      // table. It is what makes the empty-owner row above reachable only by a
      // path that does not come through here — and what makes the read-side
      // refusal non-redundant for that value.
      await expect(
        store.sessions.upsertSession({ ...row(STRANGER), ownerUserId: '' as UserId }),
      ).rejects.toThrow(/ownerUserId is required/)

      // Non-vacuity for this assertion specifically: the same call with a real
      // owner succeeds, so the rejection above is about the owner and not about
      // the row being malformed.
      await expect(store.sessions.upsertSession(row(STRANGER))).resolves.toBeUndefined()
    } finally {
      await store.close()
    }
  })

  it('still hydrates a row that names an owner, and keeps that owner', async () => {
    const store = await openTestStore(':memory:')
    try {
      // NON-VACUITY FOR THE WHOLE FILE. If hydration refused everything, the
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

  it('the NULL half of the guard is the schema half: owner_user_id is NOT NULL', () => {
    // THIS ASSERTS A CONSTRAINT; IT DOES NOT RUN HYDRATION (PDM-451). It says a
    // null owner cannot ARRIVE — not that `sessionFromStoredRow` was driven with
    // one, which no test here does and which `SessionRow`'s type
    // (`UserId | undefined`) does not admit without a cast. Read it as the
    // warrant for the null class, not as coverage of it.
    //
    // Bounded to what it covers: NOT NULL excludes NULL and says NOTHING about
    // the empty string — which is why the empty-string test above exists and
    // does not lean on this one. A migration that relaxes the column reddens
    // HERE, by name, which is the "one schema change away" scenario the issue
    // was filed about.
    const db = openMigratedTestDatabase()
    try {
      const columns = db.prepare('PRAGMA table_info(sessions)').all() as ColumnInfo[]
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
