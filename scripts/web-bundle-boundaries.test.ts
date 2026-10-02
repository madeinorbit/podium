import { describe, expect, it } from 'vitest'
import { eagerClientGraphSources, eagerJsFiles } from './web-bundle-boundaries'

describe('pool startup bundle boundary', () => {
  const graph = {
    entry: { file: 'assets/app.js', imports: ['shared'], dynamicImports: ['pool'] },
    shared: { file: 'assets/shared.js', imports: ['loading'] },
    loading: { file: 'assets/loading.js' },
    pool: { file: 'assets/pool.js', imports: ['loading'] },
  }
  const sources: Record<string, string[]> = {
    'assets/app.js': ['../../src/app/main.tsx'],
    'assets/shared.js': ['../../src/features/issues/explorer/explorer-context.tsx'],
    'assets/loading.js': ['../../../../packages/client-graph/src/loading.ts'],
    'assets/pool.js': ['../../../../packages/client-graph/src/pool.ts'],
  }
  const check = (manifest: typeof graph) =>
    eagerClientGraphSources(
      eagerJsFiles(['assets/app.js'], manifest).flatMap((file) => sources[file]!),
    )

  it('allows the marker and leaves the dynamic pool outside the eager closure', () => {
    expect(eagerJsFiles(['assets/app.js', 'assets/shared.js'], graph)).toEqual([
      'assets/app.js',
      'assets/shared.js',
      'assets/loading.js',
    ])
    expect(check(graph)).toEqual([])
  })

  it('rejects a planted static pool import even when HTML does not preload it', () => {
    const planted = { ...graph, shared: { ...graph.shared, imports: ['loading', 'pool'] } }
    expect(check(planted)).toEqual(['../../../../packages/client-graph/src/pool.ts'])
  })

  it('refuses an incomplete manifest instead of hiding an eager dependency', () => {
    expect(() =>
      eagerJsFiles(['assets/app.js'], {
        entry: { file: 'assets/app.js', imports: ['missing'] },
      }),
    ).toThrow('missing static import missing')
  })

  it('checks the entire package and allows only the exact constants entry', () => {
    expect(
      eagerClientGraphSources([
        'packages/client-graph/src/loading.ts',
        '../../packages/client-graph/src/worklist/rollup.ts',
        '/repo/node_modules/@podium/client-graph/src/pool.ts',
        'C:\\repo\\packages\\client-graph\\src\\models.ts',
        'packages/client-graph/diagnostics/sidebar-check.ts',
        'packages/client-core/src/loading.ts',
      ]),
    ).toHaveLength(4)
  })
})
