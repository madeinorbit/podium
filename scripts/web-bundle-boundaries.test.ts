import { describe, expect, it } from 'vitest'
import { eagerClientGraphSources, eagerJsFiles } from './web-bundle-boundaries'

describe('pool startup bundle boundary', () => {
  const graph = {
    entry: { file: 'assets/app.js', imports: ['shared'], dynamicImports: ['pool'] },
    shared: { file: 'assets/shared.js', imports: ['loading'] },
    loading: { file: 'assets/loading.js' },
    pool: { file: 'assets/board.js', imports: ['loading'] },
  }
  const sources: Record<string, string[]> = {
    'assets/app.js': ['../../src/app/main.tsx'],
    'assets/shared.js': ['../../src/features/issues/explorer/explorer-context.tsx'],
    'assets/loading.js': ['../../../../packages/client-graph/src/loading.ts'],
    'assets/board.js': ['../../../../packages/client-graph/src/issue-board-projection.ts'],
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

  it('rejects a planted static optional-screen import even when HTML does not preload it', () => {
    const planted = { ...graph, shared: { ...graph.shared, imports: ['loading', 'pool'] } }
    expect(check(planted)).toEqual(['../../../../packages/client-graph/src/issue-board-projection.ts'])
  })

  it('refuses an incomplete manifest instead of hiding an eager dependency', () => {
    expect(() =>
      eagerJsFiles(['assets/app.js'], {
        entry: { file: 'assets/app.js', imports: ['missing'] },
      }),
    ).toThrow('missing static import missing')
  })

  it('allows the always-pool store and first-screen readers while refusing optional and unknown modules', () => {
    // POD-5582: the old off-switch contract predates removal of the legacy
    // store. These are required on the first screen now. This does not permit
    // board, settings UI or palette implementation code to become eager.
    expect(eagerClientGraphSources([
      'packages/client-graph/src/pool.ts',
      'packages/client-graph/src/host/pool-host.ts',
      'packages/client-graph/src/worklist/sidebar.ts',
      'packages/client-graph/src/shared/session-questions.ts',
      'packages/client-graph/src/shared/feed-diagnostics.ts',
      'packages/client-graph/src/settings-schema.ts',
      'packages/client-graph/src/command-launch-schema.ts',
      'packages/client-graph/src/loading.ts',
    ])).toEqual([])
    expect(
      eagerClientGraphSources([
        'packages/client-graph/src/loading.ts',
        '../../packages/client-graph/src/issue-board-source.ts',
        '/repo/node_modules/@podium/client-graph/src/command-launch-source.ts',
        'C:\\repo\\packages\\client-graph\\src\\mobile-settings.ts',
        'packages/client-graph/src/automation-views.ts',
        'packages/client-graph/src/workflow-views.ts',
        'packages/client-graph/src/new-optional-screen.ts',
        'packages/client-graph/diagnostics/sidebar-check.ts',
        'packages/client-core/src/loading.ts',
      ]),
    ).toHaveLength(7)
  })
})
