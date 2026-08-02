import { createHash } from 'node:crypto'
import { openDatabase } from '@podium/runtime/sqlite'
import { beforeEach, expect, it } from 'vitest'
import { applyBaselineSchema } from '../migrations'
import { mintUpstreamTokenInto } from '../relay'
import { AuthRepository } from './auth'

let repo: AuthRepository

beforeEach(() => {
  const db = openDatabase(':memory:')
  applyBaselineSchema(db)
  repo = new AuthRepository(db)
})

const FUTURE = '2999-01-01T00:00:00.000Z'

it('round-trips a login session', () => {
  repo.createClientSession('hash-a', FUTURE)
  expect(repo.isClientSessionValid('hash-a', '2026-01-01T00:00:00.000Z')).toBe(true)
})

// POD-1376/POD-801: a break-glass session minted from local filesystem access and a
// node⇄hub provisioning token are both client_sessions rows. Without a label they are
// indistinguishable, so revoking one class means revoking the operator's browser logins
// too. The label is what makes them separately greppable and revocable.
it('defaults an unlabelled session to the browser-login label', () => {
  repo.createClientSession('hash-a', FUTURE)
  expect(repo.listClientSessions()[0]?.label).toBe('login')
})

it('records the label a session was minted under', () => {
  repo.createClientSession('hash-a', FUTURE, 'break-glass')
  repo.createClientSession('hash-b', FUTURE, 'upstream')
  const byHash = new Map(repo.listClientSessions().map((s) => [s.tokenHash, s.label]))
  expect(byHash.get('hash-a')).toBe('break-glass')
  expect(byHash.get('hash-b')).toBe('upstream')
})

// The node⇄hub provisioning token goes through the same table; it must NOT land under
// the browser-login label or "revoke the logins" would cut every node off its hub.
it('labels an upstream provisioning token as upstream', () => {
  const token = mintUpstreamTokenInto(repo)
  const hash = createHash('sha256').update(token).digest('hex')
  expect(repo.listClientSessions().find((s) => s.tokenHash === hash)?.label).toBe('upstream')
})

it('revokes only the sessions carrying the named label', () => {
  repo.createClientSession('login-hash', FUTURE)
  repo.createClientSession('glass-hash', FUTURE, 'break-glass')
  repo.createClientSession('upstream-hash', FUTURE, 'upstream')

  expect(repo.deleteClientSessionsByLabel('break-glass')).toBe(1)

  const now = '2026-01-01T00:00:00.000Z'
  expect(repo.isClientSessionValid('glass-hash', now)).toBe(false)
  expect(repo.isClientSessionValid('login-hash', now)).toBe(true)
  expect(repo.isClientSessionValid('upstream-hash', now)).toBe(true)
})
