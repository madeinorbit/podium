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
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewPanelMenu } from './NewPanelMenu'

// Hoisted: `vi.mock`'s factory runs before module-level bindings exist, so the
// spy the assertions read has to be created in the hoisted scope too.
const { conversationSearch, machine } = vi.hoisted(() => ({
  conversationSearch: vi.fn(async () => []),
  machine: {
    id: 'mine',
    name: 'mine',
    hostname: 'mine',
    online: true,
    inventory: {
      agents: [
        { kind: 'claude-code', installed: true, login: { state: 'in' } },
        { kind: 'cursor', installed: false, login: { state: 'unknown' } },
      ],
    },
  },
}))

vi.mock('@/app/store', () => {
  const state = {
    trpc: {
      conversations: { search: { query: conversationSearch } },
      sessions: { create: { mutate: vi.fn(async () => ({ sessionId: 'new' })) } },
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
    recentFiles: [],
    openFileInWorktree: vi.fn(),
    openArtifact: vi.fn(),
  }
  return {
    useStore: () => state,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(state as never),
  }
})

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
})

function open() {
  return render(
    <NewPanelMenu
      worktree={worktree as never}
      onOpened={vi.fn()}
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
})
