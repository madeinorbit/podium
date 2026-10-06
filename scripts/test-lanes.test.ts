import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
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

  it.each([
    ['apps/server/src/relay.test.ts', 'server'],
    ['apps/web/src/app.test.tsx', 'web'],
    ['apps/mobile/src/x.test.ts', 'mobile'],
    ['packages/sync/src/span.test.ts', 'node'],
    ['scripts/lifecycle.integration.test.ts', 'integration'],
    ['apps/server/src/gateway/picture-catchup.integration.test.ts', 'integration'],
    ['apps/server/src/example.integration.spec.ts', 'integration'],
    ['apps/server/src/sync-e2e.test.ts', 'integration'],
    ['packages/pty/src/host.integration.test.ts', 'integration'],
    ['packages/pty/test/example.pty.test.ts', 'integration'],
    ['packages/pty/test/session.test.ts', 'integration'],
    ['apps/daemon/src/daemon.test.ts', 'integration'],
    ['tests/e2e/relay.e2e.test.ts', 'e2e'],
    ['tests/e2e/harness-env.test.ts', 'e2e'],
    ['scripts/loop-split-load.integration.test.ts', 'acceptance'],
  ])('routes %s to %s', (file, lane) => {
    expect(runnerFor(file)).toEqual({ kind: 'vitest', lane })
  })

  it('keeps Bun-only files ahead of integration and package routing', () => {
    for (const file of [
      'packages/runtime/test/sqlite.bun.test.ts',
      'scripts/lifecycle.integration.bun.test.ts',
      'apps/server/src/worker.bun.test.ts',
    ])
      expect(runnerFor(file)).toEqual({ kind: 'bun-test' })
    expect(runnerFor('packages/sync/src/span.ts')).toHaveProperty('error')
    // POD-4825: the node lane excludes these; the package config runs them.
    expect(
      runnerFor('tests/worklist/harness/native/mobx-pool-fence.native.test.tsx'),
    ).toEqual({ kind: 'vitest', lane: 'worklist-native' })
    expect(runnerFor('tests/worklist/harness/src/fences.test.tsx')).toEqual({
      kind: 'vitest',
      lane: 'node',
    })
  })

  it('uses the e2e directory only when no caller path filter was given', () => {
    const lane = LANES.e2e
    if (!lane) throw new Error('missing e2e lane')
    expect(laneCommand(lane, root, [])).toContain('tests/e2e')
    // A name-pattern flag value is not a file filter, even when it looks like one.
    expect(laneCommand(lane, root, ['-t', 'sample.test.ts'])).toContain('tests/e2e')
    for (const args of [
      ['tests/e2e/picture-catchup.e2e.test.ts'],
      ['tests/e2e/picture-catchup.e2e.test.ts', '-t', 'picture'],
      ['picture-catchup'],
    ]) {
      const command = laneCommand(lane, root, args)
      expect(command).not.toContain('tests/e2e')
      expect(command.slice(-args.length - 1)).toEqual([...args, '--passWithNoTests=false'])
    }
  })

  it('overrides permissive zero-collection defaults for every lane', () => {
    for (const lane of Object.values(LANES)) {
      expect(laneCommand(lane, root, ['--passWithNoTests'])).toContain('--passWithNoTests=false')
    }
  })

  it('plans integration and e2e files independently of server units', () => {
    expect(
      planFiles(
        [
          'apps/server/src/relay.test.ts',
          'apps/server/src/gateway/picture-catchup.integration.test.ts',
          'packages/pty/src/host.integration.test.ts',
          'tests/e2e/picture-catchup.e2e.test.ts',
        ],
        root,
      ),
    ).toEqual({
      errors: [],
      plans: [
        { runner: { kind: 'vitest', lane: 'server' }, files: ['src/relay.test.ts'] },
        {
          runner: { kind: 'vitest', lane: 'integration' },
          files: [
            'apps/server/src/gateway/picture-catchup.integration.test.ts',
            'packages/pty/src/host.integration.test.ts',
          ],
        },
        {
          runner: { kind: 'vitest', lane: 'e2e' },
          files: ['tests/e2e/picture-catchup.e2e.test.ts'],
        },
      ],
    })
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

  it('keeps flag values out of the filename list', () => {
    expect(
      splitFileArgs(['scripts/test-lanes.test.ts', '-t', 'scripts/nope.test.ts'], root),
    ).toEqual({
      files: ['scripts/test-lanes.test.ts'],
      extra: ['-t', 'scripts/nope.test.ts'],
      errors: [],
    })
    expect(splitFileArgs(['scripts'], root).errors).toContain('scripts is not a file')
    expect(splitFileArgs([], root, false).errors).toEqual([])
    expect(splitFileArgs(['src/router.setup.test.ts'], root, false, 'apps/server').files).toEqual([
      'apps/server/src/router.setup.test.ts',
    ])
  })
})
