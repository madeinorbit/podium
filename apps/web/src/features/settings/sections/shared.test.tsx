import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { asAccountId, asMachineId } from '@podium/model'
import type { MachineModel, MobxPool } from '@podium/client-graph'
import { SettingsMachines } from '../settings-machine-readers'
import type { ModelCatalogState } from '@podium/client-core/react'
import type { Trpc } from '@/app/trpc'
import { useState } from 'react'
import { observable, runInAction } from 'mobx'
import * as modelCatalogHooks from '@/lib/use-model-catalog'
import { saveSettingsAsCommands } from '../save-settings'
import { BUNDLED_DESCRIPTORS } from '@podium/harness/browser'
import type { HarnessDescriptorWire } from '@podium/protocol'
import { nativeAccountId, normalizeSettings } from '@podium/runtime'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountOptions, managedCodingHarnesses, providerLabel, RoleBackendEditor } from './shared'

const fleet = vi.hoisted(() => ({
  machines: [] as MachineModel[],
}))

// Exercise the real authorization derivation while replacing the Settings opening.
const settingsMachines = new SettingsMachines({
  row: () => ({ machines: fleet.machines.map((machine) => machine.id) }),
  model: (_entity: string, id: string) => fleet.machines.find((machine) => machine.id === id),
} as unknown as MobxPool)

vi.mock('../readers', () => ({ useSettingsAuthorizedMachines: () => settingsMachines.authorized }))

beforeEach(() => {
  vi.mocked(modelCatalogHooks.useModelCatalogState).mockClear()
})

vi.mock('@/app/store', () => {
  const useStore = () => ({ trpc: {} })
  return {
    useStore,
    useRuntimeSelector: (selector: (store: unknown) => unknown) => selector(useStore()),
  }
})

afterEach(() => {
  cleanup()
  modelCatalogFixture.current = {}
  fleet.machines = []
  modelCatalogFixture.byMachine = {}
})

