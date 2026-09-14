import { resolve } from 'node:path'
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

  it('includes the whole server composition closure by default', () => {
    const root = resolve(import.meta.dirname, '..', 'apps/server/src/server.ts')
    const graph = compositionImportGraph()
    const serverGraph = compositionImportGraph(root)
    expect(graph.nodes).toEqual(serverGraph.nodes)
    expect(graph.edges).toEqual(serverGraph.edges)
    expect(graph.nodes).toContain(root)
    // Guards the modules this rooting exists to keep in view: a narrower root lost them.
    for (const module of ['auth-route.ts', 'plugin-auth.ts', 'member-invites.ts']) {
      expect(
        graph.nodes.filter((node) => node.endsWith(`/apps/server/src/${module}`)),
        `${module} must be inside the composition graph`,
      ).toHaveLength(1)
    }
    expect(() => topologicalModules(graph)).not.toThrow()
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
