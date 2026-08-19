import { existsSync, globSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const SKIPPED_DIRECTORIES = new Set([
  '.expo',
  '.git',
  '.turbo',
  'artifacts',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
])
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

interface PackageManifest {
  name?: string
  workspaces?: string[]
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface Workspace {
  directory: string
  manifestPath: string
  name: string
  dependencies: Map<string, string>
}

export interface WorkspaceResolutionCensus {
  /** Sorted owner/specifier/relative-realpath records. */
  records: string[]
  /** Sorted, human-readable contract violations. */
  errors: string[]
}

export type WorkspaceResolver = (specifier: string, ownerDirectory: string) => string

function packageName(specifier: string): string {
  const [scope, name] = specifier.split('/')
  return `${scope}/${name ?? ''}`
}

function portableRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/') || '.'
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function dependenciesOf(manifest: PackageManifest): Map<string, string> {
  const result = new Map<string, string>()
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) result.set(name, range)
  }
  return result
}

function workspaceManifests(root: string): string[] {
  const rootManifest = readManifest(join(root, 'package.json'))
  if (!Array.isArray(rootManifest.workspaces)) {
    throw new Error('root package.json must declare workspaces as an array')
  }
  return rootManifest.workspaces
    .flatMap((pattern) => globSync(`${pattern.replace(/\/$/, '')}/package.json`, { cwd: root }))
    .map((path) => join(root, path))
    .sort()
}

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
    }
  }
  visit(directory)
  return files
}

function loaderForSource(path: string): Bun.JavaScriptLoader {
  const extension = extname(path)
  if (extension === '.tsx') return 'tsx'
  if (extension === '.jsx') return 'jsx'
  if (extension === '.ts' || extension === '.mts' || extension === '.cts') return 'ts'
  return 'js'
}

function workspaceImports(workspace: Workspace, errors: string[]): Set<string> {
  const imports = new Set<string>()
  for (const file of sourceFiles(workspace.directory)) {
    try {
      const transpiler = new Bun.Transpiler({ loader: loaderForSource(file) })
      for (const imported of transpiler.scan(readFileSync(file)).imports) {
        if (imported.path.startsWith('@podium/')) imports.add(imported.path)
      }
    } catch (error) {
      errors.push(
        `${workspace.name}: could not inspect ${portableRelative(workspace.directory, file)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return imports
}

/**
 * Inspect every workspace from its own manifest directory. The resolver is Bun's
 * real resolver in production; injection exists only so narrow unit tests can
 * exercise diagnostics without constructing a node_modules tree.
 */
export function buildWorkspaceResolutionCensus(
  root: string,
  resolveSpecifier: WorkspaceResolver = Bun.resolveSync,
): WorkspaceResolutionCensus {
  const checkout = realpathSync(root)
  const errors: string[] = []
  const workspaces: Workspace[] = []
  const workspaceByName = new Map<string, Workspace>()

  for (const manifestPath of workspaceManifests(checkout)) {
    const manifest = readManifest(manifestPath)
    if (!manifest.name) {
      errors.push(`${portableRelative(checkout, manifestPath)}: workspace has no package name`)
      continue
    }
    const workspace: Workspace = {
      directory: realpathSync(dirname(manifestPath)),
      manifestPath,
      name: manifest.name,
      dependencies: dependenciesOf(manifest),
    }
    const previous = workspaceByName.get(workspace.name)
    if (previous) {
      errors.push(
        `${workspace.name}: duplicate workspace manifests ${portableRelative(checkout, previous.manifestPath)} and ${portableRelative(checkout, manifestPath)}`,
      )
      continue
    }
    workspaceByName.set(workspace.name, workspace)
    workspaces.push(workspace)
  }

  const records: string[] = []
  for (const owner of workspaces.sort((a, b) => a.name.localeCompare(b.name))) {
    const specifiers = new Set<string>()
    for (const [dependency, range] of owner.dependencies) {
      if (!dependency.startsWith('@podium/') || range !== 'workspace:*') continue
      specifiers.add(dependency)
      if (!workspaceByName.has(dependency)) {
        errors.push(`${owner.name}: declared workspace dependency ${dependency} has no workspace`)
      }
    }

    for (const specifier of workspaceImports(owner, errors)) {
      const dependency = packageName(specifier)
      const range = owner.dependencies.get(dependency)
      if (dependency !== owner.name) {
        if (range === undefined) {
          errors.push(`${owner.name}: import ${specifier} is not declared by its owner`)
        } else if (range !== 'workspace:*') {
          errors.push(
            `${owner.name}: import ${specifier} must declare ${dependency} with workspace:*`,
          )
        }
      }
      if (!workspaceByName.has(dependency)) {
        errors.push(`${owner.name}: import ${specifier} names no workspace package`)
      }
      specifiers.add(specifier)
    }

    for (const specifier of [...specifiers].sort()) {
      const target = workspaceByName.get(packageName(specifier))
      if (!target) continue
      let resolved: string
      try {
        resolved = realpathSync(resolveSpecifier(specifier, owner.directory))
      } catch {
        errors.push(`${owner.name}: ${specifier} is missing or dangling from its owner`)
        continue
      }
      const relativeRealpath = portableRelative(checkout, resolved)
      records.push(`${owner.name}\t${specifier}\t${relativeRealpath}`)
      if (!isInside(checkout, resolved)) {
        errors.push(
          `${owner.name}: ${specifier} resolves outside this checkout (${relativeRealpath})`,
        )
      } else if (!isInside(target.directory, resolved)) {
        errors.push(
          `${owner.name}: ${specifier} resolves to ${relativeRealpath}, not its owning workspace ${portableRelative(checkout, target.directory)}`,
        )
      }
    }
  }

  return {
    records: [...new Set(records)].sort(),
    errors: [...new Set(errors)].sort(),
  }
}

/** Resolve with the same @podium/source condition used by repository test lanes. */
export function readWorkspaceResolutionCensus(root: string): WorkspaceResolutionCensus {
  const worker = Bun.spawnSync([
    process.execPath,
    '--conditions=@podium/source',
    fileURLToPath(import.meta.url),
    '--worker',
    root,
  ])
  if (worker.exitCode !== 0) {
    const detail = new TextDecoder().decode(worker.stderr).trim()
    throw new Error(`workspace resolution census failed${detail ? `: ${detail}` : ''}`)
  }
  return JSON.parse(new TextDecoder().decode(worker.stdout)) as WorkspaceResolutionCensus
}

if (import.meta.main) {
  const [mode, root] = process.argv.slice(2)
  if (mode !== '--worker' || !root || !existsSync(join(root, 'package.json'))) {
    console.error('usage: workspace-resolution-census.ts --worker <workspace-root>')
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(buildWorkspaceResolutionCensus(root)))
}
