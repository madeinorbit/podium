import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  admissionRefusal,
  decideForce,
  fingerprint,
  readCensus,
  sharedTurboCacheDir,
} from './typecheck'
import { readWorkspaceResolutionCensus } from './workspace-resolution-census'

describe('decideForce', () => {
  it('plain run forwards args untouched and stays cached', () => {
    const d = decideForce(['--concurrency=4', '--filter=@podium/web'], {})
    expect(d.error).toBeNull()
    expect(d.forceRequested).toBe(false)
    expect(d.forwardArgs).toEqual(['--concurrency=4', '--filter=@podium/web'])
  })

  it('refuses --force without a reason', () => {
    const d = decideForce(['--force'], {})
    expect(d.error).toContain('--uncached-because')
    expect(d.forwardArgs).not.toContain('--force')
  })

  it('refuses TURBO_FORCE env without a reason', () => {
    expect(decideForce([], { TURBO_FORCE: '1' }).error).toContain('--uncached-because')
    expect(decideForce([], { TURBO_FORCE: 'false' }).error).toBeNull()
  })

  it('refuses write-only --cache spellings without a reason', () => {
    expect(decideForce(['--cache=local:w,remote:w'], {}).error).toContain('--uncached-because')
    expect(decideForce(['--cache=local:rw'], {}).error).toBeNull()
  })

  it('a stated reason unlocks --force and strips the reason flag', () => {
    for (const args of [
      ['--force', '--uncached-because=suspect stale artifact'],
      ['--uncached-because', 'suspect stale artifact'],
    ]) {
      const d = decideForce(args, {})
      expect(d.error).toBeNull()
      expect(d.reason).toBe('suspect stale artifact')
      expect(d.forwardArgs).toEqual(['--force'])
    }
  })

  it('refuses an empty reason', () => {
    expect(decideForce(['--uncached-because='], {}).error).toContain('empty')
  })
})

describe('fingerprint', () => {
  const base = {
    install: {
      config: ['local\tc0ffee', 'global\tabsent'],
      layout: [
        'node_modules\t@podium/model\tl\t../../packages/model',
        'node_modules\tleft-pad\td\t-',
      ],
      errors: [],
    },
    resolutions: [
      '@podium/scripts\t@podium/model\tpackages/model/src/index.ts',
      '@podium/scripts\t@podium/runtime/sqlite\tpackages/runtime/src/sqlite/index.ts',
    ],
    admissionErrors: [],
    runtime: { bun: '1.3.14', platform: 'linux', arch: 'x64' },
  }

  it('moves when the effective install configuration changes', () => {
    expect(
      fingerprint({
        ...base,
        install: { ...base.install, config: ['local\tdecaf', 'global\tabsent'] },
      }),
    ).not.toBe(fingerprint(base))
    expect(
      fingerprint({
        ...base,
        install: { ...base.install, config: ['local\tc0ffee', 'global\tdecaf'] },
      }),
    ).not.toBe(fingerprint(base))
  })

  it('separates two linker layouts that share one bunfig.toml (POD-2774)', () => {
    // The candidate installs through an external --config, so the tracked bunfig is
    // byte-identical to the hoisted control's. Only the tree it produced tells them apart.
    const isolated = {
      ...base,
      install: {
        ...base.install,
        layout: [
          'node_modules\t@podium/model\tl\t../../packages/model',
          'node_modules\tleft-pad\tl\t.bun/left-pad@1.3.0/node_modules/left-pad',
        ],
      },
    }
    expect(fingerprint(isolated)).not.toBe(fingerprint(base))
  })

  it('moves when an owner resolution changes or disappears', () => {
    expect(
      fingerprint({
        ...base,
        resolutions: [
          '@podium/scripts\t@podium/model\tpackages/model/src/index.ts',
          '@podium/scripts\t@podium/runtime/sqlite\t../podium/packages/runtime/src/sqlite/index.ts',
        ],
      }),
    ).not.toBe(fingerprint(base))
    expect(fingerprint({ ...base, resolutions: base.resolutions.slice(0, 1) })).not.toBe(
      fingerprint(base),
    )
  })

  it('moves when runtime identity changes', () => {
    expect(fingerprint({ ...base, runtime: { ...base.runtime, bun: '1.3.15' } })).not.toBe(
      fingerprint(base),
    )
    expect(fingerprint({ ...base, runtime: { ...base.runtime, arch: 'arm64' } })).not.toBe(
      fingerprint(base),
    )
  })

  it('is stable for identical environments', () => {
    expect(fingerprint({ ...base })).toBe(fingerprint(base))
  })
})

