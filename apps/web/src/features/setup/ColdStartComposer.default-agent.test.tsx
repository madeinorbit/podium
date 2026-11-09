import '@/test-support/model-catalog-mock'
import '@/test-support/mock-core-store-handle'
import { draftLaunchEffect } from '@podium/client-core'
// @vitest-environment happy-dom
/**
 * WHICH HARNESS THE BOX OPENS ON, AND WHAT REMEMBERS IT (POD-1469).
 *
 * The sidebar's deleted `New <Agent> in <Repo>` chip showed the last harness the
 * operator chose, and the mechanism was not clever: its menu WROTE the pick to
 * `roles.coding.accountId`, and the chip read that back through
 * `resolveDefaultAgent`. The composer had the read and not the write — the pick
 * lived in its own ui-state draft, so the issue page, the dock and the CLI never
 * learned it and a cleared draft forgot it.
 *
 * So the assertions are a pair: the box opens on the persisted harness, and
 * choosing one in the box persists it. Availability comes after, never before —
 * a default that cannot start on the chosen machine steps aside for one that
 * can.
 */
import { asIssueId, asMachineId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const machineId = asMachineId('machine-a')

/** Every harness this fixture's host can actually run. Readiness is checked
 *  BEFORE the default is honoured, so a machine that only has Claude Code would
 *  mask the very fallthrough these tests are about. */
function inventoryFor(kinds: readonly string[]) {
  return {
    os: 'darwin' as const,
    arch: 'arm64' as const,
    agents: kinds.map((kind) => ({
      kind: kind as 'claude-code',
      installed: true,
      login: { state: 'in' as const },
    })),
    tools: [],
    runtimeDrivers: state.runtimeDrivers,
  }
}

function session(kind: string, lastActiveAt: string) {
  return {
    sessionId: `s-${kind}`,
    agentKind: kind,
    cwd: '/work/podium',
    title: kind,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt,
    origin: { kind: 'spawn' },
    archived: false,
  }
}

const feature = { enabled: false }

const state = {
  /** `roles.coding.accountId`. A native account NAMES its CLI, which is why the
   *  settings read never has to fall back to a session scan in practice. */
  accountId: '' as string,
  /** How the setting reaches the box: from my synced record (`resolved`), not
   *  yet (`absent`: my record is not in the pool yet), or `auto`. */
  setting: 'resolved' as 'resolved' | 'absent' | 'auto',
  sessions: [] as unknown[],
  installed: ['claude-code', 'codex', 'grok'] as string[],
  runtimeDrivers: [] as Array<{
    harness: 'claude-code' | 'opencode'
    id: string
    family: 'terminal' | 'server'
  }>,
}

const uiValues = new Map<string, string>()
const uiListeners = new Set<(keys: ReadonlySet<string>) => void>()

const updatePersonal = vi.fn(async (input: { values: Record<string, string> }) => {
  state.accountId = input.values['roles.coding.accountId'] ?? state.accountId
  return { roles: { coding: { accountId: state.accountId } } }
})

const store = {
  get repos() {
    return [
      {
        path: '/work/podium',
        kind: 'repository' as const,
        branch: 'main',
        worktrees: [],
        machineId,
      },
    ]
  },
  get sessions() {
    return state.sessions
  },
  get machines() {
    return [
      {
        id: machineId,
        name: 'Studio Mac',
        hostname: 'studio',
        online: true,
        serviceAssignment: { server: false, agentExecution: true },
        availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
        lastSeenAt: new Date(0).toISOString(),
        inventory: inventoryFor(state.installed),
      },
    ]
  },
  // A REAL ui-state: the composer SUBSCRIBES to its draft key rather than seeding
  // it (POD-1469), so a pick made in the chip only sticks if the store both
  // stores and notifies.
  uiState: {
    get: (key: string) => uiValues.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) uiValues.delete(key)
      else uiValues.set(key, value)
      for (const listener of uiListeners) listener(new Set([key]))
    },
    subscribe: (listener: (keys: ReadonlySet<string>) => void) => {
      uiListeners.add(listener)
      return () => uiListeners.delete(listener)
    },
  },
  focusIssueSession: vi.fn(async () => null),
  spawnDraftAgent: vi.fn(() => ({
    sessionId: asSessionId('session-new'),
    issueId: asIssueId('issue-new'),
    settled: Promise.resolve(true),
  })),
  spawnIssueAgent: vi.fn(),
  setSelectedIssueId: vi.fn(),
  setSelectedWorktree: vi.fn(),
  setPane: vi.fn(),
  setPanelMode: vi.fn(),
  setView: vi.fn(),
  // My coding default is my synced settings record (POD-6673): written by
  // `setPreferences`, read through `useMyCodingHarness` (mocked below).
  setPreferences: async (values: Record<string, unknown>) =>
    await updatePersonal({ values: values as Record<string, string> }),
  trpc: {
    settings: {},
    issues: { create: { mutate: vi.fn() }, start: { mutate: vi.fn() } },
    sessions: { uploadImage: { mutate: vi.fn() } },
  },
}

