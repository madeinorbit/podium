import type { HandoffMachine, UserId } from '@podium/model'
import { normalizeSettings, type PodiumSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { harnessCandidates, SuperagentDefaultSeeder } from './superagent-default'

const USER = 'user_1' as UserId

function machine(
  agents: { kind: string; installed: boolean; state: 'in' | 'out' | 'unknown' }[],
  online = true,
): HandoffMachine {
  return {
    id: 'machine_1',
    online,
    inventory: {
      agents: agents.map((a) => ({
        kind: a.kind,
        installed: a.installed,
        login: { state: a.state },
      })),
    },
  }
}

/** A seeder over one in-memory person, so a test observes the exact leaves written. */
function harness(options: {
  settings?: PodiumSettings
  machines?: HandoffMachine[]
  users?: UserId[]
}) {
  let settings = options.settings ?? normalizeSettings({})
  const writes: Record<string, unknown>[] = []
  const seeder = new SuperagentDefaultSeeder({
    users: () => options.users ?? [USER],
    settingsFor: () => settings,
    machines: () => options.machines ?? [],
    updatePreferences: (_userId, values) => {
      writes.push(values)
      settings = normalizeSettings({
        ...settings,
        roles: {
          ...settings.roles,
          superagent: {
            ...settings.roles.superagent,
            ...(values['roles.superagent.accountId'] !== undefined
              ? { accountId: values['roles.superagent.accountId'] }
              : {}),
            ...(values['roles.superagent.harness'] !== undefined
              ? { harness: values['roles.superagent.harness'] }
              : {}),
            ...(values['roles.superagent.model'] !== undefined
              ? { model: values['roles.superagent.model'] }
              : {}),
            ...(values['roles.superagent.effort'] !== undefined
              ? { effort: values['roles.superagent.effort'] }
              : {}),
          },
        },
      })
    },
  })
  return { seeder, writes, current: () => settings }
}

describe('harnessCandidates', () => {
  it('reads installed and logged-in separately, and only for pickable harnesses', () => {
    const candidates = harnessCandidates([
      machine([
        { kind: 'codex', installed: true, state: 'out' },
        { kind: 'grok', installed: true, state: 'in' },
        { kind: 'claude-code', installed: false, state: 'unknown' },
        { kind: 'opencode', installed: true, state: 'in' },
      ]),
    ])
    expect(candidates).toEqual([
      { harness: 'codex', installed: true, loggedIn: false },
      { harness: 'grok', installed: true, loggedIn: true },
      { harness: 'claude-code', installed: false, loggedIn: false },
    ])
  })

  // An offline machine's binaries are still installed; nothing can be RUN on it,
  // which is what the logged-in half already refuses.
  it('counts an offline machine as installed but never as ready', () => {
    expect(
      harnessCandidates([machine([{ kind: 'codex', installed: true, state: 'in' }], false)]),
    ).toContainEqual({ harness: 'codex', installed: true, loggedIn: false })
  })
})

describe('SuperagentDefaultSeeder', () => {
  it('seeds the account, harness, model and effort of the best available harness', () => {
    const { seeder, writes, current } = harness({
      machines: [machine([{ kind: 'codex', installed: true, state: 'in' }])],
    })
    seeder.seed()
    expect(writes).toEqual([
      {
        'roles.superagent.accountId': 'native:codex',
        'roles.superagent.harness': 'codex',
        'roles.superagent.model': 'gpt-5.6-luna',
        'roles.superagent.effort': 'max',
      },
    ])
    expect(current().roles.superagent.harness).toBe('codex')
  })

  it('is idempotent — a second inventory report writes nothing', () => {
    const { seeder, writes } = harness({
      machines: [machine([{ kind: 'grok', installed: true, state: 'in' }])],
    })
    seeder.seed()
    seeder.seed()
    expect(writes).toHaveLength(1)
  })

  it('leaves a person who has already chosen an account alone', () => {
    const chosen = normalizeSettings({
      roles: { superagent: { accountId: 'native:claude-code' } },
    })
    const { seeder, writes } = harness({
      settings: chosen,
      machines: [machine([{ kind: 'codex', installed: true, state: 'in' }])],
    })
    seeder.seed()
    expect(writes).toEqual([])
  })

  it('keeps a model the person set while still seeding the account', () => {
    const partial = normalizeSettings({ roles: { superagent: { model: 'gpt-5.5' } } })
    const { seeder, writes } = harness({
      settings: partial,
      machines: [machine([{ kind: 'codex', installed: true, state: 'in' }])],
    })
    seeder.seed()
    expect(writes[0]).not.toHaveProperty('roles.superagent.model')
    expect(writes[0]).toMatchObject({ 'roles.superagent.effort': 'max' })
  })

  it('writes nothing before any machine has reported', () => {
    const { seeder, writes } = harness({ machines: [] })
    seeder.seed()
    expect(writes).toEqual([])
  })

  it('writes nothing when the fleet carries no harness it would pick', () => {
    const { seeder, writes } = harness({
      machines: [machine([{ kind: 'opencode', installed: true, state: 'in' }])],
    })
    seeder.seed()
    expect(writes).toEqual([])
  })

  // A seed is a convenience: the inventory report that triggered it must survive
  // a settings write that throws.
  it('survives a failing write', () => {
    const seeder = new SuperagentDefaultSeeder({
      users: () => [USER],
      settingsFor: () => normalizeSettings({}),
      machines: () => [machine([{ kind: 'codex', installed: true, state: 'in' }])],
      updatePreferences: () => {
        throw new Error('write refused')
      },
    })
    expect(() => seeder.seed()).not.toThrow()
  })
})
