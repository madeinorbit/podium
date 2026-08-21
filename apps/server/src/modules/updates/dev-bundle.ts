import { execFile } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { readdir, readFile as readFileAsync, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import {
  commitShaFromDevVersion,
  isHeadlessPlatform,
  isPublisherDevVersion,
  mintDevVersion,
  parsePublisherDevVersion,
  platformTargetFor,
  type UpdateTarget,
} from '@podium/protocol'
import { resolveInstanceId, stateDir } from '@podium/runtime/config'
import { devBuildCommand, devBuildScopeUnit, runLowTierBuild } from './build-scope'
import {
  readDevPublisherState,
  versionStateOf,
  writeDevPublisherState,
} from './dev-publisher-state'

const log = createLogger('server:updates')

const execFileAsync = promisify(execFile)

/**
 * EVERY GIT CALL HERE IS ASYNCHRONOUS, and that is a load-bearing property.
 *
 * This module runs inside the SERVER, which is the one process every client of
 * this instance talks to. Two of the queries below walk the whole monorepo
 * working tree, and `/version` asks for a publish on every read — so the
 * synchronous form these used to take blocked the event loop of every session
 * on the host for the length of a full-tree walk, not just the machine asking.
 * Nothing here may go back to `execFileSync` (POD-2048).
 *
 * The environment is passed EXPLICITLY rather than inherited. Bun's synchronous
 * spawns reuse the process-start environment while its asynchronous ones read
 * `process.env` live [spec:SP-3f93], so moving these calls off the loop would
 * otherwise change which environment `git` sees as an accident of the refactor.
 * Naming the map makes it a decision: git reads the LIVE environment, which is
 * what a test running under a temporary `$HOME` needs and what a runtime change
 * to `GIT_*`/`HOME` on this process should mean.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

/**
 * Where a commit keeps the migrations it defines. The folder names in this tree
 * ARE the ledger names the server's migrator writes, which is what makes them
 * comparable to what a database has applied.
 */
const MIGRATIONS_TREE = 'apps/server/src/migrations/drizzle'

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: gitEnv(),
  })
  return stdout
}

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
 * A development *bundle* is published under a publisher-minted orderable
 * version (`<base>.dev.<N>+<sha>`, POD-2502). The `+<sha>` build metadata is
 * still the claim "compiled from that commit". `scripts/build-bun.ts` compiles
 * the LIVE working tree, so an edited checkout would ship code that is not that
 * commit under a name that claims it is.
 *
 * Process/log identity on a source host remains `dev+<sha>` (see
 * `build-version.ts` / `source-version.ts`); only the published target carries
 * the orderable form.
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

/**
 * Reads the raw output of one source query.
 *
 * The defaults spawn `git` and are therefore asynchronous; a test seam that
 * already has the string may answer synchronously, so the union is the type
 * rather than a bare promise.
 */
export type DevBundleSourceReader = (root: string) => string | Promise<string>

function defaultReadIgnoredSourceInputs(root: string): Promise<string> {
  const excludes = DEV_BUNDLE_NON_SOURCE_TREES.map((tree) => `:(exclude)**/${tree}/**`)
  const generatedExcludes = DEV_BUNDLE_IGNORED_SOURCE_ALLOWED_PREFIXES.map(
    (prefix) => `:(exclude)${prefix}**`,
  )
  return git(root, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    ...DEV_BUNDLE_SOURCE_TREES,
    ...excludes,
    ...generatedExcludes,
  ])
}

function defaultReadSourceStatus(root: string): Promise<string> {
  return git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
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
    (more > 0 ? ` (+${more} more)` : '')
  )
}

/**
 * Throws unless the checkout is exactly HEAD. A git failure is itself a refusal
 * — an unreadable status cannot establish identity.
 */