const LIVE_CODEX = {
  codex: [
    { value: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { value: 'gpt-5.4', label: 'GPT-5.4', efforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
}

describe('RoleBackendEditor', () => {
  // POD-3911: effort is chosen for a concrete model the machine describes. Under
  // an Auto model the pill reads Auto and offers nothing to pick.
  it('offers no effort while the model is automatic', () => {
    render(
      // Biome mistakes this component prop for an ARIA role attribute.
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: nativeAccountId('codex'), model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={vi.fn()}
      />,
    )

    // One name per harness (POD-4475): the native row reads the descriptor
    // label 'Codex' — the ChatGPT-login disambiguation lives in the account
    // note below the row, not in a second display string.
    expect(screen.getByRole('combobox').textContent).toContain('Codex')
    expect(screen.getByRole('combobox').textContent).not.toContain('ChatGPT')
    const effort = screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement
    expect(effort.textContent).toContain('Auto')
    expect(effort.disabled).toBe(true)
  })

  it('uses the shared Codex model and effort dropdowns and persists the harness', () => {
    modelCatalogFixture.current = LIVE_CODEX
    const onChange = vi.fn()
    render(
      // Biome mistakes this component prop for an ARIA role attribute.
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="superagent"
        backend={{
          accountId: nativeAccountId('codex'),
          model: 'gpt-5.5',
          effort: 'auto',
        }}
        accounts={[]}
        onChange={onChange}
      />,
    )

    expect(screen.getByText('Default account')).toBeTruthy()
    expect(screen.getByText('Default model')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'GPT-5.4' }))
    expect(onChange).toHaveBeenCalledWith({
      accountId: nativeAccountId('codex'),
      harness: 'codex',
      model: 'gpt-5.4',
      effort: 'auto',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    expect(screen.getByRole('menuitem', { name: 'Extra high' })).toBeTruthy()
  })
})

describe('accountOptions', () => {
  it('only offers execution paths supported by each role', () => {
    expect(accountOptions('superagent').map((option) => option.id)).toEqual([
      'native:claude-code',
      'native:codex',
      'native:grok',
      'native:opencode',
      'native:cursor',
      'native:pi',
    ])
    expect(accountOptions('background').map((option) => option.id)).toEqual([
      'native:codex',
      'managed:anthropic',
      'managed:openai',
      'managed:openrouter',
    ])
    // Shipwright mirrors the superagent: every native account, discovered logins
    // included. It deliberately no longer narrows to all-tools-off harnesses — doing
    // that in the browser meant importing the harness manifest registry into the
    // settings bundle. The rule still holds where it can refuse (the server's
    // shipwright router), and this asserts the picker does NOT restate it.
    expect(
      accountOptions('shipwright', [
        {
          id: 'native:grok:fingerprint',
          provider: 'grok',
          source: 'native',
          harness: 'grok',
          status: 'connected',
        },
      ]).map((option) => option.id),
    ).toEqual([
      'native:claude-code',
      'native:codex',
      'native:grok',
      'native:opencode',
      'native:cursor',
      'native:pi',
      'native:grok:fingerprint',
    ])
  })
})

/**
 * The chain that makes #216 real: server-held credential → spawn env. It is only
 * reachable if the CODING role can actually be pointed at a managed account.
 *
 * These are the tests that would have caught the severed link: injection was green
 * end-to-end, but ONLY for `roles.coding.accountId = 'managed:*'` — a setting the
 * picker refused to produce, so no real user could ever reach it.
 */
describe('accountOptions', () => {
  it('offers managed accounts for the CODING role — this is what makes #216 reachable', () => {
    const ids = accountOptions('coding').map((o) => o.id)
    // The credential Podium injects into a coding harness spawn.
    expect(ids).toContain('managed:anthropic')
    expect(ids).toContain('managed:claude-oauth')
    expect(ids).toContain('managed:openai')
    // Native logins stay exactly as they were.
    expect(ids).toContain('native:claude-code')
    expect(ids).toContain('native:codex')
  })

  it('does not offer a credential no coding CLI can authenticate with', () => {
    // OPENROUTER_API_KEY authenticates none of the coding harnesses; offering it
    // would spawn an agent that silently falls back to the machine's own login.
    expect(accountOptions('coding').map((o) => o.id)).not.toContain('managed:openrouter')
    // It remains valid for the API-backed roles.
    expect(accountOptions('background').map((o) => o.id)).toContain('managed:openrouter')
  })
})

describe('RoleBackendEditor · managed account for the coding role (#216)', () => {
  /** Open the Nth select (0 = Account, 1 = Harness) and pick `label`. A Base UI
   *  select only commits on a real pointer sequence — a bare click is a no-op. */
  function pick(select: number, label: string | RegExp): void {
    fireEvent.click(screen.getAllByRole('combobox')[select] as HTMLElement)
    const option = screen.getByRole('option', { name: label })
    fireEvent.pointerDown(option)
    fireEvent.pointerUp(option)
    fireEvent.click(option)
  }
  const pickAccount = (label: string | RegExp): void => pick(0, label)

  it('writes the managed accountId AND a harness to run it on', () => {
    const onChange = vi.fn()
    render(
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: nativeAccountId('claude-code'), model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={onChange}
      />,
    )

    pickAccount(/Anthropic API key \(managed\)/)
    // Without `harness` the role is ambiguous: resolveRole() would decode the
    // managed id as an API backend and never run a CLI.
    expect(onChange).toHaveBeenCalledWith({
      accountId: 'managed:anthropic',
      harness: 'claude-code',
      model: 'auto',
      effort: 'auto',
    })
  })

  it('defaults the Claude subscription to claude-code and OpenAI to codex', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: nativeAccountId('claude-code'), model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={onChange}
      />,
    )
    pickAccount(/Claude subscription \(managed\)/)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'managed:claude-oauth', harness: 'claude-code' }),
    )

    onChange.mockClear()
    rerender(
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{ accountId: nativeAccountId('claude-code'), model: 'auto', effort: 'auto' }}
        accounts={[]}
        onChange={onChange}
      />,
    )
    pickAccount(/OpenAI API key \(managed\)/)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'managed:openai', harness: 'codex' }),
    )
  })

  it('switching back to a native account CLEARS the harness', () => {
    const onChange = vi.fn()
    render(
      // biome-ignore lint/a11y/useValidAriaRole: this selects the Podium backend role
      <RoleBackendEditor
        role="coding"
        backend={{
          accountId: asAccountId('managed:openai'),
          harness: 'codex',
          model: 'auto',
          effort: 'auto',
        }}
        accounts={[]}
        onChange={onChange}
      />,
    )
    pickAccount('Claude Code')
    // A stale `harness: codex` on a native:claude-code account would make
    // resolveRole() run codex — the patch must write the key, not omit it.
    expect(onChange).toHaveBeenCalledWith({
      accountId: nativeAccountId('claude-code'),
      harness: undefined,
      model: 'auto',
      effort: 'auto',
    })
  })
})

/**
 * Managed pairing reads descriptor.provider (POD-4541): no hand-written
 * harness list in the client. A future harness with provider `anthropic`
 * pairs with the same managed accounts without a client change.
 */
