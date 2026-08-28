/**
 * Remove every checkout-local node_modules entry before changing Bun linkers.
 *
 * The walk is anchored to this script's checkout, never follows directory
 * symlinks, and unlinks a node_modules symlink without touching its target.
 * Bun's shared cache lives outside the checkout and is deliberately untouched.
 */

import { lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type InstallCleanupTarget = {
  path: string
  kind: 'directory' | 'symlink'
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to clean outside checkout: ${target}`)
  }
}

/** Find checkout-local node_modules entries without descending through symlinks. */
export function findWorkspaceInstalls(repoRoot: string): InstallCleanupTarget[] {
  const root = realpathSync(repoRoot)
  const targets: InstallCleanupTarget[] = []

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue

      const full = join(dir, entry.name)
      assertInside(root, full)

      if (entry.name === 'node_modules') {
        const stat = lstatSync(full)
        if (stat.isSymbolicLink()) {
          targets.push({ path: full, kind: 'symlink' })
        } else if (stat.isDirectory()) {
          targets.push({ path: full, kind: 'directory' })
        } else {
          throw new Error(`refusing to remove non-directory node_modules entry: ${full}`)
        }
        continue
      }

      // Dirent#isDirectory does not follow symlinks. Checking the link explicitly
      // documents the boundary and protects alternate Dirent implementations.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
    }
  }

  walk(root)
  return targets.sort((a, b) => a.path.localeCompare(b.path))
}

/** Remove the discovered entries. Symlinks are always unlinked, never recursed. */
export function cleanWorkspaceInstalls(repoRoot: string): InstallCleanupTarget[] {
  const root = realpathSync(repoRoot)
  const targets = findWorkspaceInstalls(root)

  for (const target of targets) {
    assertInside(root, target.path)
    const stat = lstatSync(target.path)
    if (stat.isSymbolicLink()) {
      unlinkSync(target.path)
    } else if (stat.isDirectory()) {
      rmSync(target.path, { recursive: true })
    } else {
      throw new Error(`refusing to remove non-directory node_modules entry: ${target.path}`)
    }
  }

  return targets
}

function displayPath(root: string, target: InstallCleanupTarget): string {
  return relative(root, target.path).split(sep).join('/')
}

function main(): number {
  const args = process.argv.slice(2)
  const dryRun = args.length === 1 && args[0] === '--dry-run'
  if (args.length > 0 && !dryRun) {
    console.error('usage: bun scripts/clean-workspace-installs.ts [--dry-run]')
    return 2
  }

  const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
  const targets = dryRun ? findWorkspaceInstalls(repoRoot) : cleanWorkspaceInstalls(repoRoot)
  const verb = dryRun ? 'would remove' : 'removed'

  for (const target of targets) {
    console.log(`[linker-cleanup] ${verb} ${target.kind}: ${displayPath(repoRoot, target)}`)
  }
  console.log(
    `[linker-cleanup] ${verb} ${targets.length} checkout-local node_modules entr${targets.length === 1 ? 'y' : 'ies'}; shared Bun cache untouched`,
  )
  return 0
}

if (import.meta.main) {
  process.exit(main())
}
