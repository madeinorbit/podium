import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { readdir, readFile as readFileAsync, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '@podium/logger'
import type { UpdateTarget } from '@podium/protocol'
import { resolveInstanceId } from '@podium/runtime/config'
import { devBuildScopeUnit, runLowTierBuild } from './build-scope'

const log = createLogger('server:updates')

/**
 * WHETHER TO BUILD A DEVELOPMENT BUNDLE.
 *
 * The development host is the LIVE host: the server, the daemon and every agent
 * session share it. A `bun build --compile` here competes with all of them, and
 * this repository merges many parallel branches a day, so "rebuild when HEAD
 * moves" would mean rebuilding constantly on the one machine that can least
 * afford it.
 *
 * So: never per-commit. Explicit, or debounced, and never two at once. Pure, so
 * the policy is a table of tests rather than a judgement call at a call site.
 */

export type BuildDecision =
  | {
      build: false
      reason: 'up-to-date' | 'debounced' | 'in-flight' | 'not-a-source-run'
    }
  | { build: true }

export interface DevBuildDecisionContext {
  isSourceRun: boolean
  headSha: string
  builtSha: string | null
  lastAttemptAt: number | null
  now: number
  inFlight: boolean
  debounceMs: number
  explicit: boolean
}

export function decideDevBuild(ctx: DevBuildDecisionContext): BuildDecision {
  if (!ctx.isSourceRun) return { build: false, reason: 'not-a-source-run' }
  if (ctx.builtSha === ctx.headSha) return { build: false, reason: 'up-to-date' }
  if (ctx.inFlight) return { build: false, reason: 'in-flight' }
  if (!ctx.explicit && ctx.lastAttemptAt !== null && ctx.now - ctx.lastAttemptAt < ctx.debounceMs) {
    return { build: false, reason: 'debounced' }
  }
  return { build: true }
}

/**
 * SOURCE IDENTITY.
 *
 * A development bundle is published as `dev+<sha>`, and every consumer — the
 * daemon that downloads it, the operator reading /version — takes that string
 * to mean "this was compiled from that commit". `scripts/build-bun.ts` compiles
 * the LIVE working tree, so an edited checkout would ship code that is not that
 * commit under a name that claims it is.
 *
 * This establishes SOURCE identity, not build reproducibility: two builds of
 * the same clean checkout can still differ byte for byte (bun version, resolved
 * dependencies, embedded paths). The guarantee is only that the source compiled
 * was the named commit — which is the claim `dev+<sha>` actually makes.
 *
 * So the check is fail-closed and runs before restore, before build, before
 * publication. Anything git reports as a difference from HEAD blocks it.
 *
 * WHAT IS ALLOWED, and why "ignored" is not the same as "safe". Ignored paths
 * never appear in `git status --porcelain`, so the first query passes over
 * `node_modules/`, output trees and the local signing key for free. That is a
 * cost argument, not a correctness one: an ignored `.ts` under a source tree is
 * still importable and would still be compiled in. A second, bounded query
 * (see `classifyIgnoredSourceInputs`) catches exactly that case, and the
 * allowlist below stays an explicit list of known non-source outputs rather
 * than a blanket "anything .gitignore covers". Untracked source files are a
 * difference too: `bun build` follows imports, so a new untracked module can
 * end up in the bytes.
 */
export const DEV_BUNDLE_ALLOWED_DIRTY_PREFIXES = ['dist-bun/'] as const

export interface SourceIdentityStatus {
  clean: boolean
  /** Repository-relative paths that make the tree differ from HEAD. */
  offending: string[]
}

/**
 * Pure classification of `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * NUL-delimited, deliberately: the newline form quotes and C-escapes unusual
 * paths and separates a rename with a literal ` -> `, which a path may itself
 * contain — an identity gate must not have to guess where a filename ends. In
 * `-z` output every path is a raw, unquoted field, and a rename or copy emits
 * its DESTINATION in the status field and its SOURCE as the next field.
 */
export function classifySourceIdentity(
  porcelain: string,
  allowedPrefixes: readonly string[] = DEV_BUNDLE_ALLOWED_DIRTY_PREFIXES,
): SourceIdentityStatus {
  const fields = porcelain.split('\0')
  const offending: string[] = []
  const add = (path: string) => {
    if (path === '') return
    if (allowedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix))) return
    if (!offending.includes(path)) offending.push(path)
  }
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? ''
    if (field === '') continue
    const status = field.slice(0, 2)
    add(field.slice(3))
    if (status.includes('R') || status.includes('C')) {
      // Consume the paired source field either way; a rename moves the source
      // away from where HEAD has it, so BOTH ends differ and an allowed
      // destination must not hide a disallowed origin. A copy leaves its
      // source untouched.
      const source = fields[++index] ?? ''
      if (status.includes('R')) add(source)
    }
  }
  return { clean: offending.length === 0, offending }
}

