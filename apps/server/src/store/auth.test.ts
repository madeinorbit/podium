import { FIRST_ADMIN_USER_ID } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, expect, it } from 'vitest'
import { applyBaselineSchema } from '../migrations'
import { AuthRepository } from './auth'

let repo: AuthRepository

beforeEach(() => {
  const db = openDatabase(':memory:')
  applyBaselineSchema(db)
  repo = new AuthRepository(db)
})

const FUTURE = '2999-01-01T00:00:00.000Z'

it('round-trips a login session', () => {
  repo.createClientSession('hash-a', FIRST_ADMIN_USER_ID, FUTURE)
  expect(repo.isClientSessionValid('hash-a', '2026-01-01T00:00:00.000Z')).toBe(true)
})

// POD-1376/POD-801: a break-glass session minted from local filesystem access and a
// node⇄hub provisioning token are both client_sessions rows. Without a label they are
// indistinguishable, so revoking one class means revoking the operator's browser logins
// too. The label is what makes them separately greppable and revocable.
it('defaults an unlabelled session to the browser-login label', () => {
  repo.createClientSession('hash-a', FIRST_ADMIN_USER_ID, FUTURE)
  expect(repo.listClientSessions()[0]?.label).toBe('login')
})

it('records the label a session was minted under', () => {
  repo.createClientSession('hash-a', FIRST_ADMIN_USER_ID, FUTURE, 'break-glass')
  repo.createClientSession('hash-b', FIRST_ADMIN_USER_ID, FUTURE, 'upstream')
  const byHash = new Map(repo.listClientSessions().map((s) => [s.tokenHash, s.label]))
  expect(byHash.get('hash-a')).toBe('break-glass')
  expect(byHash.get('hash-b')).toBe('upstream')
})

// REMOVED, not ported: 'labels an upstream provisioning token as upstream'.
// It called `mintUpstreamTokenInto` (main, 1d11ae43 "feat(auth): give the operator
// CLI a credential it can mint"), and this branch has no such function to call:
// POD-309 retired the node⇄hub upstream forwarder outright because federation is
// deferred ([spec:SP-0371] — see upstream-retirement.ts), so nothing mints an
// upstream-labelled row any more. The claim it defended — that a label keeps its
// class separately revocable — is still under test in the two cases either side
// of this comment, which exercise the 'upstream' label directly.

it('revokes only the sessions carrying the named label', () => {
  repo.createClientSession('login-hash', FIRST_ADMIN_USER_ID, FUTURE)
  repo.createClientSession('glass-hash', FIRST_ADMIN_USER_ID, FUTURE, 'break-glass')
  repo.createClientSession('upstream-hash', FIRST_ADMIN_USER_ID, FUTURE, 'upstream')

  expect(repo.deleteClientSessionsByLabel('break-glass')).toBe(1)

  const now = '2026-01-01T00:00:00.000Z'
  expect(repo.isClientSessionValid('glass-hash', now)).toBe(false)
  expect(repo.isClientSessionValid('login-hash', now)).toBe(true)
  expect(repo.isClientSessionValid('upstream-hash', now)).toBe(true)
})
