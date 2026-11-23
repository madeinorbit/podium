import { LOADING } from '@podium/client-graph'
import type { AgentSetupView } from '@podium/client-graph/agent-setup-view'
import { BUILTIN_HARNESS_KINDS } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { observableRef, runInAction } from 'mobx'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installed, missing, setupFixture } from '../../harness/agent-setup-fixture'
import { installMobileMetadataStorage } from './mobile-metadata-storage'
import { finishProfileAgentSetup, profileAgentSetupFinished } from './server-profiles'

const app = vi.hoisted(() => ({
  views: [] as AgentSetupView[],
  profileId: 'server-a',
  override: false,
}))
vi.mock('@podium/client-core/demo', () => ({ demoEnabled: () => false }))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}))
vi.mock('../components/BottomSheet', () => ({ BottomSheet: () => null }))
vi.mock('./mobile-pool', () => ({ useMobilePool: () => ({ row: () => catalog.value }) }))
vi.mock('./server-profile-context', () => ({
  useOptionalServerProfile: () => ({
    profile: { id: app.profileId },
    isEphemeralOverride: app.override,
  }),
}))
vi.mock('./use-agent-setup-picker', () => ({
  useAgentSetupPicker: (ids: readonly string[]) =>
    app.views.filter((view) => ids.includes(view.machine.id)),
}))
// Stop at the connection boundary. The real full-screen panel and shared view
// still run; login sessions and credential fetching have their own sheet tests.
vi.mock('../components/AgentSetupSheet', async () => {
  const { AgentSetupOnboarding } = await import('../components/AgentSetupOnboarding')
  return {
    PhoneAgentSetupSheet: ({
      machineId,
      onContinue,
    }: {
      machineId: string
      onContinue: () => Promise<void>
    }) => {
      const view = app.views.find((candidate) => candidate.machine.id === machineId)
      if (!view) throw new Error('The onboarding machine must be loaded')
      useEffect(() => () => view.close(), [view])
      return <AgentSetupOnboarding view={view} onContinue={onContinue} />
    },
  }
})

import { AgentOnboardingGate } from './AgentOnboardingGate'

const stored = new Map<string, string>()
class Catalog {
  @observableRef accessor value: unknown = LOADING
}
const catalog = new Catalog()
beforeEach(() => {
  stored.clear()
  app.views = []
  runInAction(() => {
    catalog.value = { machines: [], repositories: [] }
  })
  app.profileId = 'server-a'
  app.override = false
  installMobileMetadataStorage({
    getItem: async (key) => stored.get(key) ?? null,
    setItem: async (key, value) => {
      stored.set(key, value)
    },
  })
})
afterEach(cleanup)

function machines(options: Parameters<typeof setupFixture>[0] = {}) {
  const fixture = setupFixture({
    origin: { kind: 'onboarding' },
    agents: BUILTIN_HARNESS_KINDS.map(missing),
    ...options,
  })
  app.views = [fixture.view]
  runInAction(() => {
    catalog.value = { machines: [fixture.machine.id], repositories: [] }
  })
  return fixture
}
function mount() {
  return render(
    <AgentOnboardingGate>
      <div>First work screen</div>
    </AgentOnboardingGate>,
  )
}
const step = () => screen.findByRole('heading', { name: 'Set up your agents' })
const work = () => screen.findByText('First work screen')