/**
 * THE SECOND QUERY: ignored files that are still source.
 *
 * `git status` never reports ignored paths, which is what makes the porcelain
 * check cheap — but "ignored" and "not compiled in" are different claims. An
 * ignored `.ts` under `apps/`, `packages/`, `scripts/` or `tooling/` can be
 * imported like any other module and land in the bundle, so treating every
 * ignored path as safe would leave dev+<sha> able to lie by exactly the route
 * the first check closes.
 *
 * Bounded on purpose: only the repository's own source trees, only extensions a
 * bundler will resolve, and never the output directories that make up the bulk
 * of what is ignored. Enumerating `node_modules` here would cost more than the
 * build.
 */
export const DEV_BUNDLE_SOURCE_TREES = ['apps', 'packages', 'scripts', 'tooling'] as const

/** Output and dependency trees, excluded from the ignored-source enumeration. */
export const DEV_BUNDLE_NON_SOURCE_TREES = [
  'node_modules',
  'dist',
  'dist-bun',
  'build',
  'coverage',
  'target',
  '.turbo',
  '.next',
] as const

/**
 * Generated inputs that are deliberately ignored and cannot affect the
 * headless development bundle. Keep this separate from the porcelain
 * allowlist: a tracked edit in these trees still differs from HEAD and must
 * block publication.
 */
export const DEV_BUNDLE_IGNORED_SOURCE_ALLOWED_PREFIXES = [
  ...DEV_BUNDLE_ALLOWED_DIRTY_PREFIXES,
  'apps/desktop/src-tauri/gen/',
  'apps/desktop/src-tauri/resources/web/',
  // Vite sourcemap archive index (POD-1957). JSON under apps/ is otherwise
  // treated as importable source; the headless compile never reads this tree.
  'apps/web/.sourcemaps/',
] as const

/** Extensions a bundler resolves from an import specifier. */
export const DEV_BUNDLE_SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.node',
  '.wasm',
] as const

/**
 * Pure classification of `git ls-files -z` output listing ignored files.
 */
export function classifyIgnoredSourceInputs(
  listing: string,
  allowedPrefixes: readonly string[] = DEV_BUNDLE_IGNORED_SOURCE_ALLOWED_PREFIXES,
): string[] {
  const offending: string[] = []
  for (const path of listing.split('\0')) {
    if (path === '') continue
    if (allowedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix))) continue
    const segments = path.split('/')
    if (
      segments.some((segment) =>
        (DEV_BUNDLE_NON_SOURCE_TREES as readonly string[]).includes(segment),
      )
    ) {
      continue
    }
    const dot = path.lastIndexOf('.')
    const extension = dot === -1 ? '' : path.slice(dot)
    if (!(DEV_BUNDLE_SOURCE_EXTENSIONS as readonly string[]).includes(extension)) continue
    if (!offending.includes(path)) offending.push(path)
  }
  return offending
}

function defaultReadIgnoredSourceInputs(root: string): string {
  const excludes = DEV_BUNDLE_NON_SOURCE_TREES.map((tree) => `:(exclude)**/${tree}/**`)
  const generatedExcludes = DEV_BUNDLE_IGNORED_SOURCE_ALLOWED_PREFIXES.map(
    (prefix) => `:(exclude)${prefix}**`,
  )
  return String(
    execFileSync(
      'git',
      [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ...DEV_BUNDLE_SOURCE_TREES,
        ...excludes,
        ...generatedExcludes,
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  )
}

function defaultReadSourceStatus(root: string): string {
  return String(
    execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
    }),
  )
}

/**
 * A refusal with two audiences.
 *
 * `message` is for the server console: it names the offending paths, because
 * the operator standing at the checkout needs to know which files to deal with.
 * `publicReason` is what the read model may show a Settings screen: the shape
 * of the problem and a count, never a path, never git or compiler output. The
 * two are deliberately not the same string — a reason that travels to a client
 * should not be a verbatim tool error.
 */
export class DevBundleUnavailableError extends Error {
  constructor(
    message: string,
    readonly publicReason: string,
  ) {
    super(message)
    this.name = 'DevBundleUnavailableError'
  }
}

/** The public half of any refusal, including one from an unexpected error. */
export function publicUnavailableReason(error: unknown, sha: string): string {
  if (error instanceof DevBundleUnavailableError) return error.publicReason
  return `Building the development bundle for dev+${sha} failed. See the server log.`
}

export function sourceIdentityDiagnostic(sha: string, offending: string[]): string {
  const shown = offending.slice(0, 5)
  const more = offending.length - shown.length
  return (
    'development bundle unavailable: the source checkout does not match HEAD (' +
    sha +
    '), so a dev+' +
    sha +
    ' artifact would not have been compiled from that commit. Commit or stash: ' +
    shown.join(', ') +
    (more > 0 ? ' (+' + more + ' more)' : '')
  )
}

/**
 * Throws unless the checkout is exactly HEAD. A git failure is itself a refusal
 * — an unreadable status cannot establish identity.
 */