vi.mock('@/app/store', () => ({
  readFixture: (selector: (value: typeof store) => unknown) => selector(store),
}))

vi.mock('@/lib/my-preferences', async () => {
  const { resolveRole } = await import('@podium/runtime')
  // What `UserPreferencesModel.codingHarness` answers: the role resolved from
  // the account exactly as stored, as the box's old `settings.get` read did;
  // undefined until my record is in the pool.
  return {
    useMyCodingHarness: () =>
      state.setting === 'absent'
        ? undefined
        : state.setting === 'auto'
          ? 'auto'
          : resolveRole(
              {
                roles: { coding: { accountId: state.accountId, model: 'auto', effort: 'auto' } },
              } as never,
              'coding',
            ).harness,
  }
})

vi.mock('@/lib/use-feature', () => ({
  useFeature: () => feature.enabled,
}))

const pickerFixture = vi.hoisted(() => ({ real: false }))
vi.mock('@/lib/ModelEffortPicker', async (original) => {
  const actual = await original<typeof import('@/lib/ModelEffortPicker')>()
  return {
    ModelPicker: (props: Parameters<typeof actual.ModelPicker>[0]) =>
      pickerFixture.real ? <actual.ModelPicker {...props} /> : null,
    EffortPicker: (props: Parameters<typeof actual.EffortPicker>[0]) =>
      pickerFixture.real ? <actual.EffortPicker {...props} /> : null,
  }
})

afterEach(() => {
  cleanup()
  uiValues.clear()
  uiListeners.clear()
  state.accountId = ''
  state.setting = 'resolved'
  state.sessions = []
  state.installed = ['claude-code', 'codex', 'grok']
  state.runtimeDrivers = []
  feature.enabled = false
  pickerFixture.real = false
  store.spawnDraftAgent.mockClear()
  updatePersonal.mockClear()
})

/** What the agent chip says it will launch. */
const chip = (): HTMLElement => screen.getByRole('button', { name: 'Agent' })

function publishDrivers(drivers: typeof state.runtimeDrivers): void {
  act(() => {
    state.runtimeDrivers = drivers
    // POD-3911: inventory publications replace rerenders that leave keyed inputs stale.
    // The fake runtime borrows ui-state's subscribers; no ui-state key changed.
    for (const listener of uiListeners) listener(new Set())
  })
}

