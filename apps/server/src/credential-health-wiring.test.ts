/**
 * CREDENTIAL HEALTH, WIRED (credential management §7, §8; epic Task 13).
 *
 * The health service's session port is bound by the composition root to the
 * session lifecycle and the interaction aggregate. A session on a removed
 * credential gets one ask naming it, also when the flag is raised inside the
 * remove command's plain-command scope, on a real server with the two-member
 * fixture's sessions. The notice port is bound to the inbox (POD-6881): an
 * attention notice is raised once and resolved by renewal, and a share notice
 * raised inside the share command reaches the grantee.
 *
 * Not covered here: the restart and stop. They need a daemon that answers a
 * kill, which the fixture's does not, and the fix that lets them run from a
 * plain command (`asSystemWrite` around hibernate, resurrect and stop) is
 * evidenced by the live drive, where the unwrapped restart was refused with
 * `PlainCommandWroteSyncedData`. A control run of this file on the unwrapped
 * relay passes, because the interaction write is not a guarded synced write.
 */

import type { CredentialId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withPlainCommand } from './plain-command-scope'
import { startTwoMemberInstance, type TwoMemberInstance } from './test-support/two-member-instance'

let f: TwoMemberInstance
beforeAll(async () => {
  f = await startTwoMemberInstance()
}, 60_000)
afterAll(async () => {
  await f?.close()
})

const CREDENTIAL = {
  id: 'cred_00000000-0000-4000-8000-000000006900' as CredentialId,
  label: 'Work key',
}

describe('the bound session port inside a credential command', () => {
  it('flags a session on a removed credential: one ask on the session, naming it', async () => {
    const health = f.handle.registry.modules.credentialHealth
    await withPlainCommand('credentials.remove', async () => {
      await health.sessions.flagRemoved(f.sessions.alice, CREDENTIAL)
    })
    const open = await f.handle.registry.sessionStore.interactions.listOpen(f.sessions.alice)
    const flags = open.filter((row) => JSON.stringify(row).includes('Work key'))
    expect(flags).toHaveLength(1)
    expect(JSON.stringify(flags[0])).toContain('was removed')
  })

  it('raises a credential-attention notice in the owner inbox once, and renewal resolves it', async () => {
    const registry = f.handle.registry
    const store = registry.sessionStore
    const health = registry.modules.credentialHealth
    const alice = f.members.alice.id
    const record = await store.credentials.insert({
      ownerUserId: alice,
      label: 'Wired key',
      type: 'anthropic.api-key',
    })
    const open = async () =>
      (await store.notices.listOpen(alice, { limit: 50 })).filter(
        (row) => row.dedupeKey === `credential-attention:${record.id}`,
      )
    await health.noteFailure({ credentialId: record.id, failure: 'rejected', reason: 'rejected' })
    await health.noteFailure({ credentialId: record.id, failure: 'rejected', reason: 'again' })
    expect(await open()).toEqual([
      expect.objectContaining({ kind: 'credential-attention', recipientUserId: alice }),
    ])
    await withPlainCommand('credentials.renew', async () => {
      await health.afterRenew(record, { providerChecked: true })
    })
    expect(await open()).toEqual([])
  })

  it('a share inside the share command raises a credential-shared notice for the grantee', async () => {
    const registry = f.handle.registry
    const store = registry.sessionStore
    const alice = f.members.alice.id
    const bob = f.members.bob.id
    const record = await store.credentials.insert({
      ownerUserId: alice,
      label: 'Shared key',
      type: 'anthropic.api-key',
    })
    await withPlainCommand('credentials.share', async () => {
      await registry.modules.credentialHealth.afterShare(record, { userId: bob }, 'use', alice)
    })
    const forBob = (await store.notices.listOpen(bob, { limit: 50 })).filter(
      (row) => row.kind === 'credential-shared',
    )
    expect(forBob).toHaveLength(1)
    expect(forBob[0]?.title).toContain('Shared key')
  })

  it('reads the live sessions on a credential from the store', async () => {
    const health = f.handle.registry.modules.credentialHealth
    expect(await health.sessions.liveSessionIds(CREDENTIAL.id)).toEqual([])
  })
})
