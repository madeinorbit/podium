/**
 * GOLDEN TEST FOR `archiveSuperagentThread` [POD-3395].
 *
 * The coverage census (POD-3244) measured this as the one never-executed method
 * of `SuperagentRepository`. It has a production caller
 * (`modules/superagent/service.ts`) and no test, so nothing today pins what
 * archiving actually does to the two readers that disagree about archived rows:
 * `listSuperagentThreads` filters them out, `getSuperagentThread` does not.
 *
 * The un-archiving arm is pinned with it, because it is not in this method at
 * all — `upsertSuperagentThread`'s conflict clause sets `archived = 0`, so
 * re-opening a thread is a side effect of writing to it. A conversion that drops
 * that one column from the upsert's SET list would leave an archived thread
 * invisible forever, and every other assertion about the upsert would pass.
 */

import { asSessionId, asThreadId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { syncQueriesOver } from './executor/sync-drizzle'
import { SuperagentRepository } from './superagent'

let superagent: SuperagentRepository

const OWNER = FIRST_ADMIN_USER_ID

beforeEach(() => {
  superagent = new SuperagentRepository(syncQueriesOver(openMigratedTestDatabase()))
  superagent.upsertSuperagentThread({
    id: 'thread-1',
    ownerUserId: OWNER,
    kind: 'btw',
    originSessionId: asSessionId('session-1'),
    title: 'first',
  })
  superagent.upsertSuperagentThread({ id: 'thread-2', ownerUserId: OWNER, kind: 'global' })
})

describe('SuperagentRepository.archiveSuperagentThread', () => {
  it('takes the thread out of the owner list', () => {
    expect(superagent.listSuperagentThreads(OWNER).map((t) => t.id)).toEqual(
      expect.arrayContaining(['thread-1', 'thread-2']),
    )

    superagent.archiveSuperagentThread('thread-1')

    expect(superagent.listSuperagentThreads(OWNER).map((t) => t.id)).toEqual(['thread-2'])
  })

  it('leaves the thread readable by id', () => {
    superagent.archiveSuperagentThread('thread-1')

    // Archived is not deleted: a direct read still answers, which is what makes
    // the list's filter the only thing hiding it.
    expect(superagent.getSuperagentThread('thread-1')?.title).toBe('first')
  })

  it('reports the archived flag on the row itself, as a boolean', () => {
    // THE MAPPED FIELD, not the list's SQL filter, and the distinction is the
    // whole of spec rule 28. Every assertion above this one is satisfied by the
    // `archived = 0` predicate in listSuperagentThreads, so a mapper that read
    // the column wrong — `r.archived === 1` against a declared boolean, which is
    // `false` forever — passed all of them. Measured, not supposed: that exact
    // mutation left this suite green until this test existed.
    expect(superagent.getSuperagentThread('thread-2')?.archived).toBe(false)

    superagent.archiveSuperagentThread('thread-2')

    const archived = superagent.getSuperagentThread('thread-2')
    expect(typeof archived?.archived).toBe('boolean')
    expect(archived?.archived).toBe(true)
  })

  it('archives only the named thread', () => {
    superagent.archiveSuperagentThread('thread-1')

    expect(superagent.listSuperagentThreads(OWNER).map((t) => t.id)).toEqual(['thread-2'])
  })

  it('does nothing for a thread that is not there', () => {
    superagent.archiveSuperagentThread('thread-missing')

    expect(superagent.listSuperagentThreads(OWNER)).toHaveLength(2)
  })

  it('is undone by a later upsert of the same thread', () => {
    superagent.archiveSuperagentThread('thread-1')
    expect(superagent.listSuperagentThreads(OWNER).map((t) => t.id)).toEqual(['thread-2'])

    superagent.upsertSuperagentThread({ id: 'thread-1', ownerUserId: OWNER, kind: 'btw' })

    expect(superagent.listSuperagentThreads(OWNER).map((t) => t.id)).toEqual(
      expect.arrayContaining(['thread-1', 'thread-2']),
    )
  })
})

/**
 * THE BOOLEAN COLUMNS THIS WAVE READS [spec rule 28].
 *
 * Drizzle applies the schema's declared modes, so `integer({ mode: 'boolean' })`
 * comes back `true`/`false` rather than `1`/`0`, and a mapper still comparing
 * against a number silently answers `false` for every row. Rule 28 asks for a
 * golden on the NON-DEFAULT value of every such column a wave touches, because
 * the default value proves nothing: a fixture seeding an ordinary row is green
 * in both worlds.
 *
 * `superagent_threads.archived` is covered above — archiving is the whole
 * subject of that suite. This is the other one: `first_turn` is FALSE on every
 * ordinary turn, so nothing that seeds a normal pending turn can tell the two
 * worlds apart. The old code wrote `row.firstTurn ? 1 : 0` and read it back
 * through `Boolean(...)`; the converted code passes the declared boolean
 * straight through, and this is what pins that the value survives the round
 * trip in BOTH states.
 */
describe('superagent pending turns: the first_turn boolean', () => {
  // ONE PENDING TURN PER THREAD — `superagent_pending_turns_thread_id_unique`,
  // which is what keeps one turn in flight per thread — so the two arms below
  // need two threads rather than two turns on one.
  const turn = (turnId: string, threadId: string, firstTurn: boolean) => ({
    turnId,
    ownerUserId: OWNER,
    threadId: asThreadId(threadId),
    podiumSessionId: asSessionId('session-1'),
    payload: { agent: 'claude-code', cwd: '/repo', prompt: 'hello' },
    firstTurn,
  })

  it('round-trips a first turn as true and a later turn as false', () => {
    superagent.putPendingTurn(turn('turn-first', 'thread-1', true))
    superagent.putPendingTurn(turn('turn-later', 'thread-2', false))

    const byId = new Map(superagent.listPendingTurns().map((t) => [t.turnId, t.firstTurn]))

    // Both arms, in one assertion, so neither a mapper stuck on `true` nor one
    // stuck on `false` can pass.
    expect(byId.get('turn-first')).toBe(true)
    expect(byId.get('turn-later')).toBe(false)
  })

  it('reads first_turn as a boolean and not as a number', () => {
    superagent.putPendingTurn(turn('turn-first', 'thread-1', true))

    const [stored] = superagent.listPendingTurns()

    // `toBe(true)` alone would pass for `1` under a loose comparison somewhere
    // upstream; the type assertion is what pins rule 28's actual claim.
    expect(typeof stored?.firstTurn).toBe('boolean')
    expect(stored?.firstTurn).toBe(true)
  })
})
