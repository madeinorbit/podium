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

vi.mock('@/app/store', () => ({
  useStoreSelector: (sel: (s: unknown) => unknown) =>
    sel({ resurrectSession: vi.fn(), killSession: vi.fn() } as never),
}))

const { ExitedBanner, HibernatedBanner } = await import('./SessionLifecyclePanes')

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
