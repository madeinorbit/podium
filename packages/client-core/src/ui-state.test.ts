import { DEVICE_LOCAL_UI_KEYS, LAYOUT_KEY_FROM_LEGACY, THEME_UI_KEYS } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { UiState } from './replica/contract'
import {
  createRoutedUiState,
  FILE_SCROLL_MAP_CAP,
  FLIGHT_DECK_BRIEF_CUTOFF_KEY,
  FLIGHT_DECK_DISPLAY_KEY,
  FLIGHT_DECK_EXPANDED_WIDTH_KEY,
  FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY,
  FLIGHT_DECK_FULL_DISPLAY_KEY,
  FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY,
  FLIGHT_DECK_FULL_WIDTH_KEY,
  type LayoutKeyPort,
  readFileScrollPosition,
  readStoredDensity,
  requireReplicatedLayoutKey,
  SHELL_DENSITY_KEY,
  UI_STATE_KEYS,
  uiStateRoute,
  writeFileScrollPosition,
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

function replicatedUi(seed: Record<string, unknown> = {}): LayoutKeyPort & {
  data: Map<string, unknown>
  set: ReturnType<typeof vi.fn>
} {
  const data = new Map(Object.entries(seed))
  const set = vi.fn((key: string, value: unknown) => void data.set(key, value))
  const clear = vi.fn((key: string) => void data.delete(key))
  return {
    data,
    get: (key) => data.get(key),
    set,
    clear,
    subscribe: () => () => {},
  }
}

describe('file reading positions', () => {
  it('routes offsets to this device and keeps preview and source separate', () => {
    const local = memoryUi()
    const replicated = replicatedUi()
    const ui = createRoutedUiState({ local, replicated })
    writeFileScrollPosition(ui, 'file:report', 'preview', { top: 640, left: 0 })
    writeFileScrollPosition(ui, 'file:report', 'source', { top: 320, left: 24 })
    expect(readFileScrollPosition(ui, 'file:report', 'preview')).toEqual({ top: 640, left: 0 })
    expect(readFileScrollPosition(ui, 'file:report', 'source')).toEqual({ top: 320, left: 24 })
    expect(local.data.has(UI_STATE_KEYS.fileScroll)).toBe(true)
    expect(replicated.data.size).toBe(0)
  })

  it('discards corrupt offsets and bounds the saved history', () => {
    const ui = memoryUi({
      [UI_STATE_KEYS.fileScroll]: JSON.stringify({
        'preview:negative': { top: -5, left: 0 },
        'source:invalid': { top: '640', left: 0 },
        'preview:missing': { top: 640 },
      }),
    })
    expect(readFileScrollPosition(ui, 'negative', 'preview')).toBeUndefined()
    expect(readFileScrollPosition(ui, 'invalid', 'source')).toBeUndefined()
    expect(readFileScrollPosition(ui, 'missing', 'preview')).toBeUndefined()
    for (let i = 0; i <= FILE_SCROLL_MAP_CAP; i++)
      writeFileScrollPosition(ui, `file:${i}`, 'preview', { top: i * 10, left: 0 })
    expect(readFileScrollPosition(ui, 'file:0', 'preview')).toBeUndefined()
    expect(readFileScrollPosition(ui, `file:${FILE_SCROLL_MAP_CAP}`, 'preview')?.top).toBe(
      FILE_SCROLL_MAP_CAP * 10,
    )
    expect(Object.keys(JSON.parse(ui.get(UI_STATE_KEYS.fileScroll)!))).toHaveLength(
      FILE_SCROLL_MAP_CAP,
    )
  })
})

describe('workspace ui-state routing', () => {
  it('routes independent tip moments and the switch to account state only', () => {
    const local = memoryUi()
    const replicated = replicatedUi()
    const ui = createRoutedUiState({ local, replicated })
    for (const [key, value] of Object.entries({
      'tips.seen.first-prompt': '2026-10-27T17:00:00.000Z',
      'tips.seen.first-send': '2026-10-27T17:01:00.000Z',
      [UI_STATE_KEYS.tipsEnabled]: 'false',
      [UI_STATE_KEYS.tipsFirstSend]: 'iss_first',
    })) {
      expect(uiStateRoute(key).home).toBe('per-user-replicated')
      ui.set(key, value)
      expect(ui.get(key)).toBe(value)
      expect(replicated.data.get(key)).toBe(value)
    }
    expect(local.data.size).toBe(0)
    expect(() => ui.get('tips.seen.')).toThrow(/Unclassified/)
    expect(() => ui.get('tips.seen')).toThrow(/Unclassified/)
  })

  it('is total over the closed key set and has both homes', () => {
    expect(
      Object.values(UI_STATE_KEYS)
        .map((key) => {
          uiStateRoute(key)
          return key
        })
        .sort(),
    ).toEqual(Object.values(UI_STATE_KEYS).sort())
    expect(new Set(Object.values(UI_STATE_KEYS).map((key) => uiStateRoute(key).home))).toEqual(
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
    // POD-1380 gave the last unrouted key a home, and it is not this module's:
    // per-user state, its own synced record (`userReadPosition`).
    expect(uiStateRoute('podium:superfeed:cursor').home).toBe('per-user-command')
  })

  it('panelMode is one modeled map plus one tested derivation', async () => {
    const { effectivePanelMode } = await import('./ui-state')
    // Saved map entry wins; missing entry falls through the shared derivation.
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: true,
        isMobile: true,
        terminalCapable: true,
        saved: 'native',
      }),
    ).toBe('native')
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: true,
        isMobile: true,
        terminalCapable: true,
      }),
    ).toBe('chat')
    expect(
      effectivePanelMode({
        startScreen: 'native',
        chatCapable: true,
        isMobile: false,
        terminalCapable: true,
        serverFamily: true,
      }),
    ).toBe('chat')
    // …and a session with no PTY behind the native view takes neither branch:
    // there is no second view for the saved entry to be a preference between
    // (POD-2290).
    expect(
      effectivePanelMode({
        startScreen: 'auto',
        chatCapable: true,
        isMobile: false,
        terminalCapable: false,
        saved: 'native',
      }),
    ).toBe('chat')
  })

  it('follows startScreen until an explicit session choice overrides it', async () => {
    const { effectivePanelMode } = await import('./ui-state')
    const base = { chatCapable: true, terminalCapable: true, isMobile: false }
    expect(effectivePanelMode({ ...base, startScreen: 'native' })).toBe('native')
    expect(effectivePanelMode({ ...base, startScreen: 'chat' })).toBe('chat')
    expect(effectivePanelMode({ ...base, startScreen: 'chat', saved: 'native' })).toBe('native')
    expect(effectivePanelMode({ ...base, startScreen: 'auto', isMobile: true })).toBe('chat')
    expect(effectivePanelMode({ ...base, startScreen: 'auto' })).toBe('native')
    // Old persisted device defaults no longer participate in the derivation.
    const legacy = { ...base, startScreen: 'native' as const, deviceDefault: 'chat' }
    expect(effectivePanelMode(legacy)).toBe('native')
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

  it('routes shell density through the device-local replica adapter', () => {
    const local = memoryUi()
    const replicated = replicatedUi()
    const ui = createRoutedUiState({ local, replicated })

    expect(readStoredDensity(ui)).toBe('balanced')
    ui.set(SHELL_DENSITY_KEY, 'compact')

    expect(readStoredDensity(ui)).toBe('compact')
    expect(local.get(SHELL_DENSITY_KEY)).toBe('compact')
    expect(replicated.get(SHELL_DENSITY_KEY)).toBeUndefined()
  })

  it('keeps the Flight Deck brief cutoff on this device', () => {
    expect(uiStateRoute(FLIGHT_DECK_BRIEF_CUTOFF_KEY).home).toBe('device-local')
    expect(uiStateRoute(FLIGHT_DECK_DISPLAY_KEY).home).toBe('device-local')
    expect(uiStateRoute(FLIGHT_DECK_EXPANDED_WIDTH_KEY).home).toBe('device-local')
    for (const key of [
      FLIGHT_DECK_FULL_DISPLAY_KEY,
      FLIGHT_DECK_FULL_COMPACT_WIDTH_KEY,
      FLIGHT_DECK_FULL_EXPANDED_WIDTH_KEY,
      FLIGHT_DECK_FULL_WIDTH_KEY,
    ]) {
      expect(uiStateRoute(key).home).toBe('device-local')
    }
  })

  it('never imports a saved device value into synced layout', () => {
    const local = memoryUi({ [UI_STATE_KEYS.superOpen]: '0' })
    const replicated = replicatedUi({ superOpen: '1' })
    const ui = createRoutedUiState({ local, replicated })
    expect(ui.get(UI_STATE_KEYS.superOpen)).toBe('1')
    expect(replicated.set).not.toHaveBeenCalled()
    expect(local.get(UI_STATE_KEYS.superOpen)).toBe('0')
  })
  it('reads only the acting user’s synced record, never another device’s old key', () => {
    const old = memoryUi({ [UI_STATE_KEYS.panelMode]: '{"s1":"chat"}' })
    const alice = replicatedUi({ panelMode: '{"s2":"native"}' }),
      bob = replicatedUi()
    expect(
      createRoutedUiState({ local: old, replicated: alice }).get(UI_STATE_KEYS.panelMode),
    ).toBe('{"s2":"native"}')
    expect(
      createRoutedUiState({ local: old, replicated: bob }).get(UI_STATE_KEYS.panelMode),
    ).toBeNull()
    expect(alice.set).not.toHaveBeenCalled()
    expect(bob.set).not.toHaveBeenCalled()
  })
})
