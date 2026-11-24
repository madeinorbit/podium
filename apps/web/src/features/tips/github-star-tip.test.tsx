import type { MobxPool } from '@podium/client-graph'
import { LOADING } from '@podium/client-graph/loading'
import { createPoolProjection } from '@podium/client-graph/runtime-pool'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PanelVisible } from '@/app/panel-visible'
import { FIRST_PROMPT_ANCHOR } from '@/features/setup/FirstPromptTip'
import { taskRowAnchor } from '@/features/worklist/first-send-tip'
import { PODIUM_REPO_URL } from './github-star-link'
import { GitHubStarOnFinishedTask, useGitHubStarOnNewPrompt } from './github-star-tip'
import { MemoryTipLog } from './memory-tip-log'
import { TipHost } from './TipHost'
import { OFF_SCREEN, ON_SCREEN, stubTipVisibility } from './test-visibility'
import { TIP_QUIET_MS } from './tip-engine'

const mutate = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@podium/client-core/react', async (original) => ({
  ...(await original<typeof import('@podium/client-core/react')>()),
  useRequestClient: () => ({ telemetry: { recordGithubStar: { mutate } } }),
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

// The count's all-history derivation is exercised in finished-task-count.test.ts.
// These scalar projections keep the real hook subscription and queue boundaries.
const facts = observable({
  count: 0 as number | typeof LOADING,
  issue: null as {
    id: string
    stage: string
    closedAt: string
    closedReason: string | null
  } | null,
})
const pool = {
  get finishedTaskCount() {
    return facts.count
  },
} as MobxPool
vi.mock('@podium/client-graph/header-companion', () => ({
  headerModel: () => ({
    get selectedIssue() {
      return facts.issue
    },
  }),
}))
vi.mock('@/app/store-worklist-pool', () => ({
  useWorklistPoolProjection<T>(read: (pool: MobxPool) => T): T {
    const projection = useMemo(() => createPoolProjection(pool, read), [read])
    useEffect(() => () => projection.dispose(), [projection])
    return useSyncExternalStore(projection.subscribe, () => projection.getSnapshot(read))
  },
}))

function NewPrompt({ first = false }: { first?: boolean }) {
  const [showing, setShowing] = useState(false)
  useGitHubStarOnNewPrompt({ first, setShowing })
  return (
    <div data-tip-anchor={FIRST_PROMPT_ANCHOR} data-showing={showing}>
      <input aria-label="Task prompt" />
    </div>
  )
}

