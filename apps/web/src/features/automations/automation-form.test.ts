import { asMachineId, type GitRepositoryWire, type MachineWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type AutomationFormState,
  automationClassOf,
  automationFormFields,
  automationInput,
  automationMachineViews,
  automationRight,
  automationTargetChoices,
  canSaveAutomation,
  cronInvalid,
  GLOBAL_TARGET,
  NEW_AUTOMATION_RIGHTS,
  scheduleValid,
  userAutomations,
} from './automation-form'

const NOW = Date.parse('2026-08-03T12:00:00.000Z')

const state = (patch: Partial<AutomationFormState> = {}): AutomationFormState => ({
  name: 'Nightly sweep',
  kind: 'schedule',
  freq: 'daily',
  time: '09:00',
  weekday: 1,
  rawCron: '',
  runAt: '',
  reactive: 'merge-main',
  glob: '',
  target: '/repos/podium',
  prompt: 'Run the suite.',
  agent: 'claude-code',
  model: 'auto',
  effort: 'auto',
  enabled: true,
  sessionMode: 'fresh',
  ...patch,
})

const ids = (s: AutomationFormState): string[] => automationFormFields(s).map((f) => f.id)

const repo = (path: string, patch: Partial<GitRepositoryWire> = {}): GitRepositoryWire =>
  ({ path, kind: 'repository', worktrees: [], ...patch }) as GitRepositoryWire

const machine = (id: string, patch: Partial<MachineWire> = {}): MachineWire =>
  ({
    id,
    name: id,
    hostname: id,
    online: true,
    lastSeenAt: '2026-08-03T11:00:00.000Z',
    ...patch,
  }) as MachineWire

describe('subform configs drive which fields exist', () => {
  it('shows only the frequency-relevant schedule fields', () => {
    expect(ids(state({ freq: 'daily' }))).toContain('automation-time')
    expect(ids(state({ freq: 'daily' }))).not.toContain('automation-weekday')

    const weekly = ids(state({ freq: 'weekly' }))
    expect(weekly).toContain('automation-weekday')
    expect(weekly).toContain('automation-time')

    const cron = ids(state({ freq: 'cron' }))
    expect(cron).toContain('automation-cron')
    expect(cron).not.toContain('automation-time')

    const once = ids(state({ freq: 'once' }))
    expect(once).toContain('automation-run-at')
    expect(once).not.toContain('automation-cron')
  })

  it('swaps the whole per-type block when the trigger kind changes', () => {
    const reactive = ids(state({ kind: 'reactive' }))
    expect(reactive).toContain('automation-reactive')
    expect(reactive).not.toContain('automation-frequency')
    // The glob only exists for the trigger that needs it.
    expect(reactive).not.toContain('automation-glob')
    expect(ids(state({ kind: 'reactive', reactive: 'file-changed' }))).toContain('automation-glob')
  })

  it('keeps the shared fields in every subform', () => {
    for (const s of [state(), state({ kind: 'reactive' })]) {
      expect(ids(s)).toEqual(
        expect.arrayContaining([
          'automation-name',
          'automation-target',
          'automation-session-mode',
          'automation-prompt',
          'automation-agent',
          'automation-enabled',
        ]),
      )
    }
  })
})

describe('the cron guard survives the config conversion', () => {
  const rights = automationRight('create', NEW_AUTOMATION_RIGHTS(true))

  it('refuses an empty custom-cron box rather than falling back to every minute', () => {
    const s = state({ freq: 'cron', rawCron: '' })
    expect(scheduleValid(s, NOW)).toBe(false)
    expect(canSaveAutomation(s, rights, NOW)).toBe(false)
    // Empty is not yet WRONG — it is just not valid; only typed garbage is flagged.
    expect(cronInvalid(s)).toBe(false)
  })

  it('refuses a malformed expression and flags the field', () => {
    const s = state({ freq: 'cron', rawCron: '99 * * * *' })
    expect(cronInvalid(s)).toBe(true)
    expect(canSaveAutomation(s, rights, NOW)).toBe(false)
  })

  it('accepts a well-formed expression', () => {
    const s = state({ freq: 'cron', rawCron: '*/30 * * * *' })
    expect(scheduleValid(s, NOW)).toBe(true)
    expect(canSaveAutomation(s, rights, NOW)).toBe(true)
    expect(automationInput(s, null).cron).toBe('*/30 * * * *')
  })

  it('refuses a one-off in the past and accepts one in the future', () => {
    expect(scheduleValid(state({ freq: 'once', runAt: '2020-01-01T00:00' }), NOW)).toBe(false)
    expect(scheduleValid(state({ freq: 'once', runAt: '2099-01-01T00:00' }), NOW)).toBe(true)
  })

  it('never lets the reactive subform save — it has no runner', () => {
    expect(canSaveAutomation(state({ kind: 'reactive' }), rights, NOW)).toBe(false)
  })
})

