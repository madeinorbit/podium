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
      sessions: [{ sessionId: 's1', name: 'Remote Codex', title: '', agentKind: 'codex' }],
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
  sessionId: 's1',
  requestId: 'open-1',
  url: 'https://auth.example/authorize',
  callbackTarget: { host: 'localhost', port: 1455, path: '/auth/callback' },
  expiresAt: Date.now() + 60_000,
}

describe('BrowserOpenOverlay', () => {
  beforeEach(() => {
    h.handlers.clear()
    vi.clearAllMocks()
  })

  it('requires a user click to open and keeps the callback paste-back affordance', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    render(<BrowserOpenOverlay />)
    emit('openUrl', request)

    expect(h.toast).toHaveBeenCalledWith(
      'Remote Codex wants to open auth.example',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open' }) }),
    )
    expect(open).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open login page' }))
    expect(open).toHaveBeenCalledWith(request.url, '_blank', 'noopener,noreferrer')
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
      sessionId: 's1',
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
      sessionId: 's1',
      requestId: 'open-1',
      status: 'completed',
      httpStatus: 200,
    } satisfies SessionOpenUrlResultMessage)

    expect(screen.queryByLabelText('Pending agent browser requests')).toBeNull()
    expect(h.toast.success).toHaveBeenCalledWith('Login callback forwarded')
  })

  it('shows no login card for a plain link and revokes the request on open', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    render(<BrowserOpenOverlay />)
    const link: SessionOpenUrlMessage = {
      type: 'sessionOpenUrl',
      sessionId: 's1',
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
    expect(open).toHaveBeenCalledWith(link.url, '_blank', 'noopener,noreferrer')
    expect(h.hub.dismissOpenUrl).toHaveBeenCalledWith('s1', 'open-2')
  })

  it('keeps a login request pending after opening (fallback: callbackTarget implies login)', () => {
    vi.spyOn(window, 'open').mockReturnValue({} as Window)
    render(<BrowserOpenOverlay />)
    emit('openUrl', request)
    const options = h.toast.mock.calls[0]?.[1] as { action: { onClick: () => void } }
    act(() => options.action.onClick())
    expect(h.hub.dismissOpenUrl).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Paste the localhost callback URL')).not.toBeNull()
  })
})