let focused = true
let visibility: DocumentVisibilityState = 'visible'
let place: ReturnType<typeof stubTipVisibility>['place']
const advance = async (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const card = () => document.querySelector('.tip-card')

beforeEach(() => {
  vi.useFakeTimers()
  focused = true
  visibility = 'visible'
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(window, 'open').mockReturnValue(null)
  ;({ place } = stubTipVisibility())
  mutate.mockClear()
  mutate.mockResolvedValue({ ok: true })
  runInAction(() => {
    facts.count = 3
    facts.issue = null
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount(
  options: {
    first?: boolean
    panelVisible?: boolean
    log?: MemoryTipLog
    finished?: boolean
    rect?: DOMRect
  } = {},
) {
  const log = options.log ?? new MemoryTipLog()
  const view = render(
    <TipHost log={log} gapMs={0}>
      <PanelVisible visible={options.panelVisible ?? true}>
        {options.finished ? (
          <>
            <button type="button" data-tip-anchor={taskRowAnchor('third')}>
              Third task
            </button>
            <GitHubStarOnFinishedTask />
          </>
        ) : (
          <NewPrompt first={options.first} />
        )}
      </PanelVisible>
    </TipHost>,
  )
  const anchor = view.container.querySelector<HTMLElement>('[data-tip-anchor]')!
  act(() => place(anchor, options.rect ?? ON_SCREEN))
  await advance()
  return { ...view, log, anchor }
}

describe('the one-time GitHub ask', () => {
  it.each([
    0,
    1,
    2,
    LOADING,
  ] as const)('does not ask before three complete tasks: %s', async (count) => {
    runInAction(() => {
      facts.count = count
    })
    const { log } = await mount()
    expect(card()).toBeNull()
    expect(log.isSeen('github-star')).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
    act(() => {
      runInAction(() => {
        facts.count = 3
      })
    })
    await advance()
    // The observer attaches only once eligibility has arrived.
    act(() => {
      for (const anchor of document.querySelectorAll('[data-tip-anchor]')) place(anchor, ON_SCREEN)
    })
    await advance()
    expect(card()?.textContent).toContain('Star us on GitHub.')
  })

  it.each([
    3, 4,
  ])('asks at or after the third task and spends it before a reload: %s', async (count) => {
    runInAction(() => {
      facts.count = count
    })
    const { log, unmount } = await mount()
    expect(card()?.textContent).toContain('Not now')
    expect(log.isSeen('github-star')).toBe(true)
    expect(mutate).toHaveBeenCalledExactlyOnceWith({ event: 'shown', surface: 'new_prompt' })
    unmount()
    await mount({ log })
    expect(card()).toBeNull()
    expect(mutate).toHaveBeenCalledTimes(1)
  })

  it.each([
    'Not now',
    'Star on GitHub',
    'Dismiss tip',
    'Escape',
  ])('%s ends the ask without disabling tips', async (answer) => {
    const { log, unmount } = await mount()
    if (answer === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else {
      const button = [...card()!.querySelectorAll('button')].find(
        (b) => b.textContent === answer || b.getAttribute('aria-label') === answer,
      )!
      fireEvent.click(button)
    }
    await advance()
    expect(card()).toBeNull()
    expect(log.enabled).toBe(true)
    if (answer === 'Star on GitHub') {
      expect(window.open).toHaveBeenCalledWith(PODIUM_REPO_URL, '_blank', 'noopener,noreferrer')
      expect(mutate).toHaveBeenLastCalledWith({ event: 'clicked', surface: 'new_prompt' })
    } else expect(window.open).not.toHaveBeenCalled()
    unmount()
    await mount({ log })
    expect(card()).toBeNull()
  })

  it('uses the open, just-finished task when its row is visible', async () => {
    runInAction(() => {
      facts.issue = {
        id: 'third',
        stage: 'done',
        closedReason: 'done',
        closedAt: new Date().toISOString(),
      }
    })
    await mount({ finished: true })
    expect(card()).not.toBeNull()
    expect(mutate).toHaveBeenCalledExactlyOnceWith({ event: 'shown', surface: 'finished_task' })
  })

  it.each(['cancelled', 'old'])('leaves the fallback available for a %s closure', async (kind) => {
    runInAction(() => {
      facts.issue = {
        id: 'third',
        stage: 'done',
        closedReason: kind === 'cancelled' ? 'cancelled' : 'done',
        closedAt: new Date(Date.now() - (kind === 'old' ? 11 * 60_000 : 0)).toISOString(),
      }
    })
    const { log, unmount } = await mount({ finished: true })
    expect(card()).toBeNull()
    expect(log.isSeen('github-star')).toBe(false)
    unmount()
    await mount({ log })
    expect(card()).not.toBeNull()
  })

  it('keeps the card usable if telemetry fails', async () => {
    mutate.mockRejectedValue(new Error('offline'))
    await mount()
    expect(card()?.textContent).toContain('Star on GitHub')
  })

  it('rechecks the closure age when focus returns after ten minutes', async () => {
    focused = false
    runInAction(() => {
      facts.issue = {
        id: 'third',
        stage: 'done',
        closedReason: 'done',
        closedAt: new Date().toISOString(),
      }
    })
    const { log, unmount } = await mount({ finished: true })
    vi.setSystemTime(Date.now() + 11 * 60_000)
    act(() => {
      focused = true
      window.dispatchEvent(new Event('focus'))
    })
    await advance()
    expect(card()).toBeNull()
    expect(log.isSeen('github-star')).toBe(false)
    unmount()
    await mount({ log })
    expect(card()).not.toBeNull()
  })
})

describe('focus and visibility', () => {
  it.each([
    'blurred',
    'hidden document',
    'hidden panel',
    'hidden row',
  ])('never spends the finished-task ask in a %s place', async (kind) => {
    focused = kind !== 'blurred'
    visibility = kind === 'hidden document' ? 'hidden' : 'visible'
    runInAction(() => {
      facts.issue = {
        id: 'third',
        stage: 'done',
        closedReason: 'done',
        closedAt: new Date().toISOString(),
      }
    })
    const { log } = await mount({
      finished: true,
      panelVisible: kind !== 'hidden panel',
      rect: kind === 'hidden row' ? OFF_SCREEN : ON_SCREEN,
    })
    expect(card()).toBeNull()
    expect(log.isSeen('github-star')).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([
    'blurred',
    'hidden document',
    'hidden panel',
    'first prompt',
  ])('never spends the ask in a %s place', async (kind) => {
    focused = kind !== 'blurred'
    visibility = kind === 'hidden document' ? 'hidden' : 'visible'
    const { log } = await mount({
      first: kind === 'first prompt',
      panelVisible: kind !== 'hidden panel',
    })
    expect(card()).toBeNull()
    expect(log.isSeen('github-star')).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('retries an offscreen composer when it scrolls into view', async () => {
    const { anchor, log } = await mount({ rect: OFF_SCREEN })
    expect(card()).toBeNull()
    expect(log.isSeen('github-star')).toBe(false)
    act(() => place(anchor, ON_SCREEN))
    await advance()
    expect(card()).not.toBeNull()
  })

  it.each([
    'blurred',
    'hidden',
  ])('checks %s again after the quiet delay, before showing', async (kind) => {
    // Establish input before registering the moment.
    const log = new MemoryTipLog()
    const view = render(
      <TipHost log={log}>
        <input />
      </TipHost>,
    )
    fireEvent.keyDown(window, { key: 'a' })
    view.rerender(
      <TipHost log={log}>
        <NewPrompt />
      </TipHost>,
    )
    const anchor = view.container.querySelector<HTMLElement>('[data-tip-anchor]')!
    act(() => place(anchor, ON_SCREEN))
    await advance(TIP_QUIET_MS - 1)
    if (kind === 'blurred') focused = false
    else anchor.style.display = 'none'
    await advance(1)
    expect(card()).toBeNull()
    expect(log.isSeen('github-star')).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([
    'blur',
    'visibilitychange',
  ])('dismisses the shown card on %s and never asks again', async (event) => {
    const { log } = await mount()
    expect(card()).not.toBeNull()
    act(() => {
      if (event === 'blur') {
        focused = false
        window.dispatchEvent(new Event(event))
      } else {
        visibility = 'hidden'
        document.dispatchEvent(new Event(event))
      }
    })
    await advance()
    expect(card()).toBeNull()
    expect(log.isSeen('github-star')).toBe(true)
  })
})
