/**
 * WHOSE PREFERENCES A SPAWN READS (PDM-295).
 *
 * `roles.*` and `autoContinue.*` are `preferences-personal` and live on
 * `user_preferences`, so every one of these reads has to name a person. Until
 * this file existed they named the EARLIEST ADMIN — `settingsViewer()` returned
 * `firstAdminMemberId()` for every caller — which meant a second member's spawn
 * ran on somebody else's model, somebody else's effort and somebody else's
 * account slot.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ASSERTIONS CAN SAY NO
 * ---------------------------------------------------------------------------
 *
 * Every case seeds BOTH people with DIFFERENT non-default values at the SAME
 * path and then asserts EACH one gets their own. A test that only checked Ben
 * would pass against a resolver that had simply stopped reading anything, and a
 * test that only checked Ada would pass against the defect itself.
 *
 * Ada is not an invented id: she is the admin the migration chain mints, read
 * back from the store, so she genuinely IS `earliestAdmin()` and the pre-fix
 * code genuinely does resolve to her. Seeding a "first admin" of my own would
 * have tested a fixture rather than the defect.
 *
 * Real `SessionStore`, real `SettingsRepository`, real `AccountsRepository`. The
 * property under test is which user id reaches a WHERE clause; a fake would have
 * to re-implement that and would then agree with itself.
 */

import { asAccountId, asUserId, type UserId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../store'
import { openTestStore } from '../../test-support/open-test-store'
import { SessionLaunchConfig } from './launch-config'

const AT = '2026-09-13T00:00:00.000Z'
const BEN = asUserId('mem_0BBBBBBBBBBBBBBBBBBBBBBBBBB')

let store: SessionStore
/** The admin the migration chain minted — the person the defect resolved to. */
let ada: UserId
let launch: SessionLaunchConfig

beforeEach(async () => {
  store = await openTestStore(':memory:')
  const earliest = await store.users.earliestAdmin()
  if (!earliest) throw new Error('fixture: the migrated store has no earliest admin')
  ada = asUserId(earliest.id)
  await store.users.create(
    {
      id: BEN,
      displayName: 'Ben',
      role: 'member',
      createdAt: '2099-01-01T00:00:00.000Z',
      disabledAt: null,
    },
    'scrypt:hash',
  )
  // Ada must really be the earliest admin, or every assertion below is vacuous.
  expect((await store.users.earliestAdmin())?.id).toBe(ada)
  launch = new SessionLaunchConfig({ store })
})

describe('the model and effort a spawn carries', () => {
  it("is the spawning member's own, not the earliest admin's", async () => {
    await store.settings.userPreferences.set(ada, 'roles.coding.model', 'ada-model', AT)
    await store.settings.userPreferences.set(BEN, 'roles.coding.model', 'ben-model', AT)

    expect((await launch.modelDefaults('claude-code', BEN)).model).toBe('ben-model')
    // …and Ada still gets hers, so this is not green because the read stopped
    // resolving anything at all.
    expect((await launch.modelDefaults('claude-code', ada)).model).toBe('ada-model')
  })

  it('carries the spawning member’s own effort', async () => {
    await store.settings.userPreferences.set(ada, 'roles.coding.effort', 'low', AT)
    await store.settings.userPreferences.set(BEN, 'roles.coding.effort', 'high', AT)

    expect((await launch.modelDefaults('claude-code', BEN)).effort).toBe('high')
    expect((await launch.modelDefaults('claude-code', ada)).effort).toBe('low')
  })
})

describe('the account SLOT a spawn runs on', () => {
  it('is chosen by the session owner, so their own credential fits it', async () => {
    // THE CASE PDM-280 §7.4 DESCRIBED. Ada runs coding on OpenAI; Ben runs it on
    // Anthropic and has connected the key for the slot HE chose. Reading the
    // slot as Ada refuses Ben on a slot he never picked and cannot change from
    // his own settings — with his own working credential sitting right there.
    await store.settings.userPreferences.set(ada, 'roles.coding.accountId', 'managed:openai', AT)
    await store.settings.userPreferences.set(
      BEN,
      'roles.coding.accountId',
      'managed:anthropic',
      AT,
    )
    await store.accounts.upsert(BEN, {
      id: asAccountId('managed:anthropic'),
      provider: 'anthropic',
      kind: 'api-key',
      credential: 'sk-ant-ben',
      identity: 'x',
      scope: 'role',
      createdAt: 1,
    })

    expect(await launch.accountEnv('claude-code', BEN)).toEqual({
      env: { ANTHROPIC_API_KEY: 'sk-ant-ben' },
    })
  })

  it('still refuses a slot the owner chose but has no credential for', async () => {
    // The negative twin: resolving the slot per-person must not turn into
    // resolving the CREDENTIAL loosely. Ben picks Anthropic and connects
    // nothing, so he is refused — by name, without borrowing Ada's key.
    await store.settings.userPreferences.set(
      BEN,
      'roles.coding.accountId',
      'managed:anthropic',
      AT,
    )
    await store.accounts.upsert(ada, {
      id: asAccountId('managed:anthropic'),
      provider: 'anthropic',
      kind: 'api-key',
      credential: 'sk-ant-ada',
      identity: 'x',
      scope: 'role',
      createdAt: 1,
    })

    await expect(launch.accountEnv('claude-code', BEN)).rejects.toThrow(
      /no managed credential for 'anthropic'/,
    )
    await expect(launch.accountEnv('claude-code', BEN)).rejects.not.toThrow(/sk-ant-ada/)
  })
})
