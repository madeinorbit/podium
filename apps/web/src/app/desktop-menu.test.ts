import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installDesktopMenuHooks,
  openAboutPodium,
  openAddProject,
  sidebarToggleFromEvent,
} from './desktop-menu'

type Globals = {
  __PODIUM_ABOUT__?: () => void
  __PODIUM_SETTINGS__?: () => void
  __PODIUM_ADD_PROJECT__?: () => void
  __PODIUM_CLOSE_TAB__?: () => boolean
  __PODIUM_UNDO__?: () => void
  __PODIUM_REDO__?: () => void
}

const g = globalThis as Globals

afterEach(() => {
  delete g.__PODIUM_ABOUT__
  delete g.__PODIUM_SETTINGS__
  delete g.__PODIUM_ADD_PROJECT__
  delete g.__PODIUM_CLOSE_TAB__
  delete g.__PODIUM_UNDO__
  delete g.__PODIUM_REDO__
})

describe('desktop menu hooks', () => {
  it('installs only the hooks that were provided and uninstalls them', () => {
    const about = vi.fn()
    const settings = vi.fn()
    const closeTab = vi.fn(() => true)
    const undo = vi.fn()
    const redo = vi.fn()
    const uninstall = installDesktopMenuHooks({ about, settings, closeTab, undo, redo })

    expect(g.__PODIUM_ABOUT__).toBe(about)
    // ⌘, in the Podium ADE menu (apps/desktop/src-tauri/src/main.rs).
    expect(g.__PODIUM_SETTINGS__).toBe(settings)
    expect(g.__PODIUM_CLOSE_TAB__?.()).toBe(true)
    g.__PODIUM_UNDO__?.()
    g.__PODIUM_REDO__?.()
    expect(undo).toHaveBeenCalledOnce()
    expect(redo).toHaveBeenCalledOnce()
    expect(g.__PODIUM_ADD_PROJECT__).toBeUndefined()

    uninstall()
    expect(g.__PODIUM_ABOUT__).toBeUndefined()
    expect(g.__PODIUM_SETTINGS__).toBeUndefined()
    expect(g.__PODIUM_CLOSE_TAB__).toBeUndefined()
    expect(g.__PODIUM_UNDO__).toBeUndefined()
    expect(g.__PODIUM_REDO__).toBeUndefined()
  })

  it('dispatches add-project and about events', () => {
    const add = vi.fn()
    const about = vi.fn()
    window.addEventListener('podium:add-project', add)
    window.addEventListener('podium:about', about)
    openAddProject()
    openAboutPodium()
    expect(add).toHaveBeenCalledOnce()
    expect(about).toHaveBeenCalledOnce()
    window.removeEventListener('podium:add-project', add)
    window.removeEventListener('podium:about', about)
  })
})

describe('sidebarToggleFromEvent', () => {
  const chord = (
    key: string,
    mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {},
  ) =>
    sidebarToggleFromEvent({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    })

  it('maps ⌘B to the right sidebar and ⇧⌘B to the left', () => {
    expect(chord('b', { metaKey: true })).toBe('right')
    expect(chord('B', { metaKey: true })).toBe('right')
    expect(chord('b', { ctrlKey: true })).toBe('right')
    expect(chord('b', { metaKey: true, shiftKey: true })).toBe('left')
    expect(chord('b', { ctrlKey: true, shiftKey: true })).toBe('left')
  })

  it('ignores Option, other letters, and an unmodified B', () => {
    expect(chord('b', { metaKey: true, altKey: true })).toBeNull()
    expect(chord('b', { metaKey: true, altKey: true, shiftKey: true })).toBeNull()
    expect(chord('n', { metaKey: true })).toBeNull()
    expect(chord('b')).toBeNull()
  })
})
