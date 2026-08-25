/**
 * Install-topology census (POD-2774): the install that is actually on disk, folded
 * into the turbo cache key, plus the refusal for an install that is already broken.
 *
 * PODIUM_CHECK_ENV_HASH used to fingerprint the tracked bunfig.toml alone. That file
 * states an intent; it is not a record of what happened. The global-store canary
 * installs its candidate worktree through an external `--config` file and never
 * touches the tracked bunfig, so a hoisted checkout and an isolated global-store
 * checkout are byte-identical there and share one cache identity — a green produced
 * under one linker replays under the other. `--linker=` on the command line, a
 * `-c/--config` override, and $HOME/.bunfig.toml are all invisible to a later
 * `bun run typecheck`, so the only honest witness at check time is the tree the
 * installer left behind, read alongside the config Bun would apply to the next install.
 *
 * Every record here is deliberately path-independent. The point of the fingerprint is
 * that two sibling worktrees, installed independently but the same way, agree — that is
 * what lets them share one durable Turbo cache. So a symlink is recorded by its relative
 * link text where it has one, and otherwise only by the class of its target (inside this
 * checkout, or external). An external target is the global store; which store it is does
 * not change what resolves, and bun.lock — already a turbo globalDependency — pins the
 * content. Recording absolute store paths would split the cache per host for no
 * correctness gain.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { workspaceDirectories } from './workspace-resolution-census'

export interface InstallTopology {
  /** `<source>\t<sha256|absent>` for every bunfig Bun would consult, in precedence order. */
  config: string[]
  /** Sorted `<install-root>\t<entry>\t<kind>\t<detail>` records for the linked tree. */
  layout: string[]
  /** Sorted, human-readable topology refusals. */
  errors: string[]
}

/** Bun reads $cwd/bunfig.toml and $HOME/.bunfig.toml; `-c` overrides only the former. */
export function configSources(root: string, home = homedir()): string[] {
  return [
    ['local', join(root, 'bunfig.toml')],
    ['global', join(home, '.bunfig.toml')],
  ].map(([label, path]) => {
    const source = path as string
    if (!existsSync(source)) return `${label}\tabsent`
    return `${label}\t${createHash('sha256').update(readFileSync(source)).digest('hex')}`
  })
}

function portable(path: string): string {
  return path.split(sep).join('/')
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/**
 * The node_modules trees an install writes: the checkout root, every workspace, and —
 * for an isolated install — the `.bun` store directory and each package's link farm
 * inside it. A hoisted install has no `.bun`, so this costs one readdir per workspace.
 */
export function installRoots(root: string, workspaces: string[]): string[] {
  const roots: string[] = []
  for (const directory of [root, ...workspaces]) {
    const modules = join(directory, 'node_modules')
    if (!existsSync(modules)) continue
    roots.push(modules)
    const store = join(modules, '.bun')
    if (!existsSync(store)) continue
    roots.push(store)
    for (const entry of readdirSync(store, { withFileTypes: true })) {
      // Bun names store entries `<pkg>@<version>`, which for a scoped package nests one
      // directory deeper (`@scope/name@version`). Open that level so scoped packages get
      // the same link-farm scrutiny unscoped ones do.
      const nested = entry.name.startsWith('@')
        ? readdirSync(join(store, entry.name), { withFileTypes: true }).map((child) =>
            join(entry.name, child.name),
          )
        : [entry.name]
      for (const relativeEntry of nested) {
        const farm = join(store, relativeEntry, 'node_modules')
        if (existsSync(farm)) roots.push(farm)
      }
    }
  }
  return roots.sort()
}

/**
 * One record per linked entry. `@scope` and `.bin` are containers rather than packages,
 * so they are opened one level; `.bun` is recorded as an entry here and walked as its
 * own install root, which keeps this enumeration one level deep everywhere.
 */
function describeEntries(
  checkout: string,
  installRoot: string,
  layout: string[],
  errors: string[],
): void {
  const rootLabel = portable(relative(checkout, installRoot))
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = `${prefix}${entry.name}`
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const linkText = readlinkSync(path)
        let detail: string
        if (!isAbsolute(linkText)) detail = portable(linkText)
        else {
          try {
            const target = realpathSync(path)
            detail = isInside(checkout, target)
              ? `checkout:${portable(relative(checkout, target))}`
              : 'external'
          } catch {
            detail = 'external'
          }
        }
        layout.push(`${rootLabel}\t${name}\tl\t${detail}`)
        try {
          statSync(path)
        } catch {
          errors.push(
            `install topology: ${rootLabel}/${name} is a dangling symlink (-> ${portable(linkText)})`,
          )
        }
        continue
      }
      if (entry.isDirectory()) {
        if (prefix === '' && (entry.name.startsWith('@') || entry.name === '.bin')) {
          layout.push(`${rootLabel}\t${name}\td\t-`)
          visit(path, `${name}/`)
          continue
        }
        layout.push(`${rootLabel}\t${name}\td\t-`)
        continue
      }
      layout.push(`${rootLabel}\t${name}\t${entry.isFile() ? 'f' : 'o'}\t-`)
    }
  }
  visit(installRoot, '')
}

export function readInstallTopology(root: string, home = homedir()): InstallTopology {
  const checkout = realpathSync(root)
  const layout: string[] = []
  const errors: string[] = []
  const roots = installRoots(checkout, workspaceDirectories(checkout))
  if (!roots.some((installRoot) => installRoot === join(checkout, 'node_modules'))) {
    errors.push('install topology: node_modules is missing; there is no install to trust')
  }
  for (const installRoot of roots) describeEntries(checkout, installRoot, layout, errors)
  return {
    config: configSources(checkout, home),
    layout: layout.sort(),
    errors: [...new Set(errors)].sort(),
  }
}
