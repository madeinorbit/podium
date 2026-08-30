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
 * what lets them share one durable Turbo cache. A symlink is normally recorded by its
 * relative link text where it has one, and otherwise only by the class of its target
 * (inside this checkout, or external). The one conservative normalization is a healthy,
 * uniquely manifest-validated executable shim in an isolated peer-context `.bin`: Bun
 * may materialize those nondeterministically, and workspace tasks cannot resolve through
 * them. They are still traversed and validated before being omitted. An external target
 * is the global store; which store it is does not change what resolves, and bun.lock —
 * already a turbo globalDependency — pins the content. Recording absolute store paths
 * would split the cache per host for no correctness gain.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

type RootKind = 'modules' | 'store'
interface Discovered {
  path: string
  kind: RootKind
}

type PackageManifest = {
  name?: unknown
  bin?: unknown
}

/**
 * Bun adds a peer-resolution suffix to isolated-store contexts. The executable links
 * inside those contexts are install-time conveniences for package lifecycle scripts;
 * unlike root/workspace `.bin`, they are not a command surface a workspace task sees.
 * Bun 1.3.14 can nondeterministically materialize a healthy subset of them on repeated
 * frozen installs, so only this exact context shape is eligible for normalization.
 */
function isPeerContextModules(checkout: string, installRoot: string): boolean {
  const parts = portable(relative(checkout, installRoot)).split('/')
  return (
    parts.length === 4 &&
    parts[0] === 'node_modules' &&
    parts[1] === '.bun' &&
    /\+[0-9a-f]{16}$/.test(parts[2] ?? '') &&
    parts[3] === 'node_modules'
  )
}

/**
 * Expected executables are derived independently of the shim being checked. Reading
 * the target's own package.json would let a wrong link nominate itself as correct.
 * Instead, enumerate every package Bun linked into the peer context and accept a
 * command only when package metadata names exactly one resolved executable for it.
 * Ambiguous commands and installer rewrites (notably esbuild's native binary) remain
 * layout records: if metadata cannot prove the omission, identity stays conservative.
 */
function manifestBins(manifest: PackageManifest): Record<string, unknown> {
  if (typeof manifest.bin === 'string' && typeof manifest.name === 'string') {
    return { [basename(manifest.name)]: manifest.bin }
  }
  return manifest.bin !== null && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
    ? (manifest.bin as Record<string, unknown>)
    : {}
}

function expectedExecutables(installRoot: string): Map<string, string[]> {
  const candidates = new Map<string, Set<string>>()
  const packageRoots: string[] = []
  for (const entry of readdirSync(installRoot, { withFileTypes: true })) {
    if (entry.name === '.bin') continue
    const path = join(installRoot, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of readdirSync(path)) packageRoots.push(join(path, child))
    } else {
      packageRoots.push(path)
    }
  }

  for (const packageRoot of packageRoots) {
    try {
      const root = realpathSync(packageRoot)
      const manifest = JSON.parse(
        readFileSync(join(root, 'package.json'), 'utf8'),
      ) as PackageManifest
      const declared = manifestBins(manifest)
      for (const [command, value] of Object.entries(declared)) {
        if (typeof value !== 'string') continue
        const lexicalTarget = resolve(root, value)
        if (!isInside(root, lexicalTarget)) continue
        const target = realpathSync(lexicalTarget)
        const stat = statSync(target)
        if (!stat.isFile() || (stat.mode & 0o111) === 0) continue
        const forCommand = candidates.get(command) ?? new Set<string>()
        forCommand.add(target)
        candidates.set(command, forCommand)
      }
    } catch {
      // An unreadable/malformed manifest can never justify omitting a layout record.
    }
  }
  return new Map([...candidates].map(([command, targets]) => [command, [...targets].sort()]))
}

/**
 * Whether the package that owns the resolved target can judge this command. A package
 * with no bin metadata is opaque: Bun's native esbuild rewrite has exactly that shape,
 * so it stays hashed. A manifest that does declare bins can positively contradict a
 * link to another command or another file, which is a sound admission refusal.
 */
function targetManifestJudgment(
  actual: string,
  command: string,
): 'matches' | 'contradicts' | 'opaque' {
  let cursor = dirname(actual)
  while (cursor !== dirname(cursor)) {
    const path = join(cursor, 'package.json')
    if (existsSync(path)) {
      try {
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
        const bins = manifestBins(manifest)
        if (Object.keys(bins).length === 0) return 'opaque'
        const declared = bins[command]
        if (typeof declared !== 'string') return 'contradicts'
        const lexicalTarget = resolve(cursor, declared)
        if (!isInside(cursor, lexicalTarget)) return 'contradicts'
        return realpathSync(lexicalTarget) === actual ? 'matches' : 'contradicts'
      } catch {
        return 'opaque'
      }
    }
    cursor = dirname(cursor)
  }
  return 'opaque'
}

