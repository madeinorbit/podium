// @vitest-environment happy-dom
import type { Inventory, MachineFacts } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { closeSetupAgents, setupAgentsRequest } from '@/features/setup-agents/open-setup-agents'
import { agentFleetStatus, CapabilityAgentMenu } from './agent-capability'
import { SetupAgentsMenuItem } from './setup-agents-menu-item'

const fixture = vi.hoisted(() => ({ machines: new Map<string, Pick<MachineFacts, 'inventory'>>() }))
vi.mock('@/app/header-data', () => ({
  usePoolMachine: (id: string) => fixture.machines.get(id),
}))

afterEach(() => {
  cleanup()
  closeSetupAgents()
  fixture.machines.clear()
})

const machines = [
  { id: 'a', name: 'Workstation' },
  { id: 'b', name: 'Build machine' },
]
const options = [
  { value: 'codex', label: 'Codex', status: {} },
  {
    value: 'cursor',
    label: 'Cursor',
    status: agentFleetStatus([{ machineName: 'a', rejection: 'harness-missing' }], 'Cursor'),
  },
  {
    value: 'pi',
    label: 'Pi',
    status: agentFleetStatus([{ machineName: 'a', loggedOut: true }], 'Pi'),
  },
  {
    value: 'grok',
    label: 'Grok',
    status: agentFleetStatus([{ machineName: 'a', rejection: 'harness-probe-timed-out' }], 'Grok'),
  },
]

it('lists available and signed-out harnesses, retains probe refusals and ends with one setup entry', async () => {
  const onSelect = vi.fn()
  render(
    <CapabilityAgentMenu
      trigger={<button type="button">Agent</button>}
      options={options}
      selectedValue="codex"
      onSelect={onSelect}
      setup={{ machineId: 'a', machines }}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
  expect(await screen.findByRole('menuitem', { name: 'Pi signed out' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: /Cursor/ })).toBeNull()
  expect(
    screen.getByRole('menuitem', { name: 'Grok probe timed out' }).getAttribute('data-disabled'),
  ).not.toBeNull()
  const entries = screen.getAllByRole('menuitem')
  expect(entries.at(-1)?.textContent).toBe('Set up agents…')
  expect(screen.getAllByRole('menuitem', { name: 'Set up agents…' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Set up agents…' }))
  expect(onSelect).not.toHaveBeenCalled()
  const request = setupAgentsRequest()
  expect(request).toMatchObject({ machineId: 'a', origin: 'menu' })
  expect(request?.focus).toBeUndefined()
  act(() => request?.onStart?.('cursor'))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('cursor')
})

it('reads only the target machine’s live install count', () => {
  const inventory = (count: number): Inventory => ({
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: (['codex', 'pi'] as const).slice(0, count).map((kind) => ({
      kind,
      installed: false,
      login: { state: 'unknown' },
      install: { managed: { paused: false, installing: { version: '1.0.0' } } },
    })),
  })
  fixture.machines.set('a', { inventory: inventory(1) })
  fixture.machines.set('b', { inventory: inventory(2) })
  const { rerender } = render(
    <div role="menu">
      <SetupAgentsMenuItem variant="context" machineId="a" machines={machines} />
    </div>,
  )
  expect(screen.getByRole('menuitem').textContent).toBe('Set up agents…1 installing')
  rerender(
    <div role="menu">
      <SetupAgentsMenuItem variant="context" machineId="b" machines={machines} />
    </div>,
  )
  expect(screen.getByRole('menuitem').textContent).toBe('Set up agents…2 installing')
  fixture.machines.set('b', { inventory: inventory(0) })
  rerender(
    <div role="menu">
      <SetupAgentsMenuItem variant="context" machineId="b" machines={machines} />
    </div>,
  )
  expect(screen.getByRole('menuitem').textContent).toBe('Set up agents…')
})

it('asks which machine for an unpinned fleet and binds handback to that choice', async () => {
  const onStart = vi.fn()
  render(
    <CapabilityAgentMenu
      trigger={<button type="button">Agent</button>}
      options={options}
      selectedValue="codex"
      onSelect={vi.fn()}
      setup={{ machines, onStart }}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Set up agents…' }))
  expect(setupAgentsRequest()).toBeNull()
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Build machine' }))
  const request = setupAgentsRequest()
  expect(request?.machineId).toBe('b')
  act(() => request?.onStart?.('pi'))
  expect(onStart).toHaveBeenCalledExactlyOnceWith('pi', 'b')
})

it('offers the same choice in the cursor menu, closing it only once the panel opens', () => {
  const onOpen = vi.fn()
  const onStart = vi.fn()
  render(
    <div role="menu">
      <SetupAgentsMenuItem
        variant="context"
        machines={machines}
        onOpen={onOpen}
        onStart={onStart}
      />
    </div>,
  )
  fireEvent.click(screen.getByRole('menuitem', { name: 'Set up agents…' }))
  expect(onOpen).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Workstation' }))
  expect(onOpen).toHaveBeenCalledTimes(1)
  act(() => setupAgentsRequest()?.onStart?.('codex'))
  expect(onStart).toHaveBeenCalledExactlyOnceWith('codex', 'a')
})
