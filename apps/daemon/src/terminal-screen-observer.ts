/**
 * Event-driven native-terminal observation.
 *
 * This is a VT emulator, not a headless Claude session: the real interactive
 * PTY remains the only agent process. The daemon mirrors its output into one
 * bounded screen per provider that opts in, coalesces a burst of frames, and
 * asks the provider to classify only when the rendered screen changed.
 */

import type {
  AgentScreenObservation,
  AgentStateProvider,
  ProviderAgentStateEvent,
} from '@podium/harness'
import type { Geometry } from '@podium/model'
import { createHeadlessScreen, type ScreenReader } from './composer-sync'

export const TERMINAL_SCREEN_COALESCE_MS = 60

export interface TerminalScreenObserverCallbacks {
  onStateEvents: (events: ProviderAgentStateEvent[]) => void
  onLoginSignal: () => void
}

export interface TerminalScreenObserver {
  onData(data: Uint8Array): void
  onResize(cols: number, rows: number): void
  dispose(): void
}

/**
 * Construct the screen mirror for one session. Providers that do not expose a
 * screen classifier cost nothing: callers skip construction for them.
 */
export function createTerminalScreenObserver(
  provider: AgentStateProvider,
  geometry: Geometry,
  callbacks: TerminalScreenObserverCallbacks,
  screen?: ScreenReader,
): TerminalScreenObserver | undefined {
  if (!provider.screen) return undefined
  const screenReader = screen ?? createHeadlessScreen(geometry.cols, geometry.rows)

  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastScreen: string | undefined
  let interactionVisible = false
  let authSignaled = false

  const classify = async (): Promise<void> => {
    timer = undefined
    if (disposed) return
    try {
      // xterm parses writes asynchronously. The empty write callback is the
      // existing ScreenReader flush seam and avoids racing a split escape
      // sequence or a partially painted modal.
      await screenReader.flush()
      if (disposed) return
      const lines = screenReader.lines(false)
      const signature = lines.join('\n')
      if (signature === lastScreen) return
      lastScreen = signature

      const observation: AgentScreenObservation | undefined = provider.screen?.(lines)
      if (!observation) return

      const events = [...observation.events]
      if (observation.interactionVisible !== undefined) {
        if (interactionVisible && !observation.interactionVisible && events.length === 0) {
          // The modal is gone and no hook exists for this onboarding flow. The
          // established state reducer treats SessionStart as an idle boundary;
          // it clears the synthetic needs_user payload without inventing an
          // answer or a second interaction protocol.
          events.push({
            kind: 'session_started',
            source: 'classifier',
            confidence: 0.3,
          })
        }
        interactionVisible = observation.interactionVisible
      }
      if (events.length > 0) callbacks.onStateEvents(events)
      if (observation.auth === 'logged-in' && !authSignaled) {
        authSignaled = true
        callbacks.onLoginSignal()
      }
    } catch {
      // A malformed/incomplete PTY sequence must never affect the live bridge.
      // The next output frame will provide another complete screen to classify.
    }
  }

  const schedule = (): void => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => void classify(), TERMINAL_SCREEN_COALESCE_MS)
    timer.unref?.()
  }

  return {
    onData(data) {
      if (disposed) return
      screenReader.write(data)
      schedule()
    },
    onResize(cols, rows) {
      if (disposed) return
      screenReader.resize(cols, rows)
      schedule()
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      screenReader.dispose()
    },
  }
}
