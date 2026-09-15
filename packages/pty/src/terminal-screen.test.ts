/**
 * TerminalScreen survives detach and reattach (P2c DONE WHEN 3).
 *
 * A screen belongs to the SESSION; the attachment is merely the current way
 * of reaching it. Attach and you get an AgentSession-like frame source;
 * detach and it is gone — but the screen (model, mode, applied size, byte
 * log, title) stays, and the next attachment resumes feeding the SAME screen.
 * No SessionId, no daemon, no protocol anywhere in this file.
 */

import { describe, expect, it } from 'vitest'
import { TerminalScreen, type TerminalScreenFrame } from './terminal-screen.js'

const ENTER_ALT = '\x1b[?1049h'
const LEAVE_ALT = '\x1b[?1049l'

/** A fake attachment: the test decides exactly which frames it emits. */
function fakeAttachment() {
  const cbs = new Set<(frame: TerminalScreenFrame) => void>()
  let seq = 0
  return {
    emit(data: string | Uint8Array): void {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
      const frame = { seq, data: bytes }
      seq += 1
      for (const cb of [...cbs]) cb(frame)
    },
    onFrame(cb: (frame: TerminalScreenFrame) => void): () => void {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
  }
}

describe('TerminalScreen per-session survival', () => {
  it('keeps model, mode, applied size and log across a detach/reattach cycle', async () => {
    const screen = new TerminalScreen({ cols: 80, rows: 24 })
    screen.setAppliedSize(80, 24)

    // First attachment paints an alternate-screen TUI frame.
    const first = fakeAttachment()
    const detach = screen.attach(first)
    first.emit(ENTER_ALT)
    first.emit('\x1b[HAgent TUI frame')
    await screen.flush()
    expect(screen.mode).toBe('alternate')
    const before = screen.snapshotFirstFrame().toString('latin1')
    expect(before).toContain('Agent TUI frame')

    // Detach: the attachment is gone. Frames it emits afterwards never reach
    // the screen, and everything the screen held is still there.
    detach()
    first.emit('stale bytes from a dead attachment')
    await screen.flush()
    expect(screen.mode).toBe('alternate')
    expect(screen.appliedSize).toEqual({ cols: 80, rows: 24 })
    expect(screen.snapshotFirstFrame().toString('latin1')).toBe(before)
    // The byte log still ends at the live frame, not the stale bytes.
    expect(Buffer.from(screen.tailBytes(15)).toString('latin1')).toBe('Agent TUI frame')

    // Reattach: a new attachment resumes the SAME screen, which still knows
    // the program is on its alternate canvas at 80x24.
    const second = fakeAttachment()
    screen.attach(second)
    expect(screen.mode).toBe('alternate')
    expect(screen.appliedSize).toEqual({ cols: 80, rows: 24 })
    second.emit(' + live update')
    await screen.flush()
    const after = screen.snapshotFirstFrame().toString('latin1')
    expect(after).toContain('Agent TUI frame')
    expect(after).toContain('live update')
    // Same-size alternate reconstitutes from the model, never replays stale bytes.
    expect(
      screen.decideReopen({
        viewerSize: { cols: 80, rows: 24 },
        ringReplayable: true,
        replayRequired: true,
      }),
    ).toEqual({ kind: 'snapshot-then-live' })
    screen.dispose()
  })

  it('leaving the alternate screen on a later attachment moves the same screen back', async () => {
    const screen = new TerminalScreen({ cols: 80, rows: 24 })
    const first = fakeAttachment()
    screen.attach(first)
    first.emit(ENTER_ALT)
    await screen.flush()
    expect(screen.mode).toBe('alternate')

    const second = fakeAttachment()
    screen.attach(second)
    second.emit(`back to shell${LEAVE_ALT}`)
    await screen.flush()
    expect(screen.mode).toBe('normal')
    expect(
      screen.decideReopen({
        viewerSize: { cols: 80, rows: 24 },
        ringReplayable: false,
        replayRequired: false,
      }),
    ).toEqual({ kind: 'repaint-only' })
    screen.dispose()
  })

  it('exposes ONE model: readers of `model` see exactly what `lines` sees', async () => {
    const screen = new TerminalScreen({ cols: 40, rows: 6 })
    screen.push(Buffer.from('shared content\r\n', 'latin1'))
    await screen.flush()
    // Identity, not equality: the composer and the observer hold this same
    // object, so no second emulator is constructed anywhere.
    expect(screen.model).toBe(screen.model)
    expect(screen.model.lines(false).join('\n')).toContain('shared content')
    expect(screen.lines(false).join('\n')).toContain('shared content')
    screen.dispose()
  })

  it('a different-size viewer resizes first with the model as placeholder', () => {
    const screen = new TerminalScreen({ cols: 80, rows: 24 })
    screen.setAppliedSize(80, 24)
    screen.push(Buffer.from(`${ENTER_ALT}frame`, 'latin1'))
    expect(
      screen.decideReopen({
        viewerSize: { cols: 40, rows: 24 },
        ringReplayable: true,
        replayRequired: true,
      }),
    ).toEqual({ kind: 'resize-repaint-with-placeholder' })
    screen.dispose()
  })

  it('bounds the byte log to its window', () => {
    const screen = new TerminalScreen({ cols: 80, rows: 24, byteLogBytes: 16 })
    screen.push(Buffer.from('0123456789abcdef', 'latin1'))
    screen.push(Buffer.from('GHIJ', 'latin1'))
    expect(screen.bufferedBytes).toBeLessThanOrEqual(16)
    expect(Buffer.from(screen.tailBytes(20)).toString('latin1')).toBe('456789abcdefGHIJ')
    screen.dispose()
  })

  it('emits the OSC title it scanned, once per change, across attachments', () => {
    const screen = new TerminalScreen({ cols: 80, rows: 24 })
    const titles: string[] = []
    screen.onTitle((t) => titles.push(t))
    const first = fakeAttachment()
    screen.attach(first)
    first.emit('\x1b]0;first title\x07output')
    first.emit('\x1b]0;first title\x07repeat')
    expect(titles).toEqual(['first title'])
    const second = fakeAttachment()
    screen.attach(second)
    second.emit('\x1b]2;second title\x07')
    expect(titles).toEqual(['first title', 'second title'])
    screen.dispose()
  })
})