export function assertSourceMatchesHead(
  root: string,
  sha: string,
  readSourceStatus: (root: string) => string = defaultReadSourceStatus,
  readIgnoredSourceInputs: (root: string) => string = defaultReadIgnoredSourceInputs,
): void {
  let porcelain: string
  try {
    porcelain = readSourceStatus(root)
  } catch (error) {
    throw new DevBundleUnavailableError(
      'development bundle unavailable: could not verify the source checkout against HEAD (' +
        sha +
        '): ' +
        (error instanceof Error ? error.message : String(error)),
      `The source checkout could not be verified against HEAD (${sha}).`,
    )
  }
  const status = classifySourceIdentity(porcelain)
  if (!status.clean) {
    const count = status.offending.length
    throw new DevBundleUnavailableError(
      sourceIdentityDiagnostic(sha, status.offending),
      `The source checkout has ${count} uncommitted ${count === 1 ? 'change' : 'changes'} and no ` +
        `longer matches HEAD (${sha}). Commit or stash them to publish dev+${sha}.`,
    )
  }

  let ignoredListing: string
  try {
    ignoredListing = readIgnoredSourceInputs(root)
  } catch (error) {
    throw new DevBundleUnavailableError(
      'development bundle unavailable: could not enumerate ignored source inputs for HEAD (' +
        sha +
        '): ' +
        (error instanceof Error ? error.message : String(error)),
      `The source checkout could not be verified against HEAD (${sha}).`,
    )
  }
  const ignoredSource = classifyIgnoredSourceInputs(ignoredListing)
  if (ignoredSource.length > 0) {
    const shown = ignoredSource.slice(0, 5)
    const more = ignoredSource.length - shown.length
    throw new DevBundleUnavailableError(
      'development bundle unavailable: ignored source files under the build trees can still be ' +
        `imported into a dev+${sha} bundle. Remove them or stop ignoring them: ` +
        shown.join(', ') +
        (more > 0 ? ` (+${more} more)` : ''),
      `The source checkout has ${ignoredSource.length} ignored source ` +
        `${ignoredSource.length === 1 ? 'file' : 'files'} that could be compiled into ` +
        `dev+${sha} without being part of HEAD (${sha}).`,
    )
  }
}

export const DEV_BUNDLE_LOCK_NAME = 'podium:dev-bundle'
export const DEV_ARTIFACT_ROUTE = '/updates/dev-bundle'

/**
 * A DESCRIPTOR, NEVER THE BUNDLE.
 *
 * A headless bundle is a quarter of a gigabyte, and the development host is the
 * live host — it runs this server, its daemon and every agent session. Holding
 * the tarball in the server's heap for the lifetime of the process (and twice
 * over for the length of a rebuild) is a cost nothing here needs to pay: the
 * digest is computed by streaming the file, and the artifact route streams it
 * again on request. What the process keeps is this descriptor, which is bytes
 * of metadata, not megabytes of payload.
 */
export interface BuiltDevBundle {
  version: string
  path: string
  size: number
  digest: string
  signature: string
}

/**
 * NAMING, so that "the previous one" is a fact on disk rather than a guess.
 *
 * `dev+<sha>` is the version a daemon sees and must stay exactly that — it is
 * the claim "compiled from that commit". The FILE, though, also carries the
 * moment it was built, which buys two things a bare sha cannot: rebuilding the
 * same commit produces a new file instead of silently overwriting the one a
 * request may be streaming, and retention can be ordered without stat-ing
 * anything or trusting mtimes that a copy or a restore would reset.
 *
 * The stamp is fixed-width and lexicographically ordered, so sorting the
 * directory listing IS sorting by build time.
 */
export const DEV_BUNDLE_PREFIX = 'podium-headless-dev+'
export const DEV_BUNDLE_SUFFIX = '.tar.gz'
export const DEV_BUNDLE_SIGNATURE_SUFFIX = '.sig'
export const DEV_BUNDLE_METADATA_SUFFIX = '.meta.json'

/**
 * HOW MANY BUNDLES SURVIVE A SWEEP.
 *
 * Only the current HEAD's bundle is reachable — `target()` withholds anything
 * else and the artifact route refuses it — so one would be enough to serve. The
 * second is kept deliberately for the human at the checkout: when a build makes
 * something worse, the bundle it replaced is still on disk to compare against.
 * Everything older is unreachable by construction and goes.
 */
export const DEV_BUNDLE_RETAINED = 2

const DEV_BUNDLE_NAME_PATTERN =
  /^podium-headless-dev\+([0-9a-f]{7,40})(?:-(\d{8}T\d{6}Z))?\.tar\.gz$/

export interface DevBundleFile {
  name: string
  sha: string
  /** Empty for a bundle built before builds were stamped; sorts oldest. */
  stamp: string
}

/** `20260812T182015Z` — fixed width, so string order is time order. */
export function devBundleStamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

