import { describe, expect, it } from 'vitest'
import { testHarnessContext } from './driver/testing/harness-context.js'
import { applyTerms, noAgentTerms, optionArgs, unchangedPosture } from './posture.js'
import type { LaunchTerms, PostureLaunch, PostureRequest, PostureSection } from './posture-types.js'

const context = testHarnessContext({ kind: 'codex', home: '/home/podium-test' })
const request: PostureRequest = {
  mode: 'terminal',
  posture: { mode: 'autonomous' },
  grants: {
    podiumCli: { name: 'podium', path: '/opt/podium/bin/podium' },
    uploadsDir: '/var/lib/podium/uploads/s1',
    mcpServers: [],
  },
  workdir: '/work/repo',
  runtimeDir: '/run/podium/s1',
  context,
}
const base: PostureLaunch = { args: ['--resume', 'id', '--', 'hello'], env: { A: '1' }, files: [] }
const terms = (posture: PostureSection): LaunchTerms => ({ posture, request })

describe('applyTerms', () => {
  it("returns the launch with the section's additions", () => {
    const out = applyTerms(
      base,
      terms((l) => ({
        ...unchangedPosture(l),
        launch: { ...l, args: optionArgs(l.args, ['--x']) },
      })),
    )
    expect(out.launch.args).toEqual(['--resume', 'id', '--x', '--', 'hello'])
  })

  it('refuses a section that drops or reorders a builder argument', () => {
    expect(() =>
      applyTerms(
        base,
        terms((l) => ({ ...unchangedPosture(l), launch: { ...l, args: ['--', 'hello'] } })),
      ),
    ).toThrow(/removed or reordered/)
    expect(() =>
      applyTerms(
        base,
        terms((l) => ({
          ...unchangedPosture(l),
          launch: { ...l, args: ['id', '--resume', '--', 'hello'] },
        })),
      ),
    ).toThrow(/removed or reordered/)
  })

  it('refuses a section that drops the builder args by mutating its input', () => {
    // The section gets a frozen copy: a mutation throws instead of rewriting
    // the snapshot the check compares against.
    expect(() =>
      applyTerms(
        base,
        terms((l) => {
          ;(l.args as string[]).splice(0, 2)
          return unchangedPosture(l)
        }),
      ),
    ).toThrow()
  })

  it('refuses a generated file outside the runtime folder', () => {
    expect(() =>
      applyTerms(
        base,
        terms((l) => ({
          ...unchangedPosture(l),
          launch: { ...l, files: [{ path: '/etc/x', contents: '' }] },
        })),
      ),
    ).toThrow(/outside the session runtime folder/)
    // A sibling that shares the folder's name as a prefix is outside it too.
    expect(() =>
      applyTerms(
        base,
        terms((l) => ({
          ...unchangedPosture(l),
          launch: { ...l, files: [{ path: '/run/podium/s1-other/x', contents: '' }] },
        })),
      ),
    ).toThrow(/outside the session runtime folder/)
    expect(() =>
      applyTerms(
        base,
        terms((l) => ({
          ...unchangedPosture(l),
          launch: { ...l, files: [{ path: '/run/podium/s1/../x', contents: '' }] },
        })),
      ),
    ).toThrow(/outside the session runtime folder/)
  })

  it('accepts a generated file inside the runtime folder, and a builder file anywhere', () => {
    const withBuilderFile: PostureLaunch = {
      ...base,
      files: [{ path: '/elsewhere/settings.json', contents: '{}' }],
    }
    const out = applyTerms(
      withBuilderFile,
      terms((l) => ({
        ...unchangedPosture(l),
        launch: {
          ...l,
          files: [
            { path: '/elsewhere/settings.json', contents: '{"merged":true}' },
            { path: '/run/podium/s1/posture.json', contents: '{}' },
          ],
        },
      })),
    )
    expect(out.launch.files.map((f) => f.path)).toEqual([
      '/elsewhere/settings.json',
      '/run/podium/s1/posture.json',
    ])
  })

  it('refuses a section that removes a builder file or env key, and keeps a merged value', () => {
    const withFile: PostureLaunch = { ...base, files: [{ path: '/run/podium/s1/a', contents: '' }] }
    expect(() =>
      applyTerms(
        withFile,
        terms((l) => ({ ...unchangedPosture(l), launch: { ...l, files: [] } })),
      ),
    ).toThrow(/removed the builder's file/)
    expect(() =>
      applyTerms(
        base,
        terms((l) => ({ ...unchangedPosture(l), launch: { ...l, env: {} } })),
      ),
    ).toThrow(/removed the builder's env A/)
    const merged = applyTerms(
      base,
      terms((l) => ({ ...unchangedPosture(l), launch: { ...l, env: { A: '1,2', B: '3' } } })),
    )
    expect(merged.launch.env).toEqual({ A: '1,2', B: '3' })
  })

  it('refuses a home edit outside the context home and roots', () => {
    expect(() =>
      applyTerms(
        base,
        terms((l) => ({
          ...unchangedPosture(l),
          homeEdits: [{ kind: 'owned-file', file: '/etc/x', contents: '', serves: 'podium-cli' }],
        })),
      ),
    ).toThrow(/outside the harness home/)
  })

  it('accepts a home edit in a root that lies outside the home', () => {
    const away = testHarnessContext({
      kind: 'codex',
      home: '/home/podium-test',
      env: { CODEX_HOME: '/srv/codex-home' },
    })
    expect(away.roots.state).toBe('/srv/codex-home')
    const out = applyTerms(base, {
      request: { ...request, context: away },
      posture: (l) => ({
        ...unchangedPosture(l),
        homeEdits: [
          {
            kind: 'owned-file',
            file: '/srv/codex-home/rules/podium.rules',
            contents: '',
            serves: 'podium-cli',
          },
        ],
      }),
    })
    expect(out.applied.homeEdits).toHaveLength(1)
  })

  it('refuses an unmet entry with a placeholder reason', () => {
    expect(() =>
      applyTerms(
        base,
        terms((l) => ({
          ...unchangedPosture(l),
          unmet: [{ requirement: 'autonomy', reason: 'n/a' }],
        })),
      ),
    ).toThrow(/reason/)
  })

  it('reports what the section returned', () => {
    const out = applyTerms(
      base,
      terms((l) => ({
        ...unchangedPosture(l),
        requestedMode: 'auto',
        unmet: [{ requirement: 'autonomy', reason: 'this harness has no approval gate' }],
      })),
    )
    expect(out.applied).toEqual({
      homeEdits: [],
      requestedMode: 'auto',
      unmet: [{ requirement: 'autonomy', reason: 'this harness has no approval gate' }],
    })
  })

  it('leaves a no-agent launch untouched', () => {
    const out = applyTerms(base, noAgentTerms('native login pane: runs no agent'))
    expect(out.launch).toEqual(base)
    expect(out.applied).toEqual({ homeEdits: [], requestedMode: null, unmet: [] })
  })

  it('refuses an empty no-agent reason', () => {
    expect(() => noAgentTerms('')).toThrow(/reason/)
  })
})

describe('optionArgs', () => {
  it('inserts options before the prompt boundary', () => {
    expect(optionArgs(['--model', 'm', '--', '-p'], ['--x'])).toEqual([
      '--model',
      'm',
      '--x',
      '--',
      '-p',
    ])
    expect(optionArgs(['--model', 'm'], ['--x'])).toEqual(['--model', 'm', '--x'])
  })
})
