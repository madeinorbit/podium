import { afterEach, describe, expect, it } from 'vitest'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  brokenSymlinks,
  canonicalizeFuturePath,
  CANDIDATE_BUNFIG,
  installCommand,
  measurePathUsage,
  metadataDigest,
  projectFleetUsage,
  runtimeEnv,
  type CanaryOptions,
  validateCanaryOptions,
  validateStorageDevices,
} from './global-store-canary'

const scratch: string[] = []

function temporary(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(path)
  return path
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

function options(root: string): CanaryOptions {
  const sourceRoot = join(root, 'repo')
  const scratchParent = join(root, 'scratch')
  const bun = join(root, '.bun', 'bin', 'bun')
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(scratchParent, { recursive: true })
  mkdirSync(join(root, '.bun', 'bin'), { recursive: true })
  writeFileSync(bun, '')
  return {
    bun,
    cacheRoot: join(root, 'canary-cache'),
    currentRef: 'HEAD',
    divergentRef: 'HEAD^',
    fleetSize: 3,
    output: join(sourceRoot, 'report.json'),
    runId: 'unit',
    scratchParent,
    sourceRoot,
  }
}

describe('global-store canary boundaries', () => {
  it('keeps the tracked default aligned with the qualified candidate topology', () => {
    const rootBunfig = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'bunfig.toml'),
      'utf8',
    )
    expect(rootBunfig).toContain('linker = "isolated"')
    expect(rootBunfig).toContain('globalStore = true')
    expect(rootBunfig).toContain('linkWorkspacePackages = true')
    expect(rootBunfig).toContain('auto = "disable"')
    expect(rootBunfig).toContain('hoist = false')
    expect(rootBunfig).not.toContain('linker = "hoisted"')
    expect(CANDIDATE_BUNFIG).toContain('linker = "isolated"')
    expect(CANDIDATE_BUNFIG).toContain('globalStore = true')
    expect(CANDIDATE_BUNFIG).toContain('linkWorkspacePackages = true')
    expect(CANDIDATE_BUNFIG).toContain('auto = "disable"')
    expect(CANDIDATE_BUNFIG).toContain('hoist = false')
  })

  it('puts the verified Bun and existing Cargo directories on nested script PATH', () => {
    const root = temporary('global-store-canary-cargo-')
    const cargoBin = join(root, '.cargo', 'bin')
    mkdirSync(cargoBin, { recursive: true })
    writeFileSync(join(cargoBin, 'cargo'), '')
    const env = runtimeEnv(
      '/opt/pinned-bun/bin/bun',
      { CANARY_MARKER: 'yes', PATH: '/usr/bin:/bin' },
      cargoBin,
    )
    expect(env.PATH?.split(':')).toEqual(['/opt/pinned-bun/bin', cargoBin, '/usr/bin', '/bin'])
    expect(env.CANARY_MARKER).toBe('yes')
  })

  it('does not duplicate an existing Cargo bin on nested script PATH', () => {
    const root = temporary('global-store-canary-cargo-')
    const cargoBin = join(root, '.cargo', 'bin')
    mkdirSync(cargoBin, { recursive: true })
    writeFileSync(join(cargoBin, 'cargo'), '')
    const env = runtimeEnv('/opt/pinned-bun/bin/bun', { PATH: `${cargoBin}:/usr/bin` }, cargoBin)
    expect(env.PATH?.split(':')).toEqual(['/opt/pinned-bun/bin', cargoBin, '/usr/bin'])
  })

  it('uses Bun value flags in their supported equals form', () => {
    expect(installCommand('/opt/bun', '/cache/control')).toEqual([
      '/opt/bun',
      'install',
      '--frozen-lockfile',
      '--cache-dir=/cache/control',
      '--linker=hoisted',
    ])
    expect(installCommand('/opt/bun', '/cache/candidate', '/tmp/canary.toml')).toEqual([
      '/opt/bun',
      'install',
      '--frozen-lockfile',
      '--cache-dir=/cache/candidate',
      '--config=/tmp/canary.toml',
      '--linker=isolated',
    ])
  })

  it('refuses cross-filesystem cache and worktree evidence', () => {
    expect(() =>
      validateStorageDevices('/durable/cache', '/tmp/worktrees', (path) =>
        path.startsWith('/durable') ? 1n : 2n,
      ),
    ).toThrow('must share one filesystem')
    expect(() =>
      validateStorageDevices('/durable/cache', '/durable/worktrees', () => 1n),
    ).not.toThrow()
  })

  it('refuses repository-local, production, and reused cache roots', () => {
    const root = temporary('global-store-canary-boundary-')
    const base = options(root)
    expect(() => validateCanaryOptions(base)).not.toThrow()
    expect(() =>
      validateCanaryOptions({ ...base, cacheRoot: join(base.sourceRoot, '.cache') }),
    ).toThrow('outside the repository')
    expect(() =>
      validateCanaryOptions({
        ...base,
        cacheRoot: join(root, '.bun', 'install', 'cache'),
      }),
    ).toThrow('production Bun cache')
    mkdirSync(join(root, '.bun', 'install', 'cache'), { recursive: true })
    const alias = join(root, 'cache-alias')
    symlinkSync(join(root, '.bun', 'install'), alias)
    expect(canonicalizeFuturePath(join(alias, 'cache', 'nested'))).toBe(
      join(root, '.bun', 'install', 'cache', 'nested'),
    )
    expect(() =>
      validateCanaryOptions({ ...base, cacheRoot: join(alias, 'cache', 'nested') }),
    ).toThrow('production Bun cache')
    mkdirSync(join(base.cacheRoot, 'runs', base.runId), { recursive: true })
    expect(() => validateCanaryOptions(base)).toThrow('run cache already exists')
  })
})