type Layout = 'hoisted' | 'isolated'
type LinkState = 'healthy' | 'missing' | 'dangling' | 'external'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function packageFiles(directory: string): void {
  writeJson(join(directory, 'package.json'), {
    name: '@podium/b',
    exports: {
      '.': { '@podium/source': './src/index.ts', import: './dist/index.js' },
      './feature': { '@podium/source': './src/feature.ts', import: './dist/feature.js' },
    },
  })
  mkdirSync(join(directory, 'src'), { recursive: true })
  writeFileSync(join(directory, 'src/index.ts'), 'export const root = true\n')
  writeFileSync(join(directory, 'src/feature.ts'), 'export const feature = true\n')
}

function resolutionFixture(
  layout: Layout,
  state: LinkState = 'healthy',
  options: { declared?: boolean; imported?: boolean; range?: string } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), `podium-resolution-${layout}-`))
  cleanup.push(root)
  const owner = join(root, 'packages/a')
  const target = join(root, 'packages/b')
  writeJson(join(root, 'package.json'), { private: true, workspaces: ['packages/*'] })
  writeJson(join(owner, 'package.json'), {
    name: '@podium/a',
    dependencies: options.declared === false ? {} : { '@podium/b': options.range ?? 'workspace:*' },
  })
  mkdirSync(join(owner, 'src'), { recursive: true })
  writeFileSync(
    join(owner, 'src/index.ts'),
    options.imported === false
      ? 'export const owner = true\n'
      : "import { feature } from '@podium/b/feature'\nexport const owner = feature\n",
  )
  packageFiles(target)

  if (state === 'missing') return root

  const linkParent =
    layout === 'hoisted' ? join(root, 'node_modules/@podium') : join(owner, 'node_modules/@podium')
  mkdirSync(linkParent, { recursive: true })
  let linkTarget = target
  if (layout === 'isolated') {
    const storePackage = join(
      root,
      'node_modules/.bun/@podium-b@workspace/packages/node_modules/@podium/b',
    )
    mkdirSync(dirname(storePackage), { recursive: true })
    linkTarget = storePackage
    if (state === 'healthy') symlinkSync(target, storePackage, 'dir')
    if (state === 'dangling') symlinkSync(join(root, 'missing-store-package'), storePackage, 'dir')
    if (state === 'external') {
      const external = mkdtempSync(join(tmpdir(), 'podium-resolution-external-'))
      cleanup.push(external)
      packageFiles(external)
      symlinkSync(external, storePackage, 'dir')
    }
  } else if (state === 'dangling') {
    linkTarget = join(root, 'missing-hoisted-package')
  } else if (state === 'external') {
    const external = mkdtempSync(join(tmpdir(), 'podium-resolution-external-'))
    cleanup.push(external)
    packageFiles(external)
    linkTarget = external
  }
  symlinkSync(linkTarget, join(linkParent, 'b'), 'dir')
  return root
}

describe.each<Layout>(['hoisted', 'isolated'])('%s workspace resolution census', (layout) => {
  it('accepts owner-local source resolutions without a root link farm', () => {
    const root = resolutionFixture(layout)
    const census = readWorkspaceResolutionCensus(root)

    expect(census.errors).toEqual([])
    expect(census.records).toEqual([
      '@podium/a\t@podium/b\tpackages/b/src/index.ts',
      '@podium/a\t@podium/b/feature\tpackages/b/src/feature.ts',
    ])
    expect(existsSync(join(root, 'node_modules/@podium/a'))).toBe(false)
    if (layout === 'isolated') expect(existsSync(join(root, 'node_modules/@podium/b'))).toBe(false)
  })

  it.each<LinkState>(['missing', 'dangling'])('rejects a %s owner resolution', (state) => {
    const census = readWorkspaceResolutionCensus(resolutionFixture(layout, state))
    expect(census.errors.some((error) => error.includes('missing or dangling'))).toBe(true)
  })

  it('rejects an external owner resolution', () => {
    const census = readWorkspaceResolutionCensus(resolutionFixture(layout, 'external'))
    expect(census.errors.some((error) => error.includes('outside this checkout'))).toBe(true)
  })
})