describe('targets are bounded by machine USE', () => {
  const repos = [
    repo('/repos/mine', { machineId: asMachineId('m-mine') }),
    repo('/repos/theirs', { machineId: asMachineId('m-theirs') }),
    repo('/repos/offline', { machineId: asMachineId('m-offline') }),
    repo('/repos/mine/wt', { machineId: asMachineId('m-mine'), kind: 'worktree' }),
  ]
  const machines = [
    machine('m-mine', { use: 'granted' }),
    machine('m-theirs', { use: 'denied' }),
    machine('m-offline', { use: 'granted', online: false }),
  ]

  it('offers only usable targets and counts the rest by reason', () => {
    const { choices, excluded } = automationTargetChoices(
      repos,
      [],
      automationMachineViews(machines),
    )
    expect(choices.map((c) => c.value)).toEqual(['/repos/mine', GLOBAL_TARGET])
    // Unauthorized and unreachable stay distinguishable (§3.1.4 M5).
    expect(excluded).toEqual({ unauthorized: 1, unreachable: 1 })
  })

  it('reads an unscoped machine list permissively, so single-user parity holds', () => {
    const unscoped = [machine('m-mine'), machine('m-theirs'), machine('m-offline')]
    const { choices, excluded } = automationTargetChoices(
      repos,
      [],
      automationMachineViews(unscoped),
    )
    expect(choices.map((c) => c.value)).toEqual([
      '/repos/mine',
      '/repos/theirs',
      '/repos/offline',
      GLOBAL_TARGET,
    ])
    expect(excluded).toEqual({ unauthorized: 0, unreachable: 0 })
  })

  it('renders an unusable saved target as an opaque, unselectable reference', () => {
    const { choices } = automationTargetChoices(
      repos,
      [],
      automationMachineViews(machines),
      '/repos/theirs',
    )
    const opaque = choices.find((c) => c.value === '/repos/theirs')
    expect(opaque?.opaque).toBe(true)
    expect(opaque?.availability).toBe('unauthorized')
    // Distinguishable from offline, which says something the user can act on.
    const offline = automationTargetChoices(
      repos,
      [],
      automationMachineViews(machines),
      '/repos/offline',
    ).choices.find((c) => c.value === '/repos/offline')
    expect(offline?.availability).toBe('unreachable')
    expect(offline?.label).toContain('offline')
  })
})

describe('the rights predicate', () => {
  const user = { systemClass: false, owned: true, visible: true, hasUsableTarget: true }

  it('refuses every act on a system automation, and says why', () => {
    for (const action of ['create', 'edit', 'enable', 'disable', 'delete'] as const) {
      const d = automationRight(action, { ...user, systemClass: true })
      expect(d.allowed).toBe(false)
      expect(d.allowed === false && d.reason).toBe('system')
    }
  })

  it('refuses someone else’s delegation before it looks at anything else', () => {
    const d = automationRight('edit', { ...user, owned: false, visible: false })
    expect(d.allowed === false && d.reason).toBe('not-owner')
  })

  it('gates the code-running acts on a usable machine, but never stop or delete', () => {
    const noTarget = { ...user, hasUsableTarget: false }
    expect(automationRight('create', noTarget).allowed).toBe(false)
    expect(automationRight('edit', noTarget).allowed).toBe(false)
    expect(automationRight('enable', noTarget).allowed).toBe(false)
    // An owner must always be able to stop or remove their own automation.
    expect(automationRight('disable', noTarget).allowed).toBe(true)
    expect(automationRight('delete', noTarget).allowed).toBe(true)
  })

  it('blocks save when the right is denied, whatever the form says', () => {
    const denied = automationRight('create', { ...user, systemClass: true })
    expect(canSaveAutomation(state({ freq: 'cron', rawCron: '*/30 * * * *' }), denied, NOW)).toBe(
      false,
    )
  })
})

describe('automation class', () => {
  it('reads every automation as user-class until the server stamps one', () => {
    expect(automationClassOf({ name: 'Nightly sweep' })).toBe('user')
    expect(automationClassOf({ name: 'steward', system: true })).toBe('system')
  })

  it('keeps system automations out of the user list entirely', () => {
    const rows = [{ name: 'mine' }, { name: 'steward', system: true }]
    expect(userAutomations(rows)).toEqual([{ name: 'mine' }])
  })
})

describe('the mutation payload', () => {
  it('carries no actor, owner or origin (§3.1.3 A3)', () => {
    const input = automationInput(state(), null)
    for (const forbidden of ['actor', 'owner', 'origin', 'onBehalfOf', 'createdBy', 'userId']) {
      expect(Object.hasOwn(input, forbidden)).toBe(false)
    }
  })

  it('preserves an explicit session target across an edit', () => {
    expect(automationInput(state(), { targetSessionId: 'sess_sleeping' }).targetSessionId).toBe(
      'sess_sleeping',
    )
  })

  it('sends the home directory as a null repo path', () => {
    expect(automationInput(state({ target: GLOBAL_TARGET }), null).repoPath).toBeNull()
  })
})
