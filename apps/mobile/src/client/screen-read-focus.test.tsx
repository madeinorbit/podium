import { asRepoId, asSessionId, asUserId, type SessionMeta } from '@podium/model'
import { act, cleanup } from '@testing-library/react'
import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext'
import { IsFocusedContext } from 'expo-router/build/react-navigation/core/useIsFocused'
import { type ReactNode, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type AppStateStatus, createNativeConnectivity } from './native-connectivity'
import { noScreenFocus, useScreenReadFocus } from './screen-read-focus'
import { renderWithMobileStore } from './test-support'

const issueId = 'resume-task'
const sessionId = asSessionId('resume-seat')
const userId = asUserId('user:test')
const base = Date.parse('2026-11-12T12:00:00.000Z')
const stamp = (offset = 0) => new Date(base + offset).toISOString()
const issue = {
  id: issueId,
  seq: 1,
  title: 'Resume task',
  repoPath: '/synthetic',
  stage: 'in_progress',
  repoId: asRepoId('fixture:/synthetic'),
  audience: 'human',
  createdAt: stamp(),
  updatedAt: stamp(),
  readAt: stamp(),
}
const session = {
  sessionId,
  issueId,
  cwd: '/synthetic',
  agentKind: 'codex',
  status: 'live',
  lastActiveAt: stamp(),
  createdAt: stamp(),
  archived: false,
} as SessionMeta

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function navigation() {
  let focused = true
  const listeners = new Map<string, Set<() => void>>()
  return {
    isFocused: () => focused,
    addListener(event: string, wake: () => void) {
      const group = listeners.get(event) ?? new Set<() => void>()
      listeners.set(event, group)
      group.add(wake)
      return () => group.delete(wake)
    },
    focus(next: boolean, notify = true) {
      focused = next
      if (!notify) return
      for (const wake of listeners.get(next ? 'focus' : 'blur') ?? []) wake()
    },
  }
}

async function fixture(withSession = true) {
  let appState: AppStateStatus = 'active'
  const listeners = new Set<(state: AppStateStatus) => void>()
  const connectivity = createNativeConnectivity({
    appState: {
      get currentState() {
        return appState
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener)
        return { remove: () => listeners.delete(listener) }
      },
    },
    netInfo: { addEventListener: () => () => {} },
  })
  const nav = navigation()
  let selectTab: (focused: boolean) => void = () => {}
  function NativeTab({ children }: { children: ReactNode }) {
    const [focused, setFocused] = useState(true)
    selectTab = setFocused
    return <IsFocusedContext.Provider value={focused}>{children}</IsFocusedContext.Provider>
  }
  function MountedTask() {
    useScreenReadFocus(issueId, withSession ? sessionId : undefined)
    return <div data-testid="mounted-task">Task screen retained under Work</div>
  }
  const view = await renderWithMobileStore(
    <NavigationContext.Provider value={nav as never}>
      {/* Keep the last React focus value, as a native frozen screen may do.
          Navigator events and isFocused must still revoke its read permission. */}
      <NativeTab>
        <MountedTask />
      </NativeTab>
    </NavigationContext.Provider>,
    {
      issues: [issue as never],
      sessions: [session],
      sessionUserStates: [{ userId, sessionId, readAt: stamp(), snoozedUntil: null }],
      visibility: connectivity.visibility,
      screenFocus: noScreenFocus,
      api: {
        issues: { markRead: { mutate: async () => ({}) } },
        sessions: { markRead: { mutate: async () => ({}) } },
      },
    },
  )
  const issueRead = vi.spyOn(view.runtime.services, 'markIssueRead')
  const sessionRead = vi.spyOn(view.runtime.services, 'markSessionRead')
  const viewState = vi.spyOn(view.runtime.hub, 'setViewState')
  vi.useFakeTimers()
  vi.setSystemTime(base)
  const go = async (next: AppStateStatus) =>
    act(async () => {
      appState = next
      for (const listener of listeners) listener(next)
    })
  const activity = async (offset: number) =>
    act(async () => {
      view.replica.applyChanges(
        'issueProjections',
        [{ ...issue, updatedAt: stamp(offset) } as never],
        [],
      )
      view.replica.applyChanges('sessions', [{ ...session, lastActiveAt: stamp(offset) }], [])
    })
  const advance = async (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  return {
    ...view,
    nav,
    issueRead,
    sessionRead,
    viewState,
    go,
    activity,
    advance,
    selectTab,
    close() {
      view.unmount()
      connectivity.dispose()
    },
  }
}