export async function assertSourceMatchesHead(
  root: string,
  sha: string,
  readSourceStatus: DevBundleSourceReader = defaultReadSourceStatus,
  readIgnoredSourceInputs: DevBundleSourceReader = defaultReadIgnoredSourceInputs,
): Promise<void> {
  let porcelain: string
  try {
    porcelain = await readSourceStatus(root)
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
    ignoredListing = await readIgnoredSourceInputs(root)
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
/** One platform's signed tarball inside a development build. */
export interface DevBundleArtifact {
  /** The updater's platform name, e.g. `linux-x86_64` or `darwin-aarch64`. */
  platform: string
  path: string
  size: number
  digest: string
  signature: string
  /**
   * The version label this artifact carries.
   *
   * Recorded per artifact, not only per build, because RECOVERY reads it back off disk
   * one file at a time: it is how a restore can tell that four files on disk belong to
   * one publish rather than to two mints of the same commit, which would produce a
   * manifest whose platforms disagreed about their own version.
   */
  version: string
}

/**
 * What one development build produced.
 *
 * The flat `path`/`size`/`digest`/`signature` describe THIS HOST'S bundle and are kept
 * as the primary shape because most readers — the artifact route's back-compatible
 * URL, readiness, the tests — only ever care about the machine they are running on.
 * `artifacts` carries every platform that was minted, host included, and is what the
 * published target enumerates.
 */
export interface BuiltDevBundle {
  version: string
  path: string
  size: number
  digest: string
  signature: string
  /** Every platform minted by this build, host first. Never empty. */
  artifacts: DevBundleArtifact[]
}

/**
 * NAMING, so that "the previous one" is a fact on disk rather than a guess.
 *
 * The published version is a publisher mint (`<base>.dev.<N>+<sha>`). The FILE
 * also carries the moment it was built, which buys two things the version alone
 * cannot: rebuilding the same commit produces a new file instead of silently
 * overwriting the one a request may be streaming, and legacy stamp-ordered
 * listings still have a total order without trusting mtimes.
 *
 * Retention itself is manifest-reference-based (POD-2502): the sweep keeps
 * artifact basenames referenced by retained publishes, never "newest N by stamp"
 * alone — a stamp sort could delete a file a current manifest still names.
 */
export const DEV_BUNDLE_PREFIX = 'podium-headless-'
export const DEV_BUNDLE_SUFFIX = '.tar.gz'
export const DEV_BUNDLE_SIGNATURE_SUFFIX = '.sig'
export const DEV_BUNDLE_METADATA_SUFFIX = '.meta.json'

/**
 * HOW MANY PUBLISHED ARTIFACTS THE PUBLISHER REMEMBERS.
 *
 * Only the current HEAD's bundle is reachable via the artifact route, so one
 * would be enough to serve. The second is kept deliberately for the human at
 * the checkout: when a build makes something worse, the bundle it replaced is
 * still on disk to compare against. The retained set is the sweep's allowlist.
 */
export const DEV_BUNDLE_RETAINED = 2

/**
 * The platform infix, as a CLOSED SET.
 *
 * That is what makes it safe to slot an optional platform into the middle of a name
 * whose other parts are open-ended: a publisher version can contain almost anything,
 * but it cannot contain `linux-x86_64`, so the parse is never ambiguous.
 */
const PLATFORM_INFIX = '(?:linux|darwin|windows)-(?:x86_64|aarch64)'

/**
 * Legacy `dev+<sha>` names, with or without a platform and with or without a stamp.
 *
 * EVERY optional group is optional on PURPOSE. A checkout that has been publishing for
 * a while has bundles on disk from before the stamp existed and from before a build
 * minted more than one platform; if these patterns stopped recognising them they would
 * not become safe, they would become invisible — unreachable files the retention sweep
 * no longer knows to delete.
 */
const LEGACY_DEV_BUNDLE_NAME = new RegExp(
  `^podium-headless-dev\\+([0-9a-f]{7,40})(?:-(${PLATFORM_INFIX}))?(?:-(\\d{8}T\\d{6}Z))?\\.tar\\.gz$`,
)
/**
 * Stamped publisher artifact: `podium-headless-<version>[-<platform>]-<stamp>.tar.gz`.
 *
 * The version is non-greedy so that a trailing platform is claimed by the platform
 * group rather than swallowed into the version — `…dev.3+abc-linux-x86_64-<stamp>`
 * parses as version `…dev.3+abc` on platform `linux-x86_64`, not as a version nobody
 * can look up.
 */
const STAMPED_DEV_BUNDLE_NAME = new RegExp(
  `^podium-headless-(.+?)(?:-(${PLATFORM_INFIX}))?-(\\d{8}T\\d{6}Z)\\.tar\\.gz$`,
)

export interface DevBundleFile {
  name: string
  /** Commit the artifact claims, when the name carries one. */
  sha: string
  /** Empty for a bundle built before builds were stamped; sorts oldest. */
  stamp: string
  /** Version label embedded in the filename, when parseable. */
  version: string
  /**
   * Empty for a bundle built before one build minted several platforms. Retention
   * groups on this: keeping "the newest two files" across four platforms would sweep
   * away three quarters of the build it just published.
   */
  platform: string
}

/** `20260812T182015Z` — fixed width, so string order is time order. */
export function devBundleStamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

/**
 * Recognise this publisher's own artifacts and NOTHING else.
 *
 * The retention sweep deletes whatever this returns a match for, so the pattern
 * is the safety boundary: legacy `dev+<sha>` names and stamped publisher mints,
 * never an unstamped release semver tarball. A release sits in the same
 * directory and `scripts/release.ts` reads it by that name.
 */
export function parseDevBundleName(name: string): DevBundleFile | null {
  const legacy = LEGACY_DEV_BUNDLE_NAME.exec(name)
  if (legacy) {
    const sha = legacy[1] as string
    return { name, sha, platform: legacy[2] ?? '', stamp: legacy[3] ?? '', version: `dev+${sha}` }
  }
  const stamped = STAMPED_DEV_BUNDLE_NAME.exec(name)
  if (!stamped) return null
  const version = stamped[1] as string
  // Release artifacts are `podium-headless-<semver>.tar.gz` with no stamp. A
  // stamped name whose version is neither a legacy identity nor a publisher
  // mint is not ours to reclaim.
  if (!version.startsWith('dev+') && !isPublisherDevVersion(version)) return null
  return {
    name,
    sha: commitShaFromDevVersion(version) ?? '',
    platform: stamped[2] ?? '',
    stamp: stamped[3] as string,
    version,
  }
}

export function devBundleFileName(version: string, stamp: string, platform?: string): string {
  const infix = platform ? `-${platform}` : ''
  return `podium-headless-${version}${infix}-${stamp}${DEV_BUNDLE_SUFFIX}`
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
 * Prefer `referenced`: every recognised development artifact whose basename is
 * not in that set (nor in `protect`) may go, along with present sidecars. That
 * is the manifest-reference rule — a file a retained publish still names is
 * never deleted, regardless of stamp order.
 *
 * `keep` remains as a fallback when no referenced set is supplied (tests / an
 * older call site): keep the newest N by stamp, matching the historical window.
 */
export function selectDevBundleSweep(
  names: readonly string[],
  options: {
    keep?: number
    protect?: readonly string[]
    /** Artifact basenames retained publishes still reference. */
    referenced?: readonly string[]
    /** Which platform an unlabelled legacy name belongs to; defaults to this host's. */
    hostPlatform?: string
  } = {},
): string[] {
  const present = new Set(names)
  const protectedNames = new Set(options.protect ?? [])
  // A name with no platform in it predates multi-platform builds, and the only bundle
  // such a build ever produced was this host's. Counting it in the host's group is what
  // lets the backlog DRAIN: give it a group of its own and its two survivors are
  // retained forever, because nothing new is ever added to push them out.
  const hostPlatform = options.hostPlatform ?? developmentPlatformTarget()
  const doomed: string[] = []

  const pushDoomed = (entryName: string) => {
    doomed.push(entryName)
    for (const suffix of [DEV_BUNDLE_SIGNATURE_SUFFIX, DEV_BUNDLE_METADATA_SUFFIX]) {
      if (present.has(entryName + suffix)) doomed.push(entryName + suffix)
    }
  }

  // An explicit allowlist of what publishes still reference (POD-2502) answers the
  // question outright, for every platform at once — a referenced artifact is kept
  // whatever its platform, and an unreferenced one goes. No counting is involved, so
  // the per-platform grouping below does not apply to it.
  if (options.referenced !== undefined) {
    const referenced = new Set(options.referenced)
    for (const entry of listDevBundles(names)) {
      if (referenced.has(entry.name) || protectedNames.has(entry.name)) continue
      pushDoomed(entry.name)
    }
    return doomed
  }

  // The counting fallback, PER PLATFORM. `keep` means "the last N builds", and a build
  // is now up to four files. Counting them in one list would keep two and delete the
  // rest of the build just published — a Mac in the fleet would be offered a target
  // whose tarball the sweep had already removed.
  const keep = options.keep ?? DEV_BUNDLE_RETAINED
  const seenPerPlatform = new Map<string, number>()
  for (const entry of listDevBundles(names)) {
    const group = entry.platform || hostPlatform
    const seen = seenPerPlatform.get(group) ?? 0
    seenPerPlatform.set(group, seen + 1)
    if (seen < keep || protectedNames.has(entry.name)) continue
    pushDoomed(entry.name)
  }
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
      stream.once('end', () => resolve({ digest: `sha256-${hash.digest('base64')}`, size }))
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
  /**
   * Which platform's bundle this describes. Optional because a sidecar written before
   * a build minted more than one platform has no such field, and `readMetadata` must
   * keep reading those rather than treating them as corrupt.
   */
  platform?: string
}

export function devBundleKeyFingerprint(signingKey: string | undefined): string {
  if (!signingKey) return 'unkeyed'
  try {
    const publicKey = createPublicKey(
      createPrivateKey({ key: Buffer.from(signingKey, 'base64'), format: 'der', type: 'pkcs8' }),
    )
    const der = publicKey.export({ format: 'der', type: 'spki' })
    return `sha256-${createHash('sha256').update(der).digest('base64')}`
  } catch {
    return 'unkeyed'
  }
}

export interface DevBundleLock {
  acquire(): Promise<boolean | undefined>
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
  /**
   * Which platform this bundle is for, as a `bun build --compile` target.
   *
   * Present for EVERY build, this host's own included [spec:SP-6144 section 8b]. The
   * development host and the release runner therefore take the same code path and
   * produce the same shape of bundle — which is the point: development use is the
   * continuous test of the release mechanism, and a path only production takes is a
   * path nothing tests until release day.
   */
  bunTarget: string
}

export type DevBuildSpawnResult =
  | undefined
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
  /**
   * Instance state directory for publisher version persistence. Defaults to
   * `stateDir()`. Seam for tests.
   */
  publisherStateDir?: string
  /**
   * Checkout release base (root package.json version). Seam for tests; defaults
   * to reading `<root>/package.json`.
   */
  checkoutReleaseBase?: string | (() => string)
  /**
   * Which platforms to mint, in build order. Defaults to this host's own.
   *
   * FLEET-SCOPED, not all-four: the development host builds a Darwin bundle when the
   * fleet has a Mac in it and not otherwise. A release publishes every platform
   * because it cannot know who will install it; a dev feed serves a fleet whose
   * members are all registered, so minting for a platform nobody runs is two minutes
   * of the live host's CPU spent on a file no one will ever fetch.
   */
  platforms?: readonly string[]
}

const SOURCE_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const DEFAULT_RENEW_INTERVAL_MS = 5 * 60 * 1000

export const DEVELOPMENT_SOURCE_ROOT = SOURCE_ROOT

export async function developmentHeadSha(root: string = SOURCE_ROOT): Promise<string> {
  return (await git(root, ['rev-parse', '--short=7', 'HEAD'])).trim()
}

function shortSha(raw: string): string {
  const sha = raw.trim()
  if (!sha) throw new Error('could not determine the development bundle HEAD sha')
  return sha.slice(0, 7)
}

/**
 * The release version the checkout currently declares — seed / ceiling input
 * for publisher minting. Never used alone as the published version: the
 * publisher's persisted base may be higher (decision 13).
 */
export function readCheckoutReleaseBase(root: string): string {
  const path = join(root, 'package.json')
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
      return parsed.version.trim()
    }
  } catch {
    // fall through
  }
  throw new Error(
    `could not read a release version from ${path}, so this publisher cannot mint a development version`,
  )
}

