/**
 * `settings.changed` FIRES AFTER THE COMMIT, NEVER INSIDE IT (POD-6349).
 *
 * `settings.updatePersonal` writes the preference row and then tells its
 * subscribers: the Telegram adapter reconfigures (network), notify replays to
 * its targets (network) and auto-continue re-arms sessions. Once the command
 * runs inside one unit of work (POD-6241 Task 10), those reactions must wait for
 * the commit, or they act on a change that can still roll back.
 */

import { readSettingsLeaf } from '@podium/commands'
import { firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { openTestStore } from '../../test-support/open-test-store'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function makeRegistry(): Promise<SessionRegistry> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  return reg
}

const USER = firstAdminMemberId()
const PATCH = { 'roles.superagent.harness': 'codex' }

describe('settings.changed waits for the commit (POD-6349)', () => {
  it('with no unit of work open, the event fires before the write returns (unchanged)', async () => {
    const reg = await makeRegistry()
    const changed = vi.fn()
    reg.bus.on('settings.changed', changed)

    await reg.modules.settings.updatePreferences(USER, PATCH)

    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('a rolled-back change tells no subscriber and leaves the setting as it was', async () => {
    const reg = await makeRegistry()
    const changed = vi.fn()
    reg.bus.on('settings.changed', changed)

    await expect(
      reg.sessionStore.transact(async () => {
        await reg.modules.settings.updatePreferences(USER, PATCH)
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(changed).not.toHaveBeenCalled()
    const settings = await reg.sessionStore.settings.getSettingsFor(USER)
    expect(readSettingsLeaf(settings, 'roles.superagent.harness')).not.toBe('codex')
  })

  it('a committed change tells each subscriber exactly once, after the commit', async () => {
    const reg = await makeRegistry()
    const changed = vi.fn()
    reg.bus.on('settings.changed', changed)

    let callsInsideTheUnitOfWork = -1
    await reg.sessionStore.transact(async () => {
      await reg.modules.settings.updatePreferences(USER, PATCH)
      callsInsideTheUnitOfWork = changed.mock.calls.length
    })

    expect(callsInsideTheUnitOfWork).toBe(0)
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
