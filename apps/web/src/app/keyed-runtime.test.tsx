import { fixtureUi } from '@podium/client-core/test-support/ui'
import { reaction } from 'mobx'
// @vitest-environment happy-dom

import { DraftStore } from '@podium/client-core/conversation'
import {
  createKeyedInputs,
  type KeyedInputsChannel,
  type RuntimeState,
} from '@podium/client-core/engine'
import { MobxPool } from '@podium/client-graph'
import { headerEntities } from '@podium/client-graph/header-entities'
import { seedFixtureMachines } from '@podium/client-graph/live-fixture'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { createPoolTransactions } from '@podium/client-graph/write/transactions'
import { asMachineId, asSessionId } from '@podium/model/browser'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgentFleetOptions } from '@/features/issues/use-agent-fleet-options'
import { useFocusedHandoffSessionId } from '@/features/mobile-handoff/mobile-handoff'
import { setFixtureSpawnPrompt } from '../../../../tests/worklist/diagnostics/session-pane-fixture'
import { useDraftValue, usePendingSpawnPrompt } from './keyed-runtime'

const f = vi.hoisted(() => ({ owner: undefined as unknown, pool: undefined as unknown }))
vi.mock('@podium/client-core/react', () => ({
  useStoreHandle: () => f.owner,
  useUiValue: (key: string) => {
    const ui = (f.owner as { ui: object }).ui
    const read = () => Reflect.get(ui, key)
    return useSyncExternalStore((notify) => reaction(read, notify), read)
  },
}))
vi.mock('./store-worklist-pool', () => ({
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown) => {
    const view = createPoolProjection(f.pool as MobxPool, read)
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))
let state: RuntimeState
let drafts: DraftStore
let inputs: KeyedInputsChannel
let transactions: ReturnType<typeof createPoolTransactions>
const prompt = (id: string, text: string | null | undefined) =>
  setFixtureSpawnPrompt(transactions, id, text)
const sid = asSessionId('first'),
  other = asSessionId('other')

beforeEach(() => {
  state = {
    fileTabs: [],
    repos: [],
    machines: [],
  } as unknown as RuntimeState
  transactions = createPoolTransactions({
    userId: 'operator',
    outbox: {
      pending: () => [],
      awaiting: () => [],
      deadLetters: () => [],
      subscribe: () => () => {},
    },
    outcomes: () => () => {},
    addressed: () => () => {},
    enqueue: async () => {},
  })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.attachTransactions(transactions)
  prompt(sid, 'First prompt')
  f.pool = pool
  inputs = createKeyedInputs(() => state)
  drafts = new DraftStore({
    storage: { get: () => null, set: () => {} },
    hub: {
      on: () => () => {},
      sendDraftEdit: () => {},
      connectionHealth: () => ({ status: 'ok' }),
    } as never,
  })
  drafts.values.set(sid, 'Saved draft')
  f.owner = {
    drafts,
    ui: fixtureUi(),
    ...inputs,
    getSnapshot: () => {
      throw new Error('Keyed reader used the old snapshot')
    },
    subscribe: () => {
      throw new Error('Keyed reader subscribed to the old snapshot')
    },
  }
})
afterEach(() => {
  cleanup()
  inputs.dispose()
  drafts.dispose()
  transactions.dispose()
  ;(f.pool as MobxPool).dispose()
})

it('keeps spawn prompts identical through updates, confirmation and an addressed session switch', () => {
  let renders = 0
  function Prompt({ id }: { id: typeof sid }) {
    renders++
    return <output data-testid="prompt">{usePendingSpawnPrompt(id) ?? 'absent'}</output>
  }
  const view = render(<Prompt id={sid} />)
  expect(screen.getByTestId('prompt').textContent).toBe('First prompt')
  const before = renders
  act(() => {
    prompt(other, 'Other prompt')
  })
  expect(renders).toBe(before)
  act(() => {
    prompt(sid, 'Revised prompt')
  })
  expect(screen.getByTestId('prompt').textContent).toBe('Revised prompt')
  act(() => {
    prompt(sid, undefined)
  })
  expect(screen.getByTestId('prompt').textContent).toBe('absent')
  view.rerender(<Prompt id={other} />)
  expect(screen.getByTestId('prompt').textContent).toBe('Other prompt')
})

it('wakes the native draft bridge only for its own document, including clears', () => {
  let renders = 0
  function Draft() {
    renders++
    return <output data-testid="draft">{useDraftValue(sid)}</output>
  }
  render(<Draft />)
  expect(screen.getByTestId('draft').textContent).toBe('Saved draft')
  const before = renders
  act(() => {
    drafts.set(other, 'Unrelated draft')
  })
  expect(renders).toBe(before)
  act(() => {
    drafts.set(sid, 'Revised draft')
  })
  expect(screen.getByTestId('draft').textContent).toBe('Revised draft')
  act(() => {
    drafts.set(sid, '')
  })
  expect(screen.getByTestId('draft').textContent).toBe('')
})

it('preserves harness availability and discovery changes, read from the records', () => {
  // Machines and repositories are records in the pool (POD-6644).
  const machineId = asMachineId('mine')
  const pool = f.pool as MobxPool
  const repo = { path: '/repo', kind: 'repository' as const, worktrees: [], machineId }
  const machine = {
    id: machineId,
    name: 'mine',
    hostname: 'mine',
    online: true,
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'boot', server: false, daemon: true, supervisor: true },
    lastSeenAt: new Date(0).toISOString(),
    inventory: {
      os: 'linux' as const,
      arch: 'x64' as const,
      agents: [{ kind: 'cursor' as const, installed: false, login: { state: 'in' as const } }],
      tools: [],
    },
  }
  const install = (next: typeof machine, repos: (typeof repo)[]) =>
    act(() => {
      headerEntities(pool).apply([
        ...(seedFixtureMachines(pool, [next]) as never[]),
        { kind: 'repository', id: JSON.stringify([machineId, '/repo']), value: repos[0] } as never,
      ])
    })
  install(machine, [repo])
  function Fleet() {
    const status = useAgentFleetOptions({ repoPath: '/repo' }).find(
      (option) => option.value === 'cursor',
    )!.status
    return (
      <output data-testid="fleet">
        {status.reason ?? 'available'}|{status.hint}
      </output>
    )
  }
  render(<Fleet />)
  expect(screen.getByTestId('fleet').textContent).toBe(
    'Cursor is not installed on mine.|not installed',
  )
  install(
    {
      ...machine,
      inventory: {
        ...machine.inventory,
        agents: [{ ...machine.inventory.agents[0]!, installed: true }],
      },
    },
    [repo],
  )
  expect(screen.getByTestId('fleet').textContent).toBe('available|')
})

