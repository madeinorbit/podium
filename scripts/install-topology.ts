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
 * One record per linked entry of one node_modules tree, plus the node_modules trees that
 * tree leads to. `@scope` and `.bin` are containers rather than packages, so they are
 * opened one level; everything deeper is reached by being an install root in its own
 * right, which keeps this enumeration one level deep everywhere and lets the caller
 * deduplicate. That matters: in an isolated layout `node_modules/foo` and
 * `node_modules/.bun/foo@1.0.0/node_modules/foo` are the same directory by two names.
 */
function describeEntries(
  checkout: string,
  installRoot: string,
  layout: string[],
  errors: string[],
): string[] {
  const rootLabel = portable(relative(checkout, installRoot))
  const children: string[] = []
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = `${prefix}${entry.name}`
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const linkText = readlinkSync(path)
        layout.push(`${rootLabel}\t${name}\tl\t${classify(checkout, path, linkText)}`)
        try {
          statSync(path)
        } catch {
          errors.push(
            `install topology: ${rootLabel}/${name} is a dangling symlink (-> ${portable(linkText)})`,
          )
          continue
        }
        if (existsSync(join(path, 'node_modules'))) children.push(join(path, 'node_modules'))
        continue
      }
      if (entry.isDirectory()) {
        layout.push(`${rootLabel}\t${name}\td\t-`)
        if (prefix === '' && entry.name === '.bun') {
          // An isolated install's store: a directory of `<pkg>@<version>` roots rather
          // than of packages, so it is walked as a root of its own and each entry there
          // leads on to that package's own link farm.
          children.push(path)
          continue
        }
        if (prefix === '' && (entry.name.startsWith('@') || entry.name === '.bin')) {
          visit(path, `${name}/`)
          continue
        }
        if (existsSync(join(path, 'node_modules'))) children.push(join(path, 'node_modules'))
        continue
      }
      layout.push(`${rootLabel}\t${name}\t${entry.isFile() ? 'f' : 'o'}\t-`)
    }
  }
  visit(installRoot, '')
  return children
}

/**
 * A relative link is recorded by its own text, which no checkout's path appears in.
 * An absolute one is recorded only by the class of its target, so two worktrees whose
 * packages come from stores at different paths still agree.
 */
function classify(checkout: string, path: string, linkText: string): string {
  if (!isAbsolute(linkText)) return portable(linkText)
  try {
    const target = realpathSync(path)
    return isInside(checkout, target)
      ? `checkout:${portable(relative(checkout, target))}`
      : 'external'
  } catch {
    return 'external'
  }
}

export function readInstallTopology(root: string, home = homedir()): InstallTopology {
  const checkout = realpathSync(root)
  const layout: string[] = []
  const errors: string[] = []
  // Every node_modules an install wrote, reached from the checkout root and each
  // workspace: nested hoisted trees, the isolated `.bun` store, and its per-package
  // link farms all arrive here by being pointed at. Deduplicating by realpath keeps a
  // symlinked alias from being walked twice and makes a link cycle terminate.
  const pending = [root, ...workspaceDirectories(checkout)].map((directory) =>
    join(directory, 'node_modules'),
  )
  if (!existsSync(join(checkout, 'node_modules'))) {
    errors.push('install topology: node_modules is missing; there is no install to trust')
  }
  const seen = new Set<string>()
  while (pending.length > 0) {
    const installRoot = pending.shift() as string
    if (!existsSync(installRoot)) continue
    const identity = realpathSync(installRoot)
    if (seen.has(identity)) continue
    seen.add(identity)
    pending.push(...describeEntries(checkout, installRoot, layout, errors))
  }
  return {
    config: configSources(checkout, home),
    layout: layout.sort(),
    errors: [...new Set(errors)].sort(),
  }
}
