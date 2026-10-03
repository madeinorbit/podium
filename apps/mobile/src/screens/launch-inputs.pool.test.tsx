import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createHeaderFixture } from '../../../web/test/header-fixture'
import type { MobilePool } from '../client/mobile-pool'
import { useLaunchInputs } from '../client/use-launch-inputs'
import { renderWithMobileStore } from '../client/test-support'
import type { LaunchConfiguration, LaunchPlan } from '../lib/launch-configuration'

const state = vi.hoisted(() => ({ host: undefined as MobilePool | undefined, poolRead: false }))
vi.mock('../client/mobile-pool', async original => {
  const real = await original<typeof import('../client/mobile-pool')>()
  return { ...real,
    useMobilePoolProjection: <T,>(...args: Parameters<MobilePool['host']['usePoolProjection']>) => state.host!.host.usePoolProjection(...args) as T,
  }
})
vi.mock('../client/hooks', async original => {
  const real = await original<typeof import('../client/hooks')>()
  return { ...real, useStoreSelector: (...args: Parameters<typeof real.useStoreSelector>) =>
    state.poolRead ? useLaunchInputs() : real.useStoreSelector(...args) }
})
vi.mock('expo-router', () => ({ useRouter: () => ({ back() {}, replace() {} }) }))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('../components/Screen', () => ({ Screen: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }))
const { createMobilePool } = await import('../client/mobile-pool')
const { LaunchConfigurationFields } = await import('../components/LaunchConfigurationFields')
const { NewIssueScreen } = await import('./NewIssueScreen')
afterEach(() => { cleanup(); storeStats.enable(false); vi.restoreAllMocks() })

async function mount(element: import('react').ReactNode) {
  state.host = createMobilePool(false, () => ({ get: () => undefined, device: () => true }))
  const fixture = createHeaderFixture(3, 3)
  let runtime!: ClientRuntime
  const view = await renderWithMobileStore(element, { replica: fixture.replica, api: fixture.api,
    attachRuntime(owner) {
      runtime = owner
      state.host!.initialize(owner.ui)
      fixture.bindHub(owner.hub)
      return state.host!.host.attach(owner, error => { throw error })
    },
  })
  await act(async () => { fixture.publishMachines(); await new Promise(resolve => setTimeout(resolve, 50)) })
  return { view, runtime, fixture }
}

it('preserves new-task form output from the accepted repository reader', async () => {
  let expected: string | undefined
  for (const poolRead of [false, true]) {
    state.poolRead = poolRead
    storeStats.enable(); storeStats.reset()
    const app = await mount(<NewIssueScreen />)
    await waitFor(() => expect(app.view.getByRole('radio', { name: 'Repository project' })).toBeTruthy())
    const output = app.view.container.innerHTML
    if (expected === undefined) expected = output
    else expect(output).toBe(expected)
    expect(output).toMatchSnapshot('last green new-task form')
    expect(readRuntimeStoreStats(app.runtime)?.selectorRuns).toBeGreaterThan(0)
    app.view.unmount()
  }
})

it('preserves launch fields and validity plans from the accepted machine and repository readers', async () => {
  const value: LaunchConfiguration = { agentKind: 'claude-code', modelPick: 'auto', effort: 'auto', machineId: '' }
  let expected: { html: string; plan: LaunchPlan | undefined } | undefined
  for (const poolRead of [false, true]) {
    state.poolRead = poolRead
    storeStats.enable(); storeStats.reset()
    let plan: LaunchPlan | undefined
    const app = await mount(<LaunchConfigurationFields repoPath="/synthetic/project" value={value} onChange={() => {}} onPlan={next => { plan = next }} />)
    await waitFor(() => expect(app.view.getByText('Agent', { exact: true })).toBeTruthy())
    const output = { html: app.view.container.innerHTML, plan }
    if (expected === undefined) expected = output
    else expect(output).toEqual(expected)
    expect(output).toMatchSnapshot('last green launch fields and plan')
    expect(readRuntimeStoreStats(app.runtime)?.selectorRuns).toBe(poolRead ? 0 : 1)
    app.view.unmount()
  }
})
