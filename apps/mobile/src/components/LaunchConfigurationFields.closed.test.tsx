import { AUTO } from '@podium/client-core/agent-models'
import { reposToViews } from '@podium/client-core/values'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LaunchConfiguration } from '../lib/launch-configuration'
import * as sheets from './ActionSheet'
import * as menus from './compose/ComposeMenu'
import * as icons from './Icon'
import { LaunchConfigurationFields } from './LaunchConfigurationFields'
import * as pressables from './PressableScale'

const state = vi.hoisted(() => ({
  fontScale: 1,
  repos: [] as GitRepositoryWire[],
  machines: [] as MachineWire[],
  catalog: {} as Record<string, Array<{ value: string; label: string; efforts?: string[] }>>,
}))
vi.mock('react-native', async (original) => ({
  ...(await original<object>()),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: state.fontScale }),
}))
vi.mock('../client/use-launch-inputs', () => ({
  useLaunchInputs: () => ({ repo: reposToViews(state.repos)[0], machines: state.machines }),
}))
vi.mock('@podium/client-core/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@podium/client-core/react')>()),
  useModelCatalogState: () => ({
    catalog: state.catalog,
    status: Object.keys(state.catalog).length ? 'ready' : 'unavailable',
  }),
  useHarnessDescriptors: () => ({ served: undefined }),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 430, height: 900 }),
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  state.repos = []
  state.machines = []
  state.catalog = {}
  state.fontScale = 1
})

it('requests no fallback menu while closed at 1x/4x and builds only the opened picker', async () => {
  for (const scale of [1, 4] as const) {
    state.repos = [
      {
        kind: 'repository',
        path: '/synthetic',
        branch: 'main',
        originUrl: 'https://example.test/project',
        worktrees: [],
      },
    ]
    state.machines = Array.from(
      { length: 128 * scale },
      (_, n) =>
        ({
          id: asMachineId(`machine-${n}`),
          name: `Machine ${n}`,
          online: true,
          serviceAssignment: { server: false, agentExecution: true },
          availability: { daemon: true },
          inventory: {
            agents: [
              { kind: 'claude-code', installed: true },
              { kind: 'codex', installed: true },
            ],
          },
        }) as MachineWire,
    )
    const sheet = vi.spyOn(sheets, 'ActionSheet').mockImplementation(() => <></>)
    const onChange = vi.fn()
    const value: LaunchConfiguration = {
      agentKind: 'claude-code',
      modelPick: AUTO,
      effort: AUTO,
      machineId: '',
    }
    let changeAgent = () => {}
    function Harness() {
      const [current, setCurrent] = useState(value)
      changeAgent = () => setCurrent((previous) => ({ ...previous, agentKind: 'codex' }))
      return (
        <LaunchConfigurationFields
          repoPath="/synthetic"
          value={current}
          onChange={(next) => {
            onChange(next)
            setCurrent(next)
          }}
        />
      )
    }
    // This guard measures the real parent's menu factory with large launch
    // inputs. Pool attachment is covered by launch-inputs.pool.test.tsx.
    const view = render(<Harness />)
    try {
      expect(sheet).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Machine, Auto' }))
      expect(sheet).toHaveBeenCalled()
      expect(sheet.mock.calls.every(([props]) => props.title === 'Machine')).toBe(true)
      const opened = sheet.mock.lastCall?.[0]
      expect(opened?.visible).toBe(true)
      expect(opened?.actions).toHaveLength(128 * scale + 1)
      expect(opened?.actions[1]?.label).toBe('Machine 0')
      expect(opened?.actions[1]?.disabled).toBe(false)
      act(() => opened?.actions[1]?.onPress())
      expect(onChange).toHaveBeenCalledWith({ ...value, machineId: 'machine-0' })
      // The sheet calls its host only after dismissal completes. Releasing
      // demand here preserves that existing deferred-action contract.
      act(() => opened?.onClose())
      sheet.mockClear()
      act(changeAgent)
      expect(sheet).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: /^Agent, / }))
      expect(sheet.mock.calls.every(([props]) => props.title === 'Agent')).toBe(true)
      expect(sheet.mock.lastCall?.[0].actions.length).toBeLessThan(10)
    } finally {
      view.unmount()
      sheet.mockRestore()
      cleanup()
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
    }
  }
})