/**
 * Recognise this build's own artifacts and NOTHING else.
 *
 * The retention sweep deletes whatever this returns a match for, so the pattern
 * is the safety boundary: `dev+<sha>` only, never a semver name. A release
 * tarball sits in the same directory and `scripts/release.ts` reads it by that
 * name.
 */
export function parseDevBundleName(name: string): DevBundleFile | null {
  const match = DEV_BUNDLE_NAME_PATTERN.exec(name)
  if (!match) return null
  return { name, sha: match[1] as string, stamp: match[2] ?? '' }
}

export function devBundleFileName(version: string, stamp: string): string {
  return `podium-headless-${version}-${stamp}${DEV_BUNDLE_SUFFIX}`
}

/** Newest first; an unstamped legacy artifact is oldest by definition. */
function byNewest(a: DevBundleFile, b: DevBundleFile): number {
  if (a.stamp !== b.stamp) return a.stamp < b.stamp ? 1 : -1
  return a.name < b.name ? 1 : -1
}

export function listDevBundles(names: readonly string[]): DevBundleFile[] {
  const parsed: DevBundleFile[] = []
  for (const name of names) {
    const entry = parseDevBundleName(name)
    if (entry) parsed.push(entry)
  }
  return parsed.sort(byNewest)
}

/**
 * WHAT A SWEEP DELETES, decided without touching the filesystem.
 *
 * Given a directory listing, the names that may go: every development bundle
 * outside the retention window, plus the sidecars belonging to each — and only
 * sidecars the listing actually shows, so the result is a list of files that
 * exist rather than a list of guesses.
 *
 * `protect` is belt and braces for the artifact currently being served. It is
 * always within the window in practice; naming it explicitly means a future
 * change to the ordering cannot make the sweep delete what it is publishing.
 */
export function selectDevBundleSweep(
  names: readonly string[],
  options: { keep?: number; protect?: readonly string[] } = {},
): string[] {
  const keep = options.keep ?? DEV_BUNDLE_RETAINED
  const present = new Set(names)
  const protectedNames = new Set(options.protect ?? [])
  const doomed: string[] = []
  listDevBundles(names).forEach((entry, index) => {
    if (index < keep || protectedNames.has(entry.name)) return
    doomed.push(entry.name)
    for (const suffix of [DEV_BUNDLE_SIGNATURE_SUFFIX, DEV_BUNDLE_METADATA_SUFFIX]) {
      if (present.has(entry.name + suffix)) doomed.push(entry.name + suffix)
    }
  })
  return doomed
}

/**
 * The filesystem this module needs, as a seam.
 *
 * Every operation is either on a small sidecar or a STREAM over the tarball;
 * there is deliberately no "read the bundle" verb, because a component that
 * cannot ask for the bytes cannot accidentally keep them.
 */
export interface DevBundleFs {
  list(dir: string): Promise<string[]>
  /** Streams the file; never materialises it. */
  digest(path: string): Promise<{ digest: string; size: number }>
  readText(path: string): Promise<string>
  writeText(path: string, contents: string): Promise<void>
  remove(path: string): Promise<void>
}

export const nodeDevBundleFs: DevBundleFs = {
  list: (dir) => readdir(dir).catch(() => []),
  digest: (path) =>
    new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      let size = 0
      const stream = createReadStream(path, { highWaterMark: 1 << 16 })
      stream.on('data', (chunk) => {
        size += chunk.length
        hash.update(chunk)
      })
      stream.once('error', reject)
      stream.once('end', () => resolve({ digest: 'sha256-' + hash.digest('base64'), size }))
    }),
  readText: (path) => readFileAsync(path, 'utf8'),
  writeText: (path, contents) => writeFile(path, contents),
  remove: (path) => rm(path, { force: true }),
}

/**
 * PUBLICATION METADATA, written by the server beside the tarball.
 *
 * Restoring an artifact after a restart has to establish two things before it
 * may be advertised: the bytes are whole, and the signature next to them was
 * made by the key this server is publishing under. The obvious way — verify the
 * Ed25519 signature — requires the entire message in memory, which is precisely
 * what this module refuses to do. So publication records the digest it signed
 * and a fingerprint of the key it signed with; restore re-derives the digest by
 * streaming and compares both. A truncated tarball fails the digest; a rotated
 * key fails the fingerprint. Neither check needs the bundle in the heap.
 */
export interface DevBundleMetadata {
  version: string
  digest: string
  size: number
  keyFingerprint: string
}

export function devBundleKeyFingerprint(signingKey: string | undefined): string {
  if (!signingKey) return 'unkeyed'
  try {
    const publicKey = createPublicKey(
      createPrivateKey({ key: Buffer.from(signingKey, 'base64'), format: 'der', type: 'pkcs8' }),
    )
    const der = publicKey.export({ format: 'der', type: 'spki' })
    return 'sha256-' + createHash('sha256').update(der).digest('base64')
  } catch {
    return 'unkeyed'
  }
}

