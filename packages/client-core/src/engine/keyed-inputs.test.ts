import { describe, expect, it, vi } from 'vitest'
import { keyedInputsOverStore } from '../../test-support/keyed-inputs'
import { createKeyedInputs, type LocalKey } from './keyed-inputs'
import type { EngineState } from './state'

// The engine publishes no locals of its own (POD-6644); the channel's
// mechanics are exercised over arbitrary keys.
const key = (name: string) => name as unknown as LocalKey
const keys = (...names: string[]) => names.map(key)

function channel(initial: Record<string, unknown>) {
  let state = { ...initial }
  const inputs = createKeyedInputs(() => state as EngineState)
  return {
    inputs,
    write(patch: Record<string, unknown>) {
      state = { ...state, ...patch }
      inputs.emit(new Set(keys(...Object.keys(patch))))
    },
  }
}

describe('keyed inputs (POD-5433)', () => {
  it('wakes a listener only for its own keys, with the changed subset', () => {
    const c = channel({ loading: false, loaded: false, rows: [] })
    const listener = vi.fn()
    c.inputs.onLocals(keys('loading', 'rows'), listener)
    c.write({ loaded: true })
    expect(listener).not.toHaveBeenCalled()
    c.write({ loading: true, loaded: false })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls).toEqual([[new Set(['loading'])]])
    expect(c.inputs.readLocal(key('loading'))).toBe(true)
  })

  it('publishes only at emit: a reader never sees an unannounced local', () => {
    let state: Record<string, unknown> = { loading: false }
    const inputs = createKeyedInputs(() => state as EngineState)
    state = { ...state, loading: true }
    expect(inputs.readLocal(key('loading'))).toBe(false)
    inputs.emit(new Set(keys('loading')))
    expect(inputs.readLocal(key('loading'))).toBe(true)
  })

  it('leaves composer documents to DraftStore', () => {
    expect(channel({}).inputs).not.toHaveProperty('onDraft')
  })

  it('a throwing listener does not stop the others', () => {
    const c = channel({ loaded: false })
    const after = vi.fn()
    c.inputs.onLocals(keys('loaded'), () => {
      throw new Error('boom')
    })
    c.inputs.onLocals(keys('loaded'), after)
    c.write({ loaded: true })
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('over a hand-held store, diffs each publication key by key', () => {
    let state: Record<string, unknown> = { loaded: false, loading: null }
    const listeners = new Set<() => void>()
    const inputs = keyedInputsOverStore({
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    const locals = vi.fn()
    inputs.onLocals(keys('loaded'), locals)
    // Following reads nothing, so a key's first publication counts as moved.
    for (const listener of listeners) listener()
    expect(locals).toHaveBeenCalledTimes(1)
    locals.mockClear()
    state = { ...state, loading: true }
    for (const listener of listeners) listener()
    expect(locals).not.toHaveBeenCalled()
    inputs.dispose()
    expect(listeners.size).toBe(0)
  })
})
