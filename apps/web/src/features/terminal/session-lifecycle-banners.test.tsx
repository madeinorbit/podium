import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * THE READ-ONLY BARS ONCE A WAKE IS IN FLIGHT (POD-762).
 *
 * A bar over a parked transcript has exactly one job while nothing is happening:
 * say the process is stopped and offer to start it. The moment a message is
 * waiting on it, that offer becomes the wrong thing to show — the wake is
 * already running, pressing the button again would achieve nothing, and the
 * operator who just pressed Enter is looking at this bar for the confirmation
 * that anything happened at all.
 */

const actions = vi.hoisted(() => ({
  endSession: vi.fn(async () => ({ ok: true })),
  hibernateSession: vi.fn(async () => {}),
}))

vi.mock('@/app/store', () => ({
  useRuntimeSelector: (sel: (s: unknown) => unknown) =>
    sel({
      resurrectSession: vi.fn(),
      killSession: vi.fn(),
      endSession: actions.endSession,
      hibernateSession: actions.hibernateSession,
    } as never),
}))

const { ExitedBanner, HibernatedBanner, LifecycleTransitionBar } = await import(
  './SessionLifecyclePanes'
)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the hibernated bar', () => {
  it('offers the resume while the queue is empty', () => {
    act(() => {
      root.render(<HibernatedBanner sessionId={asSessionId('s1')} />)
    })
    expect(container.textContent).toContain('Hibernated')
    expect(container.querySelector('[data-testid="lifecycle-resume"]')).not.toBeNull()
  })

  it('reports the wake instead of offering it again, and drops the button', () => {
    act(() => {
      root.render(<HibernatedBanner sessionId={asSessionId('s1')} waking queuedCount={1} />)
    })
    expect(container.textContent).toContain('Waking the agent')
    expect(container.textContent).toContain('your message sends')
    expect(container.textContent).not.toContain('read-only')
    expect(container.querySelector('[data-testid="lifecycle-resume"]')).toBeNull()
    expect(container.querySelector('.pane-state-bar-waking')).not.toBeNull()
    expect(container.querySelector('.pane-state-bar-mark.animate-pulse')).toBeNull()
  })

  it('counts the queue when more than one message is waiting', () => {
    act(() => {
      root.render(<HibernatedBanner sessionId={asSessionId('s1')} waking queuedCount={3} />)
    })
    expect(container.textContent).toContain('your 3 messages send')
  })
})

describe('the exited bar', () => {
  it('takes the same waking arm', () => {
    act(() => {
      root.render(<ExitedBanner sessionId={asSessionId('s1')} isShell={false} resumable waking />)
    })
    expect(container.textContent).toContain('Waking the agent')
    expect(container.querySelector('[data-testid="lifecycle-resume"]')).toBeNull()
    expect(container.querySelector('.pane-state-bar-waking')).not.toBeNull()
  })
})

describe('the lifecycle transition bar (POD-6399)', () => {
  const id = asSessionId('s1')

  it('shows nothing for a session nobody has edited', () => {
    act(() => {
      root.render(<LifecycleTransitionBar session={{ sessionId: id }} />)
    })
    expect(container.textContent).toBe('')
  })

  it('says the session is on its way while the server has not acted', () => {
    act(() => {
      root.render(
        <LifecycleTransitionBar session={{ sessionId: id, desired: 'stopped', revision: 3, observedRevision: 2 }} />,
      )
    })
    expect(container.querySelector('[data-testid="lifecycle-transition"]')?.textContent).toContain(
      'Stopping…',
    )
    expect(container.querySelector('[data-testid="lifecycle-retry"]')).toBeNull()
  })

  it('shows a refused stop with its reason and ends anyway on request', async () => {
    act(() => {
      root.render(
        <LifecycleTransitionBar
          session={{
            sessionId: id,
            desired: 'stopped',
            revision: 3,
            observedRevision: 3,
            lifecycleFailure: { revision: 3, reason: 'unsaved changes in the working tree' },
          }}
        />,
      )
    })
    const bar = container.querySelector('[data-testid="lifecycle-refused"]')
    expect(bar?.textContent).toContain("Couldn't end — unsaved changes in the working tree")
    const button = container.querySelector<HTMLButtonElement>('[data-testid="lifecycle-retry"]')
    expect(button?.textContent).toBe('End anyway')
    await act(async () => button?.click())
    expect(actions.endSession).toHaveBeenCalledWith(id, true)
  })

  it('offers to try a refused hibernate again', async () => {
    act(() => {
      root.render(
        <LifecycleTransitionBar
          session={{
            sessionId: id,
            desired: 'hibernated',
            revision: 2,
            observedRevision: 2,
            lifecycleFailure: { revision: 2, reason: 'agent is working' },
          }}
        />,
      )
    })
    const button = container.querySelector<HTMLButtonElement>('[data-testid="lifecycle-retry"]')
    expect(button?.textContent).toBe('Try again')
    await act(async () => button?.click())
    expect(actions.hibernateSession).toHaveBeenCalledWith(id)
  })
})
