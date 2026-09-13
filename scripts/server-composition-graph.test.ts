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

  // The default root is `apps/server/src/relay.ts`, which reaches only a subtree: `server.ts`
  // sits ABOVE relay (it imports `./relay`) and is the composition root that actually registers
  // the auth surface. A module is therefore in the relay-rooted graph only for as long as some
  // relay-reachable module imports it, so MOVING one import can drop a module — and any cycle
  // through it — out of the guard without failing anything. That is how the
  // auth-route → plugin-auth → member-invites cycle could have been "fixed" by rerouting the one
  // relay edge that reached it. Root at `server.ts` so the whole composed server is held to the
  // same rule regardless of which edge happens to reach a module.
  it('form a total topological order from the server composition root too', () => {
    const root = resolve(import.meta.dirname, '..', 'apps/server/src/server.ts')
    const graph = compositionImportGraph(root)
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