describe('global-store canary evidence', () => {
  it('separates hardlink-shared bytes and scales only checkout-exclusive bytes', () => {
    const root = temporary('global-store-canary-usage-')
    const cache = join(root, 'cache')
    const modules = join(root, 'node_modules')
    mkdirSync(cache)
    mkdirSync(modules)
    writeFileSync(join(cache, 'shared'), 'shared payload'.repeat(512))
    linkSync(join(cache, 'shared'), join(modules, 'shared'))
    linkSync(join(cache, 'shared'), join(modules, 'shared-again'))
    writeFileSync(join(modules, 'local'), 'local payload'.repeat(512))

    const usage = measurePathUsage(modules)
    const projection = projectFleetUsage(cache, modules, 7)
    const shared = statSync(join(cache, 'shared'))
    const local = statSync(join(modules, 'local'))
    const directory = statSync(modules)
    const sharedAllocation = shared.blocks * 512
    expect(usage.sharedAllocatedBytes).toBe(sharedAllocation)
    expect(usage.apparentBytes).toBe(shared.size * 2 + local.size + directory.size)
    expect(usage.uniqueAllocatedBytes).toBeGreaterThan(0)
    expect(projection.sharedCacheWorktreeBytes).toBeGreaterThan(0)
    expect(projection.worktreeExclusiveBytes).toBeGreaterThan(0)
    expect(projection.fleetPhysicalBytes).toBe(
      projection.cachePhysicalBytes + projection.worktreeExclusiveBytes * 7,
    )
  })

  it('digests metadata and reports publisher residue and broken links', () => {
    const root = temporary('global-store-canary-metadata-')
    mkdirSync(join(root, '.staging-publish'))
    writeFileSync(join(root, 'package'), 'one')
    symlinkSync('missing-target', join(root, 'broken'))

    const before = metadataDigest(root)
    expect(before.stagingResidue).toEqual(['.staging-publish'])
    expect(brokenSymlinks(root)).toEqual(['broken'])
    writeFileSync(join(root, 'package'), 'two')
    expect(metadataDigest(root).digest).not.toBe(before.digest)
  })
})
