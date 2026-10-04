import { tracked } from '../../../../packages/worklist-proto/harness/src/adapters/mobx-pool'
import { useSyncExternalStore } from 'react'
import { MobxPool } from '@podium/client-graph'
import { createPoolTransactions } from '@podium/client-graph/write/transactions'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
// @vitest-environment happy-dom
import {
  createKeyedInputs,
  type EngineState,
  type KeyedInputsChannel,
} from '@podium/client-core/engine'
import { asMachineId, asSessionId } from '@podium/model/browser'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAgentFleetOptions } from '@/features/issues/use-agent-fleet-options'
import { useFocusedHandoffSessionId } from '@/features/mobile-handoff/mobile-handoff'
import { usePendingSpawnPrompt, useRuntimeDraft, useRuntimeList } from './keyed-runtime'

const f = vi.hoisted(() => ({ owner: undefined as unknown, pool: undefined as unknown }))
vi.mock('@podium/client-core/react', () => ({ useStoreHandle: () => f.owner }))
vi.mock('./store-worklist-pool', () => ({
  useWorklistPoolProjection: (read: (pool: MobxPool) => unknown) => {
    const view = createPoolProjection(f.pool as MobxPool, read)
    return useSyncExternalStore(view.subscribe, view.getSnapshot)
  },
}))
let state: EngineState
let inputs: KeyedInputsChannel
let transactions: ReturnType<typeof createPoolTransactions>
const prompt = (id: string, text: string | null | undefined) => {
  // Test at the transaction's observable map boundary. Production writes use its spawn owner.
  const map = transactions.spawnPrompts as Map<string, string | null>
  tracked(() => { if (text === undefined) map.delete(id); else map.set(id, text) })
}
const sid = asSessionId('first'),
  other = asSessionId('other')

beforeEach(() => {
  state = {
    drafts: { [sid]: 'Saved draft' },
    fileTabs: [],
    repos: [],
    machines: [],
  } as unknown as EngineState
  transactions = createPoolTransactions({
    userId: 'operator', outbox: { pending: () => [], awaiting: () => [], deadLetters: () => [], subscribe: () => () => {} },
    outcomes: () => () => {}, addressed: () => () => {}, enqueue: async () => {},
  })
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
  pool.attachTransactions(transactions)
  prompt(sid, 'First prompt')
  f.pool = pool
  inputs = createKeyedInputs(() => state)
  f.owner = {
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
    return <output data-testid="draft">{useRuntimeDraft(sid)}</output>
  }
  render(<Draft />)
  expect(screen.getByTestId('draft').textContent).toBe('Saved draft')
  const before = renders
  act(() => {
    state.drafts = { ...state.drafts, [other]: 'Unrelated draft' }
    inputs.emit(new Set(['drafts']), new Set([other]))
  })
  expect(renders).toBe(before)
  act(() => {
    state.drafts = { ...state.drafts, [sid]: 'Revised draft' }
    inputs.emit(new Set(['drafts']), new Set([sid]))
  })
  expect(screen.getByTestId('draft').textContent).toBe('Revised draft')
  act(() => {
    state.drafts = { [other]: 'Unrelated draft' }
    inputs.emit(new Set(['drafts']), new Set([sid]))
  })
  expect(screen.getByTestId('draft').textContent).toBe('')
})

it('preserves discovery list order and responds to changed, added and removed ids', () => {
  const a = { id: 'a', name: 'A' },
    b = { id: 'b', name: 'B' }
  state.machines = [a, b] as EngineState['machines']
  inputs.emit(new Set(['machines']), new Set())
  let renders = 0
  function Machines() {
    renders++
    return (
      <output data-testid="machines">
        {useRuntimeList('machines')
          .map((row) => row.name)
          .join('|')}
      </output>
    )
  }
  render(<Machines />)
  expect(screen.getByTestId('machines').textContent).toBe('A|B')
  const before = renders
  act(() => inputs.emit(new Set(['coarseNow']), new Set()))
  expect(renders).toBe(before)
  act(() => {
    state.machines = [
      b,
      { ...a, name: 'Renamed' },
      { id: 'c', name: 'C' },
    ] as EngineState['machines']
    inputs.emit(new Set(['machines']), new Set())
  })
  expect(screen.getByTestId('machines').textContent).toBe('B|Renamed|C')
  act(() => {
    state.machines = [b] as EngineState['machines']
    inputs.emit(new Set(['machines']), new Set())
  })
  expect(screen.getByTestId('machines').textContent).toBe('B')
})

it('preserves harness availability and discovery changes without legacy list reads', () => {
  const machineId = asMachineId('mine')
  state.repos = [{ path: '/repo', kind: 'repository', worktrees: [], machineId }]
  const machine = {
    id: machineId,
    name: 'mine',
    hostname: 'mine',
    online: true,
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'boot', server: false, daemon: true, supervisor: true },
    lastSeenAt: new Date(0).toISOString(),
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: [{ kind: 'cursor' as const, installed: false, login: { state: 'in' as const } }],
      tools: [],
    },
  } satisfies EngineState['machines'][number]
  state.machines = [machine]
  inputs.emit(new Set(['repos', 'machines']), new Set())
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
  act(() => {
    state.machines = [
      {
        ...machine,
        inventory: {
          ...machine.inventory,
          agents: [{ ...machine.inventory.agents[0]!, installed: true }],
        },
      },
    ]
    inputs.emit(new Set(['machines']), new Set())
  })
  expect(screen.getByTestId('fleet').textContent).toBe('available|')
  act(() => {
    state.repos = []
    inputs.emit(new Set(['repos']), new Set())
  })
  expect(screen.getByTestId('fleet').textContent).toBe('available|')
})

it('preserves third-pane focus, hidden-pane fallback and restored scalar handoff', () => {
  state.workspaces = {
    none: {
      key: 'none',
      previewTabId: null,
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
    },
  }
  state.paneA = sid
  state.paneB = other
  state.split = true
  state.focusedPane = 'A'
  inputs.emit(new Set(['workspaces', 'paneA', 'paneB', 'split', 'focusedPane']), new Set())
  f.owner = {
    ...inputs,
    access:
      new Proxy(
        { workspaceKey: () => 'none' },
        {
          get: (target, key) => {
            if (key !== 'workspaceKey') throw new Error(`Handoff read legacy ${String(key)}`)
            return target.workspaceKey
          },
        },
      ),
    subscribe: () => {
      throw new Error('Handoff subscribed to the old store')
    },
  }
  function Focus() {
    return <output data-testid="focus">{useFocusedHandoffSessionId()}</output>
  }
  render(<Focus />)
  expect(screen.getByTestId('focus').textContent).toBe('third')
  act(() => {
    state.workspaces = { none: { ...state.workspaces.none!, root: { kind: 'leaf', paneId: 'A' } } }
    inputs.emit(new Set(['workspaces']), new Set())
  })
  expect(screen.getByTestId('focus').textContent).toBe(sid)
  act(() => {
    state.workspaces = {}
    state.focusedPane = 'B'
    inputs.emit(new Set(['workspaces', 'focusedPane']), new Set())
  })
  expect(screen.getByTestId('focus').textContent).toBe(other)
  act(() => {
    state.split = false
    inputs.emit(new Set(['split']), new Set())
  })
  expect(screen.getByTestId('focus').textContent).toBe(sid)
})
