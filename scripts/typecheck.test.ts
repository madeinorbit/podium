import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  admissionRefusal,
  availableMb,
  decideConcurrency,
  decideForce,
  fingerprint,
  readCensus,
  sharedTurboCacheDir,
} from './typecheck'
import { readInstallTopology } from './install-topology'
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

function executableTopologyFixture(): {
  root: string
  context: string
  peerBin: string
  rootBin: string
  workspaceBin: string
} {
  const root = mkdtempSync(join(tmpdir(), 'podium-executable-topology-'))
  cleanup.push(root)
  writeJson(join(root, 'package.json'), { private: true, workspaces: ['packages/*'] })
  writeJson(join(root, 'packages/a/package.json'), { name: '@fixture/a' })
  const context = join(root, 'node_modules/.bun/consumer@1.0.0+aaaaaaaaaaaaaaaa/node_modules')
  const tool = join(context, 'tool')
  writeJson(join(tool, 'package.json'), { name: 'tool', bin: { tool: 'cli.js' } })
  writeFileSync(join(tool, 'cli.js'), '#!/usr/bin/env bun\n')
  writeFileSync(join(tool, 'other.js'), '#!/usr/bin/env bun\n')
  chmodSync(join(tool, 'cli.js'), 0o755)
  chmodSync(join(tool, 'other.js'), 0o755)

  const peerBin = join(context, '.bin')
  const rootBin = join(root, 'node_modules/.bin')
  const workspaceBin = join(root, 'packages/a/node_modules/.bin')
  for (const directory of [peerBin, rootBin, workspaceBin])
    mkdirSync(directory, { recursive: true })
  symlinkSync('../tool/cli.js', join(peerBin, 'tool'))
  return { root, context, peerBin, rootBin, workspaceBin }
}

function topology(root: string) {
  return readInstallTopology(root, join(root, '.fixture-home'))
}

describe('isolated peer-context executable shims', () => {
  it('omits only a healthy uniquely declared nested shim from layout identity', () => {
    const fixture = executableTopologyFixture()
    const withShim = topology(fixture.root)
    expect(withShim.errors).toEqual([])
    expect(withShim.layout).not.toContainEqual(expect.stringContaining('.bin/tool\tl\t'))

    rmSync(join(fixture.peerBin, 'tool'))
    expect(topology(fixture.root)).toEqual(withShim)
  })

  it('still follows and refuses a dangling or wrong-target nested shim', () => {
    const fixture = executableTopologyFixture()
    const shim = join(fixture.peerBin, 'tool')

    rmSync(shim)
    symlinkSync('../tool/missing.js', shim)
    expect(topology(fixture.root).errors).toContainEqual(
      expect.stringContaining('dangling symlink'),
    )

    rmSync(shim)
    symlinkSync('../tool/other.js', shim)
    expect(topology(fixture.root).errors).toContainEqual(
      expect.stringContaining('points to the wrong executable'),
    )
  })

  it('keeps an ambiguous or installer-rewritten command identity-bearing', () => {
    const fixture = executableTopologyFixture()
    const alternative = join(fixture.context, 'alternative')
    writeJson(join(alternative, 'package.json'), {
      name: 'alternative',
      bin: { tool: 'alternative.js' },
    })
    writeFileSync(join(alternative, 'alternative.js'), '#!/usr/bin/env bun\n')
    chmodSync(join(alternative, 'alternative.js'), 0o755)

    expect(topology(fixture.root).layout).toContainEqual(expect.stringContaining('.bin/tool\tl\t'))
  })

  it('keeps a metadata-opaque installer rewrite identity-bearing', () => {
    const fixture = executableTopologyFixture()
    const opaque = join(fixture.context, 'opaque-native')
    writeJson(join(opaque, 'package.json'), { name: 'opaque-native' })
    writeFileSync(join(opaque, 'native.js'), '#!/usr/bin/env bun\n')
    chmodSync(join(opaque, 'native.js'), 0o755)
    const shim = join(fixture.peerBin, 'tool')
    rmSync(shim)
    symlinkSync('../opaque-native/native.js', shim)

    const census = topology(fixture.root)
    expect(census.errors).toEqual([])
    expect(census.layout).toContainEqual(expect.stringContaining('.bin/tool\tl\t'))
  })

  it('keeps root and workspace executable links identity-bearing', () => {
    const fixture = executableTopologyFixture()
    const clean = topology(fixture.root)
    const executable = join(fixture.context, 'tool/cli.js')

    symlinkSync(executable, join(fixture.rootBin, 'root-probe'))
    const rootChanged = topology(fixture.root)
    expect(rootChanged.errors).toEqual([])
    expect(rootChanged.layout).not.toEqual(clean.layout)

    rmSync(join(fixture.rootBin, 'root-probe'))
    symlinkSync(executable, join(fixture.workspaceBin, 'workspace-probe'))
    const workspaceChanged = topology(fixture.root)
    expect(workspaceChanged.errors).toEqual([])
    expect(workspaceChanged.layout).not.toEqual(clean.layout)
  })

  it('keeps package-link text identity-bearing even when resolution is unchanged', () => {
    const fixture = executableTopologyFixture()
    const link = join(fixture.root, 'node_modules/tool-link')
    const target = join(fixture.context, 'tool')
    symlinkSync('.bun/consumer@1.0.0+aaaaaaaaaaaaaaaa/node_modules/tool', link, 'dir')
    const relativeLink = topology(fixture.root)

    rmSync(link)
    symlinkSync(target, link, 'dir')
    const absoluteLink = topology(fixture.root)
    expect(relativeLink.errors).toEqual([])
    expect(absoluteLink.errors).toEqual([])
    expect(absoluteLink.layout).not.toEqual(relativeLink.layout)
  })
})

