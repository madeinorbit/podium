import {
  type AgentStateProvider,
  type ProviderAgentStateEvent,
  withStateChannelEvent,
} from '@podium/harness'
import { describe, expect, it, vi } from 'vitest'
import {
  createTerminalScreenObserver,
  TERMINAL_SCREEN_COALESCE_MS,
} from './terminal-screen-observer'
import type { ScreenReader } from './composer-sync'

function fakeScreen(): ScreenReader & { setLines(lines: string[]): void } {
  let current: string[] = []
  return {
    write: () => {},
    resize: () => {},
    lines: () => current,
    flush: async () => {},
    dispose: vi.fn(),
    setLines: (lines) => {
      current = lines
    },
  }
}

function providerFor(): AgentStateProvider {
  return {
    instrumentation: () => ({ args: [] }),
    translate: async () => [],
    screen: (lines) => ({
      events: lines.includes('prompt')
        ? [
            withStateChannelEvent(
              { kind: 'needs_user', need: 'question' },
              'classifier',
            ),
          ]
        : [],
      interactionVisible: lines.includes('prompt'),
      ...(lines.some((line) => line.includes('Login successful'))
        ? { auth: 'logged-in' as const }
        : {}),
    }),
  }
}

describe('event-driven terminal screen observer', () => {
  it('coalesces PTY bursts and emits one login signal for the observed transition', async () => {
    vi.useFakeTimers()
    try {
      const screen = fakeScreen()
      const stateEvents: ProviderAgentStateEvent[][] = []
      const onLoginSignal = vi.fn()
      const observer = createTerminalScreenObserver(
        providerFor(),
        { cols: 80, rows: 24 },
        { onStateEvents: (events) => stateEvents.push(events), onLoginSignal },
        screen,
      )
      if (!observer) throw new Error('screen classifier should create an observer')

      screen.setLines(['Login successful'])
      observer.onData(new Uint8Array([1]))
      observer.onData(new Uint8Array([2]))
      await vi.advanceTimersByTimeAsync(TERMINAL_SCREEN_COALESCE_MS - 1)
      expect(stateEvents).toEqual([])
      expect(onLoginSignal).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      expect(onLoginSignal).toHaveBeenCalledOnce()

      screen.setLines(['Login successful', 'new output'])
      observer.onData(new Uint8Array([3]))
      await vi.advanceTimersByTimeAsync(TERMINAL_SCREEN_COALESCE_MS)
      expect(onLoginSignal).toHaveBeenCalledOnce()
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a classifier-created prompt when its terminal modal disappears', async () => {
    vi.useFakeTimers()
    try {
      const screen = fakeScreen()
      const stateEvents: ProviderAgentStateEvent[][] = []
      const observer = createTerminalScreenObserver(
        providerFor(),
        { cols: 80, rows: 24 },
        {
          onStateEvents: (events) => stateEvents.push(events),
          onLoginSignal: () => {},
        },
        screen,
      )
      if (!observer) throw new Error('screen classifier should create an observer')

      screen.setLines(['prompt'])
      observer.onData(new Uint8Array([1]))
      await vi.advanceTimersByTimeAsync(TERMINAL_SCREEN_COALESCE_MS)
      expect(stateEvents[0]?.[0]).toMatchObject({ kind: 'needs_user' })

      screen.setLines(['normal'])
      observer.onData(new Uint8Array([2]))
      await vi.advanceTimersByTimeAsync(TERMINAL_SCREEN_COALESCE_MS)
      expect(stateEvents.at(-1)).toEqual([
        { kind: 'session_started', source: 'classifier', confidence: 0.3 },
      ])
      observer.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
