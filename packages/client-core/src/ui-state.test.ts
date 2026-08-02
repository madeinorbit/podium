import { DEVICE_LOCAL_UI_KEYS, LAYOUT_KEY_FROM_LEGACY, THEME_UI_KEYS } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { UiState } from './replica/contract'
import {
  createMemoryRouterWindow,
  createRoutedUiState,
  createRouterUiState,
  requireReplicatedLayoutKey,
  type ReplicatedUiStatePort,
  UI_STATE_KEYS,
  UI_STATE_ROUTES,
  uiStateRoute,
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
  return {
    data,
    hydrate: async () => {},
    get: (key) => data.get(key),
    set,
    clear,
    subscribe: () => () => {},
  }
}

describe('workspace ui-state routing', () => {
  it('is total over the closed key set and has both homes', () => {
    expect(Object.keys(UI_STATE_ROUTES).sort()).toEqual(Object.values(UI_STATE_KEYS).sort())
    expect(new Set(Object.values(UI_STATE_ROUTES).map((route) => route.home))).toEqual(
      new Set(['device-local', 'per-user-replicated']),
    )
  })

  it('fails closed outside the shared total vocabulary', () => {
    for (const key of DEVICE_LOCAL_UI_KEYS) {
      expect(uiStateRoute(key).home, key).toBe('device-local')
    }
    for (const key of Object.keys(LAYOUT_KEY_FROM_LEGACY)) {
      expect(uiStateRoute(key).home, key).toBe('per-user-replicated')
    }
    for (const key of THEME_UI_KEYS) {
      expect(uiStateRoute(key).home, key).toBe('pre-auth-theme')
    }
    expect(() => uiStateRoute('podium.unclassified')).toThrow(/Unclassified UI-state key/)
    expect(uiStateRoute('podium:superfeed:cursor').home).toBe('known-unrouted')
  })

  it('panelMode is one modeled map plus one tested derivation', async () => {
    const { effectivePanelMode } = await import('./ui-state')
    // Saved map entry wins; missing entry falls through the shared derivation.
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: true,
        isMobile: true,
        saved: 'native',
      }),
    ).toBe('native')
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: true,
        isMobile: true,
      }),
    ).toBe('chat')
  })

  it('throws when a replicated route has no canonical family key', () => {
    expect(() => requireReplicatedLayoutKey(UI_STATE_KEYS.split)).toThrow(
      'Replicated UI-state key has no layout key: podium.split',
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
