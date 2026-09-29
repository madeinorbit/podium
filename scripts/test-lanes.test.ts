import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  filesNotRun,
  LANES,
  laneCommand,
  planFiles,
  repositoryRoot,
  runnerFor,
  splitFileArgs,
} from './test-lanes'

const root = repositoryRoot()

describe('test lanes', () => {
  it('every lane names a config that exists and a runtime that can collect it', () => {
    for (const [name, lane] of Object.entries(LANES)) {
      const configIndex = lane.command.indexOf('--config')
      if (configIndex >= 0) {
        const config = resolve(root, lane.cwd, lane.command[configIndex + 1] as string)
        expect(existsSync(config), `${name}: ${config}`).toBe(true)
      }
      // apps/server and apps/web import bun: builtins — Node's vitest collects nothing there.
      if (lane.cwd === 'apps/server' || lane.cwd === 'apps/web') {
        expect(lane.command.slice(0, 2), name).toEqual(['bun', '--bun'])
      }
      const command = laneCommand(lane, root, [])
      const entry = command.find((part) => part.includes('vitest')) as string
      expect(existsSync(resolve(root, lane.cwd, entry)), `${name}: ${entry}`).toBe(true)
    }
  })

  it('routes a file to the runner that can collect it', () => {
    expect(runnerFor('apps/server/src/relay.test.ts')).toEqual({ kind: 'vitest', lane: 'server' })
    expect(runnerFor('apps/web/src/app.test.tsx')).toEqual({ kind: 'vitest', lane: 'web' })
    expect(runnerFor('apps/mobile/src/x.test.ts')).toEqual({ kind: 'vitest', lane: 'mobile' })
    expect(runnerFor('packages/sync/src/span.test.ts')).toEqual({ kind: 'vitest', lane: 'node' })
    expect(runnerFor('packages/runtime/test/sqlite.bun.test.ts')).toEqual({ kind: 'bun-test' })
    expect(runnerFor('scripts/lifecycle.integration.test.ts')).toEqual({
      kind: 'vitest',
      lane: 'integration',
    })
    expect(runnerFor('tests/e2e/relay.e2e.test.ts')).toEqual({ kind: 'vitest', lane: 'e2e' })
    expect(runnerFor('packages/sync/src/span.ts')).toHaveProperty('error')
    // POD-4825: the node lane excludes these; the package config runs them.
    expect(
      runnerFor('packages/worklist-proto/harness/native/mobx-pool-fence.native.test.tsx'),
    ).toEqual({ kind: 'vitest', lane: 'worklist-native' })
    expect(runnerFor('packages/worklist-proto/harness/src/fences.test.tsx')).toEqual({
      kind: 'vitest',
      lane: 'node',
    })
  })

  it('names every file a run was asked for and did not run (POD-4825)', () => {
    const named = ['/r/a.test.ts', '/r/b.native.test.tsx', '/r/c.test.ts']
    const report = { testResults: [{ name: '/r/a.test.ts' }, { name: '/r/c.test.ts' }] }
    expect(filesNotRun(named, report)).toEqual(['/r/b.native.test.tsx'])
    expect(
      filesNotRun(named, {
        testResults: [...report.testResults, { name: '/r/b.native.test.tsx' }],
      }),
    ).toEqual([])
    // No report is no evidence: every file counts as not run.
    expect(filesNotRun(named, null)).toEqual(named)
  })

  it('groups files per runner with filters relative to the lane cwd', () => {
    const { plans, errors } = planFiles(
      ['apps/server/src/a.test.ts', 'packages/sync/src/b.test.ts', 'apps/server/src/c.test.ts'],
      root,
    )
    expect(errors).toEqual([])
    expect(plans).toEqual([
      { runner: { kind: 'vitest', lane: 'server' }, files: ['src/a.test.ts', 'src/c.test.ts'] },
      { runner: { kind: 'vitest', lane: 'node' }, files: ['packages/sync/src/b.test.ts'] },
    ])
  })

  it('refuses a named file that does not exist instead of matching nothing', () => {
    const args = splitFileArgs(
      ['scripts/test-lanes.test.ts', 'scripts/nope.test.ts', '-t', 'lane'],
      root,
    )
    expect(args.files).toEqual(['scripts/test-lanes.test.ts'])
    expect(args.extra).toEqual(['-t', 'lane'])
    expect(args.errors).toEqual(['scripts/nope.test.ts does not exist'])
    expect(splitFileArgs([], root).errors).toEqual(['no test files named'])
  })
})