describe('managed pairing reads descriptor.provider', () => {
  const claudeRow = BUNDLED_DESCRIPTORS.find((d) => d.kind === 'claude-code')
  if (!claudeRow) throw new Error('bundled descriptors have no claude-code row')
  const futureAnthropic = {
    ...claudeRow,
    kind: 'future-cli',
    provider: 'anthropic',
    label: 'Future CLI',
    shortLabel: 'Future',
  } as HarnessDescriptorWire

  it('pairs managed:anthropic and claude-oauth with every anthropic descriptor', () => {
    const descriptors = [...BUNDLED_DESCRIPTORS, futureAnthropic]
    expect(managedCodingHarnesses(asAccountId('managed:anthropic'), descriptors)).toEqual([
      'claude-code',
      'future-cli',
    ])
    expect(managedCodingHarnesses(asAccountId('managed:claude-oauth'), descriptors)).toEqual([
      'claude-code',
      'future-cli',
    ])
  })

  it('pairs managed:openai via the bundled fallback and leaves openrouter unoffered', () => {
    expect(managedCodingHarnesses(asAccountId('managed:openai'), undefined)).toEqual(['codex'])
    expect(managedCodingHarnesses(asAccountId('managed:openrouter'), undefined)).toEqual([])
  })

  it('keeps the ChatGPT provider namespace without naming a harness', () => {
    expect(providerLabel('anthropic')).toBe('Anthropic')
    expect(providerLabel('codex')).toBe('Codex (ChatGPT)')
  })
})


it('accepts a typed default model in Settings when no live list is reported', async () => {
  const onChange = vi.fn()
  // biome-ignore lint/a11y/useValidAriaRole: backend role, not an ARIA attribute
  render(<RoleBackendEditor role="coding" backend={{ accountId: nativeAccountId('codex'), model: 'auto', effort: 'auto' }} accounts={[]} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  fireEvent.change(await screen.findByPlaceholderText('Model name…'), { target: { value: 'managed-custom-model' } })
  fireEvent.click(screen.getByRole('menuitem', { name: /Use “managed-custom-model”/ }))
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ model: 'managed-custom-model', effort: 'auto' }))
})


it('shows stored effort inert for a Settings harness with no reported levels', () => {
  // biome-ignore lint/a11y/useValidAriaRole: backend role, not an ARIA attribute
  render(<RoleBackendEditor role="coding" backend={{ accountId: nativeAccountId('cursor'), model: 'stored', effort: 'high' }} accounts={[]} onChange={vi.fn()} />)
  const pill = screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement
  expect(pill.disabled).toBe(true)
  expect(pill.textContent).toContain('High')
})


function warningMachine(id: string, name: string, patch: Partial<MachineModel> = {}): MachineModel {
  return observable({ id: asMachineId(id), name, use: 'granted', online: true, ...patch }) as MachineModel
}

function reportedCodex(model = 'gpt-5.4', status: ModelCatalogState['status'] = 'ready'): ModelCatalogState {
  return { catalog: { codex: [{ value: model, label: model }] }, status }
}

