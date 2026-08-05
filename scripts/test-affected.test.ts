import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DOCS_READ_BY_TESTS,
  type Git,
  assessCoverage,
  changedFiles,
  isInert,
  longLivedCandidates,
  parseArgs,
  resolveBase,
  testCapablePackages,
} from './test-affected'

/** Builds a fake git from an exact-args -> stdout map; anything unmapped "fails". */
function fakeGit(map: Record<string, string | null>): Git {
  return (args) => map[args.join(' ')] ?? null
}

describe('longLivedCandidates', () => {
  it('keeps only main and project/* — never another agent’s issue branch', () => {
    const git = fakeGit({
      'for-each-ref --format=%(refname:short) refs/remotes/origin': [
        'origin/main',
        'origin/project/testing',
        'origin/issue/1687-turbo-test-task',
        'origin/HEAD',
      ].join('\n'),
    })
    expect(longLivedCandidates(git)).toEqual(['origin/main', 'origin/project/testing'])
  })
})

describe('resolveBase', () => {
  it('an explicit base wins and is resolved to a sha', () => {
    const git = fakeGit({ 'rev-parse --verify deadbeef^{commit}': 'deadbeefcafe' })
    expect(resolveBase(git, { explicit: 'deadbeef' })).toMatchObject({ base: 'deadbeefcafe' })
  })

  it('rejects an explicit base that does not resolve', () => {
    const r = resolveBase(fakeGit({}), { explicit: 'nope' })
    expect(r).toHaveProperty('error')
  })

  it('picks the merge base CLOSEST to HEAD, not origin/main by default', () => {
    // Worktree cut from a long-lived project branch that is itself ahead of main.
    // Basing on origin/main would drag in the project branch’s own commits.
    const git = fakeGit({
      'rev-parse --abbrev-ref @{upstream}': null,
      'for-each-ref --format=%(refname:short) refs/remotes/origin':
        'origin/main\norigin/project/testing',
      'merge-base HEAD origin/main': 'aaa',
      'merge-base HEAD origin/project/testing': 'bbb',
      // aaa is an ancestor of bbb => bbb is the true fork point.
      'merge-base --is-ancestor aaa bbb': '',
    })
    const r = resolveBase(git)
    expect(r).toMatchObject({ base: 'bbb' })
    expect((r as { how: string }).how).toContain('origin/project/testing')
  })

  it('prefers the configured upstream when there is one', () => {
    const git = fakeGit({
      'rev-parse --abbrev-ref @{upstream}': 'origin/project/testing',
      'for-each-ref --format=%(refname:short) refs/remotes/origin': 'origin/main',
      'merge-base HEAD origin/project/testing': 'bbb',
      'merge-base HEAD origin/main': 'aaa',
      'merge-base --is-ancestor bbb aaa': null, // aaa is NOT a descendant of bbb
    })
    expect(resolveBase(git)).toMatchObject({ base: 'bbb' })
  })

  it('refuses rather than guessing when nothing shares history', () => {
    const git = fakeGit({
      'rev-parse --abbrev-ref @{upstream}': null,
      'for-each-ref --format=%(refname:short) refs/remotes/origin': '',
    })
    expect(resolveBase(git)).toHaveProperty('error')
  })
})

describe('changedFiles', () => {
  it('unions committed, uncommitted and untracked work', () => {
    const git = fakeGit({
      'diff --name-only base...HEAD': 'packages/model/src/a.ts',
      'diff --name-only HEAD': 'packages/model/src/a.ts\napps/web/src/b.ts',
      'ls-files --others --exclude-standard': 'scripts/new.ts',
    })
    expect(changedFiles(git, 'base')).toEqual([
      'apps/web/src/b.ts',
      'packages/model/src/a.ts',
      'scripts/new.ts',
    ])
  })
})

describe('testCapablePackages', () => {
  it('reads the packages turbo can actually run `test` for', () => {
    const dry = JSON.stringify({
      tasks: [
        { taskId: '@podium/web#test', package: '@podium/web' },
        { taskId: '@podium/mobile#test', package: '@podium/mobile' },
      ],
    })
    expect([...testCapablePackages(dry)].sort()).toEqual(['@podium/mobile', '@podium/web'])
  })

  it('an empty task graph yields no capable packages', () => {
    expect(testCapablePackages(JSON.stringify({ tasks: [] })).size).toBe(0)
  })
})

