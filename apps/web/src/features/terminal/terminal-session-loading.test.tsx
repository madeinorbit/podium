import { asSessionId } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => {
  const setActive = vi.fn()
  const dispose = vi.fn()
  const mountSession = vi.fn(() => ({
    connection: { state: () => ({ connected: true }) },
    view: {
      onScroll: () => () => {},
      atBottom: () => true,
      focus: vi.fn(),
    },
    setActive,
    setAppearance: vi.fn(),
    setEchoLatencyEnabled: vi.fn(),
    dispose,
  }))
  return { importAttempts: 0, loaded: vi.fn(), mountSession, setActive, dispose }
})

vi.mock('@podium/terminal-client/session-mount', () => {
  runtime.loaded()
  runtime.importAttempts += 1
  if (runtime.importAttempts === 1) throw new Error('transient chunk failure')
  return { mountSession: runtime.mountSession }
})

const { preloadTerminalRuntime, useTerminalSession } = await import('@podium/terminal-client-react')

const hub = {} as never
const sessionId = asSessionId('terminal-lazy-test')

function Probe({ enabled, active }: { enabled: boolean; active: boolean }) {
  const { containerRef } = useTerminalSession({ hub, sessionId, enabled, active })
  return <div ref={containerRef} />
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useTerminalSession lazy runtime', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('recovers a rejected deferred import and reuses the recovered mount', async () => {
    expect(runtime.loaded).not.toHaveBeenCalled()
    expect(runtime.mountSession).not.toHaveBeenCalled()

    vi.useFakeTimers()
    await act(async () => root.render(<Probe enabled active />))
    await flush()
    expect(runtime.loaded).toHaveBeenCalledTimes(1)
    expect(runtime.mountSession).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(250))
    await flush()
    expect(runtime.loaded).toHaveBeenCalledTimes(2)
    expect(runtime.mountSession).toHaveBeenCalledTimes(1)

    preloadTerminalRuntime()
    await flush()
    expect(runtime.loaded).toHaveBeenCalledTimes(2)
    expect(runtime.mountSession).toHaveBeenCalledTimes(1)

    await act(async () => root.render(<Probe enabled active={false} />))
    await flush()
    expect(runtime.setActive).toHaveBeenCalledWith(false)
    expect(runtime.mountSession).toHaveBeenCalledTimes(1)
    expect(runtime.dispose).not.toHaveBeenCalled()

    await act(async () => root.render(<Probe enabled={false} active={false} />))
    await flush()
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })
})