it('offers only Auto and live models, with no Use option in the task launch picker', () => {
  state.catalog = { codex: [{ value: 'gpt-current', label: 'Current', efforts: ['high'] }] }
  const sheet = vi.spyOn(sheets, 'ActionSheet').mockImplementation(() => <></>)
  render(
    <LaunchConfigurationFields
      repoPath="/synthetic"
      value={{ agentKind: 'codex', modelPick: AUTO, effort: AUTO, machineId: '' }}
      onChange={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Model, Auto' }))
  expect(sheet.mock.lastCall?.[0].actions.map((action) => action.label)).toEqual([
    'Auto',
    'Current',
  ])
  expect(sheet.mock.lastCall?.[0].actions.some((action) => action.label.startsWith('Use '))).toBe(
    false,
  )
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('shows stored effort inert while the concrete model list is unavailable', () => {
  const sheet = vi.spyOn(sheets, 'ActionSheet').mockImplementation(() => <></>)
  render(
    <LaunchConfigurationFields
      repoPath="/synthetic"
      value={{ agentKind: 'codex', modelPick: 'codex:stored', effort: 'high', machineId: '' }}
      onChange={vi.fn()}
    />,
  )
  const pill = screen.getByLabelText('Effort, High')
  expect(pill.getAttribute('role')).not.toBe('button')
  fireEvent.click(pill)
  expect(sheet).not.toHaveBeenCalled()
})

it.each([
  'native',
  'fallback',
])('keeps %s picker rows aligned and reflows full values with live text size', (platform) => {
  if (platform === 'native') {
    vi.spyOn(menus, 'ComposeMenu').mockImplementation(({ children }) => children(undefined))
  }
  vi.spyOn(icons, 'Icon').mockImplementation(({ as, size }) => (
    <span data-testid="picker-indicator" data-symbol={as} data-size={size} />
  ))
  const machineId = asMachineId('launch-machine')
  const machineName = 'MBP-Cofo.local with a long machine name'
  state.repos = [{ kind: 'repository', path: '/synthetic', machineId, worktrees: [] }]
  state.machines = [
    {
      id: machineId,
      name: machineName,
      online: true,
      serviceAssignment: { server: false, agentExecution: true },
      availability: { daemon: true },
      inventory: { agents: [{ kind: 'codex', installed: true }] },
    } as MachineWire,
  ]
  const changed = vi.fn()
  const form = () => (
    <LaunchConfigurationFields
      repoPath="/synthetic"
      value={{ agentKind: 'codex', modelPick: AUTO, effort: AUTO, machineId }}
      onChange={changed}
    />
  )
  const view = render(form())
  const labels = ['Agent, Codex', 'Model, Auto', 'Effort, Auto', `Machine, ${machineName}`]
  for (const name of labels) {
    const row = screen.getByLabelText(name)
    expect(getComputedStyle(row).flexDirection).toBe('row')
    const indicator = within(row).getByTestId('picker-indicator')
    expect(indicator.dataset.symbol).toBe('chevron.up.chevron.down')
    expect(indicator.dataset.size).toBe('11')
    // Every indicator sits in a slot; only the inert Effort slot dims, like a
    // disabled SwiftUI picker.
    const slot = indicator.parentElement
    const trail = slot?.parentElement
    if (!slot || !trail) throw new Error('Missing picker value and indicator')
    expect(trail.lastElementChild).toBe(slot)
    expect(getComputedStyle(trail).gap).toBe('6px')
    expect(getComputedStyle(slot).opacity).toBe(name.startsWith('Effort') ? '0.5' : '')
  }
  // The unavailable Effort row shares the indicator without pretending to open a menu.
  expect(screen.getByLabelText('Effort, Auto').getAttribute('role')).not.toBe('button')
  fireEvent.click(screen.getByLabelText('Effort, Auto'))
  for (const scale of [2.353, 3.571, 1]) {
    state.fontScale = scale
    view.rerender(form())
    for (const name of labels) {
      const row = screen.getByLabelText(name)
      expect(getComputedStyle(row).flexDirection).toBe(scale > 1 ? 'column' : 'row')
      const indicator = within(row).getByTestId('picker-indicator')
      expect(Number(indicator.dataset.size)).toBeCloseTo(11 * scale)
    }
    const machine = within(screen.getByLabelText(`Machine, ${machineName}`)).getByText(machineName)
    expect(getComputedStyle(machine).textAlign).toBe(scale > 1 ? 'left' : 'right')
    expect(getComputedStyle(machine).textOverflow).toBe(scale > 1 ? '' : 'ellipsis')
    expect(machine.textContent).toBe(machineName)
  }
  expect(changed).not.toHaveBeenCalled()
})

it('leaves native Agent, Model, Effort and Machine labels to the SwiftUI menu responder', () => {
  state.catalog = { codex: [{ value: 'current', label: 'Current', efforts: ['high'] }] }
  const sheet = vi.spyOn(sheets, 'ActionSheet').mockImplementation(() => <></>)
  vi.spyOn(menus, 'ComposeMenu').mockImplementation(({ children }) => children(undefined))
  const pressable = vi.spyOn(pressables, 'PressableScale')
  const changed = vi.fn()
  render(
    <LaunchConfigurationFields
      repoPath="/synthetic"
      value={{ agentKind: 'codex', modelPick: 'codex:current', effort: 'high', machineId: '' }}
      onChange={changed}
    />,
  )
  for (const name of ['Agent, Codex', 'Model, Codex · Current', 'Effort, High', 'Machine, Auto']) {
    const label = screen.getByRole('button', { name })
    fireEvent.click(label)
  }
  expect(sheet).not.toHaveBeenCalled()
  expect(pressable).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})
