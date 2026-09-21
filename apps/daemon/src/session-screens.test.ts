/**
 * One TerminalScreen per SESSION, not per attachment (P2c DONE WHEN 3).
 *
 * The daemon map holds the screen; attachments (bridges) come and go. A
 * detach removes the bridge but never the screen, so the reattach that
 * follows resumes feeding the SAME object — model, mode and applied size
 * intact. Readers (composer, observer) hold the shared model without owning
 * it: detaching a reader never kills the session's screen.
 */

import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './control/context'
import {
  forgetSessionScreen,
  sessionScreenFor,
  terminalScreenFor,
  trackSessionOutput,
  trackSessionSize,
} from './session-screens'
import { ComposerSyncEngine } from './composer-sync'
import { createTerminalScreenObserver } from './terminal-screen-observer'

const SESSION = asSessionId('33333333-3333-4333-8333-333333333333')
const ENTER_ALT = '\x1b[?1049h'

function ctxWith(): DaemonContext {
  return {
    sessions: testSessions(),
    send: vi.fn(),
    outputScheduler: {
      enqueue: vi.fn(),
      flushNow: vi.fn(),
      remove: vi.fn(),
      setPriority: vi.fn(),
    },
    observers: {},
    composerEngine: { has: () => false, onData: () => {}, onResize: () => {}, detach: () => {} },
  } as unknown as DaemonContext
}

describe('session screens survive detach and reattach', () => {
  it('hands back the SAME screen object across feeds, with state intact', async () => {
    const ctx = ctxWith()
    trackSessionSize(ctx, SESSION, 80, 24)
    const first = terminalScreenFor(ctx, SESSION)
    trackSessionOutput(ctx, SESSION, Buffer.from(`${ENTER_ALT}Agent TUI frame`, 'latin1'))
    await first.flush()

    // DETACH: the bridge is gone, but nothing forgets the screen.
    // (forgetSessionScreen runs only on the bridge-exit path.)
    expect(sessionScreenFor(ctx, SESSION)?.screen).toBe(first)

    // REATTACH: the next attachment feeds the same screen; the alternate
    // canvas, its 80x24 grid and its content are all still there.
    const second = terminalScreenFor(ctx, SESSION)
    expect(second).toBe(first)
    expect(second.mode).toBe('alternate')
    expect(second.appliedSize).toEqual({ cols: 80, rows: 24 })
    trackSessionOutput(ctx, SESSION, Buffer.from(' + live', 'latin1'))
    await second.flush()
    const snapshot = second.snapshotFirstFrame().toString('latin1')
    expect(snapshot).toContain('Agent TUI frame')
    expect(snapshot).toContain('live')
  })

  it('forgets only on session exit, never on detach', async () => {
    const ctx = ctxWith()
    trackSessionOutput(ctx, SESSION, Buffer.from('output', 'latin1'))
    const screen = terminalScreenFor(ctx, SESSION)
    await screen.flush()
    expect(sessionScreenFor(ctx, SESSION)).toBeDefined()
    forgetSessionScreen(ctx, SESSION)
    expect(sessionScreenFor(ctx, SESSION)).toBeUndefined()
    // A later session id starts fresh, not on the dead screen.
    expect(terminalScreenFor(ctx, SESSION)).not.toBe(screen)
  })

  it('a composer sharing the model scrapes it and detaches without killing it', async () => {
    const ctx = ctxWith()
    trackSessionSize(ctx, SESSION, 40, 6)
    const screen = terminalScreenFor(ctx, SESSION)
    trackSessionOutput(
      ctx,
      SESSION,
      Buffer.from('╭────────────╮\r\n│ > hi there │\r\n╰────────────╯\r\n'),
    )
    await screen.flush()

    const published: string[] = []
    const engine = new ComposerSyncEngine((_id, text) => published.push(text))
    expect(engine.attach(SESSION, 'claude-code', 40, 6, screen.model)).toBe(true)
    // The engine reads the shared model: drive one scrape synchronously and
    // the composer text painted by the session feed is what publishes.
    const sync = (
      engine as unknown as { sessions: Map<string, { scrape(): void }> }
    ).sessions.get(SESSION)!
    sync.scrape()
    expect(published).toEqual(['hi there'])
    engine.detach(SESSION)
    // Detaching the reader leaves the session's screen alive and readable.
    expect(screen.alive).toBe(true)
    expect(screen.lines(false).join('\n')).toContain('hi there')
    engine.disposeAll()
    expect(screen.alive).toBe(true)
    screen.dispose()
  })

  it('an observer sharing the model classifies without owning it', async () => {
    const ctx = ctxWith()
    trackSessionSize(ctx, SESSION, 80, 24)
    const screen = terminalScreenFor(ctx, SESSION)
    const provider = {
      instrumentation: () => ({ args: [] }),
      translate: async () => [],
      screen: () => ({ events: [], interactionVisible: false }),
    }
    const observer = createTerminalScreenObserver(
      provider,
      { cols: 80, rows: 24 },
      { onStateEvents: () => {}, onLoginSignal: () => {} },
      screen.model,
    )
    expect(observer).toBeDefined()
    observer!.onData(Buffer.from('bytes the shared feed already painted', 'latin1'))
    observer!.onResize(120, 40)
    await screen.flush()
    // A viewer ask through a non-owning reader must never re-grid the
    // program's canvas.
    expect(screen.appliedSize).toEqual({ cols: 80, rows: 24 })
    observer!.dispose()
    // Disposing the reader leaves the session's screen alive.
    expect(screen.alive).toBe(true)
    screen.dispose()
  })
})
