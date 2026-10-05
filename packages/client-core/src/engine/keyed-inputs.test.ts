import { keyedInputsOverStore } from '../../test-support/keyed-inputs'
import { describe, expect, it, vi } from 'vitest'
import { createKeyedInputs, discoveryRepoId } from './keyed-inputs'
import type { EngineState } from './state'

function channel(initial: Partial<EngineState>) {
  let state = { ...initial } as EngineState
  const inputs = createKeyedInputs(() => state)
  return {
    inputs,
    write(patch: Partial<EngineState>) {
      state = { ...state, ...patch }
      inputs.emit(new Set(Object.keys(patch) as (keyof EngineState)[]))
    },
  }
}

const repo = (path: string, branch = 'main') =>
  ({ path, branch, machineId: 'm1', worktrees: [] }) as unknown as EngineState['repos'][number]

describe('keyed inputs (POD-5433)', () => {
  it('wakes a listener only for its own keys, with the changed subset', () => {
    const c = channel({ paletteOpen: false, dockTab: 'files', paneA: null })
    const listener = vi.fn()
    c.inputs.onLocals(['paletteOpen', 'paneA'], listener)
    c.write({ dockTab: 'git' })
    expect(listener).not.toHaveBeenCalled()
    c.write({ paletteOpen: true, dockTab: 'files' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls).toEqual([[new Set(['paletteOpen'])]])
    expect(c.inputs.readLocal('paletteOpen')).toBe(true)
  })

  it('publishes only at emit: a reader never sees an unannounced local', () => {
    let state = { paletteOpen: false } as EngineState
    const inputs = createKeyedInputs(() => state)
    state = { ...state, paletteOpen: true }
    expect(inputs.readLocal('paletteOpen')).toBe(false)
    inputs.emit(new Set(['paletteOpen']))
    expect(inputs.readLocal('paletteOpen')).toBe(true)
  })

  it('diffs a list by id: unchanged rows keep identity, changed ids and order are named', () => {
    const a = repo('/a'), b = repo('/b')
    const c = channel({ repos: [a, b] })
    const changes: { ids: string[]; order: boolean }[] = []
    c.inputs.onList('repos', (change) => changes.push({ ids: [...change.ids], order: change.order }))
    const before = c.inputs.listRow('repos', discoveryRepoId(a))
    // A fresh RPC array with equal rows: no change, identity kept.
    c.write({ repos: [repo('/a'), repo('/b')] })
    expect(changes).toEqual([])
    expect(c.inputs.listRow('repos', discoveryRepoId(a))).toBe(before)
    // One row moves: only its id.
    c.write({ repos: [repo('/a'), repo('/b', 'next')] })
    expect(changes).toEqual([{ ids: [discoveryRepoId(b)], order: false }])
    // Reorder and removal.
    c.write({ repos: [repo('/b', 'next')] })
    expect(changes.at(-1)).toEqual({ ids: [discoveryRepoId(a)], order: true })
    expect(c.inputs.listIds('repos')).toEqual([discoveryRepoId(b)])
    expect(c.inputs.listRow('repos', discoveryRepoId(a))).toBeUndefined()
  })

  it('reads a record list by key and catches up a list nobody follows', () => {
    const c = channel({ workspaces: { w1: { panes: 1 } } as never })
    expect(c.inputs.listIds('workspaces')).toEqual(['w1'])
    c.write({ workspaces: { w1: { panes: 1 }, w2: { panes: 2 } } as never })
    expect(c.inputs.listIds('workspaces')).toEqual(['w1', 'w2'])
    expect(c.inputs.listRow('workspaces', 'w2')).toEqual({ panes: 2 })
  })

  it('leaves composer documents to DraftStore', () => {
    expect(channel({}).inputs).not.toHaveProperty('onDraft')
  })

  it('a throwing listener does not stop the others', () => {
    const c = channel({ paneA: null })
    const after = vi.fn()
    c.inputs.onLocals(['paneA'], () => {
      throw new Error('boom')
    })
    c.inputs.onLocals(['paneA'], after)
    c.write({ paneA: 'p' as never })
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('over a hand-held store, diffs each publication key by key', () => {
    let state: Record<string, unknown> = { paneA: null, paneB: null }
    const listeners = new Set<() => void>()
    const inputs = keyedInputsOverStore({
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    const locals = vi.fn()
    inputs.onLocals(['paneA'], locals)
    // Following reads nothing, so a key's first publication counts as moved.
    for (const listener of listeners) listener()
    expect(locals).toHaveBeenCalledTimes(1)
    locals.mockClear()
    state = { ...state, paneB: 'other' }
    for (const listener of listeners) listener()
    expect(locals).not.toHaveBeenCalled()
    inputs.dispose()
    expect(listeners.size).toBe(0)
  })
})
