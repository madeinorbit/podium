import { headerEntities } from '@podium/client-graph/header-entities'
import { seedInstancePreferences } from '@podium/client-graph/instance-preferences-fixture'
import { MobxPool } from '@podium/client-graph/pool'
import { asMachineId, asRepoId } from '@podium/model/browser'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  BaseBranchMenuContent,
  type BaseBranchMenuProps,
  RepoBaseBranchMenu,
} from './BaseBranchMenu'

const f = vi.hoisted(() => ({
  pool: null as unknown,
  setBase: vi.fn(async (_input: Record<string, unknown>) => []),
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPool: () => f.pool,
  useWorklistPoolProjection: (read: (pool: never) => unknown, empty: unknown) =>
    f.pool ? read(f.pool as never) : empty,
}))
vi.mock('@podium/client-core/react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useClientRuntime: () => ({
    access: {
      trpc: {
        repos: { setDefaultParentBranch: { mutate: f.setBase } },
      },
    },
  }),
}))

afterEach(cleanup)

function Harness(props: Omit<BaseBranchMenuProps, 'onDone'>) {
  const [open, setOpen] = useState(false)
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={<button type="button">Branch</button>} />
      {open && <BaseBranchMenuContent {...props} onDone={() => setOpen(false)} />}
    </DropdownMenu>
  )
}

it('saves a listed branch, a typed one, or the default, and closes on success', async () => {
  const save = vi.fn(async (_branch: string | null) => {})
  render(
    <Harness
      heading="Base branch"
      current="tf.dev"
      choices={['main', 'tf.dev']}
      fallback={{ label: 'Use Podium default (main)' }}
      onSave={save}
    />,
  )
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    return screen.findByRole('menuitem', { name: 'main' })
  }
  fireEvent.click(await open())
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(save).toHaveBeenLastCalledWith('main')

  await open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Use Podium default (main)' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(save).toHaveBeenLastCalledWith(null)

  await open()
  fireEvent.change(screen.getByLabelText('Branch name'), { target: { value: ' release ' } })
  expect(screen.queryByRole('menuitem', { name: 'main' })).toBeNull()
  fireEvent.keyDown(screen.getByLabelText('Branch name'), { key: 'Enter' })
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(save).toHaveBeenLastCalledWith('release')

  // Picking the current value is a no-op close.
  save.mockClear()
  fireEvent.click(await open().then(() => screen.getByRole('menuitem', { name: /tf\.dev/ })))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(save).not.toHaveBeenCalled()
})

it("keeps the menu open and shows the setter's refusal under the field", async () => {
  const save = vi.fn(async () => {
    throw new Error("Branch 'nope' does not exist in /repo.")
  })
  render(<Harness heading="Base branch" current={null} choices={[]} onSave={save} />)
  fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
  const field = await screen.findByLabelText('Branch name')
  fireEvent.change(field, { target: { value: 'nope' } })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Use nope' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    "Branch 'nope' does not exist in /repo.",
  )
  expect(screen.getByRole('menu')).toBeTruthy()
})

it("reads and writes the band's own repository when unrelated repos share a path on two machines", async () => {
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  // The Podium-wide default branch is the synced instance settings (POD-6677).
  seedInstancePreferences(pool, { gitWorkflow: { defaultParentBranch: 'main' } })
  f.pool = pool
  const one = asMachineId('one'),
    two = asMachineId('two')
  const a = asRepoId('repo-a'),
    b = asRepoId('repo-b')
  try {
    pool.apply({
      type: 'update',
      rows: [
        {
          kind: 'repo',
          id: a,
          value: {
            id: a,
            prefix: 'AAA',
            defaultParentBranch: 'alpha',
            repoPath: '/src/app',
          } as never,
        },
        {
          kind: 'repo',
          id: b,
          value: {
            id: b,
            prefix: 'BBB',
            defaultParentBranch: 'beta',
            repoPath: '/src/app',
          } as never,
        },
      ],
    })
    headerEntities(pool).apply([
      {
        kind: 'repository',
        id: 'a',
        value: {
          kind: 'repository',
          machineId: one,
          path: '/src/app',
          repoId: a,
          branch: 'alpha',
          worktrees: [],
        },
      },
      {
        kind: 'repository',
        id: 'b',
        value: {
          kind: 'repository',
          machineId: two,
          path: '/src/app',
          repoId: b,
          branch: 'beta',
          worktrees: [],
        },
      },
    ])
    function Menu() {
      const [open, setOpen] = useState(false)
      return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger render={<button type="button">Branch</button>} />
          {open && <RepoBaseBranchMenu repoId={b} path="/src/app" onDone={() => setOpen(false)} />}
        </DropdownMenu>
      )
    }
    render(<Menu />)
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    const current = await screen.findByRole('menuitem', { name: /beta/ })
    expect(current.querySelector('[aria-label="Current"]')).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: /alpha/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use Podium default (main)' }))
    await waitFor(() => expect(f.setBase).toHaveBeenCalled())
    expect(f.setBase).toHaveBeenLastCalledWith({ path: '/src/app', machineId: two, branch: null })
  } finally {
    pool.dispose()
  }
})

it('reaches the list from the field with the arrow keys, before and after typing', async () => {
  const save = vi.fn(async (_branch: string | null) => {})
  render(
    <Harness
      heading="Base branch"
      current="tf.dev"
      choices={['main', 'tf.dev']}
      fallback={{ label: 'Use Podium default (main)' }}
      onSave={save}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
  const field = await screen.findByLabelText('Branch name')
  field.focus()
  const clear = screen.getByRole('menuitem', { name: 'Use Podium default (main)' })
  // ArrowDown from the field enters the list; keep going until the clear row.
  for (let step = 0; step < 4 && document.activeElement !== clear; step++) {
    fireEvent.keyDown(document.activeElement ?? field, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).not.toBe(field))
  }
  expect(document.activeElement).toBe(clear)
  fireEvent.keyDown(clear, { key: 'Enter' })
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(null))

  fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
  const again = await screen.findByLabelText('Branch name')
  again.focus()
  fireEvent.change(again, { target: { value: 'rel' } })
  fireEvent.keyDown(again, { key: 'ArrowDown' })
  await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitem'))
  // Typing still reaches the field rather than the items' typeahead.
  expect((again as HTMLInputElement).value).toBe('rel')
})
