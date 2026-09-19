import { describe, expect, it, vi } from 'vitest'
import { createComputedGraph } from './computed'

describe('shared computed graph', () => {
  it('does not lose notifications in a diamond and stops equal intermediate values', () => {
    const graph = createComputedGraph(), counts = { base: 0, left: 0, right: 0, root: 0 }
    let value = 0
    const base = graph.cell('base', 'a', () => { counts.base++; return graph.input('x', () => Math.floor(value / 2)) })
    const left = graph.cell('left', 'a', () => { counts.left++; return base.getSnapshot() + 1 })
    const right = graph.cell('right', 'a', () => { counts.right++; return base.getSnapshot() + 2 })
    const root = graph.cell('root', 'a', () => { counts.root++; return left.getSnapshot() + right.getSnapshot() })
    const rootListener = vi.fn(), rightListener = vi.fn()
    const off = [root.subscribe(rootListener), right.subscribe(rightListener)]
    value = 1; graph.invalidate(['x'])
    expect(counts).toEqual({ base: 2, left: 1, right: 1, root: 1 }); expect(rootListener).not.toHaveBeenCalled()
    value = 2; graph.invalidate(['x'])
    expect(counts).toEqual({ base: 3, left: 2, right: 2, root: 2 })
    expect(rootListener).toHaveBeenCalledOnce(); expect(rightListener).toHaveBeenCalledOnce()
    off.forEach(fn => fn()); expect(graph.stats().nodes).toBe(0)
    graph.destroy()
  })

  it('releases obsolete dynamic dependencies and failed reads, and supports retained handles', () => {
    const graph = createComputedGraph(1)
    let selected = 'a', values: Record<string, number> = { a: 1, b: 2 }
    const root = graph.cell('root', 'owner', () => {
      const id = graph.input('selection', () => selected)
      return graph.cell(id, id, () => graph.input(id, () => values[id])).getSnapshot()
    })
    const listener = vi.fn(), off = root.subscribe(listener)
    selected = 'b'; graph.invalidate(['selection']); expect(root.getSnapshot()).toBe(2)
    values.a = 3; graph.invalidate(['a']); expect(listener).toHaveBeenCalledOnce()
    expect(graph.stats().nodes).toBe(2)
    off(); expect(graph.stats().nodes).toBe(0)
    const bad = graph.cell('bad', 'bad', () => { graph.input('bad', () => 0); throw Error('bad') })
    expect(() => bad.getSnapshot()).toThrow(); expect(() => bad.subscribe(() => {})).toThrow(); expect(graph.stats().nodes).toBe(0)
    expect(root.getSnapshot()).toBe(2)
    graph.evict('owner'); expect(graph.stats().nodes).toBe(0)
    expect(root.getSnapshot()).toBe(2)
    graph.destroy()
  })
})