function resolveCheckoutReleaseBase(
  deps: Pick<DevBundleBuildDeps, 'checkoutReleaseBase'>,
  root: string,
): string {
  if (typeof deps.checkoutReleaseBase === 'function') return deps.checkoutReleaseBase()
  if (typeof deps.checkoutReleaseBase === 'string') return deps.checkoutReleaseBase
  return readCheckoutReleaseBase(root)
}

/**
 * Assign the next publisher-owned version and persist the counter immediately
 * so a crash mid-compile cannot reuse N. Reuses the prior allocation when the
 * same HEAD is advertised again (identity target → later build). Call
 * {@link rememberDevArtifact} once the stamped basename is known so the sweep
 * allowlist includes it.
 *
 * READ-MODIFY-WRITE, AND NOT SERIALISED against a concurrent build. `target()`
 * calls this on the `/version` path, outside the lock `buildDevBundle` holds,
 * so two callers can interleave. Safe because allocation is idempotent per SHA
 * (`lastSha`/`lastVersion` short-circuit) and the counter only ever moves
 * forward — an interleaving costs a wasted N, never a reused one. Anything that
 * makes allocation depend on more than the SHA needs the lock first.
 */
export function allocateDevPublishVersion(input: {
  stateDir: string
  checkoutBase: string
  sha: string
}): { version: string; base: string; counter: number } {
  const existing = readDevPublisherState(input.stateDir)
  const sha = shortSha(input.sha)
  if (existing?.lastSha === sha && existing.lastVersion) {
    return {
      version: existing.lastVersion,
      base: existing.base,
      counter: existing.counter,
    }
  }
  const minted = mintDevVersion(versionStateOf(existing), input.checkoutBase, sha)
  writeDevPublisherState(
    {
      base: minted.state.base,
      counter: minted.state.counter,
      retainedArtifacts: existing?.retainedArtifacts ?? [],
      lastSha: sha,
      lastVersion: minted.version,
    },
    input.stateDir,
  )
  return {
    version: minted.version,
    base: minted.state.base,
    counter: minted.state.counter,
  }
}

