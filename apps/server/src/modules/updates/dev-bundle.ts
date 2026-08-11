import { execFileSync, spawn } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UpdateTarget } from '@podium/protocol'

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
  allowedPrefixes: readonly string[] = DEV_BUNDLE_ALLOWED_DIRTY_PREFIXES,
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

export interface BuiltDevBundle {
  version: string
  path: string
  digest: string
  signature: string
}

export interface DevBundleLock {
  acquire(): Promise<boolean | void>
  renew(): Promise<void>
  release(): Promise<void>
}

export interface DevBuildSpawnContext {
  root: string
  version: string
  signingKey?: string
}

export type DevBuildSpawnResult =
  | void
  | string
  | {
      path?: string
      bytes?: Uint8Array
      signature?: string
    }

export interface DevBundleBuildDeps {
  lock: DevBundleLock
  root?: string
  headSha?: string
  spawnBuild?: (ctx: DevBuildSpawnContext) => Promise<DevBuildSpawnResult> | DevBuildSpawnResult
  build?: (ctx: DevBuildSpawnContext) => Promise<DevBuildSpawnResult> | DevBuildSpawnResult
  readFile?: (path: string) => Promise<Uint8Array>
  signingKey?: string
  renewIntervalMs?: number
  now?: () => number
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

function defaultReadFile(path: string): Promise<Uint8Array> {
  return readFileAsync(path)
}

function developmentSigningKey(root: string): string {
  const path = join(root, 'scripts', '.podium-update-dev.key')
  if (existsSync(path)) {
    const key = readFileSync(path, 'utf8').trim()
    if (key) return key
  }
  throw new Error('development signing key missing at ' + path)
}

async function defaultSpawnBuild(ctx: DevBuildSpawnContext): Promise<void> {
  const signingKey = ctx.signingKey ?? developmentSigningKey(ctx.root)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.BUN_BIN ?? 'bun', ['scripts/build-bun.ts'], {
      cwd: ctx.root,
      env: {
        ...process.env,
        PODIUM_APP_VERSION: ctx.version,
        PODIUM_UPDATE_SIGNING_KEY: signingKey,
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (status) => {
      if (status === 0) resolve()
      else reject(new Error('scripts/build-bun.ts exited with status ' + (status ?? 'unknown')))
    })
  })
}

function sha256Digest(bytes: Uint8Array): string {
  return 'sha256-' + createHash('sha256').update(bytes).digest('base64')
}

function devBundlePath(root: string, version: string): string {
  return join(root, 'dist-bun', 'podium-headless-' + version + '.tar.gz')
}

async function readOptional(
  path: string,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path)
  } catch {
    return undefined
  }
}

/**
 * Recover the signed bundle already produced for this checkout's HEAD.
 *
 * The publisher itself is process-local, while the tarball is intentionally
 * durable across source-server restarts. Validate it against this server's
 * persisted signing identity before restoring it as the current target; a
 * partial, stale-key, or corrupt artifact is treated as absent and rebuilt.
 */
async function readExistingDevBundle(
  deps: Pick<DevBundleBuildDeps, 'root' | 'readFile' | 'signingKey'> & { headSha: string },
): Promise<BuiltDevBundle | null> {
  const root = deps.root ?? SOURCE_ROOT
  const version = 'dev+' + shortSha(deps.headSha)
  const path = devBundlePath(root, version)
  const readFile = deps.readFile ?? defaultReadFile
  if (!deps.readFile && (!existsSync(path) || !existsSync(path + '.sig'))) return null
  const bytes = await readOptional(path, readFile)
  const signatureBytes = await readOptional(path + '.sig', readFile)
  if (!bytes || !signatureBytes) return null

  const signature = Buffer.from(signatureBytes).toString('utf8').trim()
  if (!signature) return null
  if (deps.signingKey) {
    try {
      const privateKey = createPrivateKey({
        key: Buffer.from(deps.signingKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      })
      const publicKey = createPublicKey(privateKey)
      if (!cryptoVerify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, 'base64'))) {
        return null
      }
    } catch {
      return null
    }
  }

  return { version, path, digest: sha256Digest(bytes), signature }
}

/**
 * Builds the bundle and reads the exact signed tarball bytes before returning.
 * The advisory lease covers the complete operation and is renewed while the
 * asynchronous compile runs.
 */
export async function buildDevBundle(deps: DevBundleBuildDeps): Promise<BuiltDevBundle> {
  const root = deps.root ?? SOURCE_ROOT
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
    const result = await spawnBuild({
      root,
      version,
      ...(deps.signingKey ? { signingKey: deps.signingKey } : {}),
    })
    await renewal
    if (renewalError) throw renewalError

    const resultObject = typeof result === 'object' && result !== null ? result : undefined
    const artifactPath =
      (typeof result === 'string' ? result : resultObject?.path) ?? devBundlePath(root, version)
    const readFile = deps.readFile ?? defaultReadFile
    const bytes = resultObject?.bytes ?? (await readFile(artifactPath))
    let signature = resultObject?.signature
    if (!signature) {
      const signatureBytes = await readOptional(artifactPath + '.sig', readFile)
      signature = signatureBytes ? Buffer.from(signatureBytes).toString('utf8').trim() : undefined
    }
    if (!signature && deps.signingKey && resultObject?.bytes) {
      signature = cryptoSign(null, Buffer.from(bytes), {
        key: Buffer.from(deps.signingKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }).toString('base64')
    }
    if (!signature) throw new Error('development bundle is unsigned; refusing to publish it')
    return {
      version,
      path: artifactPath,
      digest: sha256Digest(bytes),
      signature,
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
      console.warn('[podium] development bundle lock release failed:', releaseError)
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
  opts: { artifactUrl?: string; platform?: string; sourceRoot?: string } = {},
): UpdateTarget {
  const platform = opts.platform ?? developmentPlatformTarget()
  const url = opts.artifactUrl ?? DEV_ARTIFACT_ROUTE + '/' + encodeURIComponent(built.version)
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
        const requested = (
          current === null
            ? readExistingDevBundle({ ...deps, headSha }).then(
                (existing) => existing ?? buildDevBundle({ ...deps, headSha }),
              )
            : buildDevBundle({ ...deps, headSha })
        ).then(
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
      if (!current) return undefined
      // HEAD moved and this bundle is the previous commit's: there is no target
      // for the code this server is now running, and saying otherwise would
      // hand a daemon an artifact whose version names a commit it is not on.
      if (builtSha !== currentHeadSha()) return undefined
      const artifactUrl =
        typeof deps.artifactUrl === 'function'
          ? deps.artifactUrl(current.version)
          : deps.artifactUrl
      return devTarget(current, {
        artifactUrl,
        platform: deps.platform,
        sourceRoot: deps.root,
      })
    },
  }
}
