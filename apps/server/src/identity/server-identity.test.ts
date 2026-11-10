/**
 * What the server hands a hosted composition root through the identity seam
 * (POD-6746; docs/design/people-and-sign-in.md, section 3).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemberWrite } from '@podium/identity'
import { firstAdminMemberId, newMemberId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { identitySeamDeps } from './server-identity'

describe('the identity seam', () => {
  let dir: string
  let store: SessionStore

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'podium-identity-seam-'))
    store = await openTestStore(join(dir, 'podium.db'))
  })

  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const member = (change: Partial<MemberWrite> & { memberId: string }): MemberWrite => ({
    version: 1,
    state: 'active',
    role: 'member',
    accountId: null,
    profile: { name: change.memberId, image: null, email: `${change.memberId}@example.test` },
    actor: { system: 'organisation' },
    ...change,
  })

  it('lists every member row, disabled ones included, earliest first, without names or addresses', async () => {
    const deps = identitySeamDeps(store)
    const first = await firstAdminMemberId(store)
    const second = newMemberId()
    const third = newMemberId()
    // Written in the opposite order of their ids' sort where it can matter:
    // the order asserted below is creation, not id.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await deps.memberRows.write(member({ memberId: second, role: 'admin', accountId: 'acct-2' }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await deps.memberRows.write(member({ memberId: third, accountId: 'acct-3' }))
    await deps.memberRows.write(
      member({
        memberId: second,
        version: 2,
        state: 'disabled',
        role: 'admin',
        accountId: 'acct-2',
      }),
    )

    expect(await deps.existingMembers()).toEqual([
      { memberId: first, role: 'admin', disabled: false, accountId: null },
      { memberId: second, role: 'admin', disabled: true, accountId: 'acct-2' },
      { memberId: third, role: 'member', disabled: false, accountId: 'acct-3' },
    ])
  })

  it('keeps the applied membership version in the workspace database', async () => {
    const deps = identitySeamDeps(store)
    expect(await deps.appliedCursor.read()).toBe(0)
    await deps.appliedCursor.write(7)
    expect(await deps.appliedCursor.read()).toBe(7)
    // Another view of the same store reads the same number: it is not held in memory.
    expect(await identitySeamDeps(store).appliedCursor.read()).toBe(7)
    await deps.appliedCursor.write(8)
    expect(await store.settings.appliedMembershipVersion()).toBe(8)
  })
})
