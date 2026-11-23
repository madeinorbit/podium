import {
  type AgentInventory,
  asMachineId,
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  type Inventory,
  type SessionId,
} from '@podium/model'
import type { HarnessActionResult, HarnessInstallAction } from '@podium/protocol'
import { observable, observableRef, runInAction } from 'mobx'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SETUP_GROUP_ORDER,
  type AgentSetupOrigin,
  type AgentSetupPreferences,
  AgentSetupView,
} from './agent-setup-view'
import { MachineHarness } from './machine-harness'
import type { MachineModel } from './synced-models'

// ---------------------------------------------------------------------------
// Fixture machines
// ---------------------------------------------------------------------------

class Machine {
  readonly id = asMachineId('test-machine')
  readonly name = 'Build box'
  @observable accessor online = true
  use = 'granted' as const
  @observableRef accessor inventory: Inventory | undefined = {
    os: 'linux',
    arch: 'x64',
    agents: [],
    tools: [],
  }
  readonly harnessInstalls = BUILTIN_HARNESS_KINDS.map(
    (kind) => new MachineHarness(this as unknown as MachineModel, kind),
  )
  setAgents(agents: AgentInventory[]): void {
    runInAction(() => {
      this.inventory = { os: 'linux', arch: 'x64', agents, tools: [] }
    })
  }
  patchAgent(kind: BuiltinHarnessKind, patch: Partial<AgentInventory>): void {
    const agents = this.inventory?.agents ?? []
    this.setAgents(agents.map((agent) => (agent.kind === kind ? { ...agent, ...patch } : agent)))
  }
}

const notInstalled = (kind: BuiltinHarnessKind): AgentInventory => ({
  kind,
  installed: false,
  login: { state: 'unknown' },
  management: { installable: true, homeVariable: 'HOME_VAR' },
})
const own = (kind: BuiltinHarnessKind, login: 'in' | 'out' | 'unknown'): AgentInventory => ({
  kind,
  installed: true,
  version: '2.0.0',
  login: { state: login, ...(login === 'in' ? { account: 'person@example.com' } : {}) },
  management: { installable: true },
})
const managed = (
  kind: BuiltinHarnessKind,
  login: 'in' | 'out' | 'unknown',
  over: Partial<NonNullable<NonNullable<AgentInventory['install']>['managed']>> = {},
): AgentInventory => ({
  kind,
  installed: true,
  version: '1.5.0',
  login: { state: login },
  management: { installable: true, homeVariable: 'HOME_VAR' },
  install: {
    managed: {
      active: { path: '/state/x', version: '1.5.0', release: 2 },
      previousVersion: '1.4.0',
      paused: false,
      ...over,
    },
  },
})

/** Every builtin harness in a known state: one of each group. */
function mixedAgents(): AgentInventory[] {
  return [
    managed('codex', 'in'),
    own('claude-code', 'out'),
    {
      ...notInstalled('grok'),
      install: { managed: { paused: false, installing: { version: '3.0.0' } } },
    },
    notInstalled('opencode'),
    notInstalled('cursor'),
    {
      ...notInstalled('pi'),
      install: {
        managed: {
          paused: false,
          lastError: { at: '2026-11-23T10:00:00Z', message: 'Download failed: 503' },
        },
      },
    },
    {
      ...notInstalled('antigravity'),
      management: { installable: false, reason: 'Not available for linux arm64.' },
    },
  ]
}

