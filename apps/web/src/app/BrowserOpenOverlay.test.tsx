import { asSessionId } from '@podium/model'
import type { SessionOpenUrlMessage, SessionOpenUrlResultMessage } from '@podium/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const handlers = new Map<string, Set<(message: never) => void>>()
  const hub = {
    on: vi.fn((kind: string, handler: (message: never) => void) => {
      let set = handlers.get(kind)
      if (!set) {
        set = new Set()
        handlers.set(kind, set)
      }
      set.add(handler)
      return () => set?.delete(handler)
    }),
    dismissOpenUrl: vi.fn(),
    submitOpenUrlCallback: vi.fn(),
  }
  const toast = Object.assign(vi.fn(), {
    dismiss: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  })
  return { handlers, hub, toast }
})

vi.mock('./store', () => ({
  useStoreSelector: (selector: (store: unknown) => unknown) =>
    selector({
      hub: h.hub,
      sessions: [
        { sessionId: asSessionId('s1'), name: 'Remote Codex', title: '', agentKind: 'codex' },
      ],
    }),
}))

vi.mock('sonner', () => ({ toast: h.toast }))

const { BrowserOpenOverlay } = await import('./BrowserOpenOverlay')

function emit(kind: 'openUrl' | 'openUrlResult', message: unknown): void {
  act(() => {
    for (const handler of h.handlers.get(kind) ?? []) handler(message as never)
  })
}

afterEach(cleanup)

const request: SessionOpenUrlMessage = {
  type: 'sessionOpenUrl',
  sessionId: asSessionId('s1'),
  requestId: 'open-1',
  url: 'https://auth.example/authorize',
  callbackTarget: { host: 'localhost', port: 1455, path: '/auth/callback' },
  expiresAt: Date.now() + 60_000,
}

/**
 * What a click actually opens. The component must NOT go through `window.open`:
 * with `noopener` in the feature string it returns null even on success, and the
 * old code read that as a blocked popup and skipped the revoke [POD-1283]. So the
 * anchor click is intercepted here (happy-dom would otherwise try to navigate),
 * and `window.open` is spied on only to assert it stays untouched.
 */
function captureOpens(): {
  opened: { href: string; target: string; rel: string }[]
  windowOpen: ReturnType<typeof vi.spyOn>
} {
  const opened: { href: string; target: string; rel: string }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    opened.push({ href: this.href, target: this.target, rel: this.rel })
  })
  return { opened, windowOpen: vi.spyOn(window, 'open').mockReturnValue(null) }
}

describe('BrowserOpenOverlay', () => {
  beforeEach(() => {
    h.handlers.clear()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('requires a user click to open and keeps the callback paste-back affordance', () => {
    const { opened, windowOpen } = captureOpens()
    render(<BrowserOpenOverlay />)
    emit('openUrl', request)

    expect(h.toast).toHaveBeenCalledWith(
      'Remote Codex wants to open auth.example',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) }),
    )
    expect(opened).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Open login page' }))
    expect(opened).toEqual([{ href: request.url, target: '_blank', rel: 'noopener noreferrer' }])
    expect(windowOpen).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByLabelText('Paste the localhost callback URL')).not.toBeNull()

    fireEvent.change(screen.getByLabelText('Paste the localhost callback URL'), {
      target: { value: 'http://localhost:1455/auth/callback?code=x' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Forward callback' }))
    expect(h.hub.submitOpenUrlCallback).toHaveBeenCalledWith(
      's1',
      'open-1',
      'http://localhost:1455/auth/callback?code=x',
    )
  })

  it('keeps retryable failures visible and dismissal revokes the request', () => {
    render(<BrowserOpenOverlay />)
    emit('openUrl', request)
    const failed: SessionOpenUrlResultMessage = {
      type: 'sessionOpenUrlResult',
      sessionId: asSessionId('s1'),
      requestId: 'open-1',
      status: 'failed',
      error: 'callback must match localhost:1455/auth/callback',
    }
    emit('openUrlResult', failed)
    expect(screen.getByRole('alert').textContent).toContain(
      'callback must match localhost:1455/auth/callback',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss pending login' }))
    expect(h.hub.dismissOpenUrl).toHaveBeenCalledWith('s1', 'open-1')
  })

  it('removes the overlay when the remote callback completes', () => {
    render(<BrowserOpenOverlay />)
    emit('openUrl', request)
    emit('openUrlResult', {
      type: 'sessionOpenUrlResult',
      sessionId: asSessionId('s1'),
      requestId: 'open-1',
      status: 'completed',
      httpStatus: 200,
    } satisfies SessionOpenUrlResultMessage)

    expect(screen.queryByLabelText('Pending agent browser requests')).toBeNull()
    expect(h.toast.success).toHaveBeenCalledWith('Login callback forwarded')
  })

  it('shows no login card for a plain link and revokes the request on open', () => {
    const { opened, windowOpen } = captureOpens()
    render(<BrowserOpenOverlay />)
    const link: SessionOpenUrlMessage = {
      type: 'sessionOpenUrl',
      sessionId: asSessionId('s1'),
      requestId: 'open-2',
      url: 'https://claude.ai/code/artifact/abc?via=auto_preview',
      intent: 'link',
      expiresAt: Date.now() + 60_000,
    }
    emit('openUrl', link)

    expect(screen.queryByLabelText('Pending agent browser requests')).toBeNull()
    expect(h.toast).toHaveBeenCalledWith('Remote Codex wants to open claude.ai', expect.anything())

    const options = h.toast.mock.calls[0]?.[1] as { action: { onClick: () => void } }
    act(() => options.action.onClick())
    expect(opened).toEqual([{ href: link.url, target: '_blank', rel: 'noopener noreferrer' }])
    expect(h.hub.dismissOpenUrl).toHaveBeenCalledWith('s1', 'open-2')
    // The revoke is what stops the server re-offering this request on every
    // reconnect, so it must not hang off anything the browser can withhold —
    // `window.open`'s return value least of all. [POD-1283]
    expect(windowOpen).not.toHaveBeenCalled()
    expect(h.toast.error).not.toHaveBeenCalled()
    expect(h.toast.dismiss).toHaveBeenCalledWith('browser-open-s1:open-2')
  })

  it('keeps a login request pending after opening (fallback: callbackTarget implies login)', () => {
    captureOpens()
    render(<BrowserOpenOverlay />)
    emit('openUrl', request)
    const options = h.toast.mock.calls[0]?.[1] as { action: { onClick: () => void } }
    act(() => options.action.onClick())
    expect(h.hub.dismissOpenUrl).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Paste the localhost callback URL')).not.toBeNull()
  })
})