/**
 * Record a freshly published artifact basename in the retained set and return
 * the full allowlist the sweep must honour.
 */
export function rememberDevArtifact(input: {
  stateDir: string
  /**
   * EVERY artifact of ONE publish — one per platform.
   *
   * This took a list rather than a name because a publish is now up to four files
   * (POD-2504). Remembering only one of them would leave the other three out of the
   * allowlist, and the very next sweep would delete the bundles a Mac in the fleet had
   * just been offered.
   */
  artifactNames: readonly string[]
  retain?: number
}): string[] {
  const existing = readDevPublisherState(input.stateDir)
  if (!existing) {
    throw new Error('cannot remember a development artifact before a version has been minted')
  }
  const retain = input.retain ?? DEV_BUNDLE_RETAINED
  const fresh = [...input.artifactNames]
  // `retain` counts PUBLISHES, not files. Slicing a flat list of names would cap at two
  // FILES and drop most of a four-platform build, so artifacts are grouped by the build
  // that produced them (its version and stamp) and whole builds are what age out.
  const buildOf = (name: string): string => {
    const parsed = parseDevBundleName(name)
    return parsed ? `${parsed.version}@${parsed.stamp}` : name
  }
  const keptBuilds = new Set(fresh.map(buildOf))
  const referenced = [...fresh]
  for (const name of existing.retainedArtifacts) {
    if (referenced.includes(name)) continue
    const build = buildOf(name)
    if (!keptBuilds.has(build)) {
      if (keptBuilds.size >= retain) continue
      keptBuilds.add(build)
    }
    referenced.push(name)
  }
  writeDevPublisherState(
    {
      ...existing,
      retainedArtifacts: referenced,
    },
    input.stateDir,
  )
  return referenced
}

/**
 * Recover publisher state from an on-disk artifact when the state file is gone.
 *
 * The allowlist is the restored artifact plus the newest other recognised
 * publisher artifacts in `knownNames` (up to the retention window) — so a
 * state-file loss does not delete the previous bundle the human still wants
 * on disk for comparison.
 */
export function seedPublisherStateFromArtifact(input: {
  stateDir: string
  version: string
  /** Every artifact of the restored publish — one per platform (POD-2504). */
  artifactNames: readonly string[]
  retain?: number
  /** Directory listing (basenames) used to keep the previous retained bundle. */
  knownNames?: readonly string[]
}): string[] {
  const retain = input.retain ?? DEV_BUNDLE_RETAINED
  const restored = [...input.artifactNames]
  // Grouped by the build that produced them, for the same reason as
  // {@link rememberDevArtifact}: `retain` counts publishes, and a flat slice would
  // drop most of a four-platform build.
  const buildOf = (name: string): string => {
    const parsed = parseDevBundleName(name)
    return parsed ? `${parsed.version}@${parsed.stamp}` : name
  }
  const keptBuilds = new Set(restored.map(buildOf))
  const referenced = [...restored]
  for (const entry of listDevBundles(input.knownNames ?? [])) {
    if (referenced.includes(entry.name)) continue
    const build = buildOf(entry.name)
    if (!keptBuilds.has(build)) {
      if (keptBuilds.size >= retain) continue
      keptBuilds.add(build)
    }
    referenced.push(entry.name)
  }
  const parsed = parsePublisherDevVersion(input.version)
  if (parsed) {
    writeDevPublisherState(
      {
        base: parsed.base,
        counter: parsed.counter,
        retainedArtifacts: referenced,
        lastSha: parsed.sha,
        lastVersion: input.version,
      },
      input.stateDir,
    )
    return referenced
  }
  // Legacy identity on disk, no mint yet — allowlist only, no counter.
  const existing = readDevPublisherState(input.stateDir)
  if (existing) {
    return rememberDevArtifact({
      stateDir: input.stateDir,
      artifactNames: restored,
      retain,
    })
  }
  return referenced
}

