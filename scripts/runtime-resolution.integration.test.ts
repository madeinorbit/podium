/**
 * Workspace imports must resolve from their declaring owner into this checkout,
 * independent of whether Bun installs a hoisted link or an isolated store chain.
 * The final test also keeps @podium/runtime's module identity load-bearing: two
 * copies mean two module-scoped WeakMaps and a database opened here is rejected by
 * the server migrator.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { applyBaselineSchema } from '../apps/server/src/migrations'
import { readWorkspaceResolutionCensus } from './workspace-resolution-census'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('workspace packages resolve inside this checkout', () => {
  it('resolves every declared edge and exercised subpath from its owner', () => {
    const census = readWorkspaceResolutionCensus(repoRoot)

    expect(census.errors).toEqual([])
    expect(census.records.length).toBeGreaterThan(0)
    expect(census.records).toEqual([...census.records].sort())
    for (const record of census.records) {
      const [owner, specifier, relativeRealpath] = record.split('\t')
      expect(owner).toMatch(/^@podium\//)
      expect(specifier).toMatch(/^@podium\//)
      expect(relativeRealpath).not.toMatch(/^\.\.\//)
    }
  })

  it('keeps conflicting third-party versions scoped to their declaring workspace', () => {
    const conflicts = [
      { workspace: 'apps/mobile', packageName: 'react' },
      { workspace: 'apps/mobile', packageName: 'react-dom' },
      { workspace: 'packages/client-core', packageName: '@types/node' },
      { workspace: 'packages/terminal-client-react', packageName: '@types/node' },
    ] as const
    const rootRequire = createRequire(join(repoRoot, 'package.json'))

    for (const { workspace, packageName } of conflicts) {
      const workspaceManifest = join(repoRoot, workspace, 'package.json')
      const workspacePackage = JSON.parse(readFileSync(workspaceManifest, 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      expect(
        workspacePackage.dependencies?.[packageName] ??
          workspacePackage.devDependencies?.[packageName],
        `${workspace} must declare ${packageName} for this isolation check to be meaningful`,
      ).toBeDefined()

      const workspaceRequire = createRequire(workspaceManifest)
      const workspaceResolved = realpathSync(
        workspaceRequire.resolve(`${packageName}/package.json`),
      )
      const expectedLocal = realpathSync(
        join(repoRoot, workspace, 'node_modules', ...packageName.split('/'), 'package.json'),
      )
      expect(
        workspaceResolved,
        `${workspace} resolved ${packageName} through the hoisted root copy`,
      ).toBe(expectedLocal)

      const rootResolved = realpathSync(rootRequire.resolve(`${packageName}/package.json`))
      const workspaceVersion = JSON.parse(readFileSync(workspaceResolved, 'utf8')).version
      const rootVersion = JSON.parse(readFileSync(rootResolved, 'utf8')).version
      expect(
        workspaceVersion,
        `${workspace}'s ${packageName} no longer conflicts with the root version`,
      ).not.toBe(rootVersion)
    }
  })
})

describe('@podium/runtime resolves to one instance (#746)', () => {
  it('the migrator recognises a database this file opened', () => {
    // openDatabase registers the handle in the runtime copy this file loaded;
    // applyBaselineSchema reads it through apps/server's copy. If resolution
    // produces two module instances, their module-scoped WeakMaps differ and the
    // migrator rejects this handle.

    const db = openDatabase(':memory:')
    expect(() => applyBaselineSchema(db)).not.toThrow()
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().length,
    ).toBeGreaterThan(0)
  })
})