export interface DevBundleLock {
  acquire(): Promise<boolean | void>
  renew(): Promise<void>
  release(): Promise<void>
}

/** The transient unit role for the headless compile; see `build-scope.ts`. */
export const DEV_BUNDLE_BUILD_ROLE = 'dev-bundle-build'

export interface DevBuildSpawnContext {
  root: string
  version: string
  /** Where the build must write the tarball. Carries the build-time stamp. */
  artifactPath: string
  signingKey?: string
  /** Names the transient build unit, so two instances cannot share one. */
  instanceId?: string
}

export type DevBuildSpawnResult =
  | void
  | string
  | {
      path?: string
      signature?: string
    }

export interface DevBundleBuildDeps {
  lock: DevBundleLock
  root?: string
  headSha?: string
  spawnBuild?: (ctx: DevBuildSpawnContext) => Promise<DevBuildSpawnResult> | DevBuildSpawnResult
  build?: (ctx: DevBuildSpawnContext) => Promise<DevBuildSpawnResult> | DevBuildSpawnResult
  fs?: DevBundleFs
  signingKey?: string
  renewIntervalMs?: number
  retain?: number
  now?: () => number
  /** Names the transient build unit; passed through to `spawnBuild`. */
  instanceId?: string
}

const SOURCE_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const DEFAULT_RENEW_INTERVAL_MS = 5 * 60 * 1000

export const DEVELOPMENT_SOURCE_ROOT = SOURCE_ROOT

export function developmentHeadSha(root: string = SOURCE_ROOT): string {
  return String(execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root })).trim()
}

function shortSha(raw: string): string {
  const sha = raw.trim()
  if (!sha) throw new Error('could not determine the development bundle HEAD sha')
  return sha.slice(0, 7)
}

function developmentSigningKey(root: string): string {
  const path = join(root, 'scripts', '.podium-update-dev.key')
  if (existsSync(path)) {
    const key = readFileSync(path, 'utf8').trim()
    if (key) return key
  }
  throw new Error('development signing key missing at ' + path)
}

/**
 * The compile, in its OWN batch-tier unit rather than the server's cgroup.
 *
 * A bare `spawn` made the build a child of `podium-server.service`, which
 * carries the interactive tier (CPUWeight=900/IOWeight=500) — so a ~50 s compile
 * ran at eighteen times the CPU weight of the agent sessions sharing the box.
 * `runLowTierBuild` puts it in a transient scope at CPUWeight=50 with a quota,
 * and falls back to exactly the spawn above wherever systemd-run cannot create
 * one (macOS, Windows, a container without a user manager). See `build-scope.ts`.
 */
async function defaultSpawnBuild(ctx: DevBuildSpawnContext): Promise<void> {
  const signingKey = ctx.signingKey ?? developmentSigningKey(ctx.root)
  await runLowTierBuild({
    unit: devBuildScopeUnit(DEV_BUNDLE_BUILD_ROLE, ctx.instanceId ?? resolveInstanceId()),
    description: `Podium development bundle build (${ctx.version})`,
    command: process.env.BUN_BIN ?? 'bun',
    args: ['scripts/build-bun.ts'],
    cwd: ctx.root,
    env: {
      ...process.env,
      PODIUM_APP_VERSION: ctx.version,
      // The caller names the artifact, because the caller owns its lifecycle:
      // the stamp in the name is what retention later sorts on.
      PODIUM_BUNDLE_ARTIFACT: ctx.artifactPath,
      PODIUM_UPDATE_SIGNING_KEY: signingKey,
    },
  })
}

export function devBundleDirectory(root: string): string {
  return join(root, 'dist-bun')
}

async function readOptionalText(fs: DevBundleFs, path: string): Promise<string | undefined> {
  try {
    return await fs.readText(path)
  } catch {
    return undefined
  }
}

async function readMetadata(fs: DevBundleFs, path: string): Promise<DevBundleMetadata | null> {
  const raw = await readOptionalText(fs, path + DEV_BUNDLE_METADATA_SUFFIX)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DevBundleMetadata>
    if (
      typeof parsed.version !== 'string' ||
      typeof parsed.digest !== 'string' ||
      typeof parsed.size !== 'number' ||
      typeof parsed.keyFingerprint !== 'string'
    ) {
      return null
    }
    return parsed as DevBundleMetadata
  } catch {
    return null
  }
}

/**
 * Reclaim every development bundle outside the retention window.
 *
 * Never fatal, per file and as a whole: a bundle that could not be deleted is
 * disk to reclaim next time, not a reason to fail a build or refuse to publish
 * one. The next sweep sees it again.
 */
