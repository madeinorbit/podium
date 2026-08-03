/**
 * SESSION ATTRIBUTION IS A PAIR, AND IT SURVIVES THE ROUND TRIP (POD-1516,
 * ADR 9 D5 A3 / docs/multi-user-readiness.md §3.1.3).
 *
 * AGAINST THE REAL MIGRATED SCHEMA. These run the SHIPPED migration manifest
 * against an in-memory database, so a missing column or a CHECK that does not
 * actually exist fails HERE rather than at boot. A fake repository would agree
 * with whatever this file asserted, including that the columns exist at all.
 *
 * WHY THE CENTRAL FIXTURE IS A **DELEGATED** SESSION. A user acting for
 * themselves puts the SAME value in both halves, so every assertion about it
 * passes just as well against an implementation that stores one value and reads
 * it out twice. The delegated case — an AGENT actor with a HUMAN on-behalf-of —
 * is the only one where collapsing the pair is observable, which is why it is
 * the case these tests are built on and why they assert the two halves are
 * DISTINGUISHABLE rather than merely present.
 *
 * Every denial is paired with an admission in the same fixture, so no assertion
 * here can be satisfied by a store that simply returns nothing.
 */

import type { Attribution, SessionId, UserId } from '@podium/model'
import {
  actorAgent,
  actorSystem,
  actorUser,
  asAgentIdentityId,
  asMachineId,
  asSessionId,
  asUserId,
} from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { runDrizzleMigrations } from '../migrations'
import { DRIZZLE_MIGRATIONS } from '../migrations/drizzle-manifest.generated'
import { SessionsRepository } from './sessions'
import type { SessionRow } from './types'

const ALICE = asUserId('user:alice')
const AGENT = asAgentIdentityId('sess-agent-7')

let db: ReturnType<typeof openDatabase>
let sessions: SessionsRepository

beforeEach(() => {
  db = openDatabase(':memory:')
  runDrizzleMigrations(db, DRIZZLE_MIGRATIONS)
  sessions = new SessionsRepository(db)
})

const row = (id: string, createdBy: Attribution | undefined): SessionRow => ({
  id: asSessionId(id),
  ownerUserId: ALICE,
  agentKind: 'claude-code',
  cwd: '/home/u/repo',
  title: 'a session',
  name: null,
  nameSource: null,
  originKind: 'spawn',
  conversationId: null,
  resumeKind: null,
  resumeValue: null,
  status: 'live',
  exitCode: null,
  spawnFailure: null,
  durableLabel: 'label-1',
  createdAt: '2026-08-03T00:00:00.000Z',
  lastActiveAt: '2026-08-03T00:00:00.000Z',
  geometry: { cols: 80, rows: 24 },
  archived: false,
  workState: null,
  machineId: asMachineId('machine-1'),
  lastOutputAt: null,
  lastInputAt: null,
  lastResumedAt: null,
  ...(createdBy ? { createdBy } : {}),
})

/** The pair this whole file is about: an AGENT acted, FOR a human. */
const DELEGATED: Attribution = { actor: actorAgent(AGENT), onBehalfOf: ALICE }

const reread = (id: string) => sessions.getSession(asSessionId(id))

