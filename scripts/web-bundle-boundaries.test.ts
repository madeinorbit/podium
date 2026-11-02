import { describe, expect, it } from 'vitest'
import {
  browserHostileSources,
  eagerClientGraphSources,
  eagerJsFiles,
} from '../apps/web/test/web-bundle-boundaries'

describe('pool startup bundle boundary', () => {
  const graph = {
    entry: { file: 'assets/app.js', imports: ['shared'], dynamicImports: ['pool'] },
    shared: { file: 'assets/shared.js', imports: ['loading'] },
    loading: { file: 'assets/loading.js' },
    pool: { file: 'assets/board.js', imports: ['loading'] },
  }
  const sources: Record<string, string[]> = {
    'assets/app.js': ['../../src/app/main.tsx'],
    'assets/shared.js': ['../../src/features/issues/dock-issue.tsx'],
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
    expect(check(planted)).toEqual([
      '../../../../packages/client-graph/src/issue-board-projection.ts',
    ])
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
    expect(
      eagerClientGraphSources([
        'packages/client-graph/src/pool.ts',
        'packages/client-graph/src/host/pool-host.ts',
        'packages/client-graph/src/worklist/sidebar.ts',
        'packages/client-graph/src/shared/session-questions.ts',
        'packages/client-graph/src/shared/joined-fields.ts',
        'packages/client-graph/src/shared/session-reference.ts',
        'packages/client-graph/src/shared/feed-diagnostics.ts',
        'packages/client-graph/src/shared/predicates.ts',
        'packages/client-graph/src/header-repositories.ts',
        'packages/client-graph/src/requested-record-source.ts',
        'packages/client-graph/src/settings-schema.ts',
        'packages/client-graph/src/command-launch-schema.ts',
        'packages/client-graph/src/loading.ts',
      ]),
    ).toEqual([])
    expect(
      eagerClientGraphSources([
        'packages/client-graph/src/loading.ts',
        '../../packages/client-graph/src/issue-board-source.ts',
        '/repo/node_modules/@podium/client-graph/src/command-launch-source.ts',
        'C:\\repo\\packages\\client-graph\\src\\mobile-settings.ts',
        'packages/client-graph/src/automation-views.ts',
        'packages/client-graph/src/workflow-views.ts',
        'packages/client-graph/src/new-optional-screen.ts',
        'tests/worklist/diagnostics/sidebar-check.ts',
        'packages/client-core/src/loading.ts',
      ]),
    ).toHaveLength(7)
  })

  it('keeps branch editing and view request lifetimes outside startup', () => {
    const optional = [
      'react/opening-view',
      'repo-base-branch',
      'request-answer',
      'requested-records',
      'visible-request',
    ].map((module) => `packages/client-graph/src/${module}.ts`)
    expect(eagerClientGraphSources(optional)).toEqual(optional)
  })

  it('allows shared read observations and worklist companions without allowing phone screens', () => {
    const startup = [
      '../../../../packages/client-graph/src/read-observation.ts',
      '/repo/node_modules/@podium/client-graph/src/worklist/phone.ts',
      'C:\\repo\\packages\\client-graph\\src\\worklist\\voice.ts',
    ]
    const optional = [
      'packages/client-graph/src/mobile-settings.ts',
      'packages/client-graph/src/worklist/phone-screen.ts',
      'packages/client-graph/src/worklist/voice-settings.ts',
    ]
    expect(eagerClientGraphSources([...startup, ...optional])).toEqual(optional)
  })
})

describe('browser bundle boundary', () => {
  it('allows the declared browser entrypoint and its pure cursor dependency chain', () => {
    expect(
      browserHostileSources([
        '../../../../packages/harness/src/browser.ts',
        '../../../../packages/harness/src/store/stream-identity.ts',
        '../../../../packages/harness/src/store/cursor-codec.ts',
        '../../../../packages/harness/src/transcript-types.ts',
        'C:\\repo\\packages\\harness\\src\\transcript-types.ts',
      ]),
    ).toEqual([])
  })

  it('still rejects host modules, unknown harness leaves and names extending an exception', () => {
    const hostile = [
      'packages/harness/src/metadata.ts',
      'packages/harness/src/store/source.ts',
      'packages/harness/src/driver/families/terminal/runtime.ts',
      'packages/harness/src/transcript-reader.ts',
      'packages/harness/src/transcript-types.ts.host.ts',
      'C:\\repo\\packages\\runtime\\src\\sqlite\\database.ts',
      'apps/web/src/file-viewer-replay.ts',
    ]
    expect(
      browserHostileSources([...hostile, ...hostile, 'packages/model/src/browser.ts']),
    ).toEqual([...hostile].sort())
  })
})
