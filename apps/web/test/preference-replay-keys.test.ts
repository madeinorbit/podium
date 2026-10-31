import { createRoutedUiState, UI_STATE_KEYS } from '@podium/client-core/ui-state'
import { describe, expect, it, vi } from 'vitest'
import { preferenceReplayKeys } from './preference-replay-keys'

describe('operator preference replay keys', () => {
  it('skips a retired sidebar key and reads the supported preference beside it', () => {
    const values: Record<string, unknown> = { 'sidebar.collapsed': true, superOpen: false }
    const write = vi.fn(() => {
      throw new Error('Replay cannot write preferences')
    })
    const subscribe = () => () => {}
    const ui = createRoutedUiState({
      local: { get: () => null, set: write, subscribe },
      replicated: {
        hydrate: async () => {},
        get: (key) => values[key],
        set: write,
        clear: write,
        subscribe,
      },
    })

    const keys = preferenceReplayKeys(values)
    expect(keys).toEqual([UI_STATE_KEYS.superOpen])
    expect(keys.map((key) => ui.get(key))).toEqual(['false'])
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps named sidebar section preferences in the replay', () => {
    expect(preferenceReplayKeys({ 'sidebar.section.closed': true })).toEqual([
      'podium:sidebar:closed',
    ])
  })
})