describe('assessCoverage', () => {
  const packages = [
    { dir: 'apps/web', name: '@podium/web' },
    { dir: 'packages/model', name: '@podium/model' },
    { dir: 'scripts', name: '@podium/scripts' },
  ].sort((a, b) => b.dir.length - a.dir.length)
  // What POD-1687 actually pinned: web and mobile only.
  const capable = new Set(['@podium/web', '@podium/mobile'])

  it('a file in a package turbo can run is covered', () => {
    expect(assessCoverage(['apps/web/src/a.ts'], packages, capable).uncovered).toEqual([])
  })

  it('root-level files are uncovered — no package filter can ever select them', () => {
    // This is the case the lane exists to refuse: vitest.unit.config.ts changes the
    // whole root sweep, and `turbo run test` would report a clean green anyway.
    const { uncovered, reasons } = assessCoverage(['vitest.unit.config.ts'], packages, capable)
    expect(uncovered).toEqual(['vitest.unit.config.ts'])
    expect(reasons.get('vitest.unit.config.ts')).toContain('no workspace package')
  })

  it('a package.json `test` script does NOT mean turbo can run it', () => {
    // The integration bug: @podium/model ships `vitest run` in package.json but has no
    // turbo task, so turbo matches nothing and exits 0. Trusting package.json here
    // printed a green for a package whose tests never ran.
    const { uncovered, reasons } = assessCoverage(['packages/model/src/a.ts'], packages, capable)
    expect(uncovered).toEqual(['packages/model/src/a.ts'])
    expect(reasons.get('packages/model/src/a.ts')).toContain('no `test` task in turbo.json')
  })

  it('widens by itself when a package joins the task graph', () => {
    const widened = new Set([...capable, '@podium/model'])
    expect(assessCoverage(['packages/model/src/a.ts'], packages, widened).uncovered).toEqual([])
  })

  it('a package with no turbo task is uncovered, not silently passed', () => {
    const { uncovered } = assessCoverage(['scripts/host.ts'], packages, capable)
    expect(uncovered).toEqual(['scripts/host.ts'])
  })

  it('matches on path boundaries, not bare prefixes', () => {
    // "apps/web-legacy" must not be mistaken for the "apps/web" package.
    expect(assessCoverage(['apps/web-legacy/src/a.ts'], packages, capable).uncovered).toEqual([
      'apps/web-legacy/src/a.ts',
    ])
  })
})

describe('isInert', () => {
  it('prose and licences are covered by construction', () => {
    for (const f of ['README.md', 'AGENTS.md', 'docs/agents/testing.md', 'LICENSE', 'NOTICE'])
      expect(isInert(f), f).toBe(true)
  })

  it('anything executable or config-shaped is NOT inert', () => {
    for (const f of [
      'vitest.unit.config.ts',
      'scripts/host.ts',
      'tooling/tsconfig/base.json',
      'turbo.json',
    ])
      expect(isInert(f), f).toBe(false)
  })

  it('a doc that a test actually reads is not inert', () => {
    // docs-drift.test.ts (packages/telemetry) reads this; editing it can turn that
    // suite red, and no package filter would select telemetry for a root-level doc.
    expect(isInert('docs/TELEMETRY.md')).toBe(false)
  })

  it('a doc-only change no longer refuses', () => {
    expect(assessCoverage(['README.md'], [], new Set()).uncovered).toEqual([])
    expect(assessCoverage(['docs/TELEMETRY.md'], [], new Set()).uncovered).toEqual([
      'docs/TELEMETRY.md',
    ])
  })
})

describe('DOCS_READ_BY_TESTS drift guard', () => {
  it('every repo-root doc a test reads is listed', () => {
    // If this fails, a new test started reading a real repo doc. Add its path to
    // DOCS_READ_BY_TESTS so a change to it keeps refusing instead of passing green.
    const root = fileURLToPath(new URL('..', import.meta.url))
    const grep = Bun.spawnSync(
      [
        'git',
        'grep',
        '-hoE',
        String.raw`new URL\('[^']*docs/[A-Za-z0-9_./-]+\.md`,
        '--',
        '*.test.ts',
        '*.test.tsx',
      ],
      { cwd: root },
    )
    const found = new Set<string>()
    for (const line of grep.stdout.toString().split('\n')) {
      const m = line.match(/docs\/[A-Za-z0-9_./-]+\.md/)
      if (m) found.add(m[0])
    }
    for (const doc of found) expect(DOCS_READ_BY_TESTS, `${doc} reads as inert`).toContain(doc)
  })
})

describe('parseArgs', () => {
  it('extracts base and allow-uncovered, forwarding the rest to turbo', () => {
    const a = parseArgs(['--base=abc', '--allow-uncovered', '--concurrency=4'])
    expect(a).toEqual({
      explicitBase: 'abc',
      allowUncovered: true,
      forward: ['--concurrency=4'],
    })
    expect(parseArgs(['--base', 'xyz']).explicitBase).toBe('xyz')
  })
})