/**
 * What the INSTALLER wrote, and only that.
 *
 * A node_modules root also accumulates tool output — `.cache`, `.vite`, `.vite-temp`
 * appear the first time something builds or tests. Folding those into the cache identity
 * would be self-defeating in both directions: a worktree's own second run would miss
 * because its first run created them, and a freshly installed sibling could never match a
 * worktree that had already been used. So an entry counts as install topology only when it
 * is a symlink (a link IS the topology, and a dangling one is the fault this refuses), one
 * of the installer's own containers (`.bin`, `.bun`, an `@scope` directory), or a directory
 * that carries a package.json. Everything else is somebody's scratch space.
 *
 * A package directory that has lost its package.json is skipped by that rule. It is not a
 * silent pass: nothing there resolves, so the typecheck it would have served goes red on
 * its own rather than green from the cache.
 *
 * One node_modules tree, one level deep. `@scope` and `.bin` are containers rather than
 * packages so they are opened here; anything deeper arrives by being an install root in
 * its own right, which lets the caller deduplicate. That matters: in an isolated layout
 * `node_modules/foo` and `.bun/foo@1.0.0/node_modules/foo` are one directory under two
 * names. The store (`kind: 'store'`) holds `<pkg>@<version>` roots rather than packages,
 * so the package.json rule does not apply to its entries.
 */
function describeEntries(
  checkout: string,
  installRoot: string,
  kind: RootKind,
  layout: string[],
  errors: string[],
): Discovered[] {
  const rootLabel = portable(relative(checkout, installRoot))
  const discovered: Discovered[] = []
  const peerExecutables = isPeerContextModules(checkout, installRoot)
    ? expectedExecutables(installRoot)
    : null
  const record = (name: string, type: string, detail: string): void => {
    layout.push(`${rootLabel}\t${name}\t${type}\t${detail}`)
  }
  const follow = (path: string): void => {
    if (existsSync(join(path, 'node_modules'))) {
      discovered.push({ path: join(path, 'node_modules'), kind: 'modules' })
    }
  }
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = `${prefix}${entry.name}`
      const path = join(directory, entry.name)
      const container = prefix === '' && entry.name.startsWith('@')

      if (entry.isSymbolicLink()) {
        // Keep traversal and identity separate. Even an eligible shim is explicitly
        // lstat/readlink/followed before a decision is made about its layout record.
        lstatSync(path)
        const linkText = readlinkSync(path)
        let targetStat: ReturnType<typeof statSync>
        try {
          targetStat = statSync(path)
        } catch {
          errors.push(
            `install topology: ${rootLabel}/${name} is a dangling symlink (-> ${portable(linkText)})`,
          )
          record(name, 'l', classify(checkout, path, linkText))
          continue
        }
        follow(path)
        if (prefix === '.bin/' && peerExecutables) {
          const nestedCommand = entry.name
          const expected = peerExecutables.get(nestedCommand) ?? []
          // Only a unique package-metadata answer can make this shim non-identity-bearing.
          if (expected.length === 1) {
            const actual = realpathSync(path)
            const expectedTarget = expected[0] as string
            if (!targetStat.isFile() || (targetStat.mode & 0o111) === 0) {
              errors.push(
                `install topology: ${rootLabel}/${name} does not point to an executable file ` +
                  `(-> ${portable(linkText)})`,
              )
            } else if (actual === expectedTarget) {
              continue
            } else if (targetManifestJudgment(actual, nestedCommand) !== 'opaque') {
              errors.push(
                `install topology: ${rootLabel}/${name} points to the wrong executable ` +
                  `(-> ${portable(linkText)}; expected ${portable(relative(directory, expectedTarget))})`,
              )
            }
          }
        }
        record(name, 'l', classify(checkout, path, linkText))
        continue
      }

      if (!entry.isDirectory()) continue

      if (prefix === '' && kind === 'modules' && entry.name === '.bun') {
        // An isolated install's store: walked as a root of its own, where each entry
        // leads on to that package's link farm.
        record(name, 'd', '-')
        discovered.push({ path, kind: 'store' })
        continue
      }
      if (container || (prefix === '' && kind === 'modules' && entry.name === '.bin')) {
        record(name, 'd', '-')
        visit(path, `${name}/`)
        continue
      }
      if (kind === 'modules' && !existsSync(join(path, 'package.json'))) continue
      record(name, 'd', '-')
      follow(path)
    }
  }
  visit(installRoot, '')
  return discovered
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
  // workspace: nested hoisted trees, the isolated `.bun` store, and its per-package link
  // farms all arrive here by being pointed at. Deduplicating by realpath keeps a
  // symlinked alias from being walked twice and makes a link cycle terminate.
  const pending: Discovered[] = [root, ...workspaceDirectories(checkout)].map((directory) => ({
    path: join(directory, 'node_modules'),
    kind: 'modules' as RootKind,
  }))
  if (!existsSync(join(checkout, 'node_modules'))) {
    errors.push('install topology: node_modules is missing; there is no install to trust')
  }
  const seen = new Set<string>()
  while (pending.length > 0) {
    const next = pending.shift() as Discovered
    if (!existsSync(next.path)) continue
    const identity = realpathSync(next.path)
    if (seen.has(identity)) continue
    seen.add(identity)
    pending.push(...describeEntries(checkout, next.path, next.kind, layout, errors))
  }
  return {
    config: configSources(checkout, home),
    layout: layout.sort(),
    errors: [...new Set(errors)].sort(),
  }
}
