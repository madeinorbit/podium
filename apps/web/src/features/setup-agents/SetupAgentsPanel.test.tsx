import type { MachineModel } from '@podium/client-graph'
import { type AgentSetupOrigin, AgentSetupView } from '@podium/client-graph/agent-setup-view'
import { MachineHarness } from '@podium/client-graph/machine-harness'
import {
  type AgentInventory,
  asMachineId,
  asSessionId,
  BUILTIN_HARNESS_KINDS,
  type BuiltinHarnessKind,
  type Inventory,
} from '@podium/model'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { observableRef, runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The browser sign-in terminal is its own dialog; the panel only hands it the session id.
vi.mock('@/app/SetupLoginTerminalDialog', () => ({
  SetupLoginTerminalDialog: ({ sessionId }: { sessionId: string | null }) =>
    sessionId ? <div data-testid="login-terminal">{sessionId}</div> : null,
}))

import { SetupAgentsPanel } from './SetupAgentsPanel'

class Machine {
  readonly id = asMachineId('test-machine')
  readonly name = 'Build box'
  readonly online = true
  readonly use = 'granted' as const
  @observableRef accessor inventory: Inventory | undefined = undefined
  readonly harnessInstalls = BUILTIN_HARNESS_KINDS.map(
    (kind) => new MachineHarness(this as unknown as MachineModel, kind),
  )
  setAgents(agents: AgentInventory[]): void {
    runInAction(() => {
      this.inventory = { os: 'linux', arch: 'x64', agents, tools: [] }
    })
  }
}

const notInstalled = (kind: BuiltinHarnessKind): AgentInventory => ({
  kind,
  installed: false,
  login: { state: 'unknown' },
  management: { installable: true, homeVariable: 'HOME_VAR' },
})
const managed = (kind: BuiltinHarnessKind, login: 'in' | 'out'): AgentInventory => ({
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
    },
  },
})
const installing = (kind: BuiltinHarnessKind): AgentInventory => ({
  ...notInstalled(kind),
  install: { managed: { paused: false, installing: { version: '0.171.0' } } },
})
const downloading = (kind: BuiltinHarnessKind, received: number, total: number) => ({
  ...notInstalled(kind),
  install: {
    managed: {
      paused: false,
      installing: {
        version: '0.171.0',
        progress: {
          phase: 'download' as const,
          receivedBytes: received * 2 ** 20,
          totalBytes: total * 2 ** 20,
        },
      },
    },
  },
})
const failed = (kind: BuiltinHarnessKind): AgentInventory => ({
  ...notInstalled(kind),
  install: {
    managed: {
      paused: false,
      lastError: { at: '2026-11-23T10:00:00Z', message: 'Download stopped: connection reset.' },
    },
  },
})

function setup(
  agents: AgentInventory[],
  options: {
    origin?: AgentSetupOrigin
    focus?: BuiltinHarnessKind
    variant?: 'dialog' | 'embedded'
    saved?: { id: string; label: string }[]
  } = {},
) {
  const machine = new Machine()
  machine.setAgents(agents)
  const mutate = vi.fn(
    async (_input: { harness: BuiltinHarnessKind; action: string }) => ({ ok: true }) as never,
  )
  const login = vi.fn(async () => ({ sessionId: asSessionId('login-session') }))
  const view = new AgentSetupView({
    machine: machine as unknown as MachineModel,
    client: { harnessInstalls: { action: { mutate } }, credentials: { login: { mutate: login } } },
    preferences: {
      credentialDefaults: () => ({}),
      saveCredentialDefaults: () => {},
      savedCredentials: () => options.saved ?? [],
    },
    origin: options.origin ?? { kind: 'settings' },
    ...(options.focus ? { focus: options.focus } : {}),
  })
  const onClose = vi.fn()
  render(
    <SetupAgentsPanel
      view={view}
      variant={options.variant ?? 'dialog'}
      {...((options.variant ?? 'dialog') === 'dialog' ? { onClose } : {})}
    />,
  )
  const row = (kind: BuiltinHarnessKind) => {
    const found = document.querySelector<HTMLElement>(`[data-harness="${kind}"]`)
    if (!found) throw new Error(`no row for ${kind}`)
    return found
  }
  return { machine, view, mutate, login, onClose, row }
}

afterEach(cleanup)

