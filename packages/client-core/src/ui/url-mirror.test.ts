import { asIssueId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { PodiumClientApi } from '../api'
import type { SocketHub } from '../socket-transport'
import { createRouter, type RouterWindow } from '../ui-state'
import { UiStore } from './ui-store'
import { UrlMirror } from './url-mirror'

function fixture(initial = '/workspace') {
  const address = new URL(initial, 'https://podium.test'),
    listeners = new Set<() => void>()
  const pushes = vi.fn((_: unknown, _title: string, url?: string | null) => {
    if (url) address.href = new URL(url, address).href
  })
  const replaces = vi.fn((_: unknown, _title: string, url?: string | null) => {
    if (url) address.href = new URL(url, address).href
  })
  const win: RouterWindow = {
    location: {
      get pathname() {
        return address.pathname
      },
      get search() {
        return address.search
      },
    },
    history: { pushState: pushes, replaceState: replaces },
    addEventListener: (_event, listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_event, listener) => {
      listeners.delete(listener)
    },
  }
  const router = createRouter({ win })
  const values = new Map<string, string>()
  const ui = new UiStore({
    api: {} as PodiumClientApi,
    hub: {} as SocketHub,
    notices: { error: vi.fn(), info: vi.fn() },
    keys: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => {
        if (value === null) values.delete(key)
        else values.set(key, value)
      },
      subscribe: () => () => {},
    },
    router,
    repositories: () => [],
    isVisible: () => true,
  })
  const mirror = new UrlMirror(ui, router, (route) =>
    ui.patch({
      view: route.view,
      settingsTab: route.settingsTab,
      openIssueId: route.issueId,
      ...(route.worktree ? { selectedWorktree: route.worktree } : {}),
    }),
  )
  return {
    ui,
    mirror,
    router,
    address,
    pushes,
    replaces,
    pop(url: string) {
      address.href = new URL(url, address).href
      for (const listener of listeners) listener()
    },
  }
}

describe('UiStore URL mirror', () => {
  it('adopts the incoming route before starting selection mirroring', () => {
    const f = fixture('/settings/appearance?demo=1')
    f.ui.patch({ view: 'workspace' })
    f.mirror.adoptCurrent()
    expect(f.ui.view).toBe('settings')
    expect(f.ui.settingsTab).toBe('appearance')
    f.mirror.start()
    expect(f.address.pathname).toBe('/settings/appearance')
    expect(f.address.searchParams.get('demo')).toBe('1')
    f.mirror.stopMirroring()
  })
  it('mirrors screen changes once, keeps unrelated query parameters, and stops on disposal', () => {
    const f = fixture('/workspace?demo=1')
    f.mirror.start()
    f.ui.setSelectedWorktree('/repo')
    f.ui.openSessionTab(asSessionId('session-1'))
    expect(f.address.pathname).toBe('/workspace')
    expect(f.address.searchParams.get('wt')).toBe('/repo')
    expect(f.address.searchParams.get('pane')).toBe('session-1')
    expect(f.address.searchParams.get('demo')).toBe('1')
    f.ui.setSettingsTab('appearance')
    expect(f.address.pathname).toBe('/settings/appearance')
    f.ui.setOpenIssueId(asIssueId('issue-2'))
    expect(f.address.pathname).toBe('/issues/issue-2')
    const before = f.replaces.mock.calls.length
    f.mirror.stopMirroring()
    f.ui.setOpenIssueId(null)
    expect(f.replaces).toHaveBeenCalledTimes(before)
  })
  it('mirrors settings while an issue workspace is loading', () => {
    const f = fixture('/workspace?pane=linked')
    f.ui.setSelectedIssueId(asIssueId('unresolved-child'))
    f.mirror.start()
    f.ui.setSettingsTab('appearance')
    expect(f.address.pathname).toBe('/settings/appearance')
    f.mirror.stopMirroring()
  })
  it('adopts popstate through the same service without echoing another history entry', () => {
    const f = fixture()
    f.mirror.start()
    f.replaces.mockClear()
    f.pushes.mockClear()
    f.pop('/settings/notifications')
    expect(f.ui.view).toBe('settings')
    expect(f.ui.settingsTab).toBe('notifications')
    expect(f.replaces).not.toHaveBeenCalled()
    expect(f.pushes).not.toHaveBeenCalled()
    f.pop('/issues/issue-3')
    expect(f.ui.openIssueId).toBe('issue-3')
    f.mirror.stopMirroring()
  })
})