it.each([
  'under Work',
  'in an unselected tab',
])('does not read a mounted task %s on resume after a long background', async (hidden) => {
  const f = await fixture()
  try {
    // The Worklist still remembers this task, just as it does after backing out.
    act(() => {
      f.runtime.access.setSelectedIssueId(issueId as never)
      if (hidden === 'under Work') f.nav.focus(false)
      else f.selectTab(false)
    })
    expect(f.getByTestId('mounted-task')).toBeDefined()
    await f.go('inactive')
    await f.go('background')
    await f.advance(12 * 60_000)
    await f.activity(1_000)
    await f.go('active')
    await f.advance(1_800)
    await f.activity(2_000)
    await f.advance(11_900)
    expect(f.issueRead).not.toHaveBeenCalled()
    expect(f.sessionRead).not.toHaveBeenCalled()
    expect(f.runtime.outbox.pending()).toEqual([])
    expect(f.viewState).toHaveBeenLastCalledWith([], null, {})
    expect(f.runtime.access.getUserFocus().visibleSessionIds).toEqual([])
  } finally {
    f.close()
  }
})

it('reads the top task and session exactly once on resume, with no repeated read after settling', async () => {
  const f = await fixture()
  try {
    await f.go('background')
    await f.advance(12 * 60_000)
    await f.activity(1_000)
    await f.advance(12_000)
    expect(f.issueRead).not.toHaveBeenCalled()
    expect(f.sessionRead).not.toHaveBeenCalled()
    await f.go('active')
    await f.advance(15_000)
    expect(f.issueRead).toHaveBeenCalledExactlyOnceWith(issueId, stamp(1_000))
    expect(f.sessionRead).toHaveBeenCalledExactlyOnceWith(sessionId, stamp(1_000))
    expect(f.viewState).toHaveBeenLastCalledWith([sessionId], sessionId, { [sessionId]: 'native' })
  } finally {
    f.close()
  }
})

it('does not enqueue a read when the top task and session were already read before resume', async () => {
  const f = await fixture()
  try {
    await f.go('background')
    await f.advance(12 * 60_000)
    await f.go('active')
    await f.advance(15_000)
    expect(f.issueRead).not.toHaveBeenCalled()
    expect(f.sessionRead).not.toHaveBeenCalled()
    expect(f.runtime.outbox.pending()).toEqual([])
  } finally {
    f.close()
  }
})

it('rechecks navigator focus when a receipt timer fires before a frozen screen can clean up', async () => {
  const f = await fixture()
  try {
    await f.activity(1_000)
    await f.advance(50)
    expect(f.issueRead).toHaveBeenCalledExactlyOnceWith(issueId, stamp(1_000))
    await f.activity(2_000)
    await f.advance(50)
    act(() => f.nav.focus(false, false))
    await f.advance(15_000)
    expect(f.issueRead).toHaveBeenCalledExactlyOnceWith(issueId, stamp(1_000))
    expect(f.sessionRead).toHaveBeenCalledExactlyOnceWith(sessionId, stamp(1_000))
  } finally {
    f.close()
  }
})

it('follows activity on a focused task page opened without a remembered Work selection', async () => {
  const f = await fixture(false)
  try {
    await f.activity(1_000)
    await f.advance(50)
    expect(f.issueRead).toHaveBeenCalledExactlyOnceWith(issueId, stamp(1_000))
    expect(f.sessionRead).not.toHaveBeenCalled()
  } finally {
    f.close()
  }
})
