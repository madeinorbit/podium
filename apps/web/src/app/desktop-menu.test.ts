import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDesktopMenuHooks, openAboutPodium, openAddProject } from './desktop-menu'

type Globals = {
  __PODIUM_ABOUT__?: () => void
  __PODIUM_SETTINGS__?: () => void
  __PODIUM_ADD_PROJECT__?: () => void
  __PODIUM_CLOSE_TAB__?: () => boolean
}

const g = globalThis as Globals

afterEach(() => {
  delete g.__PODIUM_ABOUT__
  delete g.__PODIUM_SETTINGS__
  delete g.__PODIUM_ADD_PROJECT__
  delete g.__PODIUM_CLOSE_TAB__
})

describe('desktop menu hooks', () => {
  it('installs only the hooks that were provided and uninstalls them', () => {
    const about = vi.fn()
    const settings = vi.fn()
    const closeTab = vi.fn(() => true)
    const uninstall = installDesktopMenuHooks({ about, settings, closeTab })

    expect(g.__PODIUM_ABOUT__).toBe(about)
    // ⌘, in the Podium ADE menu (apps/desktop/src-tauri/src/main.rs).
    expect(g.__PODIUM_SETTINGS__).toBe(settings)
    expect(g.__PODIUM_CLOSE_TAB__?.()).toBe(true)
    expect(g.__PODIUM_ADD_PROJECT__).toBeUndefined()

    uninstall()
    expect(g.__PODIUM_ABOUT__).toBeUndefined()
    expect(g.__PODIUM_SETTINGS__).toBeUndefined()
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