describe('the box opens on the harness the sidebar chip would have', () => {
  it('takes the persisted one', async () => {
    state.accountId = 'native:codex'
    render(<ColdStartComposer first={false} />)
    await waitFor(() => expect(chip().textContent).toContain('Codex'))
  })

  it('steps aside when that harness cannot start on this machine', async () => {
    state.accountId = 'native:grok'
    state.installed = ['claude-code']
    render(<ColdStartComposer first={false} />)
    // Grok is the default and is not installed here, so the box offers the one
    // harness that can actually run rather than a refusal.
    await waitFor(() => expect(chip().textContent).toContain('Claude Code'))
  })

  it('falls back to Claude Code when nothing has been chosen', async () => {
    render(<ColdStartComposer first={false} />)
    await waitFor(() => expect(chip().textContent).toContain('Claude Code'))
  })

  it('remembers a pick made here — on LAUNCH, the way the chip did', async () => {
    render(<ColdStartComposer first={false} />)
    await waitFor(() => expect(chip().textContent).toContain('Claude Code'))

    fireEvent.click(chip())
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Codex' }))
    await waitFor(() => expect(chip().textContent).toContain('Codex'))

    // MERELY LOOKING IS NOT CHOOSING. The deleted menu persisted and spawned as
    // one action, so the operator's global harness only ever moved when work
    // started on it — opening the chip to consider Codex and walking away must
    // not silently retarget the issue page, the dock and the CLI.
    expect(updatePersonal).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('cold-start-launch'))

    // The same key and the same account spelling the deleted sidebar menu wrote.
    await waitFor(() =>
      expect(updatePersonal).toHaveBeenCalledWith({
        values: { 'roles.coding.accountId': 'native:codex' },
      }),
    )
  })

  it('reads a session scan only when the setting arrives unresolved', async () => {
    // `auto` is what the resolver's session fallback exists for. It does not
    // reach here from `roles.coding` today; the branch is asserted so the
    // inherited resolver keeps behaving like the chip's if it ever does. The
    // other unresolved input is no setting at all: my synced record not yet in
    // the pool (POD-6673), where the old read had not answered yet.
    for (const setting of ['auto', 'absent'] as const) {
      state.setting = setting
      state.sessions = [
        session('claude-code', '2026-08-01T09:00:00.000Z'),
        session('codex', '2026-08-01T17:00:00.000Z'),
      ]
      render(<ColdStartComposer first={false} />)
      await waitFor(() => expect(chip().textContent).toContain('Codex'))
      cleanup()
      uiValues.clear()
    }
  })

  it('an account that names no harness resolves to Claude Code, as the settings read did', async () => {
    // The resolver maps an empty or unknown account (`auto` included) to the
    // default harness, so a newer session of another harness does not win.
    for (const accountId of ['', 'auto']) {
      state.accountId = accountId
      state.sessions = [
        session('claude-code', '2026-08-01T09:00:00.000Z'),
        session('codex', '2026-08-01T17:00:00.000Z'),
      ]
      render(<ColdStartComposer first={false} />)
      await waitFor(() => expect(chip().textContent).toContain('Claude Code'))
      expect(chip().textContent).not.toContain('Codex')
      cleanup()
      uiValues.clear()
    }
  })
})

