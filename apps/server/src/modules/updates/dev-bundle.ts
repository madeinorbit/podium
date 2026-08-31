import { execFile } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, renameSync } from 'node:fs'
import { mkdir, readdir, readFile as readFileAsync, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createLogger } from '@podium/logger'
import {
  commitShaFromDevVersion,
  isFlatPublisherDevVersion,
  isHeadlessPlatform,
  isPublisherDevVersion,
  mintDevVersion,
  parsePublisherDevVersion,
  platformTargetFor,
  type ReleaseProposal,
  UpdateTarget,
} from '@podium/protocol'
import { resolveInstanceId, stateDir } from '@podium/runtime/config'
import { instanceBuildSliceName } from '@podium/runtime/instance'
import {
  type ReleaseBuildTimingDeps,
  releaseBuildTimingEnvironment,
  releaseBuildTimingFileName,
  timeReleaseBuildTask,
} from '@podium/runtime/release-build-timing'
import {
  advanceOutcome,
  type BuildOutcome,
  type BuildRecord,
  type BuildRecordClient,
  buildBundlesDir,
  buildClientEvidencePath,
  buildRecordDir,
  buildTimingPath,
  listBuildRecords,
  mintBuildId,
  prepareBuildRecordDir,
  sweepBuildRecords,
  writeBuildRecord,
} from './build-record'
import { devBuildCommand, devBuildScopeUnit, runLowTierBuild } from './build-scope'
import { type DevBuildSnapshot, withDevBuildSnapshot } from './dev-build-snapshot'
import {
  readDevPublisherState,
  versionStateOf,
  writeDevPublisherState,
} from './dev-publisher-state'
import { type ReleaseProposalFacts, releaseProposalFacts } from './release-proposal'
import {
  DEV_DESKTOP_MANIFEST,
  DEV_FEED_MANIFEST,
  DEV_FEED_ROUTE,
  type DesktopFeedChannel,
  desktopReleaseManifestUrl,
  validateDesktopFeedManifest,
} from './release-target'

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
      reason: 'up-to-date' | 'debounced' | 'in-flight' | 'no-source-checkout'
    }
  | { build: true }

export interface DevBuildDecisionContext {
  sourceCheckoutAvailable: boolean
  headSha: string
  builtSha: string | null
  lastAttemptAt: number | null
  now: number
  inFlight: boolean
  debounceMs: number
  explicit: boolean
}

export function decideDevBuild(ctx: DevBuildDecisionContext): BuildDecision {
  if (!ctx.sourceCheckoutAvailable) return { build: false, reason: 'no-source-checkout' }
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
 * version (`X.Y.Z-dev.<N>+<sha>`, POD-2502). The `+<sha>` build metadata is
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

/** The displayed proposal ceased to name live HEAD before build admission. */
export class DevBundleProposalMovedError extends DevBundleUnavailableError {
  override name = 'DevBundleProposalMovedError'
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
    'development bundle unavailable: the source checkout has uncommitted changes and does not match HEAD (' +
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
/** The artifact leg of this server's own dev feed; see `artifact-route.ts`. */
export const DEV_ARTIFACT_ROUTE = `${DEV_FEED_ROUTE}/artifact`

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
  /**
   * The ledger record this build wrote (POD-3055). Every artifact below lives under
   * `<stateDir>/builds/<buildId>/bundles/`, and it is what the publish step advances to
   * `published` and what the retention sweep protects.
   */
  buildId: string
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
 * The published version is a publisher mint (`X.Y.Z-dev.<N>+<sha>`). The FILE
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
    return {
      name,
      sha,
      platform: legacy[2] ?? '',
      stamp: legacy[3] ?? '',
      version: `dev+${sha}`,
    }
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
  // ENSURE THE PARENT, because nothing else does any more.
  //
  // `dist-bun/` used to be created as a side effect of the build writing its tarballs
  // there. The tarballs live in the ledger now, so on a checkout that has never built,
  // the first thing to want that directory is the feed manifest — and a publish that
  // fails with ENOENT on `latest.json` is a release nobody can pull, reported as a disk
  // fault. The seam owns this rather than the manifest writers: they take a
  // `DevBundleFs`, and only this implementation is on a real filesystem.
  writeText: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  },
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
   * a build minted more than one platform has no such field.
   *
   * The server no longer READS this file: the build record says everything it used to
   * be consulted for, and says it about the whole publish rather than one file at a
   * time. It is still written because it travels WITH the tarball, and the
   * out-of-band repair path (`scripts/repair-stranded-update.sh`) has nothing but the
   * three copied files to verify against.
   */
  platform?: string
}

