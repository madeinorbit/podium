import { referenceState } from '@podium/client-graph/diagnostics/reference-state'
import type { ClientRuntime } from '@podium/client-core/engine'
import { readRuntimeStoreStats, storeStats } from '@podium/client-core/perf'
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider, useStoreHandle } from '@podium/client-core/react'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import { asUserId } from '@podium/model'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createSuperagentFixture } from '../../../web/src/features/superagent/fixture'
import type { MobilePool } from '../client/mobile-pool'

const state = vi.hoisted(() => ({
  host: undefined as MobilePool | undefined,
  transcripts: [] as {
    answerInteractionId?: string
    assetContext?: { sessionId: string; cwd: string }
    onAnswer: (a: unknown) => Promise<void>
  }[],
}))
vi.mock('../client/mobile-pool', async (importOriginal) => {
  const real = await importOriginal<typeof import('../client/mobile-pool')>()
  return {
    ...real,
    useMobilePool: () => state.host!.host.usePool(),
    useMobilePoolProjection: <T,>(...args: Parameters<MobilePool['host']['usePoolProjection']>) =>
      state.host!.host.usePoolProjection(...args) as T,
  }
})
vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: { Error: 'error' },
  notificationAsync: async () => {},
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
vi.mock('../hooks/useTabBarInset', () => ({ useTabBarInset: () => 72 }))
vi.mock('../hooks/useKeyboardHeight', () => ({ useKeyboardLift: () => 0 }))
vi.mock('../components/Screen', () => ({
  Screen: ({ children, right }: { children: ReactNode; right: ReactNode }) => (
    <div>
      {right}
      {children}
    </div>
  ),
  HeaderButton: ({
    children,
    label,
    onPress,
  }: {
    children: ReactNode
    label: string
    onPress: () => void
  }) => (
    // biome-ignore lint/a11y/useButtonType: Preserve accepted native Pressable mock HTML; it never belongs to a form.
    <button aria-label={label} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('../components/Icon', () => ({ Icon: () => null }))
vi.mock('../components/LaunchPlaceholders', () => ({
  BootstrapCrossfade: ({ children }: { children: ReactNode }) => children,
  TranscriptSkeleton: () => null,
}))
vi.mock('../components/PullToRefreshBoundary', () => ({
  PullToRefreshBoundary: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../components/Composer', () => ({
  Composer: ({ onSend }: { onSend: (text: string) => void }) => (
    // biome-ignore lint/a11y/useButtonType: Preserve accepted native Pressable mock HTML; it never belongs to a form.
    <button onClick={() => onSend('Synthetic handoff')}>Send</button>
  ),
}))
vi.mock('../components/SuperagentBackendRail', () => ({ SuperagentBackendRail: () => null }))
vi.mock('../components/TranscriptList', () => ({
  TranscriptList: (props: (typeof state.transcripts)[number]) => {
    state.transcripts.push(props)
    return (
      <div
        data-testid="transcript"
        data-session={props.assetContext?.sessionId}
        data-question={props.answerInteractionId}
      >
        Existing transcript
      </div>
    )
  },
}))
const { SuperagentScreen } = await import('./SuperagentScreen')
const { createMobilePool, useMobilePool } = await import('../client/mobile-pool')
afterEach(() => {
  cleanup()
  storeStats.enable(false)
  state.transcripts.length = 0
})

async function mount() {
  state.host = createMobilePool(false)
  const data = createSuperagentFixture(),
    errors: string[] = [],
    seen: unknown[] = []
  let runtime!: ClientRuntime
  function Surface() {
    runtime = useStoreHandle() as ClientRuntime
    seen.push(useMobilePool())

    return <SuperagentScreen />
  }
  storeStats.enable()
  storeStats.reset()
  const view = render(
    <StoreProvider
      principal={asClientPrincipal(asUserId('operator'))}
      config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
      api={data.api}
      createReplicaFn={() => data.newReplica()}
      networkEnabled={false}
      routerWindow={createMemoryRouterWindow()}
      onFatalError={(error) => errors.push(error)}
      attachRuntime={(owner) => {
        data.bindHub(owner.hub)
        const stop = state.host!.host.attach(owner, (error) => errors.push(error.message))
        void referenceState(owner).refreshSuperThreads()
        return stop
      }}
    >
      <Surface />
    </StoreProvider>,
  )
  // The first enabled mount includes the host's lazy graph-module import.
  await waitFor(
    () =>
      expect(
        view.container.querySelector('[data-testid="transcript"]')?.getAttribute('data-session'),
      ).toBe('synthetic-session-0'),
    { timeout: 5000 },
  )
  await waitFor(
    () =>
      expect(
        view.container.querySelector('[data-testid="transcript"]')?.getAttribute('data-question'),
      ).toBe('z-first-question'),
    { timeout: 5000 },
  )
  return { data, view, runtime, errors, seen }
}
it('renders the same phone session and question through the real no-pool to attached-pool transition', async () => {
  const enabled = await mount()
  expect(enabled.view.container.innerHTML).toMatchSnapshot('last green pilot-ON superagent')
  expect(enabled.errors).toEqual([])
  expect(enabled.seen[0]).toBeNull()
  expect(enabled.seen.some((pool) => pool !== null)).toBe(true)
})
it('has zero legacy thread, session, boot and question selectors before and after a relevant update', async () => {
  const enabled = await mount()
  expect(
    Object.entries(readRuntimeStoreStats(enabled.runtime)?.slices ?? {}).filter(
      ([name]) => name === 'superagent' || name.startsWith('superagent.'),
    ),
  ).toEqual([])
  expect(readRuntimeStoreStats(enabled.runtime)?.selectorRuns ?? 0).toBe(0)
  await act(async () => {
    enabled.data.activity(1)
    await enabled.data.updateThread(enabled.runtime, true)
  })
  expect(
    Object.entries(readRuntimeStoreStats(enabled.runtime)?.slices ?? {}).filter(
      ([name]) => name === 'superagent' || name.startsWith('superagent.'),
    ),
  ).toEqual([])
  expect(readRuntimeStoreStats(enabled.runtime)?.selectorRuns ?? 0).toBe(0)
})
it('keeps sending and clearing on the original owner and uses the declared session asset context', async () => {
  const enabled = await mount()
  expect(state.transcripts.at(-1)?.assetContext).toMatchObject({
    sessionId: 'synthetic-session-0',
    cwd: '/synthetic/project',
  })
  await act(async () => fireEvent.click(enabled.view.getByText('Send')))
  expect(enabled.data.actions.sent).toBe(1)
  await act(async () =>
    fireEvent.click(enabled.view.getByLabelText('Clear context — start the chat fresh')),
  )
  expect(enabled.data.actions.cleared).toBe(1)
  expect(enabled.errors).toEqual([])
})
