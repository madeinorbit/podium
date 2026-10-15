/**
 * A grant revoked inside a write span denies at once, in session authorization
 * and in the session projection, including through a primed owner memo; the
 * rollback restores it (POD-3889, POD-6155: every grant read asks the database,
 * which already shows the span's own writes).
 */

import { asMachineId, asSessionId, asUserId } from '@podium/model'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionStore } from '../../store'
import type { GrantRow } from '../../store/grants'
import { openTestStore } from '../../test-support/open-test-store'
import { Session } from './session'
import { SessionAuthz, type SessionAuthzPorts } from './session-authz'
import { SessionView, type SessionViewPorts } from './view'

const stores: SessionStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const alice = asUserId('user:grant-alice')
const session = asSessionId('grant-revocation')
const at = '2026-09-11T00:00:00Z'
const sessionGrant: GrantRow = {
  resourceKind: 'session',
  resourceId: session,
  grantee: alice,
  verb: 'read',
  owner: alice,
  visibility: 'personal',
  createdAt: at,
  actorKind: 'user',
  actorId: alice,
  onBehalfOf: alice,
}

it('session authorization and projection deny an in-span revocation, including primed memos', async () => {
  const store = await openTestStore(':memory:')
  stores.push(store)
  const target = new Session({
    sessionId: session, durableLabel: 'grant-revocation', agentKind: 'claude-code',
    cwd: '/tmp', title: 'Grant revocation', origin: { kind: 'spawn' }, createdAt: at,
    geometry: { cols: 80, rows: 24 }, machineId: asMachineId('grant-machine'),
    ownerUserId: alice, toDaemon: vi.fn(),
  })
  const authz = new SessionAuthz({ store, sessions: new Map([[session, target]]) } as unknown as SessionAuthzPorts)
  const view = new SessionView({
    store, sessions: new Map([[session, target]]),
    machines: { factsSnapshot: async () => ({ name: () => 'box', loginCondition: () => undefined }) },
    state: { overlaySnapshot: async () => new Map() },
  } as unknown as SessionViewPorts)
  const memo = { issues: new Map(), grants: new Map() }
  await store.grants.upsert(sessionGrant)
  await authz.primeOwnerMemo(memo, [session])
  expect((await authz.sessionOwner(session, memo))?.grants).toEqual([alice])
  expect((await authz.sessionOwner(session))?.grants).toEqual([alice])
  expect((await view.buildProjectionPass([target])).grants.get(`session:${session}`)).toEqual([alice])
  await expect(store.transact(async () => {
    await store.grants.removeAllForResource('session', session)
    expect((await authz.sessionOwner(session, memo))?.grants).toEqual([])
    await authz.primeOwnerMemo(memo, [session])
    expect(memo.grants.get(`session:${session}`)).toEqual([])
    expect((await view.buildProjectionPass([target])).grants.get(`session:${session}`)).toEqual([])
    throw new Error('rollback authz')
  })).rejects.toThrow('rollback authz')
  expect((await authz.sessionOwner(session))?.grants).toEqual([alice])
  expect((await view.buildProjectionPass([target])).grants.get(`session:${session}`)).toEqual([alice])
  await store.grants.removeAllForResource('session', session)
  expect((await authz.sessionOwner(session))?.grants).toEqual([])
})