export async function sweepDevBundles(
  fs: DevBundleFs,
  dir: string,
  options: { keep?: number; protect?: readonly string[] } = {},
): Promise<string[]> {
  const removed: string[] = []
  try {
    const doomed = selectDevBundleSweep(await fs.list(dir), options)
    for (const name of doomed) {
      try {
        await fs.remove(join(dir, name))
        removed.push(name)
      } catch (error) {
        log.warn('could not remove a stale development bundle', { name, err: error })
      }
    }
    if (removed.length > 0) log.info('reclaimed stale development bundles', { removed })
  } catch (error) {
    log.warn('development bundle sweep failed', { dir, err: error })
  }
  return removed
}

/**
 * Recover the bundle already produced for this checkout's HEAD.
 *
 * The publisher itself is process-local, while the tarball is intentionally
 * durable across source-server restarts. The newest artifact stamped for HEAD
 * is a candidate; it becomes the current target only if its recorded metadata
 * says it was published by this server's signing identity AND the file still
 * hashes to what was signed. Anything else — no metadata, a rotated key, a
 * short or corrupt file — is treated as absent and rebuilt.
 */
async function readExistingDevBundle(
  deps: Pick<DevBundleBuildDeps, 'root' | 'signingKey'> & { headSha: string; fs: DevBundleFs },
): Promise<BuiltDevBundle | null> {
  const root = deps.root ?? SOURCE_ROOT
  const sha = shortSha(deps.headSha)
  const version = 'dev+' + sha
  const dir = devBundleDirectory(root)
  const candidate = listDevBundles(await deps.fs.list(dir)).find((entry) => entry.sha === sha)
  if (!candidate) return null

  const path = join(dir, candidate.name)
  const metadata = await readMetadata(deps.fs, path)
  if (!metadata || metadata.version !== version) return null
  if (metadata.keyFingerprint !== devBundleKeyFingerprint(deps.signingKey)) return null

  const signature = (await readOptionalText(deps.fs, path + DEV_BUNDLE_SIGNATURE_SUFFIX))?.trim()
  if (!signature) return null

  let actual: { digest: string; size: number }
  try {
    actual = await deps.fs.digest(path)
  } catch {
    return null
  }
  if (actual.digest !== metadata.digest || actual.size !== metadata.size) return null

  return { version, path, size: actual.size, digest: actual.digest, signature }
}

/**
 * Builds the bundle, describes the exact signed tarball, records how it was
 * published, and reclaims what the build superseded — all under one advisory
 * lease, renewed while the asynchronous compile runs.
 *
 * The sweep belongs here rather than at a call site because this is where the
 * garbage is created and where the lock is held: a concurrent build in the same
 * checkout cannot have its half-written output deleted from under it.
 */
export async function buildDevBundle(deps: DevBundleBuildDeps): Promise<BuiltDevBundle> {
  const root = deps.root ?? SOURCE_ROOT
  const fs = deps.fs ?? nodeDevBundleFs
  const sha = shortSha(
    deps.headSha ??
      execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }),
  )
  const version = 'dev+' + sha
  const lock = deps.lock
  const acquired = await lock.acquire()
  if (acquired === false) throw new Error('could not acquire the development bundle lock')

  let renewal = Promise.resolve()
  let renewalError: unknown
  const renewTimer = setInterval(() => {
    renewal = renewal
      .then(() => lock.renew())
      .catch((error) => {
        renewalError ??= error
      })
  }, deps.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS)
  renewTimer.unref?.()

  let buildError: unknown
  try {
    const spawnBuild = deps.spawnBuild ?? deps.build ?? defaultSpawnBuild
    const stamp = devBundleStamp((deps.now ?? Date.now)())
    const requestedPath = join(devBundleDirectory(root), devBundleFileName(version, stamp))
    const result = await spawnBuild({
      root,
      version,
      artifactPath: requestedPath,
      ...(deps.signingKey ? { signingKey: deps.signingKey } : {}),
      ...(deps.instanceId ? { instanceId: deps.instanceId } : {}),
    })
    await renewal
    if (renewalError) throw renewalError

    const resultObject = typeof result === 'object' && result !== null ? result : undefined
    const artifactPath = (typeof result === 'string' ? result : resultObject?.path) ?? requestedPath
    const signature =
      resultObject?.signature ??
      (await readOptionalText(fs, artifactPath + DEV_BUNDLE_SIGNATURE_SUFFIX))?.trim()
    if (!signature) throw new Error('development bundle is unsigned; refusing to publish it')

    const { digest, size } = await fs.digest(artifactPath)
    const metadata: DevBundleMetadata = {
      version,
      digest,
      size,
      keyFingerprint: devBundleKeyFingerprint(deps.signingKey),
    }
    await fs.writeText(
      artifactPath + DEV_BUNDLE_METADATA_SUFFIX,
      JSON.stringify(metadata, null, 2) + '\n',
    )
    await sweepDevBundles(fs, dirname(artifactPath), {
      ...(deps.retain !== undefined ? { keep: deps.retain } : {}),
      protect: [basename(artifactPath)],
    })
    return { version, path: artifactPath, size, digest, signature }
  } catch (error) {
    buildError = error
    throw error
  } finally {
    clearInterval(renewTimer)
    await renewal
    try {
      await lock.release()
    } catch (releaseError) {
      if (!buildError) throw releaseError
      log.warn('development bundle lock release failed', { err: releaseError })
    }
  }
}

