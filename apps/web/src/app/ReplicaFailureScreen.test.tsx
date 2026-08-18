import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplicaFailureScreen } from './ReplicaFailureScreen'

describe('the screen a failed boot gate shows', () => {
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
    vi.restoreAllMocks()
  })

  function render(node: React.ReactNode): void {
    act(() => root.render(node))
  }

  it('asks for the password when the only thing missing is a session', () => {
    // The defect this issue exists for: a browser with no session used to be
    // told its "private replica" could not open, on a screen whose only button
    // reloaded it into the same wall.
    render(
      <ReplicaFailureScreen
        cause={{ kind: 'signed-out' }}
        detail="authenticated account is unavailable"
        httpOrigin="http://pod.test"
      />,
    )
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
    expect(container.textContent).not.toContain('private replica')
    expect(container.textContent).not.toContain('authenticated account is unavailable')
  })

  it('says a server is still coming up, and keeps the fault out of the sentence', () => {
    render(
      <ReplicaFailureScreen
        cause={{
          kind: 'server-starting',
          readiness: { state: 'unconfigured', reason: 'setup_required', dataPlane: 'blocked' },
        }}
        detail="authenticated account is unavailable"
        httpOrigin="http://pod.test:1234"
      />,
    )
    expect(container.querySelector('h1')?.textContent).toContain('set up')
    expect(container.textContent).toContain('clears itself')
    expect(container.querySelector('details')?.open).toBe(false)
  })

  it('keeps the raw fault available, but behind the disclosure', () => {
    render(
      <ReplicaFailureScreen
        cause={{ kind: 'replica-blocked' }}
        detail="SecurityError: IndexedDB is blocked"
        httpOrigin="http://pod.test"
      />,
    )
    const details = container.querySelector('details')
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain('SecurityError: IndexedDB is blocked')
    // ...and the headline is the operator's problem, not the exception's name.
    expect(container.querySelector('h1')?.textContent).not.toContain('SecurityError')
  })

  it('names the host it could not get an account from', () => {
    render(
      <ReplicaFailureScreen
        cause={{ kind: 'auth-refused', status: 503 }}
        detail="authenticated account is unavailable"
        httpOrigin="http://pod.test:9999"
      />,
    )
    expect(container.textContent).toContain('pod.test:9999')
    expect(container.textContent).toContain('HTTP 503')
  })

  it('exits by reload, from the keyboard as well as the button', () => {
    const reload = vi.fn()
    render(
      <ReplicaFailureScreen
        cause={{ kind: 'account-missing' }}
        detail="authenticated account is unavailable"
        httpOrigin="http://pod.test"
        win={{ location: { reload, href: '/x' } }}
      />,
    )
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    })
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
