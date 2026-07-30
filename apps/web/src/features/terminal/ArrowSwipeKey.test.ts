import { describe, expect, it } from 'vitest'
import {
  ArrowSwipeEngine,
  candidatePassesSwitchGate,
  computeUsableMaxes,
  distanceSpeedP,
  evaluateGeometry,
  firstRepeatDelayMs,
  isConstrainedDirection,
  repeatCps,
  type ArrowDirection,
} from './ArrowSwipeKey'

describe('evaluateGeometry', () => {
  it('stays neutral inside the activation deadzone', () => {
    expect(evaluateGeometry(4, 0, null).kind).toBe('neutral')
    expect(evaluateGeometry(0, 8, null).kind).toBe('neutral')
  })

  it('rejects diagonal ambiguity', () => {
    expect(evaluateGeometry(20, 18, null).kind).toBe('diagonalNeutral')
    expect(evaluateGeometry(-24, 22, null).kind).toBe('diagonalNeutral')
  })

  it('acquires cardinal directions with clear dominance', () => {
    expect(evaluateGeometry(24, 2, null)).toMatchObject({
      kind: 'directionActive',
      direction: 'right',
      axisDistance: 24,
    })
    expect(evaluateGeometry(-30, 4, null)).toMatchObject({
      kind: 'directionActive',
      direction: 'left',
    })
    expect(evaluateGeometry(1, 28, null)).toMatchObject({
      kind: 'directionActive',
      direction: 'up',
    })
    expect(evaluateGeometry(3, -26, null)).toMatchObject({
      kind: 'directionActive',
      direction: 'down',
    })
  })

  it('keeps an active direction with looser hysteresis', () => {
    expect(evaluateGeometry(12, 8, 'right').kind).toBe('directionActive')
    expect(evaluateGeometry(2, 7, 'up')).toMatchObject({
      kind: 'directionActive',
      direction: 'up',
    })
  })
})

describe('computeUsableMaxes', () => {
  it('clips right travel near the screen edge', () => {
    const maxes = computeUsableMaxes(360, 400, 400, 800)
    expect(maxes.right).toBe(30)
    expect(maxes.left).toBe(76)
    expect(maxes.up).toBe(60)
  })
})

describe('speed model', () => {
  it('ramps only after the precision zone', () => {
    expect(distanceSpeedP(20, 76)).toBe(0)
    expect(distanceSpeedP(31, 76)).toBe(0)
    expect(distanceSpeedP(76, 76)).toBeCloseTo(1, 2)
  })

  it('caps constrained horizontal distance speed before edge-hold', () => {
    const cps = repeatCps('right', 40, 44, true, false, 0)
    expect(cps).toBeLessThanOrEqual(8.5)
    expect(cps).toBeGreaterThan(2.5)
  })

  it('ramps to fast speed during edge-hold', () => {
    const slow = repeatCps('right', 40, 44, true, true, 300)
    const fast = repeatCps('right', 40, 44, true, true, 1200)
    expect(fast).toBeGreaterThan(slow)
    expect(fast).toBeCloseTo(15, 0)
  })

  it('uses conservative terminal vertical caps', () => {
    const up = repeatCps('up', 60, 60, false, false, 0)
    expect(up).toBeLessThanOrEqual(8.1)
  })
})

describe('firstRepeatDelayMs', () => {
  it('is slower near the key and faster farther out', () => {
    expect(firstRepeatDelayMs(0)).toBe(380)
    expect(firstRepeatDelayMs(1)).toBe(200)
    expect(firstRepeatDelayMs(0.5)).toBe(290)
  })
})

describe('candidatePassesSwitchGate', () => {
  it('requires stronger evidence than acquisition', () => {
    expect(candidatePassesSwitchGate(20, 12)).toBe(false)
    expect(candidatePassesSwitchGate(36, 10)).toBe(true)
  })
})

describe('isConstrainedDirection', () => {
  it('detects clipped right arenas', () => {
    expect(isConstrainedDirection(44)).toBe(true)
    expect(isConstrainedDirection(76)).toBe(false)
  })
})

describe('ArrowSwipeEngine', () => {
  const runGesture = (moves: Array<[number, number]>, end = true): ArrowDirection[] => {
    const emitted: ArrowDirection[] = []
    const engine = new ArrowSwipeEngine({
      onEmit: (d) => emitted.push(d),
      onVisualChange: () => {},
    })
    engine.touchDown(200, 400, 0, { x: 200, top: 370, width: 40 })
    let t = 10
    for (const [dx, dy] of moves) {
      engine.touchMove(200 + dx, 400 - dy, t)
      t += 16
    }
    if (end) engine.touchEnd(t)
    engine.dispose()
    return emitted
  }

  it('emits nothing on tap without movement', () => {
    expect(runGesture([])).toEqual([])
  })

  it('emits exactly one arrow on a short flick', () => {
    expect(runGesture([[18, 0]])).toEqual(['right'])
    expect(runGesture([[0, 20]])).toEqual(['up'])
  })

  it('emits nothing for diagonal swipes', () => {
    expect(runGesture([[20, 18]])).toEqual([])
  })

  it('does not emit on lift after a flick', () => {
    const emitted: ArrowDirection[] = []
    const engine = new ArrowSwipeEngine({
      onEmit: (d) => emitted.push(d),
      onVisualChange: () => {},
    })
    engine.touchDown(200, 400, 0, { x: 200, top: 370, width: 40 })
    engine.touchMove(220, 400, 16)
    engine.touchEnd(32)
    engine.dispose()
    expect(emitted).toEqual(['right'])
  })

  it('repeats when held in a direction', () => {
    const emitted: ArrowDirection[] = []
    const engine = new ArrowSwipeEngine({
      onEmit: (d) => emitted.push(d),
      onVisualChange: () => {},
    })
    engine.touchDown(200, 400, 0, { x: 200, top: 370, width: 40 })
    engine.touchMove(240, 400, 16)
    engine.advanceTime(500)
    engine.touchEnd(520)
    engine.dispose()
    expect(emitted.length).toBeGreaterThanOrEqual(2)
    expect(emitted[0]).toBe('right')
  })
})