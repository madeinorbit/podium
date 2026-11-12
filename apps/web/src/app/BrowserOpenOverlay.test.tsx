import { asSessionId } from '@podium/model'
import type { SessionOpenUrlMessage, SessionOpenUrlResultMessage } from '@podium/protocol'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
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
  const resolveSession = vi.fn(() => ({
    sessionId: 's1',
    name: 'Remote Codex',
    title: '',
    agentKind: 'codex',
  }))
  return { handlers, hub, toast, resolveSession }
})

vi.mock('./shell-data', () => ({
  useShellActions: () => ({ hub: h.hub }),
  useShellSessionResolver: () => h.resolveSession,
}))

vi.mock('sonner', () => ({ toast: h.toast }))

const { BrowserOpenOverlay } = await import('./BrowserOpenOverlay')

function emit(kind: 'openUrl' | 'openUrlResult', message: unknown): void {
  act(() => {
    for (const handler of h.handlers.get(kind) ?? []) handler(message as never)
  })
}

afterEach(cleanup)

/** The toast's action is a node (copy + Open); render it and click a button by name. */
function clickToastButton(name: string, call = 0): void {
  const options = h.toast.mock.calls[call]?.[1] as { action: ReactElement }
  const { container } = render(options.action)
  act(() => fireEvent.click(within(container).getByRole('button', { name })))
}

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(() => Promise.resolve())
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

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
    expect(h.resolveSession).not.toHaveBeenCalled()
    emit('openUrl', request)
    expect(h.resolveSession).toHaveBeenCalledExactlyOnceWith(request.sessionId)

    expect(h.toast).toHaveBeenCalledWith(
      'Remote Codex wants to open auth.example',
      expect.objectContaining({ action: expect.anything() }),
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

    clickToastButton('Open')
    expect(opened).toEqual([{ href: link.url, target: '_blank', rel: 'noopener noreferrer' }])
    expect(h.hub.dismissOpenUrl).toHaveBeenCalledWith('s1', 'open-2')
    // The revoke is what stops the server re-offering this request on every
    // reconnect, so it must not hang off anything the browser can withhold —
    // `window.open`'s return value least of all. [POD-1283]
    expect(windowOpen).not.toHaveBeenCalled()
    expect(h.toast.error).not.toHaveBeenCalled()
    expect(h.toast.dismiss).toHaveBeenCalledWith('browser-open-s1:open-2')
  })

  it('copies the sign-in link from the login card without opening it', async () => {
    const { opened } = captureOpens()
    const writeText = stubClipboard()
    render(<BrowserOpenOverlay />)
    emit('openUrl', request)

    fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith(request.url)
    await vi.waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Sign-in link copied'))
    expect(opened).toEqual([])
    expect(h.hub.dismissOpenUrl).not.toHaveBeenCalled()
  })

  it('copies the URL from the toast and leaves the request open', async () => {
    const { opened } = captureOpens()
    const writeText = stubClipboard()
    render(<BrowserOpenOverlay />)
    emit('openUrl', { ...request, requestId: 'open-3', intent: 'link', callbackTarget: undefined })

    clickToastButton('Copy link')
    expect(writeText).toHaveBeenCalledExactlyOnceWith(request.url)
    await vi.waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Link copied'))
    expect(opened).toEqual([])
    expect(h.hub.dismissOpenUrl).not.toHaveBeenCalled()
    expect(h.toast.dismiss).not.toHaveBeenCalled()
  })

  it('keeps a login request pending after opening (fallback: callbackTarget implies login)', () => {
    captureOpens()
    render(<BrowserOpenOverlay />)
    emit('openUrl', request)
    clickToastButton('Open')
    expect(h.hub.dismissOpenUrl).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Paste the localhost callback URL')).not.toBeNull()
  })
})