export function developmentPlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'win32' ? 'windows' : platform
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch
  return os + '-' + cpu
}

export function devTarget(
  built: BuiltDevBundle,
  opts: { artifactUrl?: string; platform?: string; sourceRoot?: string; webDigest?: string } = {},
): UpdateTarget {
  const platform = opts.platform ?? developmentPlatformTarget()
  const url = opts.artifactUrl ?? DEV_ARTIFACT_ROUTE + '/' + encodeURIComponent(built.version)
  const webDigest = opts.webDigest ?? built.version.replace(/^dev\+/, '')
  return {
    version: built.version,
    critical: false,
    artifacts: {
      headless: {
        delivery: 'bundle',
        platforms: {
          [platform]: {
            url,
            digest: built.digest,
            signature: built.signature,
          },
        },
      },
      headlessAlternatives: [
        {
          delivery: 'git',
          repo: opts.sourceRoot ?? DEVELOPMENT_SOURCE_ROOT,
          sha: built.version.replace(/^dev\+/, ''),
        },
      ],
      web: { digest: webDigest },
    },
  }
}

/**
 * dev+<sha> as an install identity when there is not yet an honest headless
 * tarball for this HEAD. Update still has something to compare and can rebuild
 * the website. Do not advertise a previous commit's tarball under this label.
 */
export function devIdentityTarget(
  headSha: string,
  opts: { sourceRoot?: string } = {},
): UpdateTarget {
  const sha = shortSha(headSha)
  return {
    version: 'dev+' + sha,
    critical: false,
    artifacts: {
      web: { digest: sha },
      headlessAlternatives: [
        {
          delivery: 'git',
          repo: opts.sourceRoot ?? DEVELOPMENT_SOURCE_ROOT,
          sha,
        },
      ],
    },
  }
}

export interface DevBundlePublisherDeps extends Omit<DevBundleBuildDeps, 'headSha'> {
  isSourceRun: boolean | (() => boolean)
  headSha: () => string
  debounceMs?: number
  artifactUrl?: string | ((version: string) => string)
  platform?: string
  /** Seam for tests; defaults to `git status --porcelain -z` in `root`. */
  readSourceStatus?: (root: string) => string
  /** Seam for tests; defaults to `git ls-files --others --ignored` in `root`. */
  readIgnoredSourceInputs?: (root: string) => string
  /**
   * Settle `apps/web/dist` before anything expensive happens — and REFUSE
   * rather than rebuild it when this request is not explicit.
   *
   * That asymmetry is the whole point, and it was learned the hard way. The
   * compile needs the dist stamped at this commit, so the obvious move is
   * "build it whenever it is stale". But this server SERVES that dist to
   * browsers, and `/version` asks for a build on every read — so building on
   * that path rebuilt the website every time main moved, while the server
   * itself stayed on the commit it booted with. The page then ran AHEAD of the
   * server, their wire schema digests disagreed, and every open tab got the
   * out-of-sync banner. Observed live: one server on dev+e10795a rebuilt the
   * website six times for five commits it was not running.
   *
   * So the dist may only move when the server can move with it: its own
   * start-up (it is at HEAD then) and an operator-driven update (which restarts
   * it straight after). On the polling path a stale dist is simply a reason not
   * to pack a tarball — a refused artifact costs nothing, a broken page costs
   * every open tab.
   */
  prepareWebDist?: (headSha: string, explicit: boolean) => Promise<void>
}

/**
 * READINESS, stated rather than implied.
 *
 * The honest question a reader has is "is the bundle the code this server is
 * running?", and the only answer that means anything is about the CURRENT HEAD.
 * A bundle built two commits ago is `idle`/`failed` for today's HEAD, not
 * `ready`: presenting it as the target would be the same lie the identity check
 * exists to prevent, one commit further out.
 */
export type DevBundleReadiness =
  | { state: 'idle'; headSha: string | null }
  | { state: 'preparing'; headSha: string }
  | { state: 'ready'; headSha: string; version: string }
  | { state: 'failed'; headSha: string | null; reason: string; publicReason: string }

