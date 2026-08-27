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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const state = {
  /** `roles.coding.accountId`. A native account NAMES its CLI, which is why the
   *  settings read never has to fall back to a session scan in practice. */
  accountId: '' as string,
  sessions: [] as unknown[],
  installed: ['claude-code', 'codex', 'grok'] as string[],
}

const uiValues = new Map<string, string>()
const uiListeners = new Set<() => void>()

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
      for (const listener of uiListeners) listener()
    },
    subscribe: (listener: () => void) => {
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
  trpc: {
    settings: {
      get: { query: vi.fn(async () => ({ roles: { coding: { accountId: state.accountId } } })) },
      updatePersonal: { mutate: updatePersonal },
    },
    issues: { create: { mutate: vi.fn() }, start: { mutate: vi.fn() } },
    sessions: { uploadImage: { mutate: vi.fn() } },
  },
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (value: typeof store) => unknown) => selector(store),
}))

vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: () => null,
  EffortPicker: () => null,
}))

afterEach(() => {
  cleanup()
  uiValues.clear()
  uiListeners.clear()
  state.accountId = ''
  state.sessions = []
  state.installed = ['claude-code', 'codex', 'grok']
  updatePersonal.mockClear()
})

/** What the agent chip says it will launch. */
const chip = (): HTMLElement => screen.getByRole('button', { name: 'Agent' })

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
    // inherited resolver keeps behaving like the chip's if it ever does.
    state.accountId = 'auto'
    state.sessions = [
      session('claude-code', '2026-08-01T09:00:00.000Z'),
      session('codex', '2026-08-01T17:00:00.000Z'),
    ]
    render(<ColdStartComposer first={false} />)
    await waitFor(() => expect(chip().textContent).toContain('Codex'))
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