function developmentSigningKey(root: string): string {
  const path = join(root, 'scripts', '.podium-update-dev.key')
  if (existsSync(path)) {
    const key = readFileSync(path, 'utf8').trim()
    if (key) return key
  }
  throw new Error(`development signing key missing at ${path}`)
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
    description: `Podium development bundle build (${ctx.version}, ${ctx.bunTarget})`,
    command: devBuildCommand(process.env),
    // `--target` on EVERY build, this host's own included. The release job passes it
    // too, so the dev host exercises the exact path that produces what ships rather
    // than a nearby one — including the cross-compiled abduco helper, which is the part
    // of a bundle a native build would have got from somewhere else.
    args: ['scripts/build-bun.ts', `--target=${ctx.bunTarget}`],
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

/**
 * The `bun build --compile` target that produces a bundle for `platform`.
 *
 * Kept here rather than imported from scripts/: the server may not reach into the build
 * scripts, and this is three lines of arithmetic on the platform name the protocol
 * already defines. `scripts/headless-platforms.test.ts` holds it to the table in
 * scripts/build-bun.ts, so the two cannot drift silently.
 */
export function bunTargetForPlatform(platform: string): string {
  const [os, cpu] = platform.split('-')
  const arch = cpu === 'x86_64' ? 'x64' : cpu === 'aarch64' ? 'arm64' : cpu
  if (!os || !arch) throw new Error(`cannot build a bundle for platform '${platform}'`)
  return `bun-${os}-${arch}`
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
  options: {
    keep?: number
    protect?: readonly string[]
    referenced?: readonly string[]
  } = {},
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
  deps: Pick<DevBundleBuildDeps, 'root' | 'signingKey'> & {
    headSha: string
    fs: DevBundleFs
    /**
     * What the fleet needs TODAY. A recovered build that predates a machine joining
     * covers fewer platforms than are now required, and publishing it would offer that
     * machine a manifest with no entry for it — so a short recovery reads as no
     * recovery, and the build runs.
     */
    platforms?: readonly string[]
  },
): Promise<BuiltDevBundle | null> {
  const root = deps.root ?? SOURCE_ROOT
  const sha = shortSha(deps.headSha)
  const dir = devBundleDirectory(root)
  const hostPlatform = developmentPlatformTarget()

  /** One candidate file, or nothing if it cannot prove it is what it claims to be. */
  const recover = async (entry: DevBundleFile): Promise<DevBundleArtifact | null> => {
    const path = join(dir, entry.name)
    const metadata = await readMetadata(deps.fs, path)
    if (!metadata) return null
    // Publisher mints carry the sha in build metadata; legacy names carried `dev+<sha>`.
    // Either way the artifact has to claim THIS commit.
    if (commitShaFromDevVersion(metadata.version) !== sha) return null
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
    // An artifact from before multi-platform builds carries no platform in either its
    // name or its sidecar; it can only be this host's, because that is the only one a
    // build of that vintage produced.
    const platform = entry.platform || metadata.platform || hostPlatform
    return {
      platform,
      path,
      size: actual.size,
      digest: actual.digest,
      signature,
      version: metadata.version,
    }
  }

  // Newest first per platform, so a rebuilt platform recovers its latest file.
  const seen = new Set<string>()
  const artifacts: DevBundleArtifact[] = []
  let version: string | undefined
  for (const entry of listDevBundles(await deps.fs.list(dir))) {
    if (entry.sha !== sha) continue
    const platform = entry.platform || hostPlatform
    if (seen.has(platform)) continue
    seen.add(platform)
    const artifact = await recover(entry)
    if (!artifact) continue
    version ??= artifact.version
    // One recovered BUILD, not an assortment: mixing two mints of the same commit
    // would publish a manifest whose platforms disagree about which version they are.
    if (artifact.version !== version) continue
    artifacts.push(artifact)
  }

  // THE HOST'S OWN BUNDLE DECIDES. Without it there is nothing for this machine to
  // converge on, and recovering only a Mac's bundle would publish a target the
  // publisher's own host could not take — so this reads as "nothing recovered", and the
  // build runs.
  const hostIndex = artifacts.findIndex((artifact) => artifact.platform === hostPlatform)
  if (hostIndex < 0 || version === undefined) return null
  const recovered = new Set(artifacts.map((artifact) => artifact.platform))
  if ((deps.platforms ?? []).some((platform) => !recovered.has(platform))) return null
  const [host] = artifacts.splice(hostIndex, 1) as [DevBundleArtifact]
  return {
    version,
    path: host.path,
    size: host.size,
    digest: host.digest,
    signature: host.signature,
    artifacts: [host, ...artifacts],
  }
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
  const sha = shortSha(deps.headSha ?? (await developmentHeadSha(root)))
  const publisherStateDir = deps.publisherStateDir ?? stateDir()
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
    const checkoutBase = resolveCheckoutReleaseBase(deps, root)
    // ONE version for the whole build. Every platform of one publish carries the same
    // label — a manifest whose platforms disagreed about their version would be a
    // release nobody could reason about.
    const allocated = allocateDevPublishVersion({
      stateDir: publisherStateDir,
      checkoutBase,
      sha,
    })
    const version = allocated.version

    // Host first, then whatever else the fleet needs. Host first matters: if a later
    // platform's compile fails, the host has already produced the bundle this machine
    // itself converges on, and the error names the platform that failed.
    const platforms = devBuildPlatforms(deps.platforms)
    const artifactNames = platforms.map((platform) => devBundleFileName(version, stamp, platform))
    // Remember the WHOLE publish before building it. The allowlist is what stops the
    // sweep reclaiming these files, and it has to name all of them.
    const referenced = rememberDevArtifact({
      stateDir: publisherStateDir,
      artifactNames,
      ...(deps.retain !== undefined ? { retain: deps.retain } : {}),
    })

    const artifacts: DevBundleArtifact[] = []
    for (const [index, platform] of platforms.entries()) {
      const requestedPath = join(devBundleDirectory(root), artifactNames[index] as string)
      const result = await spawnBuild({
        root,
        version,
        artifactPath: requestedPath,
        bunTarget: bunTargetForPlatform(platform),
        ...(deps.signingKey ? { signingKey: deps.signingKey } : {}),
        ...(deps.instanceId ? { instanceId: deps.instanceId } : {}),
      })
      await renewal
      if (renewalError) throw renewalError

      const resultObject = typeof result === 'object' && result !== null ? result : undefined
      const artifactPath =
        (typeof result === 'string' ? result : resultObject?.path) ?? requestedPath
      const signature =
        resultObject?.signature ??
        (await readOptionalText(fs, artifactPath + DEV_BUNDLE_SIGNATURE_SUFFIX))?.trim()
      // Unsigned is not "publish it anyway with a warning": a daemon verifies before it
      // swaps, so an unsigned bundle is one every machine would refuse after
      // downloading it. Refuse here, where the reason is still legible.
      if (!signature) {
        throw new Error(`development bundle for ${platform} is unsigned; refusing to publish it`)
      }

      const { digest, size } = await fs.digest(artifactPath)
      const metadata: DevBundleMetadata = {
        version,
        platform,
        digest,
        size,
        keyFingerprint: devBundleKeyFingerprint(deps.signingKey),
      }
      await fs.writeText(
        artifactPath + DEV_BUNDLE_METADATA_SUFFIX,
        `${JSON.stringify(metadata, null, 2)}\n`,
      )
      artifacts.push({ platform, path: artifactPath, size, digest, signature, version })
    }

    // ONE sweep, after every platform is on disk and with all of them protected.
    const host = artifacts[0] as DevBundleArtifact
    await sweepDevBundles(fs, dirname(host.path), {
      referenced,
      protect: artifacts.map((artifact) => basename(artifact.path)),
    })
    return {
      version,
      path: host.path,
      size: host.size,
      digest: host.digest,
      signature: host.signature,
      artifacts,
    }
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
  return platformTargetFor(platform, arch)
}

/**
 * WHICH PLATFORMS A FLEET NEEDS BUNDLES FOR.
 *
 * The development host always mints its own — it is a consumer of its own feed, and the
 * one machine guaranteed to be there. Beyond that it mints for the platforms its
 * REGISTERED MACHINES actually run, and nothing else: a release cannot know who will
 * install it, but a dev feed serves a fleet whose members have all enrolled, so a
 * platform nobody runs is two minutes of the live host's CPU spent producing a file
 * that will never be fetched.
 *
 * A machine that has not reported an inventory yet contributes nothing rather than a
 * guess — it will contribute the moment its daemon connects and says what it is. A
 * machine on a platform we publish no bundle for (Windows) is likewise skipped: there
 * is no artifact to offer it, and pretending otherwise would put a key in the manifest
 * with nothing behind it.
 *
 * Pure, and ordered host-first, so it is a table of cases rather than a judgement made
 * inside the build.
 */
export function fleetHeadlessPlatforms(
  machines: ReadonlyArray<{ inventory?: { os: string; arch: string } | undefined }>,
  host: string = developmentPlatformTarget(),
): string[] {
  const platforms = [host]
  for (const machine of machines) {
    if (!machine.inventory) continue
    const platform = platformTargetFor(machine.inventory.os, machine.inventory.arch)
    if (!isHeadlessPlatform(platform)) continue
    if (!platforms.includes(platform)) platforms.push(platform)
  }
  return platforms
}

/**
 * The platform list a build will actually walk: whatever was asked for, with this
 * host's own guaranteed to be present and first, and duplicates removed.
 *
 * Host-first is load-bearing. If a later platform's compile fails, the bundle this
 * machine converges on has already been produced, and the failure names the platform
 * that could not be built rather than losing the whole build.
 */
export function devBuildPlatforms(
  requested: readonly string[] | undefined,
  host: string = developmentPlatformTarget(),
): string[] {
  return [...new Set([host, ...(requested ?? [])])]
}

/**
 * The migration folder names a commit defines, or `undefined` when the tree
 * cannot be read.
 *
 * `undefined` is the honest answer for a probe. Publication must not use it —
 * {@link requireDefinedMigrations} throws rather than shipping silence, the
 * same posture as `scripts/release.ts` `readDefinedMigrations`.
 */
export async function migrationsAtRevision(
  root: string,
  sha: string,
): Promise<string[] | undefined> {
  try {
    const stdout = await git(root, ['ls-tree', '-d', '--name-only', `${sha}:${MIGRATIONS_TREE}`])
    const names = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    return names.length > 0 ? names : undefined
  } catch {
    return undefined
  }
}

/**
 * Migrations a published development manifest must declare.
 *
 * THROWS rather than publishing silence. A manifest with no declaration is one
 * no machine can ever prove it could open, so a publisher that cannot see the
 * checkout's migrations has to stop, not ship a target that will be refused for
 * the rest of its life (POD-2502 / release.ts parity).
 */
export function requireDefinedMigrations(migrations: string[] | undefined, sha: string): string[] {
  if (migrations && migrations.length > 0) return migrations
  throw new Error(
    `no migrations found for ${sha}, so this development release cannot declare the schema it can open`,
  )
}

export function devTarget(
  built: BuiltDevBundle,
  opts: {
    /**
     * Where a machine fetches a platform's tarball from. Given the platform, because
     * one build now publishes several and each needs its own address.
     */
    artifactUrl?: (platform: string) => string
    /** Overrides the name of the host bundle's platform. Test seam. */
    platform?: string
    sourceRoot?: string
    webDigest?: string
    schemaMigrations?: string[]
  } = {},
): UpdateTarget {
  const hostPlatform = opts.platform ?? developmentPlatformTarget()
  // Every platform this build actually MINTED, and only those. A key here with no
  // tarball behind it is a machine that downloads a 404 and stops converging, so the
  // manifest is built from the artifact list rather than from what was asked for.
  const artifacts: DevBundleArtifact[] = built.artifacts ?? [
    {
      platform: hostPlatform,
      path: built.path,
      size: built.size,
      digest: built.digest,
      signature: built.signature,
      version: built.version,
    },
  ]
  const urlFor =
    opts.artifactUrl ??
    ((platform: string) =>
      `${DEV_ARTIFACT_ROUTE}/${encodeURIComponent(built.version)}/${encodeURIComponent(platform)}`)
  // The sha lives in build metadata for a publisher mint and after `dev+` for a legacy
  // identity; both forms answer "which commit is this?" through the same call.
  const sha = commitShaFromDevVersion(built.version) ?? built.version.replace(/^dev\+/, '')
  const webDigest = opts.webDigest ?? sha
  const migrations = requireDefinedMigrations(opts.schemaMigrations, sha)
  return {
    version: built.version,
    critical: false,
    schema: { migrations },
    artifacts: {
      headless: {
        delivery: 'bundle',
        platforms: Object.fromEntries(
          artifacts.map((artifact) => [
            // The host build is published under the name the caller gave, so a test
            // seam that renames the host platform still names one thing.
            artifact.platform === artifacts[0]?.platform ? hostPlatform : artifact.platform,
            {
              url: urlFor(artifact.platform),
              digest: artifact.digest,
              signature: artifact.signature,
            },
          ]),
        ),
      },
      headlessAlternatives: [
        {
          delivery: 'git',
          repo: opts.sourceRoot ?? DEVELOPMENT_SOURCE_ROOT,
          sha,
        },
      ],
      web: { digest: webDigest },
    },
  }
}

/**
 * Orderable install identity when there is not yet an honest headless tarball
 * for this HEAD. Spec §1: dest versions are orderable on every channel, so the
 * identity target carries a publisher mint (same form a later build will reuse
 * for this SHA) rather than an unorderable `dev+<sha>`. Do not advertise a
 * previous commit's tarball under this label.
 *
 * Schema declarations are required — same fail-closed posture as {@link devTarget}.
 */
export function devIdentityTarget(
  version: string,
  headSha: string,
  opts: { sourceRoot?: string; schemaMigrations?: string[] } = {},
): UpdateTarget {
  const sha = shortSha(headSha)
  const fromVersion = commitShaFromDevVersion(version)
  if (fromVersion !== sha) {
    throw new Error(`identity target version ${version} does not name commit ${sha}`)
  }
  const migrations = requireDefinedMigrations(opts.schemaMigrations, sha)
  return {
    version,
    critical: false,
    schema: { migrations },
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
  headSha: () => string | Promise<string>
  debounceMs?: number
  /**
   * Where a machine fetches a platform's tarball from. Takes the platform as well as
   * the version, because one build now publishes several bundles and each needs its
   * own address.
   */
  artifactUrl?: string | ((version: string, platform: string) => string)
  platform?: string
  /**
   * The platforms this fleet needs bundles for, read fresh at every build so a Mac
   * that enrolls today is served by the next build rather than by the next restart.
   * Defaults to this host's own.
   */
  fleetPlatforms?: () => readonly string[]
  /**
   * The migrations defined AT a revision — what the published target declares
   * it can open (POD-2213). Seam for tests; defaults to reading the commit's
   * own migration tree.
   *
   * Read from the COMMIT, never from this server's compiled-in migration list:
   * the one case where the two differ is a checkout moving backwards, which is
   * exactly the convergence that must be refused.
   */
  migrationsAt?: (sha: string) => Promise<string[] | undefined>
  /** Seam for tests; defaults to `git status --porcelain -z` in `root`. */
  readSourceStatus?: DevBundleSourceReader
  /** Seam for tests; defaults to `git ls-files --others --ignored` in `root`. */
  readIgnoredSourceInputs?: DevBundleSourceReader
  /**
   * Called the moment a request is ADMITTED: after HEAD and the identity gate
   * have passed, before the compile that follows them.
   *
   * Reading HEAD and walking the tree happen off the event loop, so admission
   * is no longer settled by the time `requestBuild` returns — a caller can no
   * longer infer "a build started" from the call coming back. Anything that
   * must say `preparing` rather than sit on the previous commit's target for
   * the length of a compile has to be told, and this is the telling.
   */
  onAdmitted?: () => void
  /**
   * Settle `apps/web/dist` before anything expensive happens — and REFUSE
   * rather than rebuild it when this request is not explicit.
   *
   * That asymmetry is the whole point, and it was learned the hard way. The
   * compile needs the dist stamped at this commit, so the obvious move is
   * "build it whenever it is stale". But this server SERVES that dist to
   * browsers, and `/version` used to ask for a build on every read — so
   * building on that path rebuilt the website every time main moved, while the
   * server itself stayed on the commit it booted with. The page then ran AHEAD
   * of the server, their wire schema digests disagreed, and every open tab got the
   * out-of-sync banner. Observed live: one server on dev+e10795a rebuilt the
   * website six times for five commits it was not running.
   *
   * So the dist may only move during an operator-driven update, which restarts
   * the server straight after. Polling and start-up leave it alone: an unpacked
   * identity target costs nothing, a broken page costs every open tab.
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
  target(): Promise<UpdateTarget | undefined>
  /** Explicit lifecycle for this HEAD, with a reason safe to show a client. */
  readiness(): Promise<DevBundleReadiness>
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

  const currentHeadSha = async (): Promise<string | null> => {
    try {
      return shortSha(await deps.headSha())
    } catch {
      return null
    }
  }

  /** Probe only — publication goes through {@link requireDefinedMigrations}. */
  const readMigrationsAt = async (sha: string): Promise<string[] | undefined> => {
    const read =
      deps.migrationsAt ?? ((at: string) => migrationsAtRevision(deps.root ?? SOURCE_ROOT, at))
    try {
      return await read(sha)
    } catch {
      return undefined
    }
  }

  const recordFailure = (error: unknown, sha: string | null) => {
    const reason = error instanceof Error ? error.message : String(error)
    unavailable = reason
    failure = { sha, reason, publicReason: publicUnavailableReason(error, sha ?? 'unknown') }
  }

  /**
   * The outcome of deciding whether to build — the COMPILE it started, or the
   * reason it never got that far. Distinct from the compile's own result,
   * because the two now settle at different times and only the first is
   * serialised (see `admissions` below).
   */
  type Admission = { result: Promise<BuiltDevBundle | null> } | { error: unknown }

  const admit = async (explicit: boolean): Promise<Admission> => {
    // The commit this attempt actually read, kept where the catch below can
    // still see it — so a refusal is recorded against the commit it refused
    // rather than against a second, later read of HEAD.
    let attempted: string | null = null
    try {
      const headSha = shortSha(await deps.headSha())
      attempted = headSha
      const decision = decideDevBuild({
        isSourceRun: typeof deps.isSourceRun === 'function' ? deps.isSourceRun() : deps.isSourceRun,
        headSha,
        builtSha,
        lastAttemptAt,
        now: now(),
        inFlight: inFlight !== null,
        debounceMs,
        explicit,
      })
      if (!decision.build) return { result: Promise.resolve(inFlight ?? current) }

      lastAttemptAt = now()
      // Fail closed BEFORE restoring or compiling: a dirty checkout cannot
      // produce a dev+<sha> build of that commit, and an artifact left in
      // dist-bun must not be restored under a tree that has since diverged.
      await assertSourceMatchesHead(
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
      // Read fresh, per build: a Mac that enrolled since the last one must be served by
      // the NEXT build, not by the next restart.
      const platforms = devBuildPlatforms(deps.fleetPlatforms?.())
      const build = () => buildDevBundle({ ...deps, headSha, platforms })
      const requested = prepared
        .then(() =>
          current === null
            ? readExistingDevBundle({ ...deps, fs, headSha, platforms }).then(async (existing) => {
                if (!existing) return build()
                // The WHOLE publish, not just this host's file: the allowlist is what
                // stops the sweep reclaiming the other platforms' bundles.
                const artifactNames = existing.artifacts.map((artifact) => basename(artifact.path))
                const statePath = deps.publisherStateDir ?? stateDir()
                // Restoring still counts as publishing those basenames. Seed from
                // the artifacts when state was lost so the counter cannot rewind.
                let referenced: string[]
                try {
                  referenced = rememberDevArtifact({
                    stateDir: statePath,
                    artifactNames,
                    ...(deps.retain !== undefined ? { retain: deps.retain } : {}),
                  })
                } catch {
                  const knownNames = await fs.list(dirname(existing.path))
                  referenced = seedPublisherStateFromArtifact({
                    stateDir: statePath,
                    version: existing.version,
                    artifactNames,
                    knownNames,
                    ...(deps.retain !== undefined ? { retain: deps.retain } : {}),
                  })
                }
                await sweepDevBundles(fs, dirname(existing.path), {
                  referenced,
                  protect: artifactNames,
                })
                return existing
              })
            : build(),
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
      deps.onAdmitted?.()
      return { result: requested }
    } catch (error) {
      recordFailure(error, attempted)
      return { error }
    }
  }

  /**
   * ADMISSIONS RUN ONE AT A TIME, and that queue is what keeps "never two at
   * once" true now that deciding takes awaits.
   *
   * `inFlight` used to be set in the same synchronous turn as the check that
   * reads it, so two requests could not both pass it. Reading HEAD and walking
   * the tree are asynchronous, so without this queue two `/version` polls
   * landing together would both find `inFlight` empty and both start a
   * quarter-gigabyte compile on the live host.
   *
   * Only the ADMISSION is serialised, never the compile: the queue is released
   * as soon as a request has decided, so a poll arriving during a build still
   * gets its answer immediately rather than waiting out the minute.
   */
  let admissions: Promise<unknown> = Promise.resolve()

  return {
    requestBuild(explicit = false) {
      const admitted = admissions.then(() => admit(explicit))
      admissions = admitted.catch(() => undefined)
      return admitted.then((admission) =>
        'error' in admission ? Promise.reject(admission.error) : admission.result,
      )
    },
    current: () => current,
    unavailable: () => unavailable,
    readiness: async () => {
      const headSha = await currentHeadSha()
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
    target: async () => {
      const headSha = await currentHeadSha()
      if (headSha === null) return undefined
      // A source-identity label names this commit. A dirty tree is not that
      // commit, so do not advertise one. Any other failure (stale web dist,
      // compile) still needs the identity so Update can rebuild.
      if (failure?.sha === headSha && failure.reason.includes('does not match HEAD')) {
        return undefined
      }
      // Declared for the commit being advertised — the same short sha the git
      // artifact tells the daemon to check out (POD-2213). Publication fails
      // closed when the tree cannot be read (POD-2502 / release.ts parity).
      let migrations: string[]
      try {
        migrations = requireDefinedMigrations(await readMigrationsAt(headSha), headSha)
      } catch (error) {
        recordFailure(error, headSha)
        return undefined
      }
      if (current && builtSha === headSha) {
        const configured = deps.artifactUrl
        const built = current
        const hostPlatform = deps.platform ?? developmentPlatformTarget()
        const artifactUrl =
          typeof configured === 'function'
            ? (platform: string) => configured(built.version, platform)
            : configured !== undefined
              ? // A fixed string names ONE address, which could only ever be honest
                // while one platform was published. Keep honouring it for the host
                // bundle and give every other platform its own route URL, rather than
                // handing every machine the same file.
                (platform: string) =>
                  platform === hostPlatform
                    ? configured
                    : `${DEV_ARTIFACT_ROUTE}/${encodeURIComponent(built.version)}/${encodeURIComponent(platform)}`
              : undefined
        return devTarget(current, {
          ...(artifactUrl ? { artifactUrl } : {}),
          platform: deps.platform,
          sourceRoot: deps.root,
          schemaMigrations: migrations,
        })
      }
      // Allocate (or reuse) an orderable mint for this HEAD so identity
      // targets compare like every other channel (spec §1 / F6).
      //
      // FAIL SOFT, like every other step on this path. Minting reads the
      // checkout's package.json, reads and rewrites publisher state, and fails
      // closed when it cannot prove the mint is newer — five throw sites where
      // there used to be none. The only caller that matters is
      // `dev-publisher-wiring.ts`'s `onAdmitted: () => { void publishReadiness() }`,
      // a floating promise with no `.catch`: a corrupt state file thrown from
      // here is an unhandled rejection on the live server. "No target right
      // now", recorded so the operator can read the reason, is the honest
      // answer to a publisher that cannot mint.
      const root = deps.root ?? SOURCE_ROOT
      try {
        const allocated = allocateDevPublishVersion({
          stateDir: deps.publisherStateDir ?? stateDir(),
          checkoutBase: resolveCheckoutReleaseBase(deps, root),
          sha: headSha,
        })
        return devIdentityTarget(allocated.version, headSha, {
          sourceRoot: deps.root,
          schemaMigrations: migrations,
        })
      } catch (error) {
        recordFailure(error, headSha)
        return undefined
      }
    },
  }
}
