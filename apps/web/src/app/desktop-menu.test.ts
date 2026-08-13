import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installDesktopMenuHooks,
  openAboutPodium,
  openAddProject,
  sidebarToggleFromEvent,
} from './desktop-menu'

type Globals = {
  __PODIUM_ABOUT__?: () => void
  __PODIUM_ADD_PROJECT__?: () => void
  __PODIUM_CLOSE_TAB__?: () => boolean
}

const g = globalThis as Globals

afterEach(() => {
  delete g.__PODIUM_ABOUT__
  delete g.__PODIUM_ADD_PROJECT__
  delete g.__PODIUM_CLOSE_TAB__
})

describe('desktop menu hooks', () => {
  it('installs only the hooks that were provided and uninstalls them', () => {
    const about = vi.fn()
    const closeTab = vi.fn(() => true)
    const uninstall = installDesktopMenuHooks({ about, closeTab })

    expect(g.__PODIUM_ABOUT__).toBe(about)
    expect(g.__PODIUM_CLOSE_TAB__?.()).toBe(true)
    expect(g.__PODIUM_ADD_PROJECT__).toBeUndefined()

    uninstall()
    expect(g.__PODIUM_ABOUT__).toBeUndefined()
    expect(g.__PODIUM_CLOSE_TAB__).toBeUndefined()
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

  it('maps ⌘B to the left sidebar and ⌥⌘B to the right', () => {
    expect(chord('b', { metaKey: true })).toBe('left')
    expect(chord('B', { metaKey: true })).toBe('left')
    expect(chord('b', { ctrlKey: true })).toBe('left')
    expect(chord('b', { metaKey: true, altKey: true })).toBe('right')
    expect(chord('b', { ctrlKey: true, altKey: true })).toBe('right')
  })

  it('ignores shift, other letters, and an unmodified B', () => {
    expect(chord('b', { metaKey: true, shiftKey: true })).toBeNull()
    expect(chord('b', { metaKey: true, altKey: true, shiftKey: true })).toBeNull()
    expect(chord('n', { metaKey: true })).toBeNull()
    expect(chord('b')).toBeNull()
  })
})
