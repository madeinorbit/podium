import { describe, expect, it, vi } from 'vitest'
import type { UiState } from './replica/contract'
import {
  createMemoryRouterWindow,
  createRoutedUiState,
  createRouterUiState,
  type ReplicatedUiStatePort,
  UI_STATE_KEYS,
  UI_STATE_ROUTES,
} from './ui-state'

function memoryUi(seed: Record<string, string> = {}): UiState & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed))
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      if (value === null) data.delete(key)
      else data.set(key, value)
    },
    subscribe: () => () => {},
  }
}

function replicatedUi(seed: Record<string, unknown> = {}): ReplicatedUiStatePort & {
  data: Map<string, unknown>
  set: ReturnType<typeof vi.fn>
} {
  const data = new Map(Object.entries(seed))
  const set = vi.fn((key: string, value: unknown) => void data.set(key, value))
  const clear = vi.fn((key: string) => void data.delete(key))
  return { data, get: (key) => data.get(key), set, clear, subscribe: () => () => {} }
}

describe('workspace ui-state routing', () => {
  it('is total over the closed key set and has both homes', () => {
    expect(Object.keys(UI_STATE_ROUTES).sort()).toEqual(Object.values(UI_STATE_KEYS).sort())
    expect(new Set(Object.values(UI_STATE_ROUTES).map((route) => route.home))).toEqual(
      new Set(['device-local', 'per-user-replicated']),
    )
  })

  it('routes local and replicated writes to exactly one home', () => {
    const local = memoryUi()
    const replicated = replicatedUi()
    const ui = createRoutedUiState({ local, replicated })

    ui.set(UI_STATE_KEYS.split, '1')
    ui.set(UI_STATE_KEYS.panelMode, '{"s1":"chat"}')

    expect(local.get(UI_STATE_KEYS.split)).toBe('1')
    expect(replicated.get(UI_STATE_KEYS.split)).toBeUndefined()
    expect(replicated.get('panelMode')).toBe('{"s1":"chat"}')
    expect(local.get(UI_STATE_KEYS.panelMode)).toBeNull()
  })

  it('moves legacy replicated values once, then removes the principal-local copy', () => {
    const local = memoryUi({ [UI_STATE_KEYS.superOpen]: '0' })
    const replicated = replicatedUi()
    const ui = createRoutedUiState({ local, replicated })

    expect(ui.get(UI_STATE_KEYS.superOpen)).toBe('0')
    expect(replicated.set).toHaveBeenCalledOnce()
    expect(replicated.get('superOpen')).toBe('0')
    expect(local.get(UI_STATE_KEYS.superOpen)).toBeNull()

    expect(ui.get(UI_STATE_KEYS.superOpen)).toBe('0')
    expect(replicated.set).toHaveBeenCalledOnce()
  })

  it('cannot let a second principal re-consume the first principal migration', () => {
    const actingPrincipalLocal = memoryUi({ [UI_STATE_KEYS.panelMode]: '{"s1":"chat"}' })
    const alice = replicatedUi()
    const bob = replicatedUi()

    expect(
      createRoutedUiState({ local: actingPrincipalLocal, replicated: alice }).get(
        UI_STATE_KEYS.panelMode,
      ),
    ).toBe('{"s1":"chat"}')
    expect(actingPrincipalLocal.get(UI_STATE_KEYS.panelMode)).toBeNull()
    expect(
      createRoutedUiState({ local: actingPrincipalLocal, replicated: bob }).get(
        UI_STATE_KEYS.panelMode,
      ),
    ).toBeNull()
  })

  it('hydrates and flushes the whole workspace through one path across reload', () => {
    const local = memoryUi()
    const replicated = replicatedUi()
    const first = createRouterUiState({
      local,
      replicated,
      win: createMemoryRouterWindow('/workspace?wt=%2Frepo%2Fwt&pane=s1'),
    })
    const hydrated = first.hydrate()
    first.flush({
      ...hydrated,
      paneB: 's2' as never,
      split: true,
      superOpen: false,
      panelMode: { s1: 'chat' },
      dockShells: { '/repo/wt': 'shell1' as never },
    })

    const second = createRouterUiState({
      local,
      replicated,
      win: createMemoryRouterWindow('/'),
    }).hydrate()
    expect(second).toMatchObject({
      view: 'workspace',
      selectedWorktree: '/repo/wt',
      paneA: 's1',
      paneB: 's2',
      split: true,
      superOpen: false,
      panelMode: { s1: 'chat' },
      dockShells: { '/repo/wt': 'shell1' },
    })
  })
})
