import { describe, expect, it } from 'vitest'
import { ScreenModeTracker } from './screen-mode'

const ENTER = '\x1b[?1049h'
const LEAVE = '\x1b[?1049l'

describe('ScreenModeTracker', () => {
  it('starts in normal', () => {
    expect(new ScreenModeTracker().current).toBe('normal')
  })

  it('enters alternate on 1049h', () => {
    const tracker = new ScreenModeTracker()
    expect(tracker.write('prompt$ ')).toBe('normal')
    expect(tracker.write(`${ENTER}claude repaint`)).toBe('alternate')
    expect(tracker.current).toBe('alternate')
  })

  it('returns to normal on 1049l', () => {
    const tracker = new ScreenModeTracker()
    tracker.write(ENTER)
    expect(tracker.write(`back to shell${LEAVE}`)).toBe('normal')
  })

  it('entering twice stays alternate', () => {
    const tracker = new ScreenModeTracker()
    tracker.write(ENTER)
    expect(tracker.write(ENTER)).toBe('alternate')
    expect(tracker.current).toBe('alternate')
  })

  it('leaving without entering stays normal', () => {
    const tracker = new ScreenModeTracker()
    expect(tracker.write(LEAVE)).toBe('normal')
    expect(tracker.current).toBe('normal')
  })

  it.each(['\x1b[?1047h', '\x1b[?1047l'])('ignores the older 1047 switch (%j)', (sequence) => {
    const tracker = new ScreenModeTracker()
    tracker.write(ENTER)
    const before = tracker.current
    expect(tracker.write(sequence)).toBe(before)
  })

  it('ignores unrelated private modes', () => {
    const tracker = new ScreenModeTracker()
    expect(tracker.write('\x1b[?25l\x1b[?2004h')).toBe('normal')
    tracker.write(ENTER)
    expect(tracker.write('\x1b[?25h\x1b[?2004l')).toBe('alternate')
  })

  it('detects 1049 inside a multi-parameter set', () => {
    const tracker = new ScreenModeTracker()
    expect(tracker.write('\x1b[?1049;2004h')).toBe('alternate')
    expect(tracker.write('\x1b[?2004;1049l')).toBe('normal')
  })

  it('lets the last sequence in a chunk win', () => {
    expect(new ScreenModeTracker().write(`${ENTER}${LEAVE}`)).toBe('normal')
    expect(new ScreenModeTracker().write(`${LEAVE}${ENTER}`)).toBe('alternate')
  })

  it.each([ENTER, LEAVE])('detects %j split at every position across two chunks', (sequence) => {
    for (let at = 1; at < sequence.length; at += 1) {
      const tracker = new ScreenModeTracker()
      tracker.write(sequence.slice(0, at))
      expect(tracker.write(sequence.slice(at)), `split at ${at}`).toBe(
        sequence === ENTER ? 'alternate' : 'normal',
      )
    }
  })

  it('detects a sequence split across three chunks', () => {
    const tracker = new ScreenModeTracker()
    tracker.write('\x1b[')
    tracker.write('?104')
    expect(tracker.write('9h')).toBe('alternate')
  })

  it('accepts raw bytes as well as strings', () => {
    const tracker = new ScreenModeTracker()
    expect(tracker.write(Buffer.from(`output${ENTER}`, 'latin1'))).toBe('alternate')
    expect(tracker.write(Buffer.from(LEAVE, 'latin1'))).toBe('normal')
  })

  it('reset returns to a fresh normal with no carried tail', () => {
    const tracker = new ScreenModeTracker()
    tracker.write(ENTER)
    tracker.write('\x1b[?104')
    tracker.reset()
    expect(tracker.current).toBe('normal')
    // The carried partial sequence is gone: completing it must not transition.
    expect(tracker.write('9h')).toBe('normal')
  })
})
