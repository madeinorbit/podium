import { describe, expect, it } from 'vitest'
import { compositionImportGraph, topologicalModules } from './server-composition-graph'

describe('server composition runtime imports', () => {
  it('form a total topological order', () => {
    const graph = compositionImportGraph()
    const order = topologicalModules(graph)
    expect(order).toHaveLength(graph.nodes.length)
    const position = new Map(order.map((node, index) => [node, index]))
    for (const [module, dependencies] of graph.edges) {
      for (const dependency of dependencies) {
        expect(position.get(dependency), `${dependency} must precede ${module}`).toBeLessThan(
          position.get(module)!,
        )
      }
    }
  })

  it('fails loudly on a runtime import cycle', () => {
    const graph = {
      nodes: ['a', 'b'],
      edges: new Map([
        ['a', ['b']],
        ['b', ['a']],
      ]),
    }
    expect(() => topologicalModules(graph)).toThrow('runtime import cycle')
  })
})