export function devBundleKeyFingerprint(signingKey: string | undefined): string {
  if (!signingKey) return 'unkeyed'
  try {
    const publicKey = createPublicKey(
      createPrivateKey({
        key: Buffer.from(signingKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }),
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

/** One platform's slot in a publish: what to compile, and where its tarball goes. */
export interface DevBuildArtifactRequest {
  platform: string
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
  /** Where the build must write the tarball. Carries the build-time stamp. */
  artifactPath: string
}

export interface DevBuildSpawnContext {
  root: string
  version: string
  /**
   * EVERY platform of this publish, in build order, host first.
   *
   * One context, not one per platform, because one publish is now ONE build. The
   * clients are built (or restored) once by the coordinator and every platform is
   * packaged from that single output — which is what makes the bundles of one publish
   * share a web digest, and what makes an approval whose clients did not change build
   * nothing at all. Handing the spawn one platform at a time is how the publisher used
   * to pay for the client build N times over.
   */
  artifacts: readonly DevBuildArtifactRequest[]
  signingKey?: string
  /** Names the transient build unit, so two instances cannot share one. */
  instanceId?: string
  /** Opt-in evidence context inherited by the detached build command. */
  timingEnv?: NodeJS.ProcessEnv
  /**
   * This attempt's ledger directory, `<stateDir>/builds/<buildId>/`.
   *
   * The child writes its client evidence here (`client.json`) before it packages
   * anything, and the artifact paths it is handed are inside this directory's
   * `bundles/`. The publisher folds both into the record when the attempt settles.
   */
  recordDir: string
}

/**
 * What the spawn reports back, if anything.
 *
 * `undefined` is the production answer: the coordinator wrote each tarball to the path
 * this side named, and this side reads the signature from disk beside it. The array
 * form lets a seam name a different path or hand the signature back in memory.
 */
export type DevBuildSpawnResult =
  | undefined
  | ReadonlyArray<{
      platform: string
      path?: string
      signature?: string
    }>

export interface DevBundleBuildDeps {
  lock: DevBundleLock
  /**
   * Immutable build source — a detached snapshot for an approved build.
   *
   * There is no longer an `artifactRoot` beside it. Artifacts used to be written back
   * into the LIVE checkout while the build ran from a snapshot of it; they now go into
   * the build record under the state directory, which no snapshot owns and no checkout
   * can take with it.
   */
  root?: string
  headSha?: string
  spawnBuild?: (ctx: DevBuildSpawnContext) => Promise<DevBuildSpawnResult> | DevBuildSpawnResult
  build?: (ctx: DevBuildSpawnContext) => Promise<DevBuildSpawnResult> | DevBuildSpawnResult
  fs?: DevBundleFs
  signingKey?: string
  renewIntervalMs?: number
  retain?: number
  now?: () => number
  /** Enabled only by the source development-publisher wiring. */
  timing?: ReleaseBuildTimingDeps
  /** Names the transient build unit; passed through to `spawnBuild`. */
  instanceId?: string
  /**
   * Instance state directory for publisher version persistence. Defaults to
   * `stateDir()`. Seam for tests.
   */
  publisherStateDir?: string
  /** Version reserved by the approved proposal for this exact `headSha`. */
  releaseVersion?: string
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
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: unknown
    }
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
 * {@link rememberDevBuild} once the build id is known so the sweep
 * allowlist includes it.
 *
 * READ-MODIFY-WRITE, AND NOT SERIALISED against a concurrent build. `target()`
 * calls this on the `/version` path, outside the lock `buildDevBundle` holds,
 * so two callers can interleave. A current flat allocation is idempotent per SHA
 * (`lastSha`/`lastVersion` short-circuit); a legacy label takes one monotonic
 * migration before the same rule applies. The counter only ever moves forward —
 * an interleaving costs a wasted N, never a reused one. Anything that
 * makes allocation depend on more than the SHA needs the lock first.
 */
export function allocateDevPublishVersion(input: {
  stateDir: string
  checkoutBase: string
  sha: string
}): { version: string; base: string; counter: number } {
  const existing = readDevPublisherState(input.stateDir)
  const sha = shortSha(input.sha)
  if (
    existing?.lastSha === sha &&
    existing.lastVersion &&
    isFlatPublisherDevVersion(existing.lastVersion)
  ) {
    return {
      version: existing.lastVersion,
      base: existing.base,
      counter: existing.counter,
    }
  }
  const minted = mintDevVersion(versionStateOf(existing), input.checkoutBase, sha)
  writeDevPublisherState(
    {
      ...existing,
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
 * Point the publisher's persisted state at the build the ledger is about to record.
 *
 * This is all that is left of `rememberDevArtifact`, and the shrinkage is the point.
 * The old function kept an allowlist of artifact BASENAMES in the state file, because
 * the sweep worked on a flat directory of tarballs and had no other way to know which
 * files a publish still needed. The records are that knowledge now, held next to the
 * bytes they describe, so a second list here would only be a copy that can disagree
 * with them.
 *
 * It still refuses before a mint, for the reason it always did: an artifact remembered
 * against no version state is one nothing can order.
 */
export function rememberDevBuild(input: { stateDir: string; buildId: string }): void {
  const existing = readDevPublisherState(input.stateDir)
  if (!existing) {
    throw new Error('cannot remember a development build before a version has been minted')
  }
  writeDevPublisherState({ ...existing, lastBuildId: input.buildId }, input.stateDir)
}

/**
 * Recover publisher state from a build record when the state file is gone.
 *
 * The record names the version, and a publisher version parses back into the base and
 * counter that minted it — so a lost state file cannot rewind the counter under a fleet
 * that has already seen those versions.
 */
export function seedPublisherStateFromRecord(input: {
  stateDir: string
  record: BuildRecord
}): void {
  const parsed = parsePublisherDevVersion(input.record.version)
  if (!parsed) {
    // A legacy `dev+<sha>` identity on disk carries no counter to restore. There is
    // nothing to seed and nothing to rewind; the next mint starts from the checkout.
    return
  }
  writeDevPublisherState(
    {
      base: parsed.base,
      counter: parsed.counter,
      retainedArtifacts: [],
      lastSha: parsed.sha,
      lastVersion: input.record.version,
      lastBuildId: input.record.buildId,
    },
    input.stateDir,
  )
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
/**
 * The command line ONE release child is given for a whole publish.
 *
 * `scripts/release.ts --prepare-cross` is the coordinator both this publisher and the
 * CI release job run. It builds (or restores) the clients once through the Turbo lane
 * and then packages every platform named here from that one output, in process.
 * Spawning it per platform is what used to make an approval pay for the client build
 * once per platform — and calling build-bun directly refuses, so this path cannot
 * package an old approved-SHA dist by accident.
 *
 * `--platform` for EVERY platform, this host's own included, so the dev host exercises
 * the exact path that produces what ships rather than a nearby one — including the
 * cross-compiled abduco helper, which is the part of a bundle a native build would have
 * got from somewhere else. `--artifact` because this side owns the artifacts' lifecycle:
 * the build stamp in each name is what retention later sorts on, and the paths must be
 * absolute because the coordinator runs in the snapshot worktree, which is deleted
 * afterwards.
 *
 * Exported so a test can read the ACTUAL argument vector rather than grep the source
 * for a string that no longer has to mean anything.
 */
export function devReleaseBuildArgs(
  artifacts: readonly DevBuildArtifactRequest[],
  recordDir?: string,
): string[] {
  return [
    'scripts/release.ts',
    '--prepare-cross',
    ...(recordDir ? ['--record', recordDir] : []),
    ...artifacts.flatMap((artifact) => [
      '--platform',
      artifact.platform,
      '--artifact',
      `${artifact.platform}=${artifact.artifactPath}`,
    ]),
  ]
}

async function defaultSpawnBuild(ctx: DevBuildSpawnContext): Promise<undefined> {
  const signingKey = ctx.signingKey ?? developmentSigningKey(ctx.root)
  const instanceId = ctx.instanceId ?? resolveInstanceId()
  const platforms = ctx.artifacts.map((artifact) => artifact.platform)
  await runLowTierBuild({
    unit: devBuildScopeUnit(DEV_BUNDLE_BUILD_ROLE, instanceId),
    slice: instanceBuildSliceName(instanceId),
    description: `Podium development release build (${ctx.version}, ${platforms.join(', ')})`,
    command: devBuildCommand(process.env),
    // ONE child for the whole publish; see devReleaseBuildArgs.
    args: devReleaseBuildArgs(ctx.artifacts, ctx.recordDir),
    cwd: ctx.root,
    env: {
      ...process.env,
      ...ctx.timingEnv,
      PODIUM_APP_VERSION: ctx.version,
      PODIUM_UPDATE_SIGNING_KEY: signingKey,
    },
  })
  return undefined
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

/**
 * The checkout directory that holds the SERVED FEED MANIFESTS.
 *
 * It is no longer the artifact root: the published tarballs moved into the ledger under
 * the state directory (POD-3055). The two manifests stay here because they are what the
 * checkout's own web server hands out, addressed by path from the source root.
 */
export function devBundleDirectory(root: string): string {
  return join(root, 'dist-bun')
}

/**
 * The client evidence the coordinator child wrote, or `null` if it never got that far.
 *
 * Read defensively: this file crosses a process boundary from a child that may have
 * died halfway through writing it, and a record with a null client is a truthful record
 * of an attempt whose clients cannot be described — not a reason to lose the rest.
 */
function readClientBuildRecord(stateDirectory: string, buildId: string): BuildRecordClient | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(buildClientEvidencePath(stateDirectory, buildId), 'utf8'))
  } catch {
    return null
  }
  const candidate = raw as Partial<BuildRecordClient>
  if (
    typeof candidate.rootDigest !== 'string' ||
    typeof candidate.sourceCommit !== 'string' ||
    typeof candidate.version !== 'string'
  ) {
    return null
  }
  return {
    rootDigest: candidate.rootDigest,
    sourceCommit: candidate.sourceCommit,
    version: candidate.version,
    tasks: typeof candidate.tasks === 'object' && candidate.tasks !== null ? candidate.tasks : {},
  }
}

async function readOptionalText(fs: DevBundleFs, path: string): Promise<string | undefined> {
  try {
    return await fs.readText(path)
  } catch {
    return undefined
  }
}

/**
 * Recover the release already produced for this checkout's HEAD, FROM THE LEDGER.
 *
 * The publisher itself is process-local while the signed bytes are deliberately durable
 * across restarts, so a restart must be able to find what it already published. It used
 * to do that by parsing filenames in `dist-bun/` and cross-checking a sidecar; now it
 * reads records, which say the same things outright and say them about a whole publish
 * rather than one file at a time.
 *
 * What is NOT relaxed is the verification. A record is a claim; the bytes have to still
 * match it. Every artifact is re-hashed and its signature re-read, the record has to
 * have been signed by THIS server's identity, and the whole publish is taken or none of
 * it is — a mixture of two mints of one commit would publish a manifest whose platforms
 * disagreed about their own version.
 */
async function readExistingDevBundle(
  deps: Pick<DevBundleBuildDeps, 'root' | 'signingKey' | 'publisherStateDir'> & {
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
  const sha = shortSha(deps.headSha)
  const stateDirectory = deps.publisherStateDir ?? stateDir()
  const fingerprint = devBundleKeyFingerprint(deps.signingKey)
  const hostPlatform = developmentPlatformTarget()
  const required = new Set([hostPlatform, ...(deps.platforms ?? [])])

  for (const record of listBuildRecords(stateDirectory)) {
    if (record.approvedSha !== sha) continue
    // A failed attempt is forensics. Nothing recovers from one.
    if (record.outcome !== 'signed' && record.outcome !== 'published') continue
    // A rotated update key makes every earlier signature unverifiable to the fleet;
    // rebuilding is the only honest answer.
    if (record.signingKeyFingerprint !== fingerprint) continue
    if ([...required].some((platform) => !record.artifacts.some((a) => a.platform === platform))) {
      continue
    }

    const dir = buildBundlesDir(stateDirectory, record.buildId)
    const artifacts: DevBundleArtifact[] = []
    for (const entry of record.artifacts) {
      const path = join(dir, entry.file)
      const signature = (
        await readOptionalText(deps.fs, path + DEV_BUNDLE_SIGNATURE_SUFFIX)
      )?.trim()
      if (!signature || signature !== entry.signature) break
      let actual: { digest: string; size: number }
      try {
        actual = await deps.fs.digest(path)
      } catch {
        break
      }
      if (actual.digest !== entry.digest || actual.size !== entry.size) break
      artifacts.push({
        platform: entry.platform,
        path,
        size: actual.size,
        digest: actual.digest,
        signature,
        version: record.version,
      })
    }
    // ALL OF IT OR NONE OF IT: a short read means a file went missing or changed under
    // the record, and half a publish is not a publish.
    if (artifacts.length !== record.artifacts.length) continue

    // THE HOST'S OWN BUNDLE DECIDES its position: without it there is nothing for this
    // machine to converge on, which the `required` check above has already made certain.
    const hostIndex = artifacts.findIndex((artifact) => artifact.platform === hostPlatform)
    const [host] = artifacts.splice(hostIndex, 1) as [DevBundleArtifact]
    return {
      buildId: record.buildId,
      version: record.version,
      path: host.path,
      size: host.size,
      digest: host.digest,
      signature: host.signature,
      artifacts: [host, ...artifacts],
    }
  }
  return null
}

/**
 * Move this release's staged timing lines into its record.
 *
 * The sink is keyed by version because it is opened before there is a build id to key
 * it by — it times the steps that mint one. This is where the two are joined.
 */
export function finalizeTimingIntoRecord(
  timing: ReleaseBuildTimingDeps | undefined,
  stateDirectory: string,
  buildId: string,
  version: string,
): void {
  const staging = timing?.outputDirectory
  if (!staging) return
  try {
    renameSync(
      join(staging, releaseBuildTimingFileName(version)),
      buildTimingPath(stateDirectory, buildId),
    )
  } catch {
    // No lines were written, or they could not be moved. Neither is a release failure.
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
  if ('clientRootDigest' in deps) {
    throw new Error(
      'caller-supplied clientRootDigest is forbidden; the packager captures client provenance itself',
    )
  }
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
    const version = deps.releaseVersion
      ? (() => {
          if (commitShaFromDevVersion(deps.releaseVersion) !== sha) {
            throw new Error(
              `approved development version ${deps.releaseVersion} does not name commit ${sha}`,
            )
          }
          return deps.releaseVersion
        })()
      : allocateDevPublishVersion({
          stateDir: publisherStateDir,
          checkoutBase,
          sha,
        }).version
    const timingEnv = releaseBuildTimingEnvironment(deps.timing ?? {}, {
      channel: 'dev',
      version,
      sourceSha: sha,
    })

    const platforms = devBuildPlatforms(deps.platforms)
    const artifactNames = platforms.map((platform) => devBundleFileName(version, stamp, platform))
    // THE LEDGER ENTRY THIS ATTEMPT WRITES INTO.
    //
    // The directory is made before the build runs, because the build has to put its
    // tarballs somewhere; the RECORD inside it is written only once the attempt has
    // signed bytes to describe, or a named step to blame. §6 of the design had the
    // coordinator mint the id after verification and rename a `.pending-` directory
    // into place, which buys nothing here: the id is `<stamp>-<sha>`, both known before
    // the build starts, and it is `manifest.json` — not the directory — that readers
    // treat as the record. Neither the id nor this path enters any Turbo-cached key or
    // output; the lane's inputs are the client sources, and the tarballs are packaged
    // downstream of it.
    const buildId = mintBuildId(stamp, sha)
    const recordDir = prepareBuildRecordDir(publisherStateDir, buildId)
    const bundlesDir = buildBundlesDir(publisherStateDir, buildId)
    rememberDevBuild({ stateDir: publisherStateDir, buildId })
    const startedAt = new Date((deps.now ?? Date.now)()).toISOString()
    const state = readDevPublisherState(publisherStateDir)
    // The one build a sweep must never touch besides this one: the release the served
    // feed still names. A fleet mid-rollout is fetching those bytes.
    const referencedBuilds = [
      buildId,
      ...(state?.lastPublishedBuildId ? [state.lastPublishedBuildId] : []),
    ]

    /** State the attempt's outcome, whatever it was. A failure records itself too. */
    const record = (
      outcome: BuildOutcome,
      artifacts: readonly DevBundleArtifact[],
    ): BuildRecord => {
      const entry: BuildRecord = {
        recordVersion: 1,
        buildId,
        approvedSha: sha,
        version,
        platforms: [...platforms],
        client: readClientBuildRecord(publisherStateDir, buildId),
        artifacts: artifacts.map((artifact) => ({
          platform: artifact.platform,
          file: basename(artifact.path),
          size: artifact.size,
          digest: artifact.digest,
          signature: artifact.signature,
        })),
        signingKeyFingerprint: devBundleKeyFingerprint(deps.signingKey),
        startedAt,
        outcome,
        outcomeAt: new Date((deps.now ?? Date.now)()).toISOString(),
      }
      writeBuildRecord(publisherStateDir, entry)
      return entry
    }

    // Host first, then whatever else the fleet needs. Host first matters: if a later
    // platform's compile fails, the host has already produced the bundle this machine
    // itself converges on, and the error names the platform that failed. The
    // coordinator packages in the order it is given them.
    const requests: DevBuildArtifactRequest[] = platforms.map((platform, index) => ({
      platform,
      bunTarget: bunTargetForPlatform(platform),
      // Into the record, not into the checkout's `dist-bun/`. The published bytes now
      // live beside the evidence that describes them, on the instance's own state
      // volume, so a checkout that is cleaned, rebased or thrown away does not take a
      // release the fleet is still installing with it.
      artifactPath: join(bundlesDir, artifactNames[index] as string),
    }))

    // ONE build for the whole publish. The clients are built or restored once inside it
    // and every platform is packaged from that single output.
    let result: DevBuildSpawnResult
    try {
      result = await spawnBuild({
        root,
        version,
        artifacts: requests,
        recordDir,
        ...(Object.keys(timingEnv).length > 0 ? { timingEnv } : {}),
        ...(deps.signingKey ? { signingKey: deps.signingKey } : {}),
        ...(deps.instanceId ? { instanceId: deps.instanceId } : {}),
      })
    } catch (error) {
      // WHICH STEP REFUSED, from what the child left behind. A `client.json` means the
      // clients verified and the failure is downstream of them; its absence means the
      // attempt never got past verification. That distinction is the whole reason a
      // failed attempt is worth recording: "the release failed" is in the log already.
      record(
        existsSync(buildClientEvidencePath(publisherStateDir, buildId))
          ? 'failed:package'
          : 'failed:verify',
        [],
      )
      throw error
    }
    await renewal
    if (renewalError) throw renewalError

    const artifacts: DevBundleArtifact[] = []
    try {
      for (const request of requests) {
        const platform = request.platform
        const requestedPath = request.artifactPath
        await timeReleaseBuildTask(
          {
            phase: 'artifact-publication',
            task: 'describe-artifact',
            channel: 'dev',
            version,
            sourceSha: sha,
            target: platform,
          },
          async () => {
            const reported = result?.find((entry) => entry.platform === platform)
            const artifactPath = reported?.path ?? requestedPath
            const signature =
              reported?.signature ??
              (await readOptionalText(fs, artifactPath + DEV_BUNDLE_SIGNATURE_SUFFIX))?.trim()
            // Unsigned is not "publish it anyway with a warning": a daemon verifies before it
            // swaps, so an unsigned bundle is one every machine would refuse after
            // downloading it. Refuse here, where the reason is still legible.
            if (!signature) {
              throw new Error(
                `development bundle for ${platform} is unsigned; refusing to publish it`,
              )
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
            artifacts.push({
              platform,
              path: artifactPath,
              size,
              digest,
              signature,
              version,
            })
          },
          deps.timing,
        )
      }
    } catch (error) {
      // Refusing to publish an unsigned or unhashable bundle is a real outcome, and the
      // ledger says so rather than leaving a directory of tarballs nobody can explain.
      record('failed:sign', artifacts)
      throw error
    }

    // THE RECORD, once every platform has a signed tarball this host has hashed. The
    // child signs in-process, so the first outcome the server can honestly state is
    // already `signed`; `validated` is the state between the two, which only the child
    // is ever inside.
    record('signed', artifacts)

    // ONE sweep, after the record exists — so this build is a record the sweep counts
    // rather than a directory it might mistake for abandoned — and by RECORD, so a
    // release the fleet is still being served keeps every byte it names.
    const host = artifacts[0] as DevBundleArtifact
    await timeReleaseBuildTask(
      { phase: 'artifact-publication', task: 'retention', channel: 'dev', version, sourceSha: sha },
      async () =>
        sweepBuildRecords(publisherStateDir, {
          retain: deps.retain ?? DEV_BUNDLE_RETAINED,
          referenced: referencedBuilds,
          protect: [buildId],
          now: (deps.now ?? Date.now)(),
        }),
      deps.timing,
    )
    return {
      buildId,
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
  machines: ReadonlyArray<{
    inventory?: { os: string; arch: string } | undefined
  }>,
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

/**
 * THE MANIFEST THIS PUBLISHER WRITES INTO ITS FEED (spec §6 step 3).
 *
 * Byte-for-byte the shape `scripts/release.ts` writes for edge and stable, and
 * that is the point: `resolveReleaseTarget` reads it with the same parser, the
 * same non-feed-delivery rejection and the same origin fence.
 *
 * It carries NO trust root. The resolver stamps that from the channel it asked
 * for, and refuses a manifest that names one — so this publisher cannot, even
 * by accident, nominate the key its own artifacts are checked against.
 */
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
    minRequired: { desktopBridge: 1 },
    schema: { migrations },
    artifacts: {
      headless: {
        // `feed`, like every other channel. It used to be `bundle` — a delivery
        // kind that existed only to mean "signed by the server rather than by
        // CI", which is a statement about TRUST and now travels as one.
        delivery: 'feed',
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
 * NOT A FEED DOCUMENT, and never written into one. It names no artifact at all
 * now that git delivery is retired — it is purely "what commit this source host
 * IS", published straight into this process's own read model so the Update
 * surface has something to compare the served website against. A machine cannot
 * converge to it and the planner says so (`cannot: no-artifact`).
 *
 * Spec §6 step 1 replaces it with a release PROPOSAL once the approval flow
 * exists (POD-2507); until then it is what keeps a source host's Update panel
 * able to rebuild yesterday's website.
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
    minRequired: { desktopBridge: 1 },
    schema: { migrations },
    artifacts: {
      web: { digest: sha },
    },
  }
}

/** Where the publisher writes `podium-update.json` for the served dev feed. */
export function devFeedManifestPath(root: string): string {
  return join(devBundleDirectory(root), DEV_FEED_MANIFEST)
}

export function devDesktopManifestPath(root: string): string {
  return join(devBundleDirectory(root), DEV_DESKTOP_MANIFEST)
}

/**
 * PUBLISHING IS WRITING THE MANIFEST (spec §6 step 4).
 *
 * Everything after this call is the unchanged shared path: the server nudges
 * its own target refresh, `resolveReleaseTarget` pulls this document back over
 * HTTP, and the standard operation runs. Writing it is therefore the handoff,
 * and the last moment this publisher is special.
 *
 * Written whole rather than merged into whatever was there: a manifest is one
 * release's complete description, and a partial rewrite is how a feed ends up
 * advertising one version's URL beside another's digest.
 */
export async function writeDevFeedManifest(
  fs: DevBundleFs,
  root: string,
  target: UpdateTarget,
): Promise<string> {
  const path = devFeedManifestPath(root)
  await fs.writeText(path, `${JSON.stringify(target, null, 2)}\n`)
  return path
}

/** One channel's standing shell manifest, or why there was none to have. */
export type StandingDesktopManifest = { raw: unknown } | { missing: string }

/** Which shell a dev server is serving, and — if it is not the dev one — why not. */
export type DesktopManifestSource = {
  channel: DesktopFeedChannel
  /** Present only on a fallback: what the dev channel answered instead of a manifest. */
  fellBackBecause?: string
}

async function fetchStandingDesktopManifest(
  channel: DesktopFeedChannel,
): Promise<StandingDesktopManifest> {
  const url = desktopReleaseManifestUrl(channel)
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5_000) })
    if (!response.ok) {
      return { missing: `${channel} desktop manifest returned HTTP ${response.status}` }
    }
    return { raw: await response.json() }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { missing: `${channel} desktop manifest could not be fetched: ${detail}` }
  }
}

/**
 * THE DEV SHELL IF THERE IS ONE, THE EDGE SHELL IF THERE IS NOT.
 *
 * A dev machine's shell has to come from somewhere real: only CI can produce a signed,
 * notarized bundle, so both channels' shells are published to GitHub and this picks
 * between them. Preferring dev is the point — a dev release exists precisely so a build
 * can be tried without reaching an install that follows edge.
 *
 * FALLING BACK IS FINE; DOING IT QUIETLY IS NOT. An instance with no dev desktop release
 * still works exactly as it did before this channel existed, and it says that is what
 * happened — {@link DesktopManifestSource.fellBackBecause} carries the dev channel's own
 * answer, and the served document names its release in every URL it contains.
 *
 * Note where the line falls: this handles a dev release that is ABSENT. A dev manifest
 * that was served but does not validate is a BROKEN release, and the caller lets that
 * throw rather than swapping in edge — an edge shell wearing a dev label, with nothing
 * for a reader to notice, is the failure this whole path is shaped to avoid.
 */
export async function resolveStandingDesktopManifest(
  fetchFor: (channel: DesktopFeedChannel) => Promise<StandingDesktopManifest>,
): Promise<{ source: DesktopManifestSource; raw: unknown }> {
  const dev = await fetchFor('dev')
  if ('raw' in dev) return { source: { channel: 'dev' }, raw: dev.raw }
  const edge = await fetchFor('edge')
  if (!('raw' in edge)) {
    throw new Error(`no desktop shell manifest to serve: ${dev.missing}; ${edge.missing}`)
  }
  return { source: { channel: 'edge', fellBackBecause: dev.missing }, raw: edge.raw }
}

export async function writeDevDesktopManifest(
  fs: DevBundleFs,
  root: string,
  channel: DesktopFeedChannel,
  raw: unknown,
): Promise<string> {
  validateDesktopFeedManifest(channel, raw)
  const path = devDesktopManifestPath(root)
  await fs.writeText(path, JSON.stringify(raw, null, 2) + '\n')
  return path
}

export interface DevBundlePublisherDeps extends Omit<DevBundleBuildDeps, 'headSha'> {
  sourceCheckoutAvailable: boolean | (() => boolean)
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
  /** Product version and source commit captured by the server producing this proposal. */
  proposalRunningVersion?: string
  proposalRunningSha?: string
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
  /**
   * Fetches one channel's standing shell manifest. Seam for tests; production reads GitHub.
   *
   * Deliberately below the dev-then-edge choice rather than beside it: the preference and
   * the fallback are the behaviour under test, so a test replaces what GitHub answers, not
   * what this server decides to do about it.
   */
  desktopShellManifest?: (channel: DesktopFeedChannel) => Promise<StandingDesktopManifest>
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
  /** Approved builds use a detached worktree; tests may supply an equivalent snapshot. */
  snapshotBuild?: DevBuildSnapshot
  /** Git proposal facts seam; production reads the checkout relative to the running server. */
  proposalFacts?: (input: {
    headSha: string
    runningSha?: string
    runningVersion?: string
    sinceSha?: string
  }) => Promise<ReleaseProposalFacts>
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
  | {
      state: 'failed'
      headSha: string | null
      reason: string
      publicReason: string
    }

/**
 * Published metadata still identifies an artifact, but the bytes at that path
 * no longer match it. This is intentionally distinct from `null`: `null`
 * means absent, stale, or unsupported and remains an ordinary not-found
 * response; this verdict is a security event the authenticated downloader must
 * be able to name.
 */
export class DevArtifactIntegrityError extends Error {
  override readonly name = 'DevArtifactIntegrityError'
}

export function createDevBundlePublisher(deps: DevBundlePublisherDeps): {
  requestBuild(
    explicit?: boolean,
    approved?: Pick<ReleaseProposal, 'headSha' | 'version'>,
  ): Promise<BuiltDevBundle | null>
  current(): BuiltDevBundle | null
  /**
   * Resolve one artifact from the release this host actually published.
   *
   * Unlike {@link current}, this survives a process restart: the served feed
   * manifest is the publication fact, and the recovered file must still match
   * both that manifest and the publisher-authored metadata before it is handed
   * to the route.
   */
  publishedArtifact(version: string, platform?: string): Promise<DevBundleArtifact | null>
  /**
   * WHAT THIS SOURCE HOST IS, for the current HEAD — an identity, never a
   * deliverable (see {@link devIdentityTarget}). Nothing, rather than an older
   * commit's.
   *
   * The target machines actually converge to does NOT come from here any more:
   * it is pulled back out of the feed by `resolveReleaseTarget`, exactly as on
   * edge and stable. That split is the whole shape of the pull conversion.
   */
  target(): Promise<UpdateTarget | undefined>
  /**
   * The manifest document for the build published for the CURRENT HEAD, or
   * nothing when no honest tarball exists for it yet.
   */
  feedManifest(): Promise<UpdateTarget | undefined>
  /**
   * Write {@link feedManifest} into the served feed directory, and answer
   * whether there was one to write. This is spec §6 step 4's handoff.
   */
  publishFeed(): Promise<boolean>
  /** The one collapsing, unbuilt release proposal for current HEAD. */
  proposal(): Promise<ReleaseProposal | undefined>
  /** Where the product manifest is written, so the feed route can serve it. */
  feedManifestPath(): string
  /** Where the shell manifest this server re-serves is written. */
  desktopManifestPath(): string
  /**
   * Which channel's shell the last publish put there, and why it is not the dev one when
   * it is not. Nothing before this process has published — after a restart the answer that
   * matters is derivable from the served file itself (`desktopManifestFeedChannel`), which
   * is why this is a convenience and never the record.
   */
  desktopManifestSource(): DesktopManifestSource | undefined
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
  let desktopManifestSource: DesktopManifestSource | undefined
  let failure: { sha: string | null; reason: string; publicReason: string } | undefined
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? 60_000
  const fs = deps.fs ?? nodeDevBundleFs
  const recoveredPublishedArtifacts = new Map<string, DevBundleArtifact>()

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
    failure = {
      sha,
      reason,
      publicReason: publicUnavailableReason(error, sha ?? 'unknown'),
    }
  }

  /**
   * The outcome of deciding whether to build — the COMPILE it started, or the
   * reason it never got that far. Distinct from the compile's own result,
   * because the two now settle at different times and only the first is
   * serialised (see `admissions` below).
   */
  type Admission = { result: Promise<BuiltDevBundle | null> } | { error: unknown }

  const admit = async (
    explicit: boolean,
    approved?: Pick<ReleaseProposal, 'headSha' | 'version'>,
  ): Promise<Admission> => {
    // The commit this attempt actually read, kept where the catch below can
    // still see it — so a refusal is recorded against the commit it refused
    // rather than against a second, later read of HEAD.
    let attempted: string | null = null
    try {
      const headSha = shortSha(await deps.headSha())
      attempted = headSha
      if (approved !== undefined && headSha !== shortSha(approved.headSha)) {
        throw new DevBundleProposalMovedError(
          `development release approval named ${shortSha(
            approved.headSha,
          )}, but HEAD is ${headSha}`,
          'HEAD changed after this development release was approved. Review and approve the new proposal.',
        )
      }
      const decision = decideDevBuild({
        sourceCheckoutAvailable:
          typeof deps.sourceCheckoutAvailable === 'function'
            ? deps.sourceCheckoutAvailable()
            : deps.sourceCheckoutAvailable,
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
      // produce a dev+<sha> build of that commit, and a recorded build must not be
      // restored under a tree that has since diverged.
      await assertSourceMatchesHead(
        deps.root ?? SOURCE_ROOT,
        headSha,
        deps.readSourceStatus,
        deps.readIgnoredSourceInputs,
      )
      // A restart loses only the in-memory descriptor, not the signed bytes.
      // Restore an exact-HEAD build from the ledger first; compile only when it
      // is absent or no longer verifies under this server's persisted update key.
      //
      // Read fresh, per build: a Mac that enrolled since the last one must be served by
      // the NEXT build, not by the next restart.
      const platforms = devBuildPlatforms(deps.fleetPlatforms?.())
      const liveRoot = deps.root ?? SOURCE_ROOT
      const buildFrom = async (buildRoot: string): Promise<BuiltDevBundle> => {
        // The clients are no longer built here. The release child owns them: it builds
        // or RESTORES web and mobile through the Turbo lane inside the snapshot, once
        // for the whole publish, and packages every platform from that one output.
        //
        // That also retires the refuse/rebuild asymmetry this used to need. The old
        // step wrote the LIVE `apps/web/dist`, which this server serves to browsers, so
        // a `/version` poll asking for a build marched the page ahead of the server it
        // was talking to — one server on dev+e10795a rebuilt the website six times for
        // five commits it was not running. The release build touches the live dist not
        // at all, so a poll has nothing to refuse. The Update panel's explicit "rebuild
        // the website" still owns live-dist rebuilds, through `createDevWebBuilder`.
        const build = () =>
          buildDevBundle({
            ...deps,
            root: buildRoot,
            headSha,
            platforms,
            ...(approved ? { releaseVersion: approved.version } : {}),
          })
        return current === null
          ? readExistingDevBundle({ ...deps, fs, headSha, platforms }).then(async (existing) => {
              if (!existing || (approved && existing.version !== approved.version)) return build()
              const statePath = deps.publisherStateDir ?? stateDir()
              // Restoring still counts as publishing that build. Seed from the record
              // when state was lost, so the counter cannot rewind under a fleet that
              // has already seen these versions.
              try {
                rememberDevBuild({ stateDir: statePath, buildId: existing.buildId })
              } catch {
                const record = listBuildRecords(statePath).find(
                  (entry) => entry.buildId === existing.buildId,
                )
                if (record) seedPublisherStateFromRecord({ stateDir: statePath, record })
              }
              // A restore sweeps too. Retention that only ran on a successful build
              // would leave whatever a crash, a failed compile or a plain shutdown
              // left behind — and residue that only accumulates when something went
              // wrong is exactly the kind that grows unnoticed for months.
              const state = readDevPublisherState(statePath)
              sweepBuildRecords(statePath, {
                retain: deps.retain ?? DEV_BUNDLE_RETAINED,
                referenced: [
                  existing.buildId,
                  ...(state?.lastPublishedBuildId ? [state.lastPublishedBuildId] : []),
                ],
              })
              return existing
            })
          : build()
      }
      const snapshotBuild =
        deps.snapshotBuild ??
        (<T>(approvedSha: string, build: (snapshotRoot: string) => Promise<T>) =>
          withDevBuildSnapshot(
            {
              sourceRoot: liveRoot,
              approvedSha,
              ...(approved?.version ? { releaseVersion: approved.version } : {}),
              timing: deps.timing,
            },
            async (snapshotRoot) => {
              const result = await build(snapshotRoot)
              // Re-arm BOTH original identity guards after every platform has
              // compiled: tracked drift and ignored importable source are equally
              // capable of producing bytes the approved commit does not contain.
              await timeReleaseBuildTask(
                {
                  phase: 'validation',
                  task: 'final-source-inputs',
                  channel: 'dev',
                  ...(approved?.version ? { version: approved.version } : {}),
                  sourceSha: approvedSha,
                },
                () => assertSourceMatchesHead(snapshotRoot, approvedSha),
                deps.timing,
              )
              return result
            },
          ))
      let approvedBuilt: BuiltDevBundle | null | undefined
      const buildApproved = () =>
        snapshotBuild(headSha, async (snapshotRoot) => {
          approvedBuilt = await buildFrom(snapshotRoot)
          return approvedBuilt
        }).catch(async (error: unknown) => {
          // A complete build rejected by ANY snapshot identity fence must never
          // become a recoverable candidate on the next approval or restart.
          // Its bytes, signature and server-authored metadata all go.
          if (approvedBuilt) {
            await Promise.all(
              approvedBuilt.artifacts.flatMap((artifact) => [
                fs.remove(artifact.path),
                fs.remove(artifact.path + DEV_BUNDLE_SIGNATURE_SUFFIX),
                fs.remove(artifact.path + DEV_BUNDLE_METADATA_SUFFIX),
              ]),
            )
            // And the ledger stops calling it signed. A record naming bytes that have
            // just been deleted is worse than no record: the next restart would read it,
            // fail to verify, and have no idea why the files were missing.
            try {
              advanceOutcome(
                deps.publisherStateDir ?? stateDir(),
                approvedBuilt.buildId,
                'failed:identity',
              )
            } catch (recordError) {
              log.warn('could not record the identity refusal for a development build', {
                buildId: approvedBuilt.buildId,
                err: recordError,
              })
            }
          }
          throw error
        })
      const requested = (approved ? buildApproved() : buildFrom(liveRoot)).then(
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

  /**
   * The two facts every publication needs about the current commit, or nothing
   * when this HEAD may not be advertised at all.
   *
   * Shared by the identity target and the feed manifest because they must agree:
   * a commit whose tree is dirty, or whose migrations cannot be read, is one
   * neither may name. Two copies of that reasoning is how the two publications
   * drift apart and start describing different commits.
   */
  const settleHead = async (): Promise<{ headSha: string; migrations: string[] } | undefined> => {
    const headSha = await currentHeadSha()
    if (headSha === null) return undefined
    // A source-identity label names this commit. A dirty tree is not that
    // commit, so do not advertise one. Any other failure (stale web dist,
    // compile) still needs the identity so Update can rebuild.
    if (failure?.sha === headSha && failure.reason.includes('does not match HEAD')) {
      return undefined
    }
    // Declared for the commit being advertised (POD-2213). Publication fails
    // closed when the tree cannot be read (POD-2502 / release.ts parity).
    try {
      return {
        headSha,
        migrations: requireDefinedMigrations(await readMigrationsAt(headSha), headSha),
      }
    } catch (error) {
      recordFailure(error, headSha)
      return undefined
    }
  }

  const feedManifest = async (): Promise<UpdateTarget | undefined> => {
    const settled = await settleHead()
    if (!settled) return undefined
    // A tarball for a DIFFERENT commit is not this HEAD's release, and writing
    // it into the feed would advertise one commit's bytes under another's name.
    if (!current || builtSha !== settled.headSha) return undefined
    const built = current
    const configured = deps.artifactUrl
    const hostPlatform = deps.platform ?? developmentPlatformTarget()
    const artifactUrl =
      typeof configured === 'function'
        ? (platform: string) => configured(built.version, platform)
        : configured !== undefined
          ? (platform: string) =>
              platform === hostPlatform
                ? configured
                : `${DEV_ARTIFACT_ROUTE}/${encodeURIComponent(
                    built.version,
                  )}/${encodeURIComponent(platform)}`
          : undefined
    return devTarget(built, {
      ...(artifactUrl ? { artifactUrl } : {}),
      platform: deps.platform,
      sourceRoot: deps.root,
      schemaMigrations: settled.migrations,
    })
  }

  const proposal = async (): Promise<ReleaseProposal | undefined> => {
    // A proposal is ABOUT committed HEAD. A dirty working tree is a build
    // refusal, not a reason to hide the commit or the failure from the card.
    const headSha = await currentHeadSha()
    if (!headSha) return undefined
    const statePath = deps.publisherStateDir ?? stateDir()
    try {
      const before = readDevPublisherState(statePath)
      if (before?.lastPublishedSha === headSha) return undefined
      const allocated = allocateDevPublishVersion({
        stateDir: statePath,
        checkoutBase: resolveCheckoutReleaseBase(deps, deps.root ?? SOURCE_ROOT),
        sha: headSha,
      })
      const root = deps.root ?? SOURCE_ROOT
      const runningVersion = deps.proposalRunningVersion ?? resolveCheckoutReleaseBase(deps, root)
      const proposalInput = {
        headSha,
        ...(deps.proposalRunningSha ? { runningSha: deps.proposalRunningSha } : { runningVersion }),
        ...(before?.lastPublishedSha ? { sinceSha: before.lastPublishedSha } : {}),
      }
      const facts = deps.proposalFacts
        ? await deps.proposalFacts(proposalInput)
        : await releaseProposalFacts({
            root,
            ...proposalInput,
          })
      return {
        headSha,
        version: allocated.version,
        branch: facts.branch,
        runningVersion,
        commits: facts.commits,
        addedMigrations: facts.addedMigrations,
        state: 'pending',
      }
    } catch (error) {
      recordFailure(error, headSha)
      return undefined
    }
  }

  /**
   * The build admitted by the approval remains publishable if HEAD advances
   * while it compiles. Approval releases HEAD-at-approval-time; the newly landed
   * commit becomes the next collapsing proposal instead of silently replacing
   * the consent already given.
   */
  const builtManifest = async (): Promise<UpdateTarget | undefined> => {
    if (!current || !builtSha) return undefined
    const migrations = requireDefinedMigrations(await readMigrationsAt(builtSha), builtSha)
    const built = current
    const configured = deps.artifactUrl
    const hostPlatform = deps.platform ?? developmentPlatformTarget()
    const artifactUrl =
      typeof configured === 'function'
        ? (platform: string) => configured(built.version, platform)
        : configured !== undefined
          ? (platform: string) =>
              platform === hostPlatform
                ? configured
                : `${DEV_ARTIFACT_ROUTE}/${encodeURIComponent(
                    built.version,
                  )}/${encodeURIComponent(platform)}`
          : undefined
    return devTarget(built, {
      ...(artifactUrl ? { artifactUrl } : {}),
      platform: deps.platform,
      sourceRoot: deps.root,
      schemaMigrations: migrations,
    })
  }

  /**
   * RECONSTRUCT FROM THE PUBLICATION, NOT FROM THIS PROCESS'S BUILD HISTORY.
   *
   * The manifest is read on every request because replacing it is the act of
   * publication. The quarter-gigabyte artifact is hashed only on the first
   * successful request after a restart; the verified descriptor is then safe
   * to reuse under the same digest/signature tuple, exactly as an in-process
   * build descriptor was already reused after its publication-time hash.
   */
  const publishedArtifact = async (
    requestedVersion: string,
    requestedPlatform?: string,
  ): Promise<DevBundleArtifact | null> => {
    const root = deps.root ?? SOURCE_ROOT
    let manifest: UpdateTarget
    try {
      const raw = await fs.readText(devFeedManifestPath(root))
      manifest = UpdateTarget.parse(JSON.parse(raw))
    } catch {
      return null
    }
    if (manifest.version !== requestedVersion) return null

    const platform = requestedPlatform ?? deps.platform ?? developmentPlatformTarget()
    const named = manifest.artifacts.headless?.platforms[platform]
    if (!named) return null

    const matchesPublication = (artifact: DevBundleArtifact): boolean =>
      artifact.version === requestedVersion &&
      artifact.platform === platform &&
      artifact.digest === named.digest &&
      artifact.signature === named.signature

    const live = current?.artifacts.find((artifact) => artifact.platform === platform)
    if (live && matchesPublication(live)) return live

    const cacheKey = `${requestedVersion}\0${platform}`
    const cached = recoveredPublishedArtifacts.get(cacheKey)
    if (cached && matchesPublication(cached)) return cached

    try {
      const stateDirectory = deps.publisherStateDir ?? stateDir()
      // FROM THE LEDGER, not from a directory listing. The record already answers
      // every question the sidecar scan used to ask — which version, which platform,
      // which signing identity, which digest — so what is left here is the one thing a
      // record cannot promise: that the bytes on disk are still those bytes.
      const candidates = listBuildRecords(stateDirectory).filter(
        (record) =>
          record.version === requestedVersion &&
          (record.outcome === 'signed' || record.outcome === 'published') &&
          record.signingKeyFingerprint === devBundleKeyFingerprint(deps.signingKey),
      )
      let storedBytesFailedIntegrity = false
      for (const record of candidates) {
        const entry = record.artifacts.find((artifact) => artifact.platform === platform)
        if (!entry) continue
        // The SERVED manifest decides what this address means. A record whose digest or
        // signature differs from the published one describes a different release that
        // happens to share a version label, and handing its bytes back would answer a
        // published address with something nobody published.
        if (entry.digest !== named.digest || entry.signature !== named.signature) continue
        const path = join(buildBundlesDir(stateDirectory, record.buildId), entry.file)
        const signature = (await readOptionalText(fs, path + DEV_BUNDLE_SIGNATURE_SUFFIX))?.trim()
        if (!signature || signature !== named.signature) continue
        let actual: { digest: string; size: number }
        try {
          actual = await fs.digest(path)
        } catch {
          continue
        }
        if (actual.digest !== entry.digest || actual.size !== entry.size) {
          storedBytesFailedIntegrity = true
          continue
        }
        const recovered: DevBundleArtifact = {
          version: requestedVersion,
          platform,
          path,
          size: actual.size,
          digest: actual.digest,
          signature,
        }
        recoveredPublishedArtifacts.set(cacheKey, recovered)
        return recovered
      }
      if (storedBytesFailedIntegrity) {
        throw new DevArtifactIntegrityError(
          `published artifact bytes failed digest verification for ${requestedVersion} ${platform}`,
        )
      }
    } catch (error) {
      if (error instanceof DevArtifactIntegrityError) throw error
      // A missing directory, unreadable sidecar, or failed hash is the same
      // honest route answer as a file retention removed: this host has no
      // verified artifact for that published address.
    }
    return null
  }

  return {
    requestBuild(explicit = false, approved) {
      const admitted = admissions.then(() => admit(explicit, approved))
      admissions = admitted.catch(() => undefined)
      return admitted.then((admission) =>
        'error' in admission ? Promise.reject(admission.error) : admission.result,
      )
    },
    current: () => current,
    publishedArtifact,
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
      const settled = await settleHead()
      if (!settled) return undefined
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
          sha: settled.headSha,
        })
        return devIdentityTarget(allocated.version, settled.headSha, {
          sourceRoot: deps.root,
          schemaMigrations: settled.migrations,
        })
      } catch (error) {
        recordFailure(error, settled.headSha)
        return undefined
      }
    },
    proposal,
    feedManifest,
    feedManifestPath: () => devFeedManifestPath(deps.root ?? SOURCE_ROOT),
    desktopManifestPath: () => devDesktopManifestPath(deps.root ?? SOURCE_ROOT),
    desktopManifestSource: () => desktopManifestSource,
    publishFeed: async () => {
      const manifest = await builtManifest()
      if (!manifest) return false
      try {
        if (!builtSha) throw new Error('cannot publish a development release without its commit')
        const publishedSha = builtSha
        const root = deps.root ?? SOURCE_ROOT
        const { source, raw: desktopRaw } = await timeReleaseBuildTask(
          {
            phase: 'desktop-work',
            task: 'resolve-standing-shell',
            channel: 'dev',
            version: manifest.version,
            sourceSha: publishedSha,
          },
          async () => {
            const resolved = await resolveStandingDesktopManifest(
              deps.desktopShellManifest ?? fetchStandingDesktopManifest,
            )
            validateDesktopFeedManifest(resolved.source.channel, resolved.raw)
            return resolved
          },
          deps.timing,
        )
        return await timeReleaseBuildTask(
          {
            phase: 'feed-activation',
            task: 'write-feed-manifests',
            channel: 'dev',
            version: manifest.version,
            sourceSha: publishedSha,
          },
          async () => {
            const desktopPath = await writeDevDesktopManifest(fs, root, source.channel, desktopRaw)
            const path = await writeDevFeedManifest(fs, root, manifest)
            const statePath = deps.publisherStateDir ?? stateDir()
            const publisherState = readDevPublisherState(statePath)
            if (!publisherState) {
              throw new Error(
                'cannot record a published development release before a version is minted',
              )
            }
            const publishedBuildId = current?.buildId
            writeDevPublisherState(
              {
                ...publisherState,
                lastPublishedSha: publishedSha,
                ...(publishedBuildId ? { lastPublishedBuildId: publishedBuildId } : {}),
              },
              statePath,
            )
            // THE LEDGER LEARNS IT WAS PUBLISHED, after the manifests are on disk and
            // not before: publication IS writing them, so a record that said
            // `published` first would be claiming something that had not happened yet.
            // Never fatal — the feed is written and the fleet can pull it; a record
            // stuck at `signed` is a wrong sentence in the ledger, not a broken release.
            if (publishedBuildId) {
              try {
                advanceOutcome(statePath, publishedBuildId, 'published')
              } catch (error) {
                log.warn('could not record the published outcome for a development build', {
                  buildId: publishedBuildId,
                  err: error,
                })
              }
            }
            desktopManifestSource = source
            log.info('published development feed manifests', {
              version: manifest.version,
              path,
              desktopPath,
              // Which shell this instance is now handing out. On a fallback the reason travels
              // with it, so the log says "edge, because dev had none" rather than just "edge"
              // — or, worse, nothing at all while the feed answers to the name dev.
              desktopChannel: source.channel,
              ...(source.fellBackBecause ? { desktopFallback: source.fellBackBecause } : {}),
            })
            return true
          },
          deps.timing,
        )
      } catch (error) {
        // A manifest that could not be written is a release nobody can pull, so
        // it is recorded as this HEAD's failure rather than swallowed — the
        // operator's next move (disk, permissions) is nothing like the moves a
        // failed compile calls for, and silence here would leave the feed
        // advertising the PREVIOUS release with no trace of why.
        recordFailure(error, builtSha)
        return false
      }
    },
  }
}
