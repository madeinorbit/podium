import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { planConvergence, type UpdateGrantMessage } from '@podium/protocol'
import type { MachineUpdateAdapter, PreparedUpdate } from './machine-update'
import { readAppliedMigrations } from './migration-ledger'
import { runningPlatform } from './parent-update-swap'
import { fetchArtifact, PODIUM_UPDATE_PUBKEY } from './update-delivery'
import { BUNDLE_EXTRACT_TIMEOUT_MS, oldBundlePath } from './update-install'
import { createSchemaGate, releaseCarriesNewMigrations } from './update-schema'

export const INSTALLED_ARTIFACT_FILE = 'ARTIFACT.sha256'
export function installedArtifactDigest(installDir: string): string | undefined {
  try {
    return readFileSync(join(installDir, INSTALLED_ARTIFACT_FILE), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
export function installedPayloadVersion(installDir: string): string | undefined {
  try {
    return readFileSync(join(installDir, 'VERSION'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** Bounded installer primitives; all decisions and durable phases belong to the executor. */
export function createHeadlessMachineUpdateAdapter(deps: {
  installDir: string
  runningVersion: string
  runningDigest?: string
  caps: readonly string[]
  pinnedPubkey(): string | undefined
  pubkey?: string
  platform?: string
  fetch?: typeof fetch
  readApplied?: () => readonly string[] | undefined
  restart(grant: UpdateGrantMessage, prepared: PreparedUpdate): Promise<void | 'handover-pending'>
}): MachineUpdateAdapter {
  const staged = `${deps.installDir}.prepared`
  const replacement = join(staged, 'headless')
  const readApplied = deps.readApplied ?? readAppliedMigrations
  const discard = async () => {
    rmSync(staged, { recursive: true, force: true })
  }
  const activate = async (grant: UpdateGrantMessage, prepared: PreparedUpdate) => {
    if (
      installedArtifactDigest(deps.installDir) === prepared.digest &&
      installedPayloadVersion(deps.installDir) === grant.target.version
    )
      return
    if (
      installedArtifactDigest(replacement) !== prepared.digest ||
      installedPayloadVersion(replacement) !== grant.target.version
    )
      throw new Error('prepared artifact identity changed before activation')
    const backup = oldBundlePath(deps.installDir)
    if (existsSync(deps.installDir)) {
      rmSync(backup, { recursive: true, force: true })
      renameSync(deps.installDir, backup)
    }
    try {
      renameSync(replacement, deps.installDir)
    } catch (error) {
      if (!existsSync(deps.installDir) && existsSync(backup)) renameSync(backup, deps.installDir)
      throw error
    }
    await discard()
  }
  return {
    runningVersion: () => deps.runningVersion,
    runningDigest: () => deps.runningDigest,
    async prepare(grant, signal, progress) {
      const plan = planConvergence({
        current: deps.runningVersion,
        target: grant.target,
        caps: deps.caps,
        platform: deps.platform ?? runningPlatform(),
        repair: true,
      })
      if (plan.action !== 'converge')
        throw new Error(
          `cannot take delivery: ${plan.action === 'cannot' ? plan.reason : plan.action}`,
        )
      const refusal = createSchemaGate({ readApplied, currentVersion: deps.runningVersion })(
        grant.target,
      )
      if (refusal) throw new Error(refusal)
      const releaseHadMigrations = releaseCarriesNewMigrations(grant.target, readApplied())
      const artifact = await fetchArtifact(plan.asset, {
        fetch: deps.fetch ?? fetch,
        pubkey: deps.pubkey ?? PODIUM_UPDATE_PUBKEY,
        pinnedPubkey: deps.pinnedPubkey(),
        publisherPubkey: grant.updatePubkey,
        verifyDigest: plan.asset.digest !== `signature:${plan.asset.signature}`,
        trust: grant.target.trust,
        signal,
        onProgress: (event) => progress(event.percent),
      })
      signal.throwIfAborted()
      await discard()
      mkdirSync(dirname(staged), { recursive: true })
      mkdirSync(staged, { mode: 0o700 })
      const archive = join(staged, 'bundle.tar.gz')
      writeFileSync(archive, artifact.bytes, { mode: 0o600 })
      try {
        await promisify(execFile)('tar', ['-xzf', archive, '-C', staged], {
          timeout: BUNDLE_EXTRACT_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          signal,
        })
        if (!existsSync(replacement))
          throw new Error('artifact has no headless/ bundle; live bundle untouched')
        if (installedPayloadVersion(replacement) !== grant.target.version)
          throw new Error(
            'prepared VERSION does not match the authorized target; live bundle untouched',
          )
        const digest = `sha256-${createHash('sha256').update(artifact.bytes).digest('base64')}`
        writeFileSync(join(replacement, INSTALLED_ARTIFACT_FILE), digest + '\n', { mode: 0o600 })
        signal.throwIfAborted()
        return { digest, ...(releaseHadMigrations !== undefined ? { releaseHadMigrations } : {}) }
      } catch (error) {
        await discard()
        throw error
      }
    },
    activate,
    discard,
    restart: deps.restart,
    async recoverActivation(grant, prepared) {
      try {
        await activate(grant, prepared)
      } catch (error) {
        const backup = oldBundlePath(deps.installDir)
        if (!existsSync(deps.installDir) && existsSync(backup)) renameSync(backup, deps.installDir)
        throw error
      }
    },
  }
}
