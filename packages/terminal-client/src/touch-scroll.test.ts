// packages/terminal-client/src/touch-scroll.test.ts
import { describe, expect, it } from 'vitest'
import { TouchScrollEngine, type TouchScrollTerminal } from './touch-scroll'

const ROW = 20

/** A terminal stub that records the wheel notches the engine emits. */
/** Defaults to the case the fix exists for: the application owns the mouse. */
function stub(opts: { mouse?: boolean; alt?: boolean; row?: number; sensitivity?: number } = {}): {
  term: TouchScrollTerminal
  wheels: { deltaY: number; x: number; y: number }[]
} {
  const wheels: { deltaY: number; x: number; y: number }[] = []
  return {
    wheels,
    term: {
      appOwnsMouse: () => opts.mouse ?? true,
      altBuffer: () => opts.alt ?? false,
      rowHeight: () => opts.row ?? ROW,
      sensitivity: () => opts.sensitivity ?? 1,
      wheel: (deltaY, x, y) => wheels.push({ deltaY, x, y }),
    },
  }
}

/** Drag from y=400 upward by `travel` pixels in `steps` frames. */
function drag(engine: TouchScrollEngine, travel: number, steps = 1, x = 100): boolean[] {
  const consumed: boolean[] = []
  engine.down(x, 400)
  for (let i = 1; i <= steps; i++) consumed.push(engine.move(x, 400 - (travel * i) / steps))
  return consumed
}

describe('TouchScrollEngine', () => {
  it('stays out of the way when xterm can touch-scroll itself', () => {
    // No application mouse tracking and a normal buffer: xterm's own touch
    // handler works there, and it scrolls pixel-smooth — leave the gesture to it.
    const { term, wheels } = stub({ mouse: false, alt: false })
    const engine = new TouchScrollEngine(term)
    expect(drag(engine, 100)).toEqual([false])
    expect(wheels).toEqual([])
    expect(engine.end()).toBe(false)
  })

  it('scrolls in the alternate screen with no mouse tracking (pagers, vim)', () => {
    const { term, wheels } = stub({ mouse: false, alt: true })
    const engine = new TouchScrollEngine(term)
    drag(engine, 2 * ROW)
    expect(wheels).toHaveLength(2)
  })

  it('decides ownership at touch-down, so a mode flip cannot split a gesture', () => {
    let mouse = true
    const wheels: number[] = []
    const engine = new TouchScrollEngine({
      appOwnsMouse: () => mouse,
      altBuffer: () => false,
      rowHeight: () => ROW,
      sensitivity: () => 1,
      wheel: (deltaY) => wheels.push(deltaY),
    })
    engine.down(100, 400)
    mouse = false
    expect(engine.move(100, 400 - ROW)).toBe(true)
    expect(wheels).toHaveLength(1)
  })

  it('turns a finger drag into wheel notches, one per row of travel', () => {
    const { term, wheels } = stub()
    const engine = new TouchScrollEngine(term)
    expect(drag(engine, 3 * ROW)).toEqual([true])
    // Finger up = content scrolls down = positive wheel delta.
    expect(wheels.map((w) => w.deltaY)).toEqual([ROW, ROW, ROW])
    expect(engine.end()).toBe(true)
  })

  it('sends the notch at the touch point so the app can route it', () => {
    const { term, wheels } = stub()
    const engine = new TouchScrollEngine(term)
    engine.down(240, 400)
    engine.move(240, 400 - ROW)
    expect(wheels[0]).toMatchObject({ x: 240, y: 400 - ROW })
  })

  it('pre-divides the delta by xterm scrollSensitivity so a row of travel is a line', () => {
    const { term, wheels } = stub({ sensitivity: 3 })
    const engine = new TouchScrollEngine(term)
    drag(engine, ROW)
    expect(wheels.map((w) => w.deltaY)).toEqual([ROW / 3])
  })

  it('scrolls the other way when the finger moves down', () => {
    const { term, wheels } = stub()
    const engine = new TouchScrollEngine(term)
    engine.down(100, 100)
    engine.move(100, 100 + 2 * ROW)
    expect(wheels.map((w) => w.deltaY)).toEqual([-ROW, -ROW])
  })

  it('pays out partial rows across frames instead of dropping them', () => {
    const { term, wheels } = stub()
    const engine = new TouchScrollEngine(term)
    drag(engine, 2 * ROW, 8) // 5px per frame
    expect(wheels).toHaveLength(2)
  })

  it('ignores a horizontal drag — that is the application’s gesture', () => {
    const { term, wheels } = stub()
    const engine = new TouchScrollEngine(term)
    engine.down(100, 400)
    expect(engine.move(300, 402)).toBe(false)
    expect(wheels).toEqual([])
    expect(engine.end()).toBe(false)
  })

  it('ignores a tap: below the slop nothing is consumed or scrolled', () => {
    const { term, wheels } = stub()
    const engine = new TouchScrollEngine(term)
    engine.down(100, 400)
    expect(engine.move(100, 397)).toBe(false)
    expect(wheels).toEqual([])
    // A tap must stay a tap — the caller leaves the touch to xterm, which turns
    // it into the click the application expects.
    expect(engine.end()).toBe(false)
  })

  it('caps the reports a single fling frame can emit', () => {
    const { term, wheels } = stub()
    const engine = new TouchScrollEngine(term)
    drag(engine, 40 * ROW)
    expect(wheels).toHaveLength(8)
  })

  it('does nothing when the row height is unmeasurable (unmounted pane)', () => {
    const { term, wheels } = stub({ row: 0 })
    const engine = new TouchScrollEngine(term)
    expect(drag(engine, 100)).toEqual([false])
    expect(wheels).toEqual([])
  })
})