describe('readCensus', () => {
  it('carries an install-topology break into the same admission errors', () => {
    // Pins the wiring, not just the two censuses: every workspace edge here resolves
    // perfectly, and the install is still one whose cached green means nothing.
    const root = resolutionFixture('hoisted')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    symlinkSync('../evaporated/optional-addon', join(root, 'node_modules/optional-addon'))

    const census = readCensus(root)
    expect(census.resolutions.length).toBeGreaterThan(0)
    expect(census.admissionErrors).toEqual([
      'install topology: node_modules/optional-addon is a dangling symlink ' +
        '(-> ../evaporated/optional-addon)',
    ])
    expect(admissionRefusal(census, 'typecheck')).toContain('optional-addon')
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
          'install topology: node_modules/optional-addon is a dangling symlink (-> ../evaporated)',
        ],
      },
      'test',
    )
    expect(refusal).toContain('test refused')
    expect(refusal).toContain('@podium/b is missing or dangling')
    expect(refusal).toContain('node_modules/optional-addon is a dangling symlink')
  })

  it('refuses on a third-party break with every workspace edge intact', () => {
    // The case the workspace census alone cannot see: @podium resolution is perfect and
    // the install is still not one whose cached green means anything.
    expect(
      admissionRefusal(
        {
          ...clean,
          resolutions: ['@podium/a\t@podium/b\tpackages/b/src/index.ts'],
          admissionErrors: [
            'install topology: node_modules/optional-addon is a dangling symlink (-> x)',
          ],
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

describe('decideConcurrency', () => {
  // The machine this was measured on: 6 cores, 11.9GB, ~817MB peak per tsgo.
  const box = (mb: number) => ({ cores: 6, availableMb: mb })

  it('caps by MEMORY when memory is the scarce thing', () => {
    // The incident: load 90, 859MB available, turbo happily starting ten.
    expect(decideConcurrency([], box(859)).cap).toBe(1)
    // 5GB looks roomy and is not: the cap must not spend all of it, because the
    // daemon and every other session are in the same 12GB.
    expect(decideConcurrency([], box(5000)).cap).toBe(3)
  })

  it('reserves headroom for everything else on the box', () => {
    // Without a reserve, 2000MB would read as "two compilers", i.e. 1.8GB of the
    // 2GB left, and the daemon dies instead of the gate.
    expect(decideConcurrency([], box(2000)).cap).toBe(1)
  })

  it('caps by CORES when memory is plentiful, leaving one for everything else', () => {
    // 32GB would allow 35 by memory; the box still has six cores, and the daemon,
    // the live sessions and any running instance are on them too.
    expect(decideConcurrency([], box(32_000)).cap).toBe(5)
  })

  it('never proposes zero, however starved the box is', () => {
    // Refusing to run at all is the failure this cap exists to avoid, not a
    // safety feature: one at a time is slow, but it finishes.
    expect(decideConcurrency([], box(0)).cap).toBe(1)
    expect(decideConcurrency([], box(10)).cap).toBe(1)
  })

  it('gets out of the way when the caller sets --concurrency, in either spelling', () => {
    expect(decideConcurrency(['--concurrency=8'], box(859)).cap).toBeNull()
    expect(decideConcurrency(['--concurrency', '8'], box(859)).cap).toBeNull()
    // A different flag that merely starts the same way must NOT count as one.
    expect(decideConcurrency(['--concurrency-limit=8'], box(32_000)).cap).toBe(5)
  })
})

describe('availableMb', () => {
  it('reads MemAvailable, not MemFree', () => {
    // MemFree ignores reclaimable page cache and undercounts badly; a cap built on
    // it would serialise a machine that is actually fine. This box reported 221MB
    // free and 1540MB available at the same instant.
    const meminfo = ['MemTotal:       12244000 kB', 'MemFree:          226000 kB', 'MemAvailable:    1577000 kB', ''].join('\n')
    expect(availableMb(meminfo)).toBe(1540)
  })

  it('falls back rather than returning zero when the field is absent', () => {
    // A kernel without MemAvailable must not read as "no memory", which would
    // pin concurrency at 1 forever on every non-Linux host.
    expect(availableMb('MemTotal: 12244000 kB\n')).toBeGreaterThan(0)
  })
})
