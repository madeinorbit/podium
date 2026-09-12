/**
 * A MEMBER CANNOT TURN LOGIN OFF FOR THE WHOLE INSTANCE (PDM-294).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE HAS ITS OWN FILE
 * ---------------------------------------------------------------------------
 *
 * `auth.setLoginRequired` was not one of eighteen unenforced floors. It is the
 * one that had a check in front of it that answered the WRONG QUESTION, and that
 * is a worse defect than an absent check for the reason the false-green
 * catalogue gives about unwitnessed rules: the next reader finds something and
 * stops looking.
 *
 * The contract declares `roleFloor: 'admin'`. The service verified
 * `verifyPasswordHash(input.current, users.credentialFor(callerUserId))` — the
 * CALLER'S OWN password. That answers *"are you the holder of this account"*. It
 * never answers *"is this account an admin"*, and for a command that writes
 * `auth.openMode` into config.json and drops the login requirement for EVERY
 * account on the instance, only the second question matters. Any member who knew
 * their own password satisfied everything the server asked.
 *
 * Two comments in `service.ts` named that password check as the family's
 * enforcement, which is how it survived; both are corrected in the same change
 * as this file.
 *
 * ---------------------------------------------------------------------------
 * THE CASE THAT MAKES THE DISTINCTION VISIBLE
 * ---------------------------------------------------------------------------
 *
 * A member refused with a WRONG password proves nothing — the old code refused
 * that too, for the old reason. The witness is a member refused **with the
 * correct password**, and it is only a witness if the password really is
 * correct, so the fixture asserts that separately against
 * `verifyPasswordHash` rather than leaving it to be believed (catalogue entry
 * 14: does the fixture construct the situation the test claims?).
 *
 * The third case keeps the confirmation honest. The password check was NOT
 * deleted — it is a real defence against a hijacked admin session — so an admin
 * with the wrong password must still be refused, and by a DIFFERENT code. If
 * that case ever goes green with `FORBIDDEN`, the confirmation has been lost
 * behind the floor.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asUserId, firstAdminMemberId, type UserId } from '@podium/model'
import { hashPassword, verifyPasswordHash } from '@podium/runtime/auth-store'
import { loadConfig } from '@podium/runtime/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal, userCommandPrincipal } from '../../command-principal'
import { SuperagentService } from '../../modules/superagent'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { OPERATOR } from '../../test-support/capabilities'

const MEMBER = asUserId('user:pdm294-login-member')
const MEMBER_PASSWORD = 'the-member-knows-this-one'
const ADMIN_PASSWORD = 'the-admin-knows-this-one'

type Caller = ReturnType<typeof appRouter.createCaller>

const priorStateDir = process.env.PODIUM_STATE_DIR

describe('auth.setLoginRequired — the floor, not the password', () => {
  let dir: string
  let registry: SessionRegistry
  let admin: Caller
  let member: Caller
  let users: SessionRegistry['sessionStore']['users']

  beforeEach(async () => {
    // `setLoginRequired` WRITES config.json, so it needs a state dir of its own
    // or it would edit whatever this machine is actually running.
    dir = mkdtempSync(join(tmpdir(), 'podium-pdm294-login-'))
    process.env.PODIUM_STATE_DIR = dir

    registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    const repos = new RepoRegistry(registry, registry.sessionStore)
    const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
    users = registry.sessionStore.users

    const callerFor = (capability: Parameters<typeof resolvePrincipal>[0]): Caller =>
      appRouter.createCaller({
        registry,
        repos,
        superagent,
        users,
        capability,
        principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
      } as Parameters<typeof appRouter.createCaller>[0])

    // The first admin is the instance's existing account; give it a password so
    // the confirmation arm has something real to verify against.
    await users.setPasswordHash(
      firstAdminMemberId(),
      await hashPassword(ADMIN_PASSWORD),
      new Date().toISOString(),
    )
    admin = callerFor(OPERATOR)

    // A SECOND, REAL PERSON at member grade — not a second identity wearing the
    // admin capability, which would decide every assertion here by the admin
    // path rather than by the floor.
    await users.create(
      {
        id: MEMBER,
        displayName: 'Member',
        email: null,
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      await hashPassword(MEMBER_PASSWORD),
    )
    member = callerFor(userCommandPrincipal(MEMBER as UserId, 'member').capability)
  })

  afterEach(async () => {
    await registry.dispose()
    if (priorStateDir === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = priorStateDir
    rmSync(dir, { recursive: true, force: true })
  })

  /**
   * THE FIXTURE GUARD. Everything below turns on the member's password being
   * genuinely correct; if this fixture ever stopped storing a verifiable hash,
   * the refusal case would pass for the old reason and report the new one.
   */
  it('the member really does know their own password', async () => {
    const stored = (await users.credentialFor(MEMBER))?.passwordHash
    expect(stored).toBeDefined()
    expect(await verifyPasswordHash(MEMBER_PASSWORD, stored as string)).toBe(true)
  })

  it('refuses a member WHO SUPPLIES THE CORRECT PASSWORD, by name', async () => {
    await expect(
      member.auth.setLoginRequired({
        required: false,
        current: MEMBER_PASSWORD,
        acknowledgeNoPassword: true,
      }),
    ).rejects.toThrow(/auth\.setLoginRequired requires an admin account/)

    // AND THE WRITE DID NOT HAPPEN. A refusal that threw after saving the config
    // would satisfy the assertion above and leave the instance open.
    expect(loadConfig().auth?.openMode ?? false).toBe(false)
  })

  it('serves the same call to an admin, so the refusal is the floor and not the input', async () => {
    await expect(
      admin.auth.setLoginRequired({
        required: false,
        current: ADMIN_PASSWORD,
        acknowledgeNoPassword: true,
      }),
    ).resolves.toBeDefined()
    expect(loadConfig().auth?.openMode).toBe(true)
  })

  /**
   * THE CONFIRMATION IS STILL THERE. `UNAUTHORIZED`, not `FORBIDDEN` — a
   * different question, refused for a different reason, and the pair is what
   * says the floor was ADDED rather than swapped in for the password check.
   */
  it('still refuses an admin with the wrong password, and not as a floor failure', async () => {
    await expect(
      admin.auth.setLoginRequired({
        required: false,
        current: 'not-the-admin-password',
        acknowledgeNoPassword: true,
      }),
    ).rejects.toThrow(/current password is incorrect/)
    expect(loadConfig().auth?.openMode ?? false).toBe(false)
  })
})