describe('workspace resolution ownership', () => {
  it('requires every exercised import to be declared by its owner', () => {
    const census = readWorkspaceResolutionCensus(
      resolutionFixture('isolated', 'healthy', { declared: false }),
    )
    expect(census.errors).toContain(
      '@podium/a: import @podium/b/feature is not declared by its owner',
    )
  })

  it('requires the exact workspace:* declaration protocol', () => {
    const census = readWorkspaceResolutionCensus(
      resolutionFixture('isolated', 'healthy', { range: 'workspace:^' }),
    )
    expect(census.errors).toContain(
      '@podium/a: import @podium/b/feature must declare @podium/b with workspace:*',
    )
  })

  it('allows a workspace to resolve its own exported subpaths', () => {
    const root = resolutionFixture('isolated', 'healthy', { imported: false })
    writeFileSync(
      join(root, 'packages/b/src/index.ts'),
      "export { feature } from '@podium/b/feature'\n",
    )

    const census = readWorkspaceResolutionCensus(root)
    expect(census.errors).toEqual([])
    expect(census.records).toContain('@podium/b\t@podium/b/feature\tpackages/b/src/feature.ts')
  })

  it('does not traverse a source-directory symlink outside the checkout', () => {
    const root = resolutionFixture('isolated', 'healthy', { imported: false })
    const external = mkdtempSync(join(tmpdir(), 'podium-resolution-source-escape-'))
    cleanup.push(external)
    writeFileSync(join(external, 'escape.ts'), "import '@podium/not-a-workspace'\n")
    symlinkSync(external, join(root, 'packages/a/src/linked-external'), 'dir')

    const census = readWorkspaceResolutionCensus(root)
    expect(census.errors).toEqual([])
    expect(census.records).not.toContainEqual(expect.stringContaining('@podium/not-a-workspace'))
  })

  it('resolves declared workspace edges even when source does not import them', () => {
    const census = readWorkspaceResolutionCensus(
      resolutionFixture('isolated', 'healthy', { imported: false }),
    )
    expect(census.errors).toEqual([])
    expect(census.records).toEqual(['@podium/a\t@podium/b\tpackages/b/src/index.ts'])
  })

  it('keeps generated subtrees out of the census and environment hash', () => {
    const root = resolutionFixture('isolated', 'healthy', { imported: false })
    const before = readWorkspaceResolutionCensus(root)

    for (const directory of ['.expo', 'artifacts', 'target']) {
      const generated = join(root, 'packages/a/src', directory, 'nested')
      mkdirSync(generated, { recursive: true })
      writeFileSync(join(generated, 'phantom.ts'), `import '@podium/generated-${directory}'\n`)
    }

    const after = readWorkspaceResolutionCensus(root)
    expect(after).toEqual(before)
    const environment = {
      install: { config: ['local\tc0ffee', 'global\tabsent'], layout: [], errors: [] },
      admissionErrors: [],
      runtime: { bun: '1.3.14', platform: 'linux', arch: 'x64' },
    }
    expect(fingerprint({ ...environment, resolutions: after.records })).toBe(
      fingerprint({ ...environment, resolutions: before.records }),
    )
  })
})

describe('readCensus', () => {
  it('carries an install-topology break into the same admission errors', () => {
    // Pins the wiring, not just the two censuses: every workspace edge here resolves
    // perfectly, and the install is still one whose cached green means nothing.
    const root = resolutionFixture('hoisted')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync('../evaporated/node-pty', join(root, 'node_modules/node-pty'))

    const census = readCensus(root)
    expect(census.resolutions.length).toBeGreaterThan(0)
    expect(census.admissionErrors).toEqual([
      'install topology: node_modules/node-pty is a dangling symlink (-> ../evaporated/node-pty)',
    ])
    expect(admissionRefusal(census, 'typecheck')).toContain('node-pty')
  })

  it('admits a healthy install', () => {
    expect(readCensus(resolutionFixture('hoisted')).admissionErrors).toEqual([])
  })
})

