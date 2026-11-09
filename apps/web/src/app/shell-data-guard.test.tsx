import { withKeyedInputs } from '@podium/client-core/test-support/keyed-inputs'
import { disposeFixtureUi } from '@podium/client-core/test-support/ui'
import type { MobxPool } from '@podium/client-graph/pool'
import { observer } from '@podium/client-graph/react'
import { shellViews } from '@podium/client-graph/shell-views'
import { act, cleanup, render, screen } from '@testing-library/react'
import { autorun, computed, configure, observable, reaction, runInAction } from 'mobx'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as reads from './shell-data'

const source = vi.hoisted(() => ({
  pool: null as MobxPool | null,
  read: () => undefined as unknown,
}))
let uiOwner: ReturnType<typeof withKeyedInputs>
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useStoreHandle: () => uiOwner,
}))
vi.mock('./store-worklist-pool', () => ({ useWorklistPool: () => source.pool }))
vi.mock('@podium/client-graph/shell-views', () => ({
  shellViews: () => {
    const read = () => source.read()
    const dock = {
      get active() {
        return read()
      },
      get shipping() {
        return read()
      },
    }
    return {
      dock,
      sessions: read,
      close: read,
      machines: read,
      chrome: read,
      linkedSession: read,
      linkedIssue: read,
      issue: read,
      session: read,
    }
  },
}))

beforeEach(() => {
  vi.stubEnv('DEV', true)
  source.pool = null
  source.read = () => undefined
  uiOwner = withKeyedInputs({
    getSnapshot: () => ({
      selectedIssueId:
        String((source.read() as { version?: number } | undefined)?.version ?? '') || null,
    }),
    subscribe: (notify) => reaction(() => source.read(), notify),
  })
})
afterEach(() => {
  cleanup()
  disposeFixtureUi(uiOwner)
  configure({
    enforceActions: 'never',
    computedRequiresReaction: false,
    reactionRequiresObservable: false,
    observableRequiresReaction: false,
  })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const live = [
  ['useShellDock', reads.useShellDock],
  ['useShellShipping', reads.useShellShipping],
  ['useShellWindow', reads.useShellWindow],
  ['useShellApprovals', reads.useShellApprovals],
  ['useShellSessions', reads.useShellSessions],
  ['useShellClose', reads.useShellClose],
  ['useShellMachines', reads.useShellMachines],
  ['useShellChrome', reads.useShellChrome],
] as const

it.each(live)('rejects %s outside an observer even while the pool is loading', (name, useRead) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  function Bare() {
    useRead()
    return null
  }
  expect(() => render(<Bare />)).toThrow(`${name} must run inside an observer`)
})

// The approvals list reads the pool's effect models (POD-6674), not a shell
// view; `approval-effects` is tested in client-graph.
const viewReads = live.filter(([name]) => name !== 'useShellApprovals')

it.each(viewReads)('keeps %s reactive inside an observer', (_name, useRead) => {
  const value = observable.box(1),
    derived = computed(() => ({ version: value.get() }))
  source.read = () => derived.get()
  source.pool = {
    row: () => source.read(),
    sources: { peekView: () => shellViews(source.pool!) },
  } as unknown as MobxPool
  const Surface = observer(() => <output>{JSON.stringify(useRead())}</output>)
  render(<Surface />)
  expect(screen.getByRole('status').textContent).toContain('1')
  act(() => runInAction(() => value.set(2)))
  expect(screen.getByRole('status').textContent).toContain('2')
})

it('leaves production hook reads unchanged', () => {
  vi.stubEnv('DEV', false)
  function Bare() {
    reads.useShellWindow()
    return null
  }
  expect(() => render(<Bare />)).not.toThrow()
})

it('permits imperative link/resolver reads without losing their reactive dependencies', () => {
  configure({
    enforceActions: 'always',
    computedRequiresReaction: true,
    observableRequiresReaction: true,
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const value = observable.box(1),
    derived = computed(() => ({ version: value.get() }))
  source.read = () => derived.get()
  source.pool = { sources: { peekView: () => shellViews(source.pool!) } } as unknown as MobxPool
  let links: ReturnType<typeof reads.useShellLinks> | undefined
  let resolve: ReturnType<typeof reads.useShellSessionResolver> | undefined
  function Callbacks() {
    links = reads.useShellLinks()
    resolve = reads.useShellSessionResolver()
    return null
  }
  render(<Callbacks />)
  const callbacks = [
    () => links!.readSession('id'),
    () => links!.readIssue('id'),
    () => links!.artifactIssue('id'),
    () => resolve!('id'),
  ]
  for (const read of callbacks) {
    expect(read()).toEqual({ version: 1 })
    const seen: unknown[] = [],
      stop = autorun(() => seen.push(read()))
    runInAction(() => value.set(2))
    expect(seen).toEqual([{ version: 1 }, { version: 2 }])
    stop()
    runInAction(() => value.set(1))
  }
  expect(warn).not.toHaveBeenCalled()
})
