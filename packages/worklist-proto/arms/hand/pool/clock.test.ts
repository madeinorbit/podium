/**
 * POD-4578 (Ha1) — the deadline clock: `now` is the one plain field read
 * inside cells, so both directions of every answer must dirty the reader.
 */

import { describe, expect, it } from 'vitest'
import { CellGraph, sameData } from './cells'
import { DeadlineClock, nextUp } from './clock'

function rig(now: number, ...deadlines: number[]) {
  const graph = new CellGraph()
  const clock = new DeadlineClock(graph, now)
  const runs: number[] = []
  const cells = deadlines.map((t, i) =>
    graph.cell(`at:${t}`, () => {
      runs.push(i)
      return { reached: clock.reached(t), passed: clock.passed(t) }
    }, sameData),
  )
  const read = () => cells.map((cell) => graph.read(cell))
  const move = (to: number) => {
    runs.length = 0
    clock.move(to)
    graph.flush()
  }
  return { graph, clock, cells, runs, read, move }
}

describe('deadline clock', () => {
  it('a forward move dirties exactly the deadlines it crosses, inclusive of the new time', () => {
    const r = rig(0, 10, 20, 30)
    expect(r.read().map((v) => v.reached)).toEqual([false, false, false])
    expect(r.clock.waiting).toBe(6) // each asks reached(t) and reached(nextUp(t))
    r.move(20)
    expect(r.runs.sort()).toEqual([0, 1])
    expect(r.read()).toEqual([
      { reached: true, passed: true },
      { reached: true, passed: false },
      { reached: false, passed: false },
    ])
    r.move(nextUp(20))
    expect(r.runs).toEqual([1])
    expect(r.read()[1]).toEqual({ reached: true, passed: true })
    r.move(25)
    expect(r.runs).toEqual([])
  })

  it('a rewind dirties the same deadlines back, with no second path', () => {
    const r = rig(100, 10, 50, 150)
    expect(r.read().map((v) => v.reached)).toEqual([true, true, false])
    r.move(30)
    expect(r.runs).toEqual([1])
    expect(r.read().map((v) => v.reached)).toEqual([true, false, false])
    r.move(10)
    expect(r.runs).toEqual([0])
    expect(r.read()[0]).toEqual({ reached: true, passed: false })
  })

  it('forgets a deadline when its last reader stops asking', () => {
    const r = rig(0, 10)
    r.read()
    expect(r.clock.waiting).toBe(2)
    r.graph.dispose(r.cells[0]!)
    expect(r.clock.waiting).toBe(0)
    expect(r.clock.index.size).toBe(0)
  })
})
