/**
 * THE SERVER'S OWN READS NEED NO ACTIVE ADMIN (POD-7597).
 *
 * An in-process session read (`sessionById` and the like, with no principal)
 * used to ask whether the instance had an active admin first, and answered
 * nothing without one. With the only admin disabled, every stop, health check
 * and cleanup that read a session through it saw none and did nothing. The
 * settings read for nobody in particular (git workflow, worktree GC) threw.
 *
 * Each test disables the only admin, then asks what the server itself asks.
 */
import {
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
} from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry, settingsOfNobodyNamed } from './relay'
import type { SessionStore } from './store'
import { memberFacts } from './store/fixtures/test-support'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

const AT = '2026-11-25T12:00:00.000Z'

const opened: { store: SessionStore; reg: SessionRegistry }[] = []

afterEach(async () => {
  for (const { store, reg } of opened.splice(0)) {
    await reg.dispose()
    await store.close()
  }
})

/** An instance whose only member, its admin, owns a parent and a child session. */
async function soleAdminWithSessions(): Promise<{
  store: SessionStore
  reg: SessionRegistry
  admin: UserId
  parent: SessionId
  child: SessionId
}> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  opened.push({ store, reg })
  await attachHostDaemon(reg, () => {})
  const admin = await firstAdminMemberId(store)
  const { sessionId: parent } = await reg.modules.sessions.createSession({
    agentKind: 'shell',
    cwd: '/p',
    ownerUserId: admin,
  })
  const { sessionId: child } = await reg.modules.sessions.createSession({
    agentKind: 'shell',
    cwd: '/p',
    ownerUserId: admin,
    spawnedBy: parent,
  })
  return { store, reg, admin, parent, child }
}

describe('with no active admin, the server still reads its sessions (POD-7597)', () => {
  it('finds the disabled admin’s sessions by id, by set and by parent', async () => {
    const { store, reg, admin, parent, child } = await soleAdminWithSessions()
    const sessions = reg.modules.sessions
    expect(await sessions.sessionById(child)).toBeDefined()

    await memberFacts(store).disable(admin, AT)
    expect(await store.users.earliestAdmin()).toBeUndefined()

    expect((await sessions.sessionById(child))?.sessionId).toBe(child)
    expect((await sessions.sessionsById([parent, child])).map((s) => s.sessionId).sort()).toEqual(
      [parent, child].sort(),
    )
    expect(await sessions.sessionSpawnedBy(child)).toBe(parent)
    // An unknown id is still absent.
    expect(await sessions.sessionById(asSessionId('ses_unknown'))).toBeUndefined()
  })

  // The server's read widened; a person's did not. A later edit that routed a
  // principal's read through the in-process branch would fail here.
  it('still shows another member none of the disabled admin’s sessions', async () => {
    const { store, reg, admin, parent, child } = await soleAdminWithSessions()
    const bob = asUserId('user:no-active-admin-bob')
    await memberFacts(store).create(
      {
        id: bob,
        displayName: 'Bob',
        email: null,
        role: 'member',
        createdAt: AT,
        disabledAt: null,
      },
      'not-a-real-hash',
    )
    await memberFacts(store).disable(admin, AT)
    expect(await store.users.earliestAdmin()).toBeUndefined()

    const sessions = reg.modules.sessions
    // The server itself sees both, so each empty answer below is Bob's alone.
    expect((await sessions.listSessionsForIssue('/p', undefined)).length).toBe(2)
    const asBob = await sessions.view.principalForTrustedUser(bob)
    expect(await sessions.sessionById(child, asBob)).toBeUndefined()
    expect(await sessions.sessionsById([parent, child], asBob)).toEqual([])
    expect(await sessions.sessionSpawnedBy(child, asBob)).toBeUndefined()
    expect(await sessions.listSessionsForIssue('/p', undefined, asBob)).toEqual([])
  })

  it('reads instance policy for nobody in particular instead of failing', async () => {
    const { store, reg, admin } = await soleAdminWithSessions()
    await memberFacts(store).disable(admin, AT)

    const settings = await settingsOfNobodyNamed(store)
    expect(settings).toEqual(await store.settings.getSettings())
    // The issue service's instance-tier reads go through it: worktree GC no
    // longer throws.
    await expect(
      reg.modules.issues.gitWorkflow.listReclaimableWorktrees(Date.now()),
    ).resolves.toBeDefined()
  })

  it('reads the first admin’s settings while there is one', async () => {
    const { store, admin } = await soleAdminWithSessions()
    const forAdmin = vi.spyOn(store.settings, 'getSettingsFor')
    await settingsOfNobodyNamed(store)
    expect(forAdmin).toHaveBeenCalledWith(admin)
  })
})
