import { asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { beforeEach, expect, it } from 'vitest'
import { openMigratedTestDatabase } from '../test-support/migrated-database'
import { AuthRepository } from './auth'
import { createBunStoreExecutor } from './executor'

let repo: AuthRepository

beforeEach(() => {
  const db = openMigratedTestDatabase()
  const stage = createBunStoreExecutor({ database: db }).syncQueries
  if (!stage) throw new Error('the test database is not bun-backed')
  repo = new AuthRepository(stage)
})

const FUTURE = '2999-01-01T00:00:00.000Z'

it('round-trips a login session', async () => {
  await repo.createClientSession('hash-a', FIRST_ADMIN_USER_ID, FUTURE)
  expect(await repo.isClientSessionValid('hash-a', '2026-01-01T00:00:00.000Z')).toBe(true)
})

// POD-1376/POD-801: a break-glass session minted from local filesystem access and a
// node⇄hub provisioning token are both client_sessions rows. Without a label they are
// indistinguishable, so revoking one class means revoking the operator's browser logins
// too. The label is what makes them separately greppable and revocable.
it('defaults an unlabelled session to the browser-login label', async () => {
  await repo.createClientSession('hash-a', FIRST_ADMIN_USER_ID, FUTURE)
  expect((await repo.listClientSessions())[0]?.label).toBe('login')
})

it('records the label a session was minted under', async () => {
  await repo.createClientSession('hash-a', FIRST_ADMIN_USER_ID, FUTURE, 'break-glass')
  await repo.createClientSession('hash-b', FIRST_ADMIN_USER_ID, FUTURE, 'upstream')
  const byHash = new Map((await repo.listClientSessions()).map((s) => [s.tokenHash, s.label]))
  expect(byHash.get('hash-a')).toBe('break-glass')
  expect(byHash.get('hash-b')).toBe('upstream')
})

it('round-trips mobile device metadata, activity, and owner-scoped row revocation', async () => {
  const other = asUserId('user:other')
  await repo.createClientSession('mobile-a', FIRST_ADMIN_USER_ID, FUTURE, 'mobile', {
    sessionId: 'session-aaaaaaaaaaaa',
    deviceId: 'device-a',
    deviceName: "Sam's iPhone",
    platform: 'ios',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  })
  await repo.createClientSession('mobile-b', other, FUTURE, 'mobile', {
    sessionId: 'session-bbbbbbbbbbbb',
    deviceId: 'device-b',
    deviceName: 'Other phone',
    platform: 'android',
  })
  expect(await repo.listMobileClientSessions(FIRST_ADMIN_USER_ID)).toMatchObject([
    {
      tokenHash: 'mobile-a',
      sessionId: 'session-aaaaaaaaaaaa',
      deviceId: 'device-a',
      deviceName: "Sam's iPhone",
      platform: 'ios',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    },
  ])
  await repo.touchClientSession('mobile-a', '2026-01-02T00:00:00.000Z')
  expect((await repo.getClientSession('mobile-a'))?.lastSeenAt).toBe('2026-01-02T00:00:00.000Z')
  expect(
    await repo.deleteOwnedMobileClientSession('session-bbbbbbbbbbbb', FIRST_ADMIN_USER_ID),
  ).toBeUndefined()
  expect(
    await repo.deleteOwnedMobileClientSession('session-aaaaaaaaaaaa', FIRST_ADMIN_USER_ID),
  ).toBe('mobile-a')
})

// REMOVED, not ported: 'labels an upstream provisioning token as upstream'.
// It called `mintUpstreamTokenInto` (main, 1d11ae43 "feat(auth): give the operator
// CLI a credential it can mint"), and this branch has no such function to call:
// POD-309 retired the node⇄hub upstream forwarder outright because federation is
// deferred ([spec:SP-0371] — see upstream-retirement.ts), so nothing mints an
// upstream-labelled row any more. The claim it defended — that a label keeps its
// class separately revocable — is still under test in the two cases either side
// of this comment, which exercise the 'upstream' label directly.

it('revokes only the sessions carrying the named label', async () => {
  await repo.createClientSession('login-hash', FIRST_ADMIN_USER_ID, FUTURE)
  await repo.createClientSession('glass-hash', FIRST_ADMIN_USER_ID, FUTURE, 'break-glass')
  await repo.createClientSession('upstream-hash', FIRST_ADMIN_USER_ID, FUTURE, 'upstream')

  expect(await repo.deleteClientSessionsByLabel('break-glass')).toBe(1)

  const now = '2026-01-01T00:00:00.000Z'
  expect(await repo.isClientSessionValid('glass-hash', now)).toBe(false)
  expect(await repo.isClientSessionValid('login-hash', now)).toBe(true)
  expect(await repo.isClientSessionValid('upstream-hash', now)).toBe(true)
})