class Defaults {
  @observableRef accessor value: Partial<Record<BuiltinHarnessKind, string>> = {
    grok: 'cred_other',
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(cause: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(
  options: {
    agents?: AgentInventory[]
    origin?: AgentSetupOrigin
    focus?: BuiltinHarnessKind
    saved?: Partial<Record<BuiltinHarnessKind, { id: string; label: string }[]>>
  } = {},
) {
  const machine = new Machine()
  machine.setAgents(options.agents ?? mixedAgents())
  const actions: {
    action: HarnessInstallAction
    harness: BuiltinHarnessKind
    confirmedConversations?: string[]
    reply: Deferred<HarnessActionResult>
  }[] = []
  const logins: { harness: BuiltinHarnessKind; reply: Deferred<{ sessionId: SessionId }> }[] = []
  const client = {
    harnessInstalls: {
      action: {
        mutate: vi.fn(
          (input: {
            harness: BuiltinHarnessKind
            action: HarnessInstallAction
            confirmedConversations?: string[]
          }) => {
            const reply = deferred<HarnessActionResult>()
            actions.push({ ...input, reply })
            return reply.promise
          },
        ),
      },
    },
    credentials: {
      login: {
        mutate: vi.fn((input: { harness: BuiltinHarnessKind }) => {
          const reply = deferred<{ sessionId: SessionId }>()
          logins.push({ harness: input.harness, reply })
          return reply.promise
        }),
      },
    },
  }
  const defaults = new Defaults()
  const saves: Partial<Record<BuiltinHarnessKind, string>>[] = []
  const preferences: AgentSetupPreferences = {
    credentialDefaults: () => defaults.value,
    saveCredentialDefaults: (next) => {
      saves.push(next)
      runInAction(() => {
        defaults.value = next
      })
    },
    savedCredentials: (harness) => options.saved?.[harness] ?? [],
  }
  const view = new AgentSetupView({
    machine: machine as unknown as MachineModel,
    client,
    preferences,
    origin: options.origin ?? { kind: 'settings' },
    ...(options.focus ? { focus: options.focus } : {}),
  })
  const item = (kind: BuiltinHarnessKind) => {
    const found = view.itemFor(kind)
    if (!found) throw new Error(`no item for ${kind}`)
    return found
  }
  return { machine, view, client, actions, logins, saves, defaults, item }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const ok = (over: Partial<HarnessActionResult> = {}): HarnessActionResult => ({ ok: true, ...over })

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('agent setup groups', () => {
  it('puts each harness in one group, in panel order, and counts them in the summary', () => {
    const { view } = setup()
    expect(view.groups.map((group) => [group.title, group.items.map((item) => item.kind)])).toEqual(
      [
        ['Didn’t install', ['pi']],
        ['Installing', ['grok']],
        ['Ready', ['codex']],
        ['Needs sign-in', ['claude-code']],
        ['Not installed', ['opencode', 'cursor']],
        ['Can’t install here', ['antigravity']],
      ],
    )
    expect(view.groups.map((group) => group.status)).toEqual(AGENT_SETUP_GROUP_ORDER)
    expect(view.summary).toBe(
      '1 ready · 1 installing · 1 needs sign-in · 2 not installed · 1 didn’t install · 1 can’t install here',
    )
  })

  it('leaves out empty groups and counts only what is there', () => {
    const { view } = setup({
      agents: [
        managed('codex', 'in'),
        own('claude-code', 'unknown'),
        {
          ...notInstalled('grok'),
          install: { managed: { paused: false, installing: {} } },
        },
        own('opencode', 'out'),
        notInstalled('cursor'),
        notInstalled('pi'),
        notInstalled('antigravity'),
      ],
    })
    expect(view.groups.map((group) => group.status)).toEqual([
      'installing',
      'ready',
      'needs-sign-in',
      'not-installed',
    ])
    expect(view.summary).toBe('2 ready · 1 installing · 1 needs sign-in · 3 not installed')
  })

  it('carries version, source, sign-in, blocked reason and install label per item', () => {
    const { item, machine } = setup()
    expect(item('codex')).toMatchObject({ version: '1.5.0', source: 'podium' })
    expect(item('codex').sourceLabel).toBe('Podium’s copy')
    expect(item('codex').signIn.state).toBe('signed-in')
    expect(item('claude-code')).toMatchObject({ version: '2.0.0', source: 'own' })
    expect(item('claude-code').signIn.state).toBe('signed-out')
    expect(item('claude-code').signIn.stateLabel).toBe('Not signed in')
    expect(item('grok').progressLabel).toBe('Installing 3.0.0…')
    expect(item('pi').failure).toBe('Download failed: 503')
    expect(item('pi').installLabel).toBe('Try again')
    expect(item('antigravity').blocked).toEqual({ reason: 'Not available for linux arm64.' })
    expect(item('opencode').blocked).toBeUndefined()

    machine.patchAgent('claude-code', {
      missingPrerequisites: [
        {
          executable: 'bwrap',
          package: 'bubblewrap',
          neededFor: 'passed-in-credential',
          message: 'Claude Code needs bubblewrap here.',
        },
      ],
    })
    expect(item('claude-code').prerequisites).toEqual([
      { reason: 'Claude Code needs bubblewrap here.', fix: 'Install bubblewrap on this machine.' },
    ])
    expect(item('claude-code').status).toBe('needs-sign-in')
  })

  it('puts an unreported harness under can’t install with the reason', () => {
    const { view, item } = setup({
      agents: [
        {
          ...notInstalled('codex'),
          installed: null,
          probeError: { reason: 'timed-out', timeoutMs: 30_000 },
        },
      ],
    })
    expect(item('codex').status).toBe('blocked')
    expect(item('codex').blocked?.reason).toContain('timed out after 30s')
    expect(item('pi').blocked?.reason).toBe('This machine does not report Pi.')
    expect(view.checking).toBe(false)
  })

  it('shows nothing while the machine has not sent an inventory', () => {
    const { view, machine } = setup()
    runInAction(() => {
      machine.inventory = undefined
    })
    expect(view.checking).toBe(true)
    expect(view.groups).toEqual([])
    expect(view.summary).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Selection and installs
// ---------------------------------------------------------------------------

describe('agent setup selection and installs', () => {
  it('selects only not-installed harnesses and installs them all at once', async () => {
    const { view, actions, item, machine } = setup()
    view.toggle('codex')
    view.toggle('antigravity')
    view.toggle('opencode')
    expect(view.selectedKinds).toEqual(['opencode'])
    view.selectAllNotInstalled()
    expect(view.selectedKinds).toEqual(['opencode', 'cursor'])
    expect(view.installSelectedLabel).toBe('Install 2 selected')
    expect(view.canInstallSelected).toBe(true)

    view.installSelected()
    // Both requests go out before either answers.
    expect(actions.map((call) => [call.harness, call.action])).toEqual([
      ['opencode', 'install'],
      ['cursor', 'install'],
    ])
    expect(view.selectedKinds).toEqual([])
    expect(item('opencode').status).toBe('installing')
    expect(item('cursor').status).toBe('installing')
    expect(item('opencode').progressLabel).toBe('Installing OpenCode…')
    expect(
      view.groups.find((group) => group.status === 'installing')?.items.map((i) => i.kind),
    ).toEqual(['grok', 'opencode', 'cursor'])

    actions[0]?.reply.resolve(ok())
    machine.patchAgent('opencode', managed('opencode', 'unknown'))
    await settle()
    expect(item('opencode').status).toBe('ready')
    expect(item('opencode').source).toBe('podium')
  })

  it('drops a ticked harness from the selection once it is no longer not-installed', () => {
    const { view, machine } = setup()
    view.toggle('cursor')
    expect(view.selectedKinds).toEqual(['cursor'])
    machine.patchAgent('cursor', own('cursor', 'unknown'))
    expect(view.selectedKinds).toEqual([])
    expect(view.canInstallSelected).toBe(false)
  })

  it('shows a refused install as didn’t install and retries it', async () => {
    const { actions, item } = setup()
    item('cursor').install()
    actions[0]?.reply.resolve({ ok: false, error: 'No space left on device' })
    await settle()
    expect(item('cursor').status).toBe('failed')
    expect(item('cursor').failure).toBe('No space left on device')

    item('cursor').retry()
    expect(actions.map((call) => [call.harness, call.action])).toEqual([
      ['cursor', 'install'],
      ['cursor', 'install'],
    ])
    expect(item('cursor').status).toBe('installing')
    actions[1]?.reply.reject(new Error('machine went away'))
    await settle()
    expect(item('cursor').failure).toBe('machine went away')
  })

  it('a cancelled install, from here or another client, goes back to not installed', async () => {
    const { actions, item } = setup()
    item('cursor').install()
    actions[0]?.reply.resolve({
      ok: false,
      outcome: 'cancelled',
      error: 'The install was cancelled.',
    } as HarnessActionResult)
    await settle()
    expect(item('cursor').failure).toBeUndefined()
    expect(item('cursor').status).toBe('not-installed')
  })

  it('does not install where Podium can’t, or while the machine is offline', () => {
    const { item, actions, machine } = setup()
    item('antigravity').install()
    expect(actions).toEqual([])
    runInAction(() => {
      machine.online = false
    })
    expect(item('cursor').canInstall).toBe(false)
    item('cursor').install()
    expect(actions).toEqual([])
  })

  it('cancels an install only when the machine offers cancel', () => {
    const { item, actions } = setup()
    expect(item('grok').canCancel).toBe(false)
    item('grok').cancel()
    expect(actions).toEqual([])
    // The install-progress task adds `cancel` to an installing row's actions.
    Object.defineProperty(item('grok').row, 'actions', { value: ['cancel-install'] })
    expect(item('grok').canCancel).toBe(true)
    item('grok').cancel()
    expect(actions.map((call) => [call.harness, call.action])).toEqual([['grok', 'cancel-install']])
  })
})

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

describe('agent setup detail', () => {
  const states: [string, AgentInventory][] = [
    ['not installed', notInstalled('codex')],
    ['own', own('codex', 'in')],
    ['managed', managed('codex', 'in')],
    ['managed, paused', managed('codex', 'in', { paused: true })],
    ['vendor updated', managed('codex', 'in', { vendorUpdated: true })],
    [
      'both',
      {
        ...managed('codex', 'in'),
        install: {
          external: { path: '/own/codex', version: '1.0.0' },
          managed: { active: { path: '/s', version: '1.5.0', release: 1 }, paused: false },
        },
      },
    ],
    [
      'shared',
      {
        ...managed('codex', 'in'),
        management: { installable: false },
        install: {
          external: { path: '/own/codex', version: '1.0.0' },
          managed: { active: { path: '/s', version: '1.5.0', release: 1 }, paused: false },
        },
      },
    ],
  ]

  it.each(states)('offers every Settings action for a %s harness', (_name, inventory) => {
    const { view, item } = setup({ agents: [inventory] })
    view.openDetail('codex')
    const detail = view.detail
    if (!detail) throw new Error('no detail')
    expect(detail.sections.flatMap((section) => section.actions)).toEqual(
      expect.arrayContaining([...item('codex').row.actions]),
    )
    expect(detail.sections.flatMap((section) => section.actions)).toHaveLength(
      item('codex').row.actions.length,
    )
  })

  it('names the facts, updates and own-install actions of a harness with both installs', () => {
    const { view } = setup({
      agents: [
        {
          ...managed('codex', 'in'),
          install: {
            external: { path: '/own/codex', version: '1.0.0' },
            managed: {
              active: { path: '/s', version: '1.5.0', release: 1 },
              previousVersion: '1.4.0',
              latest: '1.6.0',
              paused: false,
            },
          },
        },
      ],
    })
    view.openDetail('codex')
    const detail = view.detail
    if (!detail) throw new Error('no detail')
    expect(detail.podiumVersion).toBe('1.5.0')
    expect(detail.ownVersion).toBe('1.0.0')
    expect(detail.latestVersion).toBe('1.6.0')
    expect(detail.autoUpdate).toBe(true)
    expect(detail.item.signIn.stateLabel).toBe('Signed in')
    expect(detail.sections.map((section) => [section.key, section.actions])).toEqual([
      ['updates', ['check', 'back', 'pause']],
      ['own', ['take-settings', 'changes', 'remove-changes']],
      ['home', ['home-info']],
      ['remove', ['remove']],
    ])
    expect(detail.label('pause')).toBe('Turn off automatic updates')
    expect(detail.label('back')).toBe('Go back to 1.4.0')
    expect(detail.label('home-info')).toBe('Podium home…')
  })

  it('asks before removing and shows the running-sessions note', async () => {
    const { view, actions } = setup({ agents: [managed('codex', 'in')] })
    view.openDetail('codex')
    const detail = view.detail
    if (!detail) throw new Error('no detail')
    detail.press('remove')
    expect(actions).toEqual([])
    expect(detail.confirmingRemove).toBe(true)
    expect(detail.removeConfirmation).toContain('Remove Podium’s copy of Codex?')
    detail.confirmRemove()
    expect(actions.map((call) => call.action)).toEqual(['remove'])
    actions[0]?.reply.resolve(ok({ pendingSessions: 2 }))
    await settle()
    expect(detail.pendingSessionsNote).toBe(
      'Removal is waiting for 2 running sessions. Homes and conversations are kept.',
    )
  })

  it('shows the Podium home and deletes it naming its conversations', async () => {
    const { view, actions } = setup({ agents: [managed('codex', 'in')] })
    view.openDetail('codex')
    const detail = view.detail
    if (!detail) throw new Error('no detail')
    detail.press('home-info')
    actions[0]?.reply.resolve(
      ok({ homeExists: true, conversations: [{ id: 'c1', title: 'Fix login' }] }),
    )
    await settle()
    expect(detail.home).toEqual({ exists: true, conversations: [{ id: 'c1', title: 'Fix login' }] })
    expect(detail.sections.find((section) => section.key === 'home')?.actions).toEqual([
      'home-info',
      'remove-home',
    ])
    detail.press('remove-home')
    expect(detail.confirmingRemoveHome).toBe(true)
    expect(detail.removeHomeConfirmation).toContain('Fix login')
    detail.confirmRemoveHome()
    expect(actions[1]).toMatchObject({ action: 'remove-home', confirmedConversations: ['c1'] })
  })
})

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

describe('agent setup sign-in', () => {
  it('opens the browser sign-in on this machine and follows the machine’s report', async () => {
    const { item, logins, machine } = setup()
    const signIn = item('claude-code').signIn
    const pending = signIn.signInWithBrowser()
    expect(signIn.state).toBe('opening')
    expect(logins.map((login) => login.harness)).toEqual(['claude-code'])
    logins[0]?.reply.resolve({ sessionId: 'ses_login' as SessionId })
    await pending
    expect(signIn.state).toBe('signing-in')
    expect(signIn.loginSessionId).toBe('ses_login')
    expect(item('claude-code').status).toBe('needs-sign-in')

    machine.patchAgent('claude-code', { login: { state: 'in', account: 'person@example.com' } })
    expect(signIn.state).toBe('signed-in')
    expect(signIn.stateLabel).toBe('Signed in as person@example.com')
    expect(item('claude-code').status).toBe('ready')
    signIn.closeLogin()
    expect(signIn.loginSessionId).toBeNull()
  })

  it('keeps the person signed out with the error when sign-in cannot open', async () => {
    const { item, logins } = setup()
    const signIn = item('claude-code').signIn
    const pending = signIn.signInWithBrowser()
    logins[0]?.reply.reject(new Error('Machine login is not available on this server.'))
    await pending
    expect(signIn.state).toBe('signed-out')
    expect(signIn.error).toBe('Machine login is not available on this server.')
  })

  it('saves a credential as the person’s default for every session of that harness', async () => {
    const { item, saves } = setup({
      saved: { 'claude-code': [{ id: 'cred_work', label: 'Work key' }] },
    })
    const signIn = item('claude-code').signIn
    const saved = signIn.choices.find((choice) => choice.kind === 'saved')
    expect(saved?.available).toBe(true)
    expect(saved?.detail).toBe(
      'Every Claude Code session you start uses it, on any machine, not only Build box.',
    )
    await signIn.useSavedCredential('cred_work')
    // The other harness's default is kept.
    expect(saves).toEqual([{ grok: 'cred_other', 'claude-code': 'cred_work' }])
    expect(signIn.state).toBe('saved-credential')
    expect(signIn.stateLabel).toBe('Uses Work key')
    expect(item('claude-code').status).toBe('ready')
  })

  it('offers no saved credential when there is none, and ignores an unknown id', async () => {
    const { item, saves } = setup()
    const signIn = item('claude-code').signIn
    expect(signIn.choices.find((choice) => choice.kind === 'saved')?.available).toBe(false)
    await signIn.useSavedCredential('cred_missing')
    expect(saves).toEqual([])
  })

  it('later changes nothing and leaves the harness in needs sign-in', () => {
    const { item, saves, logins, actions } = setup()
    const signIn = item('claude-code').signIn
    signIn.chooseLater()
    expect(signIn.state).toBe('later')
    expect(signIn.stateLabel).toBe('Sessions ask you to sign in when they start')
    expect(item('claude-code').status).toBe('needs-sign-in')
    expect(item('claude-code').readyToStart).toBe(true)
    expect(saves).toEqual([])
    expect(logins).toEqual([])
    expect(actions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Hand-back
// ---------------------------------------------------------------------------

describe('agent setup hand-back', () => {
  it('ticks the focused harness and hands it back once installed and signed in', async () => {
    const onStart = vi.fn()
    const { view, actions, machine } = setup({
      origin: { kind: 'menu', onStart },
      focus: 'cursor',
    })
    expect(view.selectedKinds).toEqual(['cursor'])
    expect(actions).toEqual([])
    expect(view.primary).toEqual({ kind: 'start', label: 'Start Cursor', enabled: false })
    view.start()
    expect(onStart).not.toHaveBeenCalled()

    view.installSelected()
    actions[0]?.reply.resolve(ok())
    machine.patchAgent('cursor', managed('cursor', 'out'))
    await settle()
    expect(view.canStart).toBe(false)
    machine.patchAgent('cursor', { login: { state: 'in' } })
    expect(view.canStart).toBe(true)
    expect(view.primary).toEqual({ kind: 'start', label: 'Start Cursor', enabled: true })
    view.start()
    expect(onStart).toHaveBeenCalledWith('cursor')
  })

  it('hands back a signed-out harness once the person chooses later', () => {
    const onStart = vi.fn()
    const { view, item } = setup({ origin: { kind: 'onboarding', onStart }, focus: 'claude-code' })
    expect(view.canStart).toBe(false)
    item('claude-code').signIn.chooseLater()
    expect(view.canStart).toBe(true)
    view.start()
    expect(onStart).toHaveBeenCalledWith('claude-code')
  })

  it('opened from settings, its primary action is Done and it starts nothing', () => {
    const onStart = vi.fn()
    const { view } = setup({ origin: { kind: 'settings', onStart }, focus: 'codex' })
    expect(view.primary).toEqual({ kind: 'done', label: 'Done' })
    expect(view.canStart).toBe(false)
    view.start()
    expect(onStart).not.toHaveBeenCalled()
  })

  it('without a focus harness a menu opening ends with Done', () => {
    const { view } = setup({ origin: { kind: 'menu', onStart: vi.fn() } })
    expect(view.primary).toEqual({ kind: 'done', label: 'Done' })
  })

  it('opened with no focus, the first harness the person installs becomes the one to start', () => {
    const onStart = vi.fn()
    const { view } = setup({ origin: { kind: 'menu', onStart } })
    view.toggle('cursor')
    view.installSelected()
    expect(view.focus).toBe('cursor')
    expect(view.primary).toEqual({ kind: 'start', label: 'Start Cursor', enabled: false })
  })

  it('a single install from the harness page also sets the focus when none is set', () => {
    const { view, item } = setup({ origin: { kind: 'menu', onStart: vi.fn() } })
    item('cursor').install()
    expect(view.focus).toBe('cursor')
  })

  it('setFocus retargets the hand-back to another harness', () => {
    const { view } = setup({ origin: { kind: 'menu', onStart: vi.fn() }, focus: 'cursor' })
    view.setFocus('claude-code')
    expect(view.primary.label).toBe('Start Claude Code')
    view.setFocus(undefined)
    expect(view.primary).toEqual({ kind: 'done', label: 'Done' })
  })

  it('closing drops the opening’s answers, sign-in and selection', async () => {
    const { view, item, logins } = setup({
      origin: { kind: 'menu', onStart: vi.fn() },
      focus: 'cursor',
    })
    const pending = item('claude-code').signIn.signInWithBrowser()
    view.close()
    logins[0]?.reply.resolve({ sessionId: 'ses_late' as SessionId })
    await pending
    expect(item('claude-code').signIn.loginSessionId).toBeNull()
    expect(view.selectedKinds).toEqual([])
  })
})
