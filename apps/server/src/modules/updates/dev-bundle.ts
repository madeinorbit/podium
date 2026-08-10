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
}

export function createDevBundlePublisher(deps: DevBundlePublisherDeps): {
  requestBuild(explicit?: boolean): Promise<BuiltDevBundle | null>
  current(): BuiltDevBundle | null
  target(): UpdateTarget | undefined
} {
  let current: BuiltDevBundle | null = null
  let builtSha: string | null = null
  let lastAttemptAt: number | null = null
  let inFlight: Promise<BuiltDevBundle> | null = null
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? 60_000

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
        // A restart loses only the in-memory descriptor, not the signed bytes.
        // Restore an exact-HEAD artifact first; compile only when it is absent
        // or no longer verifies under this server's persisted update key.
        const requested = (
          current === null
            ? readExistingDevBundle({ ...deps, headSha }).then(
                (existing) => existing ?? buildDevBundle({ ...deps, headSha }),
              )
            : buildDevBundle({ ...deps, headSha })
        ).then((built) => {
          current = built
          builtSha = headSha
          return built
        })
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
        return Promise.reject(error)
      }
    },
    current: () => current,
    target: () => {
      if (!current) return undefined
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
