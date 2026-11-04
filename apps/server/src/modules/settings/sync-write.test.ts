/**
 * `settings.updatePersonal` ON THE SYNC WRITE ENTRY POINT (POD-6350, ADR 12 D2).
 *
 * It was one of the three outbox commands with no dedup (with `layout.set` and
 * `layout.clear`). Personal settings are not a synced kind yet (POD-5802), so
 * the write appends no change row; its receipt is still the head, which is what
 * confirms a write that changed nothing on the feed (plan Decision 1).
 */

import { readSettingsLeaf } from '@podium/commands'
import { firstAdminMemberId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle } from '../sessions/oracle-support'
import {
  appliedReply,
  envelope,
  expectAppliedOnPath,
  submit,
} from '../sync-write/outbox-test-support'

afterEach(() => disposeOracles())

const ME = firstAdminMemberId()
const PATH = 'roles.superagent.harness'

async function stored(o: Awaited<ReturnType<typeof makeOracle>>): Promise<unknown> {
  return readSettingsLeaf(await o.store.settings.getSettingsFor(ME), PATH)
}

const trail = async (o: Awaited<ReturnType<typeof makeOracle>>) =>
  (await o.store.settingsAudit.list()).filter((row) => row.command === 'settings.updatePersonal')

describe('settings.updatePersonal on sync.submit', () => {
  it('applies once, answers the head, and a replay runs nothing', async () => {
    const o = await makeOracle()

    await expectAppliedOnPath(
      o,
      envelope('settings.updatePersonal', { values: { [PATH]: 'codex' } }, 'm-pref'),
      { writes: false },
    )

    expect(await stored(o)).toBe('codex')
    const replay = appliedReply(
      await submit(
        o,
        envelope('settings.updatePersonal', { values: { [PATH]: 'claude-code' } }, 'm-pref'),
      ),
    )
    expect(replay.replayed).toBe(true)
    expect(await stored(o)).toBe('codex')
    // The trail records the write it ran, once: a replay ran nothing.
    expect((await trail(o)).map((row) => row.outcome)).toEqual(['applied'])
  })

  it('a patch the contract refuses is invalid, and writes nothing', async () => {
    const o = await makeOracle()

    const reply = await submit(
      o,
      envelope('settings.updatePersonal', { values: { 'apiKeys.openai': 'sk-material' } }, 'm-bad'),
    )

    expect(reply).toMatchObject({ outcome: 'rejected', refusal: { kind: 'invalid' } })
    expect(await trail(o)).toEqual([])
  })

  it('a principal with no account is refused by the live gate, and the trail keeps it', async () => {
    const o = await makeOracle()
    const users = o.store.users as unknown as {
      roleOf: (id: string) => Promise<string | undefined>
    }
    users.roleOf = async () => undefined

    const reply = await submit(
      o,
      envelope('settings.updatePersonal', { values: { [PATH]: 'codex' } }, 'm-gate'),
    )

    expect(reply).toEqual({ outcome: 'rejected', refusal: { kind: 'unauthorized' } })
    expect((await trail(o)).map((row) => row.outcome)).toEqual(['refused'])
    expect(await stored(o)).not.toBe('codex')
  })
})

describe('the old settings.updatePersonal route is an adapter onto sync.submit', () => {
  it('deduplicates by the mutationId it carries and keeps its reply', async () => {
    const o = await makeOracle()

    const first = await o.call.settings.updatePersonal({
      values: { [PATH]: 'codex' },
      mutationId: 'm-route-pref',
    } as never)
    expect(readSettingsLeaf(first, PATH)).toBe('codex')
    const again = await o.call.settings.updatePersonal({
      values: { [PATH]: 'claude-code' },
      mutationId: 'm-route-pref',
    } as never)

    expect(readSettingsLeaf(again, PATH)).toBe('codex')
    expect(await stored(o)).toBe('codex')
    expect((await trail(o)).map((row) => row.outcome)).toEqual(['applied'])
  })
})