describe.each(['coding', 'superagent'] as const)('%s default model warning', (role) => {
  function show(model = 'gpt-5.5', effort = 'auto') {
    return render(
      // biome-ignore lint/a11y/useValidAriaRole: backend role, not an ARIA attribute
      <RoleBackendEditor role={role} backend={{ accountId: nativeAccountId('codex'), model, effort }} accounts={[]} onChange={vi.fn()} />,
    )
  }

  beforeEach(() => {
    fleet.machines = [warningMachine('studio', 'Studio Mac')]
    modelCatalogFixture.byMachine.studio = reportedCodex()
  })

  it('names one machine under the model row and above effort', () => {
    show()
    const warning = screen.getByRole('status')
    expect(warning.textContent).toBe('Not offered on Studio Mac')
    expect(warning.previousElementSibling?.textContent).toContain(role === 'coding' ? 'Model' : 'Default model')
    expect(warning.nextElementSibling?.textContent).toContain(role === 'coding' ? 'Effort' : 'Default effort')
  })

  it('names two machines, comma-separated, including an offline stored list', () => {
    fleet.machines.push(warningMachine('laptop', 'Travel Laptop', { online: false }))
    modelCatalogFixture.byMachine.laptop = reportedCodex('gpt-5.3', 'unavailable')
    show()
    expect(screen.getByRole('status').textContent).toBe('Not offered on Studio Mac, Travel Laptop')
  })

  it('has no warning for Auto', () => {
    show('auto')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('has no warning when every authorized machine lists the model', () => {
    fleet.machines.push(warningMachine('laptop', 'Travel Laptop', { online: false }))
    modelCatalogFixture.byMachine.laptop = reportedCodex('gpt-5.4', 'unavailable')
    show('gpt-5.4')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('has no warning when no machine has reported a list for the harness', () => {
    modelCatalogFixture.byMachine.studio = { catalog: { grok: [{ value: 'grok-4', label: 'Grok 4' }] }, status: 'ready' }
    show()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('has no warning for an empty reported list', () => {
    modelCatalogFixture.byMachine.studio = { catalog: { codex: [] }, status: 'ready' }
    show()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('has no warning while any authorized list is loading, even with stored models', () => {
    fleet.machines.push(warningMachine('laptop', 'Travel Laptop'))
    modelCatalogFixture.byMachine.laptop = reportedCodex('gpt-5.3', 'loading')
    show()
    expect(modelCatalogHooks.useModelCatalogState).toHaveBeenCalledWith(asMachineId('studio'))
    expect(modelCatalogHooks.useModelCatalogState).toHaveBeenCalledWith(asMachineId('laptop'))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('ignores denied machines and machines whose use permission is not evaluated', () => {
    fleet.machines.push(warningMachine('denied', 'Shared Mac', { use: 'denied' }))
    fleet.machines.push(warningMachine('unknown', 'Unknown Mac', { use: undefined }))
    modelCatalogFixture.byMachine.denied = reportedCodex('gpt-5.3')
    modelCatalogFixture.byMachine.unknown = reportedCodex('gpt-5.3', 'loading')
    show('gpt-5.4')
    expect(screen.queryByRole('status')).toBeNull()
    expect(modelCatalogHooks.useModelCatalogState).not.toHaveBeenCalledWith(asMachineId('denied'))
    expect(modelCatalogHooks.useModelCatalogState).not.toHaveBeenCalledWith(asMachineId('unknown'))
  })

  it('has no warning when there are no authorized machines', () => {
    fleet.machines = []
    show()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not warn about unsupported effort for an offered model', () => {
    show('gpt-5.4', 'ultra')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Effort' }).textContent).toContain('Ultra')
  })

  it('updates when catalogs finish loading and the machine name changes', () => {
    modelCatalogFixture.byMachine.studio = reportedCodex('gpt-5.4', 'loading')
    show()
    expect(screen.queryByRole('status')).toBeNull()
    modelCatalogFixture.byMachine.studio = reportedCodex()
    act(() => runInAction(() => Object.assign(fleet.machines[0]!, { name: 'Renamed Mac' })))
    expect(screen.getByRole('status').textContent).toBe('Not offered on Renamed Mac')
  })

  it('writes the chosen model to personal settings while the warning is shown', async () => {
    const previous = normalizeSettings({ roles: { [role]: { accountId: nativeAccountId('codex'), model: 'auto', effort: 'auto' } } })
    const updatePersonal = vi.fn(async () => previous)
    const trpc = { settings: { updatePersonal: { mutate: updatePersonal } } } as unknown as Trpc
    function EditableDefault() {
      const [settings, setSettings] = useState(previous)
      return (
        <>
          {/* biome-ignore lint/a11y/useValidAriaRole: backend role, not an ARIA attribute */}
          <RoleBackendEditor role={role} backend={settings.roles[role]} accounts={[]} onChange={(backend) => setSettings({ ...settings, roles: { ...settings.roles, [role]: { ...settings.roles[role], ...backend } } })} />
          <button type="button" onClick={() => saveSettingsAsCommands(trpc, previous, settings)}>Save</button>
        </>
      )
    }
    render(<EditableDefault />)
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.change(await screen.findByPlaceholderText('Model name…'), { target: { value: 'custom-model' } })
    fireEvent.click(screen.getByRole('menuitem', { name: /Use “custom-model”/ }))
    expect(screen.getByRole('status').textContent).toBe('Not offered on Studio Mac')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(updatePersonal).toHaveBeenCalledWith({
      values: expect.objectContaining({ [`roles.${role}.model`]: 'custom-model' }),
    }))
  })
})

it('has no warning for a managed coding account with no reported list', () => {
  fleet.machines = [warningMachine('studio', 'Studio Mac')]
  modelCatalogFixture.byMachine.studio = { catalog: {}, status: 'unavailable' }
  // biome-ignore lint/a11y/useValidAriaRole: backend role, not an ARIA attribute
  render(<RoleBackendEditor role="coding" backend={{ accountId: asAccountId('managed:openai'), harness: 'codex', model: 'managed-model', effort: 'ultra' }} accounts={[]} onChange={vi.fn()} />)
  expect(screen.queryByRole('status')).toBeNull()
})
