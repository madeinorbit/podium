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

import { asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { createBunStoreExecutor } from './executor'
import { SuperagentRepository } from './superagent'

let superagent: SuperagentRepository

const OWNER = FIRST_ADMIN_USER_ID

beforeEach(() => {
  superagent = new SuperagentRepository(
    createBunStoreExecutor({ database: openMigratedTestDatabase() }),
  )
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