describe('Set up agents list', () => {
  it('groups the harnesses and gives every row at most one control beside its chevron', () => {
    const { row } = setup([
      managed('codex', 'in'),
      managed('claude-code', 'out'),
      installing('grok'),
      failed('pi'),
      notInstalled('opencode'),
      { ...notInstalled('cursor'), management: { installable: false, reason: 'Not here.' } },
    ])
    for (const title of ['Didn’t install', 'Installing', 'Ready', 'Needs sign-in', 'Not installed'])
      expect(screen.getByRole('region', { name: title })).toBeTruthy()
    // POD-7440: a row never carries a wrap of buttons next to its name.
    for (const kind of ['codex', 'claude-code', 'grok', 'pi', 'opencode', 'cursor'] as const) {
      const buttons = within(row(kind)).getAllByRole('button')
      expect(buttons.length, kind).toBeLessThanOrEqual(2)
      expect(buttons.at(-1)?.getAttribute('aria-label')).toMatch(/^Open /)
    }
    expect(within(row('claude-code')).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(within(row('pi')).getByRole('alert').textContent).toBe(
      'Download stopped: connection reset.',
    )
    expect(within(row('pi')).getAllByRole('button')).toHaveLength(2)
    expect(within(row('cursor')).getByText('Not here.')).toBeTruthy()
  })

  it('shows an installing row’s step and percent when the machine reports progress, else an indeterminate bar', () => {
    const { row } = setup([downloading('codex', 18, 41), installing('opencode')])
    expect(within(row('codex')).getByRole('status').textContent).toBe(
      'Downloading · 18 of 41 MB · 43%',
    )
    expect(within(row('codex')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('43')
    expect(within(row('opencode')).getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(
      false,
    )
  })

  it('never moves the bar backwards when a second file starts downloading', () => {
    const { machine, row } = setup([downloading('codex', 40, 41)])
    expect(within(row('codex')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('97')
    act(() => machine.setAgents([downloading('codex', 2, 30)]))
    expect(within(row('codex')).getByRole('status').textContent).toBe('Downloading')
    expect(within(row('codex')).getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  })

  it('installs the ticked harnesses only when the person presses Install', () => {
    const { mutate } = setup([notInstalled('codex'), notInstalled('opencode')])
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install Codex' }))
    expect(screen.getByRole('button', { name: 'Install Codex' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Install OpenCode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install 2 agents' }))
    expect(mutate.mock.calls.map(([input]) => [input.harness, input.action])).toEqual([
      ['codex', 'install'],
      ['opencode', 'install'],
    ])
  })

  it('opened from a menu on a harness, ticks it and starts it only once it is ready', async () => {
    const onStart = vi.fn()
    const { machine, onClose } = setup([notInstalled('codex')], {
      origin: { kind: 'menu', onStart },
      focus: 'codex',
    })
    expect(
      (screen.getByRole('checkbox', { name: 'Install Codex' }) as HTMLInputElement).checked,
    ).toBe(true)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }))
    })
    act(() => machine.setAgents([installing('codex')]))
    const start = screen.getByRole('button', { name: /Start Codex session/ })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    // Finished: the panel asks how it signs in, then hands it back.
    act(() => machine.setAgents([managed('codex', 'out')]))
    expect(screen.getByText('How should Codex sign in?')).toBeTruthy()
    expect(screen.getByText(/Installed Codex/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Later/ }))
    fireEvent.click(screen.getByRole('button', { name: /Start Codex session/ }))
    expect(onStart).toHaveBeenCalledWith('codex')
    expect(onClose).toHaveBeenCalled()
  })

  it('embedded in Settings it has no close and no Done', () => {
    setup([managed('codex', 'in')], { variant: 'embedded' })
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Set up agents' })).toBeNull()
  })
})

describe('Set up agents sign-in', () => {
  it('opens the browser sign-in terminal, and says a saved credential applies on any machine', async () => {
    const { login, row } = setup([managed('codex', 'out')], {
      saved: [{ id: 'cred_work', label: 'Work key' }],
    })
    fireEvent.click(within(row('codex')).getByRole('button', { name: 'Sign in' }))
    expect(screen.getByRole('radio', { name: /Sign in with ChatGPT/ })).toBeTruthy()
    expect(screen.getByRole('radio', { name: /Use a saved credential/ }).textContent).toContain(
      'on any machine',
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /Sign in with ChatGPT/ }))
    })
    expect(login).toHaveBeenCalledWith({ harness: 'codex', machineId: 'test-machine' })
    expect(screen.getByTestId('login-terminal').textContent).toBe('login-session')
  })
})

describe('Set up agents harness page', () => {
  it('shows the facts and asks before removing Podium’s copy', () => {
    const { mutate, row } = setup([managed('codex', 'in')])
    fireEvent.click(within(row('codex')).getByRole('button', { name: 'Open Codex' }))
    expect(screen.getByRole('button', { name: /All agents/ })).toBeTruthy()
    expect(screen.getByText('Podium’s copy')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Podium’s copy…' }))
    expect(mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mutate.mock.calls.map(([input]) => input.action)).toEqual(['remove'])
  })
})
