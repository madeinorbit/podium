// @vitest-environment happy-dom
/**
 * THE HARNESS AXIS IN THE SIDEBAR'S SPAWN MENU (POD-1201).
 *
 * `SidebarUnified.machine-use.test.tsx` covers the `use` axis and
 * `SidebarUnified.machine-start.test.tsx` the unscoped parity case. This is the
 * third axis: a machine that is yours, online, and simply has no such CLI
 * installed. Before POD-1201 that row looked exactly like a startable one and
 * spawned a session that died on a missing binary.
 *
 * The fixture's ONE machine runs claude-code and not cursor, so every assertion
 * carries its own counterfactual inside the same menu: if the gate were removed
 * the Cursor assertions fail, and if it were applied indiscriminately the Claude
 * ones do.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenu } from '@/components/ui/dropdown-menu'
import { NewAgentMenu } from './NewAgentMenu'

const onSpawn = vi.fn()

const machine = (agents: { kind: string; installed: boolean; login?: 'in' | 'out' }[]) => ({
  machine: {
    id: 'mine',
    name: 'mine',
    hostname: 'mine',
    online: true,
    inventory: {
      agents: agents.map(({ login, ...a }) => ({ ...a, login: { state: login ?? 'in' } })),
    },
  },
  grants: { see: true, use: true, manage: true },
  availability: 'available' as const,
})

const repo = { path: '/home/mine/podium', name: 'podium', machines: [{ machineId: 'mine' }] }

function open(views: ReturnType<typeof machine>[]): JSX.Element {
  return (
    <DropdownMenu open>
      <NewAgentMenu
        menuRepos={[repo as never]}
        machineViews={views as never}
        defaultRepo={repo as never}
        onSpawn={onSpawn}
        onPersistDefaultAgent={vi.fn()}
        onNewIssue={vi.fn()}
      />
    </DropdownMenu>
  )
}

afterEach(() => {
  cleanup()
  onSpawn.mockClear()
})

describe('sidebar new-agent menu — an uninstalled harness', () => {
  it('greys the row, names the reason on it, and refuses the click', async () => {
    render(open([machine([{ kind: 'claude-code', installed: true }])]))

    const cursor = await screen.findByRole('menuitem', { name: /New Cursor/ })
    expect(cursor.textContent).toContain('not installed')
    expect(cursor.getAttribute('data-refused')).toBe('true')
    // The sentence is reachable by pointer as well as stated on the row.
    expect(cursor.getAttribute('title')).toBe('Cursor is not installed on mine.')

    fireEvent.click(cursor)
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('leaves an installed harness offered — the same menu, same machine', async () => {
    render(open([machine([{ kind: 'claude-code', installed: true }])]))

    const claude = await screen.findByRole('menuitem', { name: /New Claude/ })
    expect(claude.textContent).not.toContain('not installed')
    expect(claude.getAttribute('data-refused')).toBeNull()

    fireEvent.click(claude)
    expect(onSpawn).toHaveBeenCalled()
  })

  /** A shell needs no harness at all — only an online daemon — so it must never
   *  pick up the refusal its neighbours get (`harnessRejection` returns undefined
   *  for it, and this is the row that proves the exemption survived the port). */
  it('never refuses New Shell over a missing harness', async () => {
    render(open([machine([])]))

    const shell = await screen.findByRole('menuitem', { name: /New Shell/ })
    expect(shell.getAttribute('data-refused')).toBeNull()
  })

  it('states the refusal once at the agent level rather than opening onto dead repos', async () => {
    render(open([machine([{ kind: 'claude-code', installed: true }])]))

    // A refused agent is a plain item, not a submenu trigger: there is nothing
    // under it but refusals, and a live-looking chevron would invite the trip.
    // The offered row beside it IS a trigger, which is what makes the absence
    // above a fact about this row rather than about the markup.
    const claude = await screen.findByRole('menuitem', { name: /New Claude/ })
    expect(claude.getAttribute('aria-haspopup')).toBe('menu')
    const cursor = await screen.findByRole('menuitem', { name: /New Cursor/ })
    expect(cursor.getAttribute('aria-haspopup')).toBeNull()
  })
})

/**
 * THE SIGNED-OUT ROW (POD-1322).
 *
 * Installed but logged out is a CONDITION, not a refusal: the pane the row opens
 * is where you sign in, so the click has to survive. It used to survive wearing
 * amber ink across the whole label, which made the row that works louder than
 * the `not installed` row above, which does not — hence the counterfactual these
 * tests keep against the Cursor ones in the same fixture.
 */
describe('sidebar new-agent menu — a signed-out harness', () => {
  const signedOut = () =>
    machine([
      { kind: 'claude-code', installed: true },
      { kind: 'cursor', installed: true, login: 'out' },
    ])

  it('keeps the row live and spawns on click', async () => {
    render(open([signedOut()]))

    const cursor = await screen.findByRole('menuitem', { name: /New Cursor/ })
    expect(cursor.getAttribute('data-refused')).toBeNull()
    expect(cursor.getAttribute('aria-disabled')).not.toBe('true')

    fireEvent.click(cursor)
    expect(onSpawn).toHaveBeenCalled()
  })

  it('states the condition in the hint column instead of colouring the row', async () => {
    render(open([signedOut()]))

    const cursor = await screen.findByRole('menuitem', { name: /New Cursor/ })
    expect(cursor.textContent).toContain('signed out')
    expect(cursor.textContent).not.toContain('not installed')
    // The ink is the regression: amber here outshouted the refusal beside it.
    expect(cursor.className).not.toContain('text-warning')
    // The sentence still reaches a pointer, and it says what the click will do.
    expect(cursor.getAttribute('title')).toContain('isn\u2019t logged in on mine')
  })

  it('leaves a signed-in harness in the same menu unmarked', async () => {
    render(open([signedOut()]))

    const claude = await screen.findByRole('menuitem', { name: /New Claude/ })
    expect(claude.textContent).not.toContain('signed out')
    expect(claude.getAttribute('title')).toBeNull()
  })
})
