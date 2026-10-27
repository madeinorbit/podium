// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { moduleGraphOf, specifiersOf } from '../entry-pin'

const PROTOTYPE = process.cwd().endsWith(join('tests', 'worklist'))
  ? process.cwd()
  : join(process.cwd(), 'tests/worklist')
const PRODUCT = join(PROTOTYPE, '../../packages/client-graph')

describe('product worklist package boundary', () => {
  it('public data, shared and React entries reach the one pool without prototype machinery', () => {
    const graph = new Set(
      ['index.ts', 'runtime-pool.ts', 'shared/index.ts', 'react/index.ts'].flatMap((entry) =>
        moduleGraphOf(join(PRODUCT, 'src', entry)),
      ),
    )
    for (const file of [
      'pool.ts',
      'models.ts',
      'tables.ts',
      'relations.ts',
      'residency.ts',
      'worklist/visible.ts',
      'worklist/rollup.ts',
      'write/transactions.ts',
      'shared/row-source.ts',
      'react/row.tsx',
    ]) {
      expect(graph.has(join(PRODUCT, 'src', file)), file).toBe(true)
    }
    for (const file of graph) {
      expect(
        file,
        'no dependency on prototype code, even through a relative re-export',
      ).not.toMatch(/\/(?:worklist-proto|tests\/worklist)\//)
      const imports = specifiersOf(readFileSync(file, 'utf-8'))
      expect(
        imports.filter((specifier) =>
          /worklist-proto|tests\/worklist|@podium\/worklist-tests|react-virtual|react-native|^node:/.test(specifier),
        ),
        file,
      ).toEqual([])
    }
  })

  it('owns its runtime dependencies without shipping the experiment virtualizer', () => {
    const product = JSON.parse(readFileSync(join(PRODUCT, 'package.json'), 'utf-8'))
    const prototype = JSON.parse(readFileSync(join(PROTOTYPE, 'package.json'), 'utf-8'))
    expect(product.dependencies.mobx).toBe(prototype.dependencies.mobx)
    expect(product.dependencies['mobx-react-lite']).toBe(prototype.dependencies['mobx-react-lite'])
    expect(product.dependencies['@podium/client-core']).toBe('workspace:*')
    expect(product.dependencies['@podium/harness']).toBe('workspace:*')
    expect(product.dependencies['@podium/model']).toBe('workspace:*')
    expect(product.dependencies['@tanstack/react-virtual']).toBeUndefined()
    expect(prototype.dependencies['@podium/client-graph']).toBe('workspace:*')
    expect(product.peerDependencies.react).toBe('>=19')
    expect(product.sideEffects).toBe(false)
  })
})
