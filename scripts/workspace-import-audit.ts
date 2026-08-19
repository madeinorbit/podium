/**
 * Repository-wide audit for imports of Podium workspace packages.
 *
 * The architecture boundary checker predates fixture workspaces and deliberately
 * limits its declared-dependency rule to workspace `src` directories. This audit
 * covers every source-shaped file below every root workspace pattern, including
 * tests, build configuration, and fixture entrypoints. A missing edge is dangerous
 * even for a type-only import: a hoisted install can satisfy it by walking into a
 * neighbouring checkout while an isolated install correctly leaves it unresolved.
 *
 * Run the resolution half with the source export condition enabled:
 *
 *   bun --conditions=@podium/source scripts/workspace-import-audit.ts --resolve
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_FILE_RE = /(?:\.(?:[cm]?[jt]s|[jt]sx)|\.(?:[jt]s)\.txt)$/
const SKIP_DIRS = new Set([
  '.git',
  '.turbo',
  '.expo',
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
  exports?: string | Record<string, unknown>
}

export interface Workspace {
  dir: string
  manifestPath: string
  manifest: PackageManifest
}

export interface WorkspaceImport {
  file: string
  specifier: string
  packageName: string
  owner: Workspace | null
  target: Workspace
}

export interface AuditViolation {
  file: string
  specifier: string
  message: string
}

export interface WorkspaceImportAudit {
  imports: WorkspaceImport[]
  declarationViolations: AuditViolation[]
  resolutionViolations: AuditViolation[]
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function expandWorkspaceRoots(repoRoot: string, patterns: readonly string[]): string[] {
  const roots = new Set<string>()
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      const dir = join(repoRoot, pattern)
      if (existsSync(dir)) roots.add(resolve(dir))
      continue
    }
    const parent = join(repoRoot, pattern.slice(0, -2))
    if (!existsSync(parent)) continue
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.add(resolve(parent, entry.name))
    }
  }
  return [...roots].sort()
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(join(dir, entry.name))
      continue
    }
    if (entry.isFile() && SOURCE_FILE_RE.test(entry.name)) yield join(dir, entry.name)
  }
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, lead: string) => lead + ' '.repeat(match.length - lead.length),
    )
}

function workspacePackageName(specifier: string): string | null {
  const match = specifier.match(/^(@podium\/[A-Za-z0-9._-]+)(?:\/|$)/)
  return match?.[1] ?? null
}

/** Static imports/exports, dynamic imports, require(), and common module mocks. */
export function extractWorkspaceSpecifiers(source: string): string[] {
  const stripped = stripComments(source)
  const specifiers = new Set<string>()
  const moduleName = '(@podium\/[A-Za-z0-9._/-]+)'
  const patterns = [
    new RegExp(
      `\\b(?:import|export)\\s+[^\x27\x22;]+?\\s+from\\s*[\x27\x22]${moduleName}[\x27\x22]`,
      'g',
    ),
    new RegExp(`(?:^|[\\n;{}])\\s*import\\s*[\x27\x22]${moduleName}[\x27\x22]`, 'g'),
    new RegExp(`\\b(?:require|import)\\s*\\(\\s*[\x27\x22]${moduleName}[\x27\x22]`, 'g'),
    new RegExp(
      `\\b(?:vi|jest)\\.(?:mock|doMock|unmock)\\s*\\(\\s*[\x27\x22]${moduleName}[\x27\x22]`,
      'g',
    ),
    new RegExp(`\\bmock\\.module\\s*\\(\\s*[\x27\x22]${moduleName}[\x27\x22]`, 'g'),
  ]
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) specifiers.add(specifier)
    }
  }
  return [...specifiers].sort()
}

type SourceLoader = 'js' | 'jsx' | 'ts' | 'tsx'

const transpilers = new Map<SourceLoader, Bun.Transpiler>()

function loaderFor(file: string): SourceLoader {
  if (/\.tsx(?:\.txt)?$/.test(file)) return 'tsx'
  if (/\.jsx$/.test(file)) return 'jsx'
  if (/\.(?:[cm]?js|js\.txt)$/.test(file)) return 'js'
  return 'ts'
}

function extractResolvableWorkspaceSpecifiers(source: string, file: string): string[] {
  const loader = loaderFor(file)
  let transpiler = transpilers.get(loader)
  if (!transpiler) {
    transpiler = new Bun.Transpiler({ loader })
    transpilers.set(loader, transpiler)
  }
  return [
    ...new Set(
      transpiler
        .scan(source)
        .imports.map((entry) => entry.path)
        .filter((specifier) => specifier.startsWith('@podium/')),
    ),
  ].sort()
}

function exportsSpecifier(
  manifest: PackageManifest,
  packageName: string,
  specifier: string,
): boolean {
  const key = specifier === packageName ? '.' : `.${specifier.slice(packageName.length)}`
  const exports = manifest.exports
  if (typeof exports === 'string') return key === '.'
  if (!exports) return false
  const keys = Object.keys(exports)
  return keys.some((entry) => entry.startsWith('.')) ? key in exports : key === '.'
}

