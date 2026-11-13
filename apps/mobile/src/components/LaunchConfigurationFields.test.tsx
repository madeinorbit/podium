import { AUTO, encodeModelPick } from '@podium/client-core/agent-models'
import { asMachineId, type GitRepositoryWire, type MachineWire } from '@podium/model'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { observer } from 'mobx-react-lite'
import { useCallback, useLayoutEffect, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import { useLaunchInputs } from '../client/use-launch-inputs'
import type { LaunchConfiguration, LaunchPlan } from '../lib/launch-configuration'
import { NewIssueScreen } from '../screens/NewIssueScreen'
import type { ComposeSheetHeaderProps } from './compose/ComposeStartButton'
import { LaunchConfigurationFields } from './LaunchConfigurationFields'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 430, height: 900 }),
}))
vi.mock('expo-router', () => ({
  useRouter: () => ({ back() {}, replace() {} }),
  useLocalSearchParams: () => ({}),
}))
vi.mock('expo-router/react-navigation', async () => ({
  HeaderHeightContext: (await import('react')).createContext(0),
}))
vi.mock('../hooks/useContentBottomInset', () => ({ useContentBottomInset: () => 0 }))
vi.mock('./Screen', () => ({
  Screen: ({ children }: { children: import('react').ReactNode }) => <>{children}</>,
}))
vi.mock('./ActionSheet', () => ({
  ActionSheet: ({
    visible,
    actions,
    onClose,
  }: {
    visible: boolean
    actions: { label: string; onPress: () => void; disabled?: boolean; selected?: boolean }[]
    onClose: () => void
  }) =>
    visible ? (
      <div>
        {actions.map((action) => (
          <button
            type="button"
            key={action.label}
            disabled={action.disabled}
            aria-pressed={action.selected}
            onClick={() => {
              action.onPress()
              onClose()
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    ) : null,
}))
// Map the native toolbar's canStart onto a DOM disabled prop. This test keeps
// the real form and picker while replacing the platform bar.
vi.mock('./compose/ComposeSheetHeader', () => ({
  ComposeSheetHeader: (props: ComposeSheetHeaderProps) => (
    <button type="button" disabled={!props.canStart} onClick={props.onStart}>
      Start Task
    </button>
  ),
}))
afterEach(cleanup)

it('renders new-task launch controls before any machine is available', async () => {
  let plan: LaunchPlan | undefined
  await renderWithMobileStore(
    <LaunchConfigurationFields
      repoPath="/synthetic"
      value={{ agentKind: 'claude-code', modelPick: AUTO, effort: AUTO, machineId: '' }}
      onChange={() => {}}
      onPlan={(next) => {
        plan = next
      }}
    />,
  )
  expect(screen.getByText('Agent', { exact: true })).toBeTruthy()
  expect(screen.getByText('Model', { exact: true })).toBeTruthy()
  expect(screen.getByText('Machine', { exact: true })).toBeTruthy()
  expect(plan?.configuration.agentKind).toBe('claude-code')
})

const value: LaunchConfiguration = {
  agentKind: 'codex',
  modelPick: AUTO,
  effort: AUTO,
  machineId: '',
}

function launchFixture() {
  const machine: MachineWire = {
    id: asMachineId('launch-host'),
    name: 'Launch host',
    hostname: 'launch-host',
    online: true,
    lastSeenAt: new Date().toISOString(),
    use: 'granted',
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'one', daemon: true, server: false, supervisor: true },
    inventory: {
      os: 'linux',
      arch: 'x64',
      tools: [],
      agents: [
        { kind: 'codex', installed: true, login: { state: 'in' } },
        { kind: 'claude-code', installed: true, login: { state: 'in' } },
      ],
    },
  }
  const repo: GitRepositoryWire = {
    path: '/synthetic',
    kind: 'repository',
    worktrees: [],
    machineId: machine.id,
    originUrl: 'https://example.invalid/repository.git',
  }
  return { machine, repos: [repo], machines: [machine] }
}

async function publishMachines(
  app: Awaited<ReturnType<typeof renderWithMobileStore>>,
  fixture: ReturnType<typeof launchFixture>,
  machines: MachineWire[],
) {
  // A scope change also refreshes repositories. Its answer must agree with the
  // pushed roster rather than restoring the fixture's original machine state.
  fixture.machines = machines
  await act(async () => {
    app.emit('machines', machines)
  })
}

it('publishes one unchanged plan even when its parent rebuilds the configuration', async () => {
  const published = vi.fn()
  let redraw!: () => void
  function Form() {
    const [, setRevision] = useState(0)
    const [plan, setPlan] = useState<LaunchPlan | null>(null)
    const onPlan = useCallback((next: LaunchPlan) => {
      published(next)
      setPlan(next)
    }, [])
    redraw = () => setRevision((revision) => revision + 1)
    return (
      <>
        <LaunchConfigurationFields
          repoPath="/synthetic"
          value={{ ...value }}
          onChange={() => {}}
          onPlan={onPlan}
        />
        <output>{plan?.refusal}</output>
      </>
    )
  }
  await renderWithMobileStore(<Form />)
  expect(published).toHaveBeenCalledTimes(1)
  act(redraw)
  expect(published).toHaveBeenCalledTimes(1)
})

it('publishes the correct plan when switching repositories away and back', async () => {
  const fixture = launchFixture()
  const otherRepo: GitRepositoryWire = {
    path: '/other-repository',
    kind: 'repository',
    worktrees: [],
    machineId: asMachineId('other-host'),
  }
  fixture.repos.push(otherRepo)
  const configuration = { ...value, machineId: fixture.machine.id }
  const published = vi.fn()
  const changed = vi.fn()
  function Form() {
    const [repoPath, setRepoPath] = useState('/synthetic')
    const [plan, setPlan] = useState<LaunchPlan | null>(null)
    const onPlan = useCallback((next: LaunchPlan) => {
      published(next)
      setPlan(next)
    }, [])
    return (
      <>
        <button type="button" onClick={() => setRepoPath(otherRepo.path)}>
          Other repository
        </button>
        <button type="button" onClick={() => setRepoPath('/synthetic')}>
          Original repository
        </button>
        <LaunchConfigurationFields
          repoPath={repoPath}
          value={{ ...configuration }}
          onChange={changed}
          onPlan={onPlan}
        />
        <output>{plan?.refusal ?? 'Ready'}</output>
      </>
    )
  }
  await renderWithMobileStore(<Form />, fixture)
  await waitFor(() => expect(published).toHaveBeenLastCalledWith({ configuration }))
  published.mockClear()

  fireEvent.click(screen.getByRole('button', { name: 'Other repository' }))
  const refusal = 'The selected machine is no longer available for this repository.'
  await waitFor(() => expect(published).toHaveBeenLastCalledWith({ configuration, refusal }))
  expect(screen.getByRole('status').textContent).toBe(refusal)
  published.mockClear()

  fireEvent.click(screen.getByRole('button', { name: 'Original repository' }))
  await waitFor(() => expect(published).toHaveBeenLastCalledWith({ configuration }))
  expect(screen.getByRole('status').textContent).toBe('Ready')
  expect(changed).not.toHaveBeenCalled()
})

it('publishes an offline refusal before paint without changing the selected configuration', async () => {
  const fixture = launchFixture()
  const configuration = { ...value, machineId: fixture.machine.id }
  let plan: LaunchPlan | undefined
  const published = vi.fn((next: LaunchPlan) => {
    plan = next
  })
  const changed = vi.fn()
  const beforePaint = vi.fn()
  const Form = observer(function Form() {
    const inputs = useLaunchInputs('/synthetic')
    const online = inputs.machines.find((machine) => machine.id === configuration.machineId)?.online
    // Child layout effects run before this parent's layout effect. A passive
    // publication would leave the previous valid plan visible at this boundary.
    useLayoutEffect(() => {
      beforePaint(online, plan)
    }, [online])
    return (
      <LaunchConfigurationFields
        repoPath="/synthetic"
        value={configuration}
        onChange={changed}
        onPlan={published}
      />
    )
  })
  const app = await renderWithMobileStore(<Form />, fixture)
  await waitFor(() => expect(beforePaint).toHaveBeenLastCalledWith(true, { configuration }))
  published.mockClear()
  beforePaint.mockClear()

  await publishMachines(app, fixture, [{ ...fixture.machine, online: false }])
  const refused = { configuration, refusal: 'Launch host is offline.' }
  const offlineCommits = beforePaint.mock.calls.filter(([online]) => online === false)
  expect(offlineCommits.length).toBeGreaterThan(0)
  for (const [, committedPlan] of offlineCommits) expect(committedPlan).toEqual(refused)
  expect(published).toHaveBeenLastCalledWith(refused)
  expect(changed).not.toHaveBeenCalled()
})

it('keeps new-task submission usable on equal selections and responds to live invalidation', async () => {
  const fixture = launchFixture()
  const app = await renderWithMobileStore(<NewIssueScreen />, fixture)
  const prompt = screen.getByRole('textbox', { name: 'Task prompt' }) as HTMLTextAreaElement
  fireEvent.change(prompt, { target: { value: 'A usable task form' } })
  const start = screen.getByRole('button', { name: 'Start Task' }) as HTMLButtonElement
  await waitFor(() => expect(start.disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Project, repository' }))
  fireEvent.click(await screen.findByRole('button', { name: 'repository' }))
  expect(start.disabled).toBe(false)
  expect(prompt.value).toBe('A usable task form')
  await publishMachines(app, fixture, [{ ...fixture.machine, use: 'denied' }])
  expect(start.disabled).toBe(true)
  await publishMachines(app, fixture, [fixture.machine])
  expect(start.disabled).toBe(false)
})

it.each([
  'Auto',
  'pinned',
] as const)('republishes %s machine validity when live facts change', async (placement) => {
  const fixture = launchFixture()
  const configuration = { ...value, machineId: placement === 'pinned' ? fixture.machine.id : '' }
  const published = vi.fn()
  const app = await renderWithMobileStore(
    <LaunchConfigurationFields
      repoPath="/synthetic"
      value={configuration}
      onChange={() => {}}
      onPlan={published}
    />,
    fixture,
  )
  await waitFor(() => expect(published).toHaveBeenLastCalledWith({ configuration }))
  const accepted = published.mock.calls.at(-1)![0]
  const publications = published.mock.calls.length
  // A display-only update must keep the plan stable while still painting the name.
  await publishMachines(app, fixture, [{ ...fixture.machine, name: 'Renamed host' }])
  expect(published).toHaveBeenCalledTimes(publications)
  expect(published.mock.calls.at(-1)![0]).toBe(accepted)
  if (placement === 'pinned') expect(screen.getByLabelText('Machine, Renamed host')).toBeTruthy()

  const unavailable: Array<{ machine: MachineWire; reason: string }> = [
    { machine: { ...fixture.machine, online: false }, reason: 'Launch host is offline.' },
    {
      machine: { ...fixture.machine, use: 'denied' },
      reason: 'You do not have permission to use Launch host.',
    },
    {
      machine: {
        ...fixture.machine,
        availability: { ...fixture.machine.availability!, daemon: false },
      },
      reason: 'Launch host is offline.',
    },
    {
      machine: { ...fixture.machine, inventory: { ...fixture.machine.inventory!, agents: [] } },
      reason: 'Launch host cannot run Codex.',
    },
  ]
  for (const update of unavailable) {
    await publishMachines(app, fixture, [update.machine])
    await waitFor(() =>
      expect(published).toHaveBeenLastCalledWith({
        configuration,
        refusal:
          placement === 'pinned'
            ? update.reason
            : 'No available machine can run Codex for this repository.',
      }),
    )
    await publishMachines(app, fixture, [fixture.machine])
    await waitFor(() => expect(published).toHaveBeenLastCalledWith({ configuration }))
  }
  await publishMachines(app, fixture, [])
  await waitFor(() =>
    expect(published).toHaveBeenLastCalledWith({
      configuration,
      refusal:
        placement === 'pinned'
          ? 'The selected machine is no longer available for this repository.'
          : 'No available machine can run Codex for this repository.',
    }),
  )
})

it.each([
  ['retired model', 'retired', 'high', AUTO, AUTO],
  ['retired effort', 'current', 'ultra', encodeModelPick('codex', 'current'), AUTO],
] as const)('republishes a %s when an authoritative catalog arrives', async (_case, model, effort, expectedModel, expectedEffort) => {
  const fixture = launchFixture()
  const configuration = { ...value, modelPick: encodeModelPick('codex', model), effort }
  let resolveCatalog!: (snapshot: unknown) => void
  const pending = new Promise((resolve) => {
    resolveCatalog = resolve
  })
  const published = vi.fn()
  await renderWithMobileStore(
    <LaunchConfigurationFields
      repoPath="/synthetic"
      value={configuration}
      onChange={() => {}}
      onPlan={published}
    />,
    { ...fixture, api: { models: { catalog: { query: () => pending } } } },
  )
  await waitFor(() => expect(published).toHaveBeenLastCalledWith({ configuration }))
  await act(async () => {
    resolveCatalog({
      machineId: fixture.machine.id,
      fetchedAt: Date.now(),
      byAgent: { codex: [{ value: 'current', label: 'Current', efforts: ['high'] }] },
    })
  })
  await waitFor(() =>
    expect(published).toHaveBeenLastCalledWith({
      configuration: { ...configuration, modelPick: expectedModel, effort: expectedEffort },
    }),
  )
})