it('preserves third-pane focus and falls back only within the restored layout', () => {
  const ui = (f.owner as { ui: ReturnType<typeof fixtureUi> }).ui
  ui.patch({
    workspaces: {
      none: {
        key: 'none',
        focusedPaneId: 'C',
        root: {
          kind: 'split',
          axis: 'row',
          sizes: [1, 1, 1],
          children: [
            { kind: 'leaf', paneId: 'A' },
            { kind: 'leaf', paneId: 'B' },
            { kind: 'leaf', paneId: 'C' },
          ],
        },
        panes: {
          A: { id: 'A', tabs: [sid], activeTabId: sid },
          B: { id: 'B', tabs: [other], activeTabId: other },
          C: { id: 'C', tabs: ['third'], activeTabId: 'third' },
        },
      } as never,
    },
  })
  function Focus() {
    return <output data-testid="focus">{useFocusedHandoffSessionId()}</output>
  }
  render(<Focus />)
  expect(screen.getByTestId('focus').textContent).toBe('third')
  act(() =>
    ui.patch({
      workspaces: { none: { ...ui.workspaces.none!, root: { kind: 'leaf', paneId: 'A' } } },
    }),
  )
  expect(screen.getByTestId('focus').textContent).toBe(sid)
  act(() => ui.patch({ workspaces: {} }))
  expect(screen.getByTestId('focus').textContent).toBe('')
})