function declaredVersion(manifest: PackageManifest, packageName: string): string | undefined {
  for (const field of DEPENDENCY_FIELDS) {
    const version = manifest[field]?.[packageName]
    if (version !== undefined) return version
  }
  return undefined
}

function displayPath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/')
}

function inside(path: string, directory: string): boolean {
  const rel = relative(directory, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function auditWorkspaceImports(
  repoRoot: string,
  options: { resolveImports?: boolean } = {},
): WorkspaceImportAudit {
  const root = resolve(repoRoot)
  const rootManifest = readManifest(join(root, 'package.json'))
  const workspaceRoots = expandWorkspaceRoots(root, rootManifest.workspaces ?? [])
  const workspaces = workspaceRoots.flatMap((dir): Workspace[] => {
    const manifestPath = join(dir, 'package.json')
    return existsSync(manifestPath)
      ? [{ dir, manifestPath, manifest: readManifest(manifestPath) }]
      : []
  })
  const packageTargets = new Map(
    workspaces.flatMap((workspace) =>
      workspace.manifest.name ? [[workspace.manifest.name, workspace] as const] : [],
    ),
  )
  const ownerByDir = new Map(workspaces.map((workspace) => [workspace.dir, workspace]))
  const imports: WorkspaceImport[] = []
  const declarationViolations: AuditViolation[] = []
  const resolutionViolations: AuditViolation[] = []
  const resolvedFrom = new Set<string>()

  for (const candidateRoot of workspaceRoots) {
    const owner = ownerByDir.get(candidateRoot) ?? null
    for (const absoluteFile of sourceFiles(candidateRoot)) {
      const file = displayPath(root, absoluteFile)
      const source = readFileSync(absoluteFile, 'utf8')
      if (!source.includes('@podium/')) continue
      const executable = options.resolveImports
        ? new Set(extractResolvableWorkspaceSpecifiers(source, file))
        : null
      for (const specifier of extractWorkspaceSpecifiers(source)) {
        const packageName = workspacePackageName(specifier)
        const target = packageName ? packageTargets.get(packageName) : undefined
        // @podium/source is an export condition, not a package in this workspace.
        if (!packageName || !target) continue
        if (
          !executable?.has(specifier) &&
          !exportsSpecifier(target.manifest, packageName, specifier)
        )
          continue
        const record = { file, specifier, packageName, owner, target }
        imports.push(record)

        if (owner === null) {
          declarationViolations.push({
            file,
            specifier,
            message: `${file} imports ${specifier} but ${displayPath(root, candidateRoot)} has no owning workspace package.json`,
          })
        } else if (owner !== target) {
          const version = declaredVersion(owner.manifest, packageName)
          if (version !== 'workspace:*') {
            declarationViolations.push({
              file,
              specifier,
              message:
                `${file} imports ${specifier} but ${displayPath(root, owner.manifestPath)} ` +
                `${version === undefined ? 'does not declare it' : `declares ${packageName} as ${version}, not workspace:*`}`,
            })
          }
        }

        const resolutionKey = `${candidateRoot}\0${specifier}`
        if (
          !options.resolveImports ||
          !executable?.has(specifier) ||
          resolvedFrom.has(resolutionKey)
        )
          continue
        resolvedFrom.add(resolutionKey)
        try {
          const resolved = realpathSync(Bun.resolveSync(specifier, dirname(absoluteFile)))
          const expected = realpathSync(target.dir)
          if (!inside(resolved, expected) || !inside(resolved, join(expected, 'src'))) {
            resolutionViolations.push({
              file,
              specifier,
              message:
                `${file} resolves ${specifier} to ${resolved}; expected @podium/source ` +
                `inside ${join(expected, 'src')}`,
            })
          }
        } catch (error) {
          resolutionViolations.push({
            file,
            specifier,
            message: `${file} cannot resolve ${specifier} under @podium/source: ${String(error)}`,
          })
        }
      }
    }
  }

  return {
    imports: imports.sort((a, b) =>
      `${a.file}\0${a.specifier}`.localeCompare(`${b.file}\0${b.specifier}`),
    ),
    declarationViolations,
    resolutionViolations,
  }
}

function formatViolations(violations: readonly AuditViolation[]): string {
  return violations.map((violation) => `- ${violation.message}`).join('\n')
}

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const resolveImports = process.argv.includes('--resolve')
  const audit = auditWorkspaceImports(repoRoot, { resolveImports })
  const violations = [
    ...audit.declarationViolations,
    ...(resolveImports ? audit.resolutionViolations : []),
  ]
  if (violations.length > 0) {
    console.error(formatViolations(violations))
    process.exit(1)
  }
  console.log(
    `workspace import audit passed: ${audit.imports.length} imports are declared` +
      (resolveImports ? ' and resolve to this checkout source' : ''),
  )
}