describe('admissionRefusal', () => {
  const clean = {
    install: { config: ['local\tc0ffee', 'global\tabsent'], layout: [], errors: [] },
    resolutions: [],
    admissionErrors: [],
    runtime: { bun: '1.3.14', platform: 'linux', arch: 'x64' },
  }

  it('says nothing about a healthy install', () => {
    expect(admissionRefusal(clean, 'typecheck')).toBeNull()
  })

  it('names the lane and every reason, so the refusal is actionable', () => {
    const refusal = admissionRefusal(
      {
        ...clean,
        admissionErrors: [
          '@podium/a: @podium/b is missing or dangling from its owner',
          'install topology: node_modules/node-pty is a dangling symlink (-> ../evaporated)',
        ],
      },
      'test',
    )
    expect(refusal).toContain('test refused')
    expect(refusal).toContain('@podium/b is missing or dangling')
    expect(refusal).toContain('node_modules/node-pty is a dangling symlink')
  })

  it('refuses on a third-party break with every workspace edge intact', () => {
    // The case the workspace census alone cannot see: @podium resolution is perfect and
    // the install is still not one whose cached green means anything.
    expect(
      admissionRefusal(
        {
          ...clean,
          resolutions: ['@podium/a\t@podium/b\tpackages/b/src/index.ts'],
          admissionErrors: ['install topology: node_modules/node-pty is a dangling symlink (-> x)'],
        },
        'typecheck',
      ),
    ).not.toBeNull()
  })
})

describe('sharedTurboCacheDir', () => {
  function repository(): { common: string; worktrees: string[] } {
    const root = mkdtempSync(join(tmpdir(), 'podium-cache-key-'))
    cleanup.push(root)
    const common = join(root, 'repo/.git')
    mkdirSync(join(common, 'worktrees'), { recursive: true })
    const worktrees = ['alpha', 'beta'].map((name) => {
      const worktree = join(root, name)
      mkdirSync(worktree, { recursive: true })
      mkdirSync(join(common, 'worktrees', name), { recursive: true })
      writeFileSync(join(worktree, '.git'), `gitdir: ${join(common, 'worktrees', name)}\n`)
      return worktree
    })
    return { common, worktrees }
  }

  it('gives sibling worktrees of one repository the same durable cache', () => {
    const { worktrees } = repository()
    const [alpha, beta] = worktrees as [string, string]
    const home = mkdtempSync(join(tmpdir(), 'podium-home-'))
    cleanup.push(home)

    expect(sharedTurboCacheDir(alpha, {}, home)).toBe(sharedTurboCacheDir(beta, {}, home))
    expect(dirname(sharedTurboCacheDir(alpha, {}, home))).toBe(join(home, '.cache/podium/turbo'))
  })

  it('prefers $HOME/.cache over the temporary directory, which TMPDIR reminting moves', () => {
    const { worktrees } = repository()
    const [alpha] = worktrees as [string, string]
    const home = mkdtempSync(join(tmpdir(), 'podium-home-'))
    cleanup.push(home)

    const chosen = sharedTurboCacheDir(alpha, {}, home)
    expect(chosen.startsWith(join(home, '.cache'))).toBe(true)
    // A per-session temporary directory must not move a durable cache.
    expect(sharedTurboCacheDir(alpha, { TMPDIR: '/tmp/session-a' }, home)).toBe(chosen)
    expect(sharedTurboCacheDir(alpha, { TMPDIR: '/tmp/session-b' }, home)).toBe(chosen)
  })

  it('honours an absolute XDG_CACHE_HOME and ignores a relative one', () => {
    const { worktrees } = repository()
    const [alpha] = worktrees as [string, string]
    const home = mkdtempSync(join(tmpdir(), 'podium-home-'))
    cleanup.push(home)

    expect(sharedTurboCacheDir(alpha, { XDG_CACHE_HOME: '/xdg' }, home).startsWith('/xdg')).toBe(
      true,
    )
    expect(sharedTurboCacheDir(alpha, { XDG_CACHE_HOME: 'relative' }, home)).toBe(
      sharedTurboCacheDir(alpha, {}, home),
    )
  })

  it('falls back to the temporary directory only when there is no usable home', () => {
    const { worktrees } = repository()
    const [alpha] = worktrees as [string, string]
    expect(sharedTurboCacheDir(alpha, {}, '').startsWith(join(tmpdir(), 'podium-cache'))).toBe(true)
  })

  it('separates unrelated repositories', () => {
    const home = mkdtempSync(join(tmpdir(), 'podium-home-'))
    cleanup.push(home)
    const [first] = repository().worktrees as [string, string]
    const [second] = repository().worktrees as [string, string]
    expect(sharedTurboCacheDir(first, {}, home)).not.toBe(sharedTurboCacheDir(second, {}, home))
  })
})
