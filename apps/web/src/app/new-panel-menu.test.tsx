// @vitest-environment happy-dom
/**
 * THE TAB STRIP'S "+" (POD-1201).
 *
 * Two things are asserted here, and they are the two halves of the same brief:
 *
 *  1. NO RESUME REGION. The menu used to end in a server-indexed history search
 *     with its own filter field. The field is gone, and so is the query behind
 *     it — a menu that still fetched conversations it never renders would be an
 *     invisible cost on every open.
 *  2. THE HARNESS READING SURVIVED. This menu is the one the other two spawn
 *     surfaces were made to match, so its own refusal has to keep working: the
 *     fixture machine runs claude-code and not cursor.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewPanelMenu } from './NewPanelMenu'

// Hoisted: `vi.mock`'s factory runs before module-level bindings exist, so the
// spy the assertions read has to be created in the hoisted scope too.
const { conversationSearch, createSession, feature, machine, opened, setPanelMode } = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ sessionId: 'new' })),
  feature: { enabled: false },
  conversationSearch: vi.fn(async () => []),
  opened: vi.fn(),
  setPanelMode: vi.fn(),
  machine: {
    id: 'mine',
    name: 'mine',
    hostname: 'mine',
    online: true,
    inventory: {
      agents: [
        { kind: 'claude-code', installed: true, login: { state: 'in' } },
        { kind: 'cursor', installed: false, login: { state: 'unknown' } },
        { kind: 'opencode', installed: true, login: { state: 'in' } },
      ],
      runtimeDrivers: [
        { harness: 'claude-code', id: 'claude-pty', family: 'terminal' },
        { harness: 'claude-code', id: 'claude-sdk', family: 'embedded' },
        { harness: 'opencode', id: 'generic-pty', family: 'terminal' },
        { harness: 'opencode', id: 'opencode-server', family: 'server' },
      ],
    },
  },
}))

vi.mock('@/app/store', () => {
  const state = {
    trpc: {
      conversations: { search: { query: conversationSearch } },
      sessions: { create: { mutate: createSession } },
    },
    repos: [
      {
        path: '/home/mine/podium',
        kind: 'repository',
        branch: 'main',
        machineId: 'mine',
        worktrees: [],
      },
    ],
    sessions: [],
    machines: [machine],
    setPanelMode,
    recentFiles: [],
    openFileInWorktree: vi.fn(),
    openArtifact: vi.fn(),
  }
  return {
    useStore: () => state,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state as never),
  }
})

vi.mock('@/lib/use-feature', () => ({
  useFeature: () => feature.enabled,
}))

const worktree = {
  path: '/home/mine/podium',
  repoPath: '/home/mine/podium',
  isMain: true,
  branch: 'main',
  machineId: 'mine',
}

afterEach(() => {
  cleanup()
  conversationSearch.mockClear()
  createSession.mockClear()
  feature.enabled = false
  opened.mockClear()
  setPanelMode.mockClear()
})

function open() {
  return render(
    <NewPanelMenu
      worktree={worktree as never}
      onOpened={opened}
      open
      onOpenChange={vi.fn()}
      trigger={<button type="button">plus</button>}
    />,
  )
}

describe('the new-panel menu', () => {
  it('no longer offers a history search, and no longer queries for one', async () => {
    open()
    // The agents region proves the panel actually rendered, so the absences below
    // are absences rather than an empty tree.
    expect(await screen.findByRole('menuitem', { name: /New Claude/ })).toBeTruthy()

    expect(screen.queryByLabelText('Search history')).toBeNull()
    expect(screen.queryByText('RESUME')).toBeNull()
    expect(conversationSearch).not.toHaveBeenCalled()
  })

  it('still refuses a harness the machine does not have', async () => {
    open()

    const cursor = await screen.findByRole('menuitem', { name: /New Cursor/ })
    expect(cursor.textContent).toContain('not installed')
    expect(cursor.getAttribute('data-refused')).toBe('true')

    const claude = await screen.findByRole('menuitem', { name: /New Claude/ })
    expect(claude.getAttribute('data-refused')).toBeNull()
  })

  it('keeps headed creation as the default and exposes only available headless drivers when enabled', async () => {
    feature.enabled = true
    open()

    fireEvent.click(await screen.findByRole('menuitem', { name: /^New Claude$/ }))
    expect(createSession).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ runtimeContract: expect.anything() }),
    )

    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('new'))
    opened.mockClear()
    setPanelMode.mockClear()
    fireEvent.click(screen.getByRole('menuitem', { name: /^New OpenCode$/ }))
    await vi.waitFor(() =>
      expect(createSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentKind: 'opencode',
          runtimeContract: true,
        }),
      ),
    )
    expect(createSession).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ accountId: expect.anything() }),
    )
    expect(setPanelMode).toHaveBeenCalledWith('new', 'native')
    expect(setPanelMode.mock.invocationCallOrder[0]).toBeLessThan(
      opened.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )

    fireEvent.click(screen.getByRole('menuitem', { name: /New OpenCode — opencode-server/ }))
    await vi.waitFor(() =>
      expect(createSession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentKind: 'opencode',
          runtimeContract: 'opencode-server',
        }),
      ),
    )
    expect(createSession).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ accountId: expect.anything() }),
    )
    expect(setPanelMode).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('menuitem', { name: /New Claude — claude-sdk/ }))
    expect(createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeContract: 'claude-sdk' }),
    )
    expect(screen.queryByText('codex-app-server')).toBeNull()
  })

  it('does not expose headless drivers while the experiment is off', async () => {
    open()
    expect(await screen.findByRole('menuitem', { name: /^New Claude$/ })).toBeTruthy()
    expect(screen.queryByText(/claude-sdk/)).toBeNull()
  })

  it('makes a logged-out headless choice visibly conditional instead of silently rebinding it', async () => {
    feature.enabled = true
    const claude = machine.inventory.agents.find((agent) => agent.kind === 'claude-code')
    if (!claude) throw new Error('fixture has no claude-code inventory row')
    claude.login.state = 'out'
    open()

    const headless = await screen.findByRole('menuitem', { name: /New Claude — claude-sdk/ })
    await vi.waitFor(() => expect(headless.textContent).toContain('logged out'))
    claude.login.state = 'in'
  })
})