describe('phone agent onboarding', () => {
  it('shows setup when a machine has no ready agent, with suggestions ticked and no automatic installs', async () => {
    const { actions } = machines()
    mount()
    await step()
    expect(screen.getByText('Set up Podium · 2 of 3')).toBeTruthy()
    expect(screen.queryByText('First work screen')).toBeNull()
    expect(
      screen.getByRole('checkbox', { name: 'Install Codex' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(screen.getByRole('checkbox', { name: 'Install Pi' }).getAttribute('aria-checked')).toBe(
      'false',
    )
    expect(screen.getByRole('button', { name: 'Install 3 and continue' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue without installing' })).toBeNull()
    expect(actions).toEqual([])
  })

  it('installs only the chosen agents, continues with requests pending, and remembers completion', async () => {
    const { actions } = machines()
    const ui = mount()
    await step()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install OpenCode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install 2 and continue' }))
    await work()
    expect(actions.map(({ harness, action }) => [harness, action])).toEqual([
      ['claude-code', 'install'],
      ['codex', 'install'],
    ])
    expect(await profileAgentSetupFinished('server-a')).toBe(true)
    await act(async () => {
      for (const action of actions) action.resolve({ ok: true })
    })
    expect(actions).toHaveLength(2)
    ui.unmount()
    machines()
    mount()
    await work()
    expect(screen.queryByRole('heading', { name: 'Set up your agents' })).toBeNull()
  })

  it('skips a server with a ready agent and remembers the skip if that agent later disappears', async () => {
    const { actions } = machines({ agents: [installed('claude-code')] })
    const ui = mount()
    await work()
    expect(screen.queryByRole('heading', { name: 'Set up your agents' })).toBeNull()
    expect(actions).toEqual([])
    expect(await profileAgentSetupFinished('server-a')).toBe(true)
    ui.unmount()
    machines()
    mount()
    await work()
  })

  it('skips when there is no machine and does not confuse an empty catalog with loading', async () => {
    runInAction(() => {
      catalog.value = LOADING
    })
    mount()
    await screen.findByText('Checking agents…')
    expect(screen.queryByText('First work screen')).toBeNull()
    expect(await profileAgentSetupFinished('server-a')).toBe(false)
    act(() =>
      runInAction(() => {
        catalog.value = { machines: [], repositories: [] }
      }),
    )
    await work()
    expect(await profileAgentSetupFinished('server-a')).toBe(true)
  })

  it('waits for inventory instead of treating it as ready or missing', async () => {
    const { machine, actions } = machines()
    runInAction(() => {
      machine.inventory = undefined
    })
    mount()
    await screen.findByText('Checking agents…')
    expect(screen.queryByText('First work screen')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Set up your agents' })).toBeNull()
    act(() =>
      runInAction(() => {
        machine.inventory = {
          os: 'linux',
          arch: 'x64',
          tools: [],
          agents: BUILTIN_HARNESS_KINDS.map(missing),
        }
      }),
    )
    await step()
    expect(actions).toEqual([])
  })

  it('keeps the open step in place when an agent becomes ready, then allows continuing without an install', async () => {
    const { machine, actions } = machines()
    const ui = mount()
    await step()
    act(() => machine.patch('codex', installed('codex')))
    expect(screen.getByRole('heading', { name: 'Set up your agents' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue without installing' }))
    await work()
    expect(actions).toEqual([])
    ui.unmount()
    machines()
    mount()
    await work()
  })

  it('still shows setup when the installed agent needs sign-in', async () => {
    machines({
      agents: BUILTIN_HARNESS_KINDS.map((kind) =>
        kind === 'pi' ? installed('pi', 'out') : missing(kind),
      ),
    })
    mount()
    await step()
    expect(screen.getByRole('button', { name: 'Sign in Pi' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue without installing' })).toBeNull()
  })

  it('stores completion per server profile rather than for the whole app', async () => {
    await finishProfileAgentSetup('server-a', 'completed')
    machines()
    const ui = mount()
    await work()
    app.profileId = 'server-b'
    ui.rerender(
      <AgentOnboardingGate>
        <div>First work screen</div>
      </AgentOnboardingGate>,
    )
    await step()
    expect(await profileAgentSetupFinished('server-b')).toBe(false)
  })

  it('keeps development overrides outside saved onboarding', async () => {
    app.override = true
    const { actions } = machines()
    mount()
    await work()
    expect(actions).toEqual([])
    expect(stored.size).toBe(0)
  })

  it('can retry saving completion without submitting the installs again', async () => {
    const { actions } = machines()
    let fail = true
    installMobileMetadataStorage({
      getItem: async () => null,
      setItem: async () => {
        if (fail) throw new Error('Storage unavailable')
      },
    })
    mount()
    await step()
    fireEvent.click(screen.getByRole('button', { name: 'Install 3 and continue' }))
    await screen.findByRole('alert')
    expect(actions).toHaveLength(3)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await work()
    expect(actions).toHaveLength(3)
  })
})
