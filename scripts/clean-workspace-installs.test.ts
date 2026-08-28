import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanWorkspaceInstalls, findWorkspaceInstalls } from './clean-workspace-installs'

describe('clean-workspace-installs', () => {
  const temps: string[] = []

  afterEach(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true })
    temps.length = 0
  })

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    temps.push(dir)
    return dir
  }

  it('removes root and workspace installs while preserving source files', () => {
    const root = scratch('linker-cleanup-repo-')
    const installs = [
      join(root, 'node_modules'),
      join(root, 'apps', 'web', 'node_modules'),
      join(root, 'packages', 'model', 'node_modules'),
    ]
    for (const install of installs) {
      mkdirSync(join(install, 'dependency'), { recursive: true })
      writeFileSync(join(install, 'dependency', 'package.json'), '{}')
    }
    mkdirSync(join(root, 'packages', 'model', 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', 'model', 'src', 'index.ts'), 'export {}\n')

    const removed = cleanWorkspaceInstalls(root)

    expect(removed.map(({ path }) => relative(root, path))).toEqual([
      'apps/web/node_modules',
      'node_modules',
      'packages/model/node_modules',
    ])
    for (const install of installs) expect(existsSync(install)).toBe(false)
    expect(existsSync(join(root, 'packages', 'model', 'src', 'index.ts'))).toBe(true)
  })

  it('never follows symlinks or removes their external targets', () => {
    const root = scratch('linker-cleanup-repo-')
    const outside = scratch('linker-cleanup-outside-')
    const sharedCache = join(outside, 'bun-cache')
    const escapedTree = join(outside, 'linked-workspace')
    mkdirSync(join(sharedCache, 'pkg'), { recursive: true })
    mkdirSync(join(escapedTree, 'node_modules', 'external-dependency'), { recursive: true })
    writeFileSync(join(sharedCache, 'pkg', 'artifact'), 'cached')
    writeFileSync(join(escapedTree, 'node_modules', 'external-dependency', 'package.json'), '{}')

    mkdirSync(join(root, 'packages', 'linked'), { recursive: true })
    symlinkSync(sharedCache, join(root, 'packages', 'linked', 'node_modules'), 'dir')
    symlinkSync(escapedTree, join(root, 'vendor'), 'dir')

    expect(findWorkspaceInstalls(root).map(({ kind }) => kind)).toEqual(['symlink'])
    cleanWorkspaceInstalls(root)

    expect(existsSync(join(root, 'packages', 'linked', 'node_modules'))).toBe(false)
    expect(readFileSync(join(sharedCache, 'pkg', 'artifact'), 'utf8')).toBe('cached')
    expect(existsSync(join(escapedTree, 'node_modules', 'external-dependency'))).toBe(true)
  })

  it('supports a non-mutating dry-run discovery pass', () => {
    const root = scratch('linker-cleanup-repo-')
    const install = join(root, 'services', 'worker', 'node_modules', 'dependency')
    mkdirSync(install, { recursive: true })

    expect(findWorkspaceInstalls(root).map(({ path }) => relative(root, path))).toEqual([
      'services/worker/node_modules',
    ])
    expect(existsSync(install)).toBe(true)
  })

  it('fails closed before mutation when node_modules is an unexpected file', () => {
    const root = scratch('linker-cleanup-repo-')
    const validInstall = join(root, 'node_modules', 'dependency')
    const unexpected = join(root, 'apps', 'web', 'node_modules')
    mkdirSync(validInstall, { recursive: true })
    mkdirSync(join(root, 'apps', 'web'), { recursive: true })
    writeFileSync(unexpected, 'not a package tree')

    expect(() => cleanWorkspaceInstalls(root)).toThrow('non-directory node_modules entry')
    expect(existsSync(validInstall)).toBe(true)
    expect(readFileSync(unexpected, 'utf8')).toBe('not a package tree')
  })
})
