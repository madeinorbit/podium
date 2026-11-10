import type { ModelCatalogState } from '@podium/client-core/react'
import type { MachineModel } from '@podium/client-graph'
import { type AccountView, asMachineId } from '@podium/model/browser'
import { normalizeSettings, resolveRole } from '@podium/runtime'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRoleFields, AgentsSection } from './agents'
import { ModelAvailabilityWarning } from './model-availability-warning'
import { SettingsControlsContext } from './shared'

const fixture = vi.hoisted(() => ({
  machines: [] as MachineModel[],
  catalog: {} as ModelCatalogState['catalog'],
  byMachine: {} as Record<string, ModelCatalogState>,
}))
vi.mock('../readers', () => ({
  useSettingsAuthorizedMachines: () =>
    fixture.machines.filter((machine) => machine.use === 'granted'),
}))
vi.mock('@/lib/use-model-catalog', () => ({
  useModelCatalogState: (id?: string): ModelCatalogState =>
    id
      ? (fixture.byMachine[id] ?? { catalog: {}, status: 'unavailable' })
      : { catalog: fixture.catalog, status: 'ready' },
}))
vi.mock('@/lib/use-harness-descriptors', () => ({ useHarnessDescriptors: () => ({ served: [] }) }))

const accounts: AccountView[] = [
  {
    id: 'native:codex',
    provider: 'openai',
    source: 'native',
    harness: 'codex',
    status: 'connected',
  },
  {
    id: 'managed:openai',
    provider: 'openai',
    source: 'managed',
    kind: 'api-key',
    credentialSource: 'stored',
    status: 'connected',
  },
]
function machine(id: string, name: string, patch: Partial<MachineModel> = {}): MachineModel {
  return observable({
    id: asMachineId(id),
    name,
    use: 'granted',
    online: true,
    ...patch,
  }) as MachineModel
}
function reported(
  model = 'other',
  status: ModelCatalogState['status'] = 'ready',
): ModelCatalogState {
  return { catalog: { codex: [{ value: model, label: model }] }, status }
}
afterEach(() => {
  cleanup()
  fixture.machines = []
  fixture.catalog = {}
  fixture.byMachine = {}
})

describe('Model availability', () => {
  beforeEach(() => {
    fixture.machines = [machine('studio', 'Studio')]
    fixture.byMachine.studio = reported()
  })
  const show = (model = 'chosen') =>
    render(<ModelAvailabilityWarning harness="codex" model={model} />)
  it('names unavailable machines, including offline stored catalogs', () => {
    fixture.machines.push(machine('laptop', 'Laptop', { online: false }))
    fixture.byMachine.laptop = reported('older', 'unavailable')
    show()
    expect(screen.getByRole('status').textContent).toBe('Not offered on Studio, Laptop')
  })
  it('does not warn for Auto or an offered model', () => {
    const { rerender } = show('auto')
    expect(screen.queryByRole('status')).toBeNull()
    rerender(<ModelAvailabilityWarning harness="codex" model="other" />)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it.each([
    {},
    { codex: [] },
    { grok: [{ value: 'grok', label: 'Grok' }] },
  ])('does not infer absence from an unreported or empty catalog (%j)', (catalog) => {
    fixture.byMachine.studio = { catalog, status: 'unavailable' }
    show()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('waits for every authorized catalog to settle', () => {
    fixture.machines.push(machine('laptop', 'Laptop'))
    fixture.byMachine.laptop = reported('older', 'loading')
    show()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('ignores denied machines and unknown use permission', () => {
    fixture.byMachine.studio = reported('chosen')
    fixture.machines.push(
      machine('denied', 'Denied', { use: 'denied' }),
      machine('unknown', 'Unknown', { use: undefined }),
    )
    fixture.byMachine.denied = reported()
    fixture.byMachine.unknown = reported('other', 'loading')
    show()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('updates after a rename and a catalog finishes loading', () => {
    fixture.byMachine.studio = reported('other', 'loading')
    show()
    expect(screen.queryByRole('status')).toBeNull()
    fixture.byMachine.studio = reported()
    const first = fixture.machines[0]
    if (!first) throw new Error('Missing fixture machine')
    act(() => runInAction(() => Object.assign(first, { name: 'Renamed' })))
    expect(screen.getByRole('status').textContent).toBe('Not offered on Renamed')
  })
})

describe('Agent role fields', () => {
  it('writes account and harness together without resetting compatible overrides', () => {
    fixture.catalog = { codex: [{ value: 'shared-model', label: 'Shared', efforts: ['high'] }] }
    const settings = normalizeSettings({
      roles: { coding: { accountId: 'native:codex', model: 'shared-model', effort: 'high' } },
    })
    const onChange = vi.fn()
    render(
      <AgentRoleFields
        roleName="coding"
        backend={settings.roles.coding}
        resolved={resolveRole(settings, 'coding')}
        accounts={accounts}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent' }))
    const option = screen.getByRole('option', { name: /your OpenAI key/ })
    fireEvent.pointerDown(option)
    fireEvent.pointerUp(option)
    fireEvent.click(option)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'managed:openai',
        harness: 'codex',
        model: 'shared-model',
        effort: 'high',
      }),
    )
  })
  it('shows the resolved Auto model and catalog effort segments', () => {
    fixture.catalog = {
      codex: [{ value: 'catalog-default', label: 'Catalog default', efforts: ['low', 'high'] }],
    }
    const settings = normalizeSettings({ roles: { coding: { accountId: 'native:codex' } } })
    const onChange = vi.fn()
    render(
      <AgentRoleFields
        roleName="coding"
        backend={settings.roles.coding}
        resolved={resolveRole(settings, 'coding')}
        accounts={accounts}
        onChange={onChange}
      />,
    )
    expect(screen.getByRole('button', { name: 'Model' }).textContent).toBe('Auto · Catalog default')
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }))
  })
  it('keeps denied preference controls read-only', () => {
    const settings = normalizeSettings({ roles: { coding: { accountId: 'native:codex' } } })
    render(
      <SettingsControlsContext.Provider
        value={{ settings, permitted: { 'records.userPreferences.edit': false } }}
      >
        <AgentRoleFields
          roleName="coding"
          backend={settings.roles.coding}
          resolved={resolveRole(settings, 'coding')}
          accounts={accounts}
          onChange={vi.fn()}
        />
      </SettingsControlsContext.Provider>,
    )
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

it('shows subagent model only when the harness accepts it', () => {
  const settings = normalizeSettings({ roles: { coding: { accountId: 'native:claude-code' } } })
  const { rerender } = render(
    <AgentsSection settings={settings} accounts={accounts} patch={vi.fn()} />,
  )
  expect(screen.getByText('Subagent model')).toBeTruthy()
  const next = normalizeSettings({ roles: { coding: { accountId: 'native:codex' } } })
  rerender(<AgentsSection settings={next} accounts={accounts} patch={vi.fn()} />)
  expect(screen.queryByText('Subagent model')).toBeNull()
})

it('shows the background error with its machine', () => {
  const settings = normalizeSettings({ roles: { background: { accountId: 'native:codex' } } })
  const withError = accounts.map((account) =>
    account.id === 'native:codex'
      ? {
          ...account,
          serverAi: { machineName: 'Workstation', lastError: 'Provider refused the request' },
        }
      : account,
  )
  render(<AgentsSection settings={settings} accounts={withError} patch={vi.fn()} />)
  expect(screen.getByText('Last error: Provider refused the request')).toBeTruthy()
  expect(screen.getByText('Uses the login on Workstation.')).toBeTruthy()
})
