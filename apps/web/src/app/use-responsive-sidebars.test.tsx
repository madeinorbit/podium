// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RightPanelTab } from './shell-state'
import { useResponsiveSidebars } from './use-responsive-sidebars'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function resize(width: number): void {
  act(() => {
    vi.stubGlobal('innerWidth', width)
    window.dispatchEvent(new Event('resize'))
  })
}

function setup(width: number, collapsed = false, panel: RightPanelTab | null = 'files') {
  vi.stubGlobal('innerWidth', width)
  const writes = { sidebar: vi.fn(), panel: vi.fn() }
  const hook = renderHook(() => {
    const [sidebarCollapsed, setSidebarCollapsed] = useState(collapsed)
    const [rightPanel, setRightPanel] = useState(panel)
    return useResponsiveSidebars({
      sidebarCollapsed,
      rightPanel,
      setSidebarCollapsed: (next) => {
        writes.sidebar(next)
        setSidebarCollapsed(next)
      },
      setRightPanel: (next) => {
        writes.panel(next)
        setRightPanel(next)
      },
    })
  })
  return { ...hook, writes }
}

describe('responsive sidebars', () => {
  it('boots folded on a laptop and restores the saved panels without writing preferences', () => {
    const { result, writes } = setup(1512)
    expect(result.current.sidebarCollapsed).toBe(true)
    expect(result.current.rightPanel).toBeNull()

    resize(2560)
    expect(result.current.sidebarCollapsed).toBe(false)
    expect(result.current.rightPanel).toBe('files')
    expect(writes.sidebar).not.toHaveBeenCalled()
    expect(writes.panel).not.toHaveBeenCalled()
  })

  it('folds on shrink and uses a buffer before restoring', () => {
    const { result } = setup(1920)
    resize(1600)
    expect(result.current.compact).toBe(false)
    resize(1599)
    expect(result.current.sidebarCollapsed).toBe(true)
    expect(result.current.rightPanel).toBeNull()
    resize(1650)
    expect(result.current.compact).toBe(true)
    resize(1680)
    expect(result.current.sidebarCollapsed).toBe(false)
    expect(result.current.rightPanel).toBe('files')
    resize(1600)
    expect(result.current.compact).toBe(false)
  })

  it('never restores panels the user had manually closed', () => {
    const { result, writes } = setup(1920, true, null)
    resize(1280)
    resize(1920)
    expect(result.current.sidebarCollapsed).toBe(true)
    expect(result.current.rightPanel).toBeNull()
    expect(writes.sidebar).not.toHaveBeenCalled()
    expect(writes.panel).not.toHaveBeenCalled()
  })

  it('allows independent manual reveals until the next compact visit', () => {
    const { result, writes } = setup(1280)
    act(() => result.current.setSidebarCollapsed(false))
    expect(result.current.sidebarCollapsed).toBe(false)
    expect(result.current.rightPanel).toBeNull()
    act(() => result.current.setRightPanel('git'))
    resize(1300)
    expect(result.current.rightPanel).toBe('git')
    expect(result.current.sidebarCollapsed).toBe(false)
    resize(1920)
    expect(result.current.rightPanel).toBe('git')
    resize(1280)
    expect(result.current.rightPanel).toBeNull()
    expect(result.current.sidebarCollapsed).toBe(true)
    expect(writes.sidebar).toHaveBeenCalledExactlyOnceWith(false)
    expect(writes.panel).toHaveBeenCalledExactlyOnceWith('git')
  })

  it('remembers a manual close after a compact reveal when returning to a big screen', () => {
    const { result } = setup(1280)
    act(() => {
      result.current.setSidebarCollapsed(false)
      result.current.setRightPanel('issue')
    })
    act(() => {
      result.current.setSidebarCollapsed(true)
      result.current.setRightPanel(null)
    })
    resize(1920)
    expect(result.current.sidebarCollapsed).toBe(true)
    expect(result.current.rightPanel).toBeNull()
  })

  it('keeps late replicated preferences folded and restores their latest values', () => {
    vi.stubGlobal('innerWidth', 1280)
    const setSidebarCollapsed = vi.fn()
    const setRightPanel = vi.fn()
    const initialProps: { sidebarCollapsed: boolean; rightPanel: RightPanelTab | null } = {
      sidebarCollapsed: false,
      rightPanel: null,
    }
    const { result, rerender } = renderHook(
      (preferences: { sidebarCollapsed: boolean; rightPanel: RightPanelTab | null }) =>
        useResponsiveSidebars({ ...preferences, setSidebarCollapsed, setRightPanel }),
      { initialProps },
    )
    rerender({ sidebarCollapsed: true, rightPanel: 'superagent' })
    expect(result.current.sidebarCollapsed).toBe(true)
    expect(result.current.rightPanel).toBeNull()
    resize(1920)
    expect(result.current.sidebarCollapsed).toBe(true)
    expect(result.current.rightPanel).toBe('superagent')
    expect(setSidebarCollapsed).not.toHaveBeenCalled()
    expect(setRightPanel).not.toHaveBeenCalled()
  })

  it('does not keep a compact reveal after reopening the app', () => {
    const first = setup(1280)
    act(() => first.result.current.setSidebarCollapsed(false))
    first.unmount()
    const next = setup(1280)
    expect(next.result.current.sidebarCollapsed).toBe(true)
    expect(next.result.current.rightPanel).toBeNull()
  })

  it('removes the window listener on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const view = setup(1920)
    const listener = add.mock.calls.find(([event]) => event === 'resize')?.[1]
    expect(listener).toBeDefined()
    view.unmount()
    expect(remove).toHaveBeenCalledWith('resize', listener)
  })
})