describe('cold-start runtime driver choice', () => {
  it('keeps the headed default with the experiment disabled', async () => {
    state.accountId = 'native:opencode'
    state.installed = ['opencode']
    state.runtimeDrivers = [{ harness: 'opencode', id: 'opencode-server', family: 'server' }]
    render(<ColdStartComposer first={false} />)
    await waitFor(() => expect(chip().textContent).toContain('OpenCode'))
    expect(screen.queryByRole('button', { name: 'Driver' })).toBeNull()
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(store.spawnDraftAgent).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ requestedDriverId: expect.anything() }),
    )
  })

  it('keeps headed explicit by default and sends an available OpenCode server choice', async () => {
    feature.enabled = true
    state.accountId = 'native:opencode'
    state.installed = ['opencode']
    state.runtimeDrivers = [{ harness: 'opencode', id: 'opencode-server', family: 'server' }]
    render(<ColdStartComposer first={false} />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Driver' }).textContent).toContain('Headed'),
    )
    expect(screen.getByRole('button', { name: 'Driver' }).textContent).not.toContain('contract')
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(store.spawnDraftAgent).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ requestedDriverId: expect.anything() }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Driver' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OpenCode 1 (headless)' }))
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(store.spawnDraftAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentKind: 'opencode', requestedDriverId: 'opencode-server' }),
    )
  })

  it('offers headed and headless choices, and headed sends no override', async () => {
    feature.enabled = true
    state.accountId = 'native:opencode'
    state.installed = ['opencode']
    state.runtimeDrivers = [
      { harness: 'opencode', id: 'generic-pty', family: 'terminal' },
      { harness: 'opencode', id: 'opencode-server', family: 'server' },
    ]
    render(<ColdStartComposer first={false} />)

    // The headed row is the manifest's terminal default: plain "Headed", and
    // choosing it sends NOTHING — omission already means the terminal driver
    // (the NewPanelMenu sibling got this right; see its requestedDriverId
    // comment). There is one headed path now, no second headed spelling.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Driver' }).textContent).toContain('Headed'),
    )
    expect(screen.getByRole('button', { name: 'Driver' }).textContent).not.toContain('contract')
    fireEvent.click(screen.getByRole('button', { name: 'Driver' }))
    expect(await screen.findByRole('menuitem', { name: 'Headed' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'OpenCode 1 (headless)' })).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Headed' }))
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(store.spawnDraftAgent).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ requestedDriverId: expect.anything() }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Driver' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'OpenCode 1 (headless)' }))
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(store.spawnDraftAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentKind: 'opencode', requestedDriverId: 'opencode-server' }),
    )
  })

  it('refuses a selected driver that disappears from inventory', async () => {
    feature.enabled = true
    state.accountId = 'native:opencode'
    state.installed = ['opencode']
    state.runtimeDrivers = [{ harness: 'opencode', id: 'opencode-server', family: 'server' }]
    render(<ColdStartComposer first={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Driver' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OpenCode 1 (headless)' }))
    publishDrivers([])
    expect((await screen.findByRole('status')).textContent).toContain('opencode-server unavailable')
    expect((screen.getByTestId('cold-start-launch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(store.spawnDraftAgent).not.toHaveBeenCalled()
  })

  it('reports a vanished headless driver while a headed recovery driver remains', async () => {
    feature.enabled = true
    state.accountId = 'native:opencode'
    state.installed = ['opencode']
    const headed = { harness: 'opencode', id: 'generic-pty', family: 'terminal' } as const
    state.runtimeDrivers = [
      headed,
      { harness: 'opencode', id: 'opencode-server', family: 'server' },
    ]
    render(<ColdStartComposer first={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Driver' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OpenCode 1 (headless)' }))
    publishDrivers([headed])
    expect((await screen.findByRole('status')).textContent).toContain('opencode-server unavailable')
    // The remaining headed driver keeps a recovery menu beside the refusal.
    expect(screen.getByRole('button', { name: 'Driver' })).toBeTruthy()
    expect((screen.getByTestId('cold-start-launch') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(store.spawnDraftAgent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Driver' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Headed' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect((screen.getByTestId('cold-start-launch') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(store.spawnDraftAgent).toHaveBeenCalledWith(
      expect.not.objectContaining({ requestedDriverId: expect.anything() }),
    )
  })
})

describe('driver override reaches the wire through the real spawn path', () => {
  // The component hands `requestedDriverId` to `store.spawnDraftAgent`, which
  // wraps `draftLaunchEffect` (optimism.ts) — the network half that forwards
  // ONLY that field onto `sessions.create`. A spread of a conditional object
  // is not excess-property-checked, so a wrong field name here compiles and
  // is then silently dropped on the wire: exactly the defect this issue fixes.
  // This guard pins the second half of the chain (store arg → wire field);
  // the component tests above pin the first half (Driver chip → store arg).
  it('forwards requestedDriverId to the launch, and omits it when absent', () => {
    // POD-6408: a draft start is a session.launch effect; its input is what the
    // server's `sessions.create` code runs with.
    const target = { path: '/work/podium', repoPath: '/work/podium', placement: 'allowed' as const }
    const driven = draftLaunchEffect({
      effectId: 'eff_00000000-0000-4000-8000-000000000001',
      sessionId: asSessionId('session-driver'),
      issueId: asIssueId('issue-driver'),
      target,
      agentKind: 'opencode',
      requestedDriverId: 'opencode-server',
    })
    expect(driven.input).toMatchObject({ requestedDriverId: 'opencode-server' })

    const headed = draftLaunchEffect({
      effectId: 'eff_00000000-0000-4000-8000-000000000002',
      sessionId: asSessionId('session-headed'),
      issueId: asIssueId('issue-headed'),
      target,
      agentKind: 'opencode',
    })
    expect(headed.input).not.toHaveProperty('requestedDriverId')
  })
})

describe('the agent chip wears its harness', () => {
  it('draws the selected harness glyph, not a brand-coloured bullet', async () => {
    state.accountId = 'native:codex'
    render(<ColdStartComposer first={false} />)
    await waitFor(() => expect(chip().textContent).toContain('Codex'))
    // The glyph is an <svg> from the agent icon set. The thing it replaced was a
    // 7px `bg-claude` square — Claude's clay, in front of the word `Codex`.
    expect(chip().querySelector('svg')).toBeTruthy()
    expect(chip().querySelector('.bg-claude')).toBeNull()
  })

  it('leaves no brand swatch on the project pill either', () => {
    render(<ColdStartComposer first={false} />)
    const project = screen.getByRole('button', { name: /^Project: / })
    expect(project.querySelector('.bg-claude')).toBeNull()
    expect(project.querySelector('.cold-start-project-mark')).toBeNull()
  })
})

it('offers no Use option in the new-task model menu', async () => {
  pickerFixture.real = true
  render(<ColdStartComposer first={false} />)
  await waitFor(() => expect(chip().textContent).toContain('Claude Code'))
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  fireEvent.change(await screen.findByPlaceholderText('Filter…'), {
    target: { value: 'my-custom-model' },
  })
  expect(screen.queryByRole('menuitem', { name: /Use / })).toBeNull()
})
