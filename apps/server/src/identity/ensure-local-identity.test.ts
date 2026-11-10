/**
 * The membership of a fresh database's first admin, and every database this
 * step must leave alone (POD-6746).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceIdentity } from '@podium/identity'
import { asUserId, firstAdminMemberId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { ensureLocalIdentity } from './ensure-local-identity'
import { createMemberOfRequest } from './member-of-request'
import { openServerIdentity } from './server-identity'

const AT = '2026-11-10T12:00:00.000Z'
const IDENTITY_TABLES = [
  'identity_user',
  'identity_account',
  'identity_session',
  'identity_membership',
  'identity_invitation',
] as const

describe('ensureLocalIdentity', () => {
  let dir: string
  let path: string
  let store: SessionStore
  let workspace: WorkspaceIdentity

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-ensure-local-identity-'))
    path = join(dir, 'podium.db')
    store = await openTestStore(path)
    // The core as the server builds it, without the boot step this file tests.
    workspace = (await openServerIdentity(store, { readOnly: true })).workspace
  })

  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Everything the step could write, read on a connection of its own. */
  const snapshot = () => {
    const reader = openDatabase(path)
    try {
      return {
        users: reader.prepare('SELECT * FROM users ORDER BY id').all(),
        credentials: reader.prepare('SELECT * FROM user_credentials ORDER BY user_id').all(),
        identity: Object.fromEntries(
          IDENTITY_TABLES.map((table) => [
            table,
            (reader.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
          ]),
        ),
      }
    } finally {
      reader.close()
    }
  }
  const noIdentityRows = Object.fromEntries(IDENTITY_TABLES.map((table) => [table, 0]))

  it('gives the sole member of a fresh database an active membership and an account with no login method', async () => {
    const first = firstAdminMemberId()
    expect(await ensureLocalIdentity(store, workspace)).toEqual({
      kind: 'adopted-first-admin',
      memberId: first,
    })
    const [membership, ...rest] = await workspace.memberships.list()
    expect(rest).toEqual([])
    expect(membership).toMatchObject({
      memberId: first,
      role: 'admin',
      status: 'active',
      hasPassword: false,
    })
    const row = await store.users.get(first)
    expect(row?.accountId).toBe(membership?.account?.id)
    expect(row?.role).toBe('admin')
    expect(snapshot().identity).toMatchObject({ identity_user: 1, identity_account: 0 })

    // The one-person server works as before: no sign-in on its own machine.
    expect(await workspace.signInRequired()).toBe(false)
    const memberOfRequest = createMemberOfRequest({
      identity: workspace,
      users: store.users,
      trustedProxyHops: 0,
    })
    expect(
      await memberOfRequest(
        new Request('http://127.0.0.1:18787/trpc/x', {
          headers: { 'x-podium-peer-address': '127.0.0.1' },
        }),
      ),
    ).toMatchObject({ kind: 'member', memberId: first, deviceSignIn: null })
  })

  it('changes nothing the second time', async () => {
    await ensureLocalIdentity(store, workspace)
    const after = snapshot()
    expect(await ensureLocalIdentity(store, workspace)).toEqual({ kind: 'nothing-to-do' })
    expect(snapshot()).toEqual(after)
  })

  it('leaves a database with two member rows untouched', async () => {
    await store.users.create(
      {
        id: asUserId('mem_second'),
        displayName: 'Second',
        role: 'member',
        createdAt: AT,
        disabledAt: null,
      },
      'unused-hash',
    )
    const before = snapshot()
    expect(await ensureLocalIdentity(store, workspace)).toEqual({
      kind: 'left-untouched',
      reason: 'several-members',
      members: 2,
    })
    expect(snapshot()).toEqual(before)
    expect(before.identity).toEqual(noIdentityRows)
  })

  it('leaves a database whose only member row is disabled untouched', async () => {
    await store.users.disable(firstAdminMemberId(), AT)
    const before = snapshot()
    expect(await ensureLocalIdentity(store, workspace)).toEqual({
      kind: 'left-untouched',
      reason: 'disabled-member',
      members: 1,
    })
    expect(snapshot()).toEqual(before)
    expect(before.identity).toEqual(noIdentityRows)
  })

  it('leaves a database whose only member has a password in user_credentials untouched', async () => {
    await store.users.setPasswordHash(
      firstAdminMemberId(),
      await hashPassword('their password'),
      AT,
    )
    const before = snapshot()
    expect(await ensureLocalIdentity(store, workspace)).toEqual({
      kind: 'left-untouched',
      reason: 'member-has-password',
      members: 1,
    })
    expect(snapshot()).toEqual(before)
    expect(before.identity).toEqual(noIdentityRows)
    // Nobody can sign in to such a database until the upgrade step exists.
    expect(await workspace.memberships.list()).toEqual([])
  })
})