export function createDevBundlePublisher(deps: DevBundlePublisherDeps): {
  requestBuild(explicit?: boolean): Promise<BuiltDevBundle | null>
  current(): BuiltDevBundle | null
  /** The target for the CURRENT HEAD, or nothing. Never an older commit's. */
  target(): UpdateTarget | undefined
  /** Explicit lifecycle for this HEAD, with a reason safe to show a client. */
  readiness(): DevBundleReadiness
  /**
   * Why the last attempt refused or failed, in full — paths included. For the
   * server log; `readiness().publicReason` is the half a client may see.
   */
  unavailable(): string | undefined
} {
  let current: BuiltDevBundle | null = null
  let builtSha: string | null = null
  let lastAttemptAt: number | null = null
  let inFlight: Promise<BuiltDevBundle> | null = null
  let unavailable: string | undefined
  let failure: { sha: string | null; reason: string; publicReason: string } | undefined
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? 60_000
  const fs = deps.fs ?? nodeDevBundleFs

  const currentHeadSha = (): string | null => {
    try {
      return shortSha(deps.headSha())
    } catch {
      return null
    }
  }

  const recordFailure = (error: unknown, sha: string | null) => {
    const reason = error instanceof Error ? error.message : String(error)
    unavailable = reason
    failure = { sha, reason, publicReason: publicUnavailableReason(error, sha ?? 'unknown') }
  }

  return {
    requestBuild(explicit = false) {
      try {
        const headSha = shortSha(deps.headSha())
        const decision = decideDevBuild({
          isSourceRun:
            typeof deps.isSourceRun === 'function' ? deps.isSourceRun() : deps.isSourceRun,
          headSha,
          builtSha,
          lastAttemptAt,
          now: now(),
          inFlight: inFlight !== null,
          debounceMs,
          explicit,
        })
        if (!decision.build) return inFlight ?? Promise.resolve(current)

        lastAttemptAt = now()
        // Fail closed BEFORE restoring or compiling: a dirty checkout cannot
        // produce a dev+<sha> build of that commit, and an artifact left in
        // dist-bun must not be restored under a tree that has since diverged.
        assertSourceMatchesHead(
          deps.root ?? SOURCE_ROOT,
          headSha,
          deps.readSourceStatus,
          deps.readIgnoredSourceInputs,
        )
        // A restart loses only the in-memory descriptor, not the signed bytes.
        // Restore an exact-HEAD artifact first; compile only when it is absent
        // or no longer verifies under this server's persisted update key.
        //
        // A restore sweeps too. Retention that only ran on a successful build
        // would leave whatever a crash, a failed compile or a plain shutdown
        // left behind — and residue that only accumulates when something went
        // wrong is exactly the kind that grows unnoticed for months.
        //
        // The website is settled first, because the compile cannot pack a
        // dev+<sha> tarball around another commit's dist. `explicit` travels
        // with the request: it decides whether a stale dist is REBUILT (this
        // server is about to be at that commit) or merely REFUSED (it is not,
        // and moving the page ahead of it would break every open tab). Costs a
        // single small file read when the dist is already current, which is the
        // common case on the `/version` path.
        const prepared = deps.prepareWebDist?.(headSha, explicit) ?? Promise.resolve()
        const requested = prepared
          .then(() =>
            current === null
              ? readExistingDevBundle({ ...deps, fs, headSha }).then(async (existing) => {
                  if (!existing) return buildDevBundle({ ...deps, headSha })
                  await sweepDevBundles(fs, dirname(existing.path), {
                    ...(deps.retain !== undefined ? { keep: deps.retain } : {}),
                    protect: [basename(existing.path)],
                  })
                  return existing
                })
              : buildDevBundle({ ...deps, headSha }),
          )
          .then(
            (built) => {
              current = built
              builtSha = headSha
              unavailable = undefined
              failure = undefined
              return built
            },
            (error: unknown) => {
              recordFailure(error, headSha)
              throw error
            },
          )
        inFlight = requested
        void requested.then(
          () => {
            inFlight = null
          },
          () => {
            inFlight = null
          },
        )
        return requested
      } catch (error) {
        recordFailure(error, currentHeadSha())
        return Promise.reject(error)
      }
    },
    current: () => current,
    unavailable: () => unavailable,
    readiness: () => {
      const headSha = currentHeadSha()
      if (headSha !== null && builtSha === headSha && current) {
        return { state: 'ready', headSha, version: current.version }
      }
      if (inFlight !== null && headSha !== null) return { state: 'preparing', headSha }
      // A failure recorded against an older HEAD says nothing about this one.
      if (failure && failure.sha === headSha) {
        return {
          state: 'failed',
          headSha,
          reason: failure.reason,
          publicReason: failure.publicReason,
        }
      }
      return { state: 'idle', headSha }
    },
    target: () => {
      const headSha = currentHeadSha()
      if (headSha === null) return undefined
      // A dev+<sha> label names this commit. A dirty tree is not that commit,
      // so do not advertise one. Any other failure (stale web dist, compile)
      // still needs the identity so Update can rebuild.
      if (failure?.sha === headSha && failure.reason.includes('does not match HEAD')) {
        return undefined
      }
      if (current && builtSha === headSha) {
        const artifactUrl =
          typeof deps.artifactUrl === 'function'
            ? deps.artifactUrl(current.version)
            : deps.artifactUrl
        return devTarget(current, {
          artifactUrl,
          platform: deps.platform,
          sourceRoot: deps.root,
        })
      }
      return devIdentityTarget(headSha, { sourceRoot: deps.root })
    },
  }
}