describe('session attribution pair — durable round trip', () => {
  it('round-trips a DELEGATED pair with both halves distinguishable', () => {
    sessions.upsertSession(row('sess-1', DELEGATED))
    const back = reread('sess-1')?.createdBy

    // WHO ACTED: an agent, and the agent's own id — not the human's.
    expect(back?.actor).toEqual({ kind: 'agent', id: AGENT })
    // FOR WHOM: the delegating human.
    expect(back?.onBehalfOf).toBe(ALICE)

    // THE ASSERTION THAT KILLS A COLLAPSE. If the pair were stored or read as a
    // single value, these two would be equal whichever value survived. They are
    // different facts and must hold different values here.
    expect(back?.actor.kind).not.toBe('user')
    expect(String((back?.actor as { id: string }).id)).not.toBe(String(back?.onBehalfOf))
  })

  it('keeps a HUMAN pair distinguishable from a delegated one', () => {
    // The admission that pairs with the denial above: a direct human act really
    // does put the same person in both halves, so the previous test is asserting
    // a property of DELEGATION and not an artefact of how rows are written.
    sessions.upsertSession(row('sess-2', { actor: actorUser(ALICE), onBehalfOf: ALICE }))
    const back = reread('sess-2')?.createdBy
    expect(back?.actor).toEqual({ kind: 'user', id: ALICE })
    expect(back?.onBehalfOf).toBe(ALICE)
  })

  it('stores a SYSTEM actor with an explicit null human, never the owner', () => {
    sessions.upsertSession(row('sess-3', { actor: actorSystem('steward'), onBehalfOf: null }))
    const back = reread('sess-3')?.createdBy

    // ADR 9 D8 S5: the job is named, and it has NO human by construction.
    expect(back?.actor).toEqual({ kind: 'system', job: 'steward' })
    expect(back?.onBehalfOf).toBeNull()
    // The row's owner is ALICE and must NOT have been substituted in.
    expect(back?.onBehalfOf).not.toBe(ALICE)
  })

  it('refuses a system actor carrying a human, at the database', () => {
    // The CHECK is the enforcement, so it is asserted against the real schema:
    // a system principal that acquired a delegating human is a corrupt row, not
    // a merely unusual one.
    sessions.upsertSession(row('sess-1', DELEGATED))
    const setActor = (kind: string, human: UserId | null, id: SessionId) =>
      db
        .prepare(
          `UPDATE sessions SET created_by_actor_kind = ?, created_by_actor_id = 'steward',
             created_by_on_behalf_of = ? WHERE id = ?`,
        )
        .run(kind, human, id)

    // FIRST, PROVE THE STATEMENT REACHES A ROW AT ALL. Without this the denial
    // below passes just as well against an UPDATE that matched nothing — which
    // is exactly how this test failed on its first run.
    setActor('system', null, asSessionId('sess-1'))
    expect(reread('sess-1')?.createdBy?.actor).toEqual({ kind: 'system', job: 'steward' })

    // Same statement, same row, one value changed: now it must be refused.
    expect(() => setActor('system', ALICE, asSessionId('sess-1'))).toThrow()
    // And the closed kind set is enforced too — a fifth principal kind is an
    // ADR 9 D1 amendment, not something a writer can introduce.
    expect(() => setActor('superagent', null, asSessionId('sess-1'))).toThrow()
  })

  it('reads a pre-attribution row as NO PAIR, and invents nothing', () => {
    // A row from before the columns existed. `owner_user_id` and `spawned_by`
    // are both populated and both LOOK like an answer — the point is that
    // neither is used to manufacture one.
    sessions.upsertSession({ ...row('sess-4', undefined), spawnedBy: 'user' })
    const back = reread('sess-4')

    expect(back?.createdBy).toBeUndefined()
    // The admission: the row is otherwise fully present, so `null` above is the
    // attribution being absent and not the read failing.
    expect(back?.ownerUserId).toBe(ALICE)
    expect(back?.spawnedBy).toBe('user')
  })

  it('never re-attributes a session on a later upsert', () => {
    // `createdBy` is in SESSION_IMMUTABLE_AFTER_CREATE. A status change or a
    // rename must not restamp the pair with whoever triggered it — the COALESCE
    // in the upsert is what makes that structural rather than a convention.
    sessions.upsertSession(row('sess-5', DELEGATED))
    sessions.upsertSession({
      ...row('sess-5', { actor: actorUser(asUserId('user:mallory')), onBehalfOf: asUserId('user:mallory') }),
      title: 'renamed',
    })
    const back = reread('sess-5')

    expect(back?.createdBy?.actor).toEqual({ kind: 'agent', id: AGENT })
    expect(back?.createdBy?.onBehalfOf).toBe(ALICE)
    // The admission: the upsert DID take effect for mutable fields, so the
    // assertion above is immutability and not a write that silently no-oped.
    expect(back?.title).toBe('renamed')
  })

  it('fills a pair that was never recorded, without overwriting one that was', () => {
    // The other half of COALESCE: a legacy row CAN acquire a pair later. Without
    // this, "immutable" would be indistinguishable from "unwritable".
    sessions.upsertSession(row('sess-6', undefined))
    expect(reread('sess-6')?.createdBy).toBeUndefined()
    sessions.upsertSession(row('sess-6', DELEGATED))
    expect(reread('sess-6')?.createdBy?.actor).toEqual({ kind: 'agent', id: AGENT })
  })
})
