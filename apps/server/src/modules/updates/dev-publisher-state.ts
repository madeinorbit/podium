/**
 * PUBLISHER VERSION STATE — the monotonic base + counter that mints orderable
 * development versions (POD-2502).
 *
 * Lives in the instance state directory next to the update signing key, not in
 * the checkout: a branch with an older package.json must still mint above the
 * fleet, so the counter cannot be derived from the working tree alone.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, type DevPublisherVersionState } from '@podium/protocol'
import { stateDir } from '@podium/runtime/config'

const FILE_NAME = 'dev-publisher-version.json'

export interface PersistedDevPublisherState extends DevPublisherVersionState {
  /**
   * LEGACY: artifact basenames in the checkout's `dist-bun/`, from before the build
   * ledger moved the published files into the state directory (POD-3055).
   *
   * Retained here, and still read back, so a state file written by an older server is
   * not silently truncated by a newer one. Nothing adds to it any more: what a publish
   * retains is now the build records under `<stateDir>/builds/`, and the `dist-bun/`
   * files an older server left behind are cleaned up by hand once
   * (docs/updating-a-dev-instance.md).
   */
  retainedArtifacts: string[]
  /**
   * Most recently allocated mint — reused when the same HEAD is advertised as
   * an identity target and later built, so identity and bundle share one N.
   */
  lastSha?: string
  lastVersion?: string
  /** Commit whose manifest was last written into the served feed. */
  lastPublishedSha?: string
  /**
   * The last build the ledger recorded, and the last one whose manifest went into the
   * served feed (POD-3055).
   *
   * `lastPublishedBuildId` is what the retention sweep protects. The record list is the
   * durable retained set now — there is deliberately no second copy of it here, because
   * two lists of what is retained can disagree and only one of them owns the bytes. What
   * the state file adds is the pointer the record list cannot hold: which of those
   * records the fleet is currently being served.
   */
  lastBuildId?: string
  lastPublishedBuildId?: string
}

function invalidState(path: string): Error {
  return new Error(`invalid persisted development publisher state at ${path}`)
}

function parsePersistedState(path: string, raw: string): PersistedDevPublisherState {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) throw invalidState(path)
    const candidate = value as {
      base?: unknown
      counter?: unknown
      retainedArtifacts?: unknown
      lastSha?: unknown
      lastVersion?: unknown
      lastPublishedSha?: unknown
      lastBuildId?: unknown
      lastPublishedBuildId?: unknown
    }
    if (typeof candidate.base !== 'string' || candidate.base.trim().length === 0) {
      throw invalidState(path)
    }
    // A base this system cannot ORDER is not a base. Minting on one produces a
    // version with no provable relation to the last one, and `mintDevVersion`
    // rightly refuses it — catching it here means the whole file is rejected at
    // the door, so nothing else (the retained-artifact set, `lastVersion`) is
    // read out of a file we have already decided is corrupt.
    //
    // NOT `effectiveMintBase(base)`, which round 2 suggested: a stored base is
    // often a legitimate bare stable (`0.1.2`, the next-patch lineage after a
    // `0.1.1` cut), and re-bumping it on every read walks the lineage away from
    // reality — measured 0.1.2 → 0.1.3 → 0.1.4 → 0.1.5 on four mints from one
    // unchanged checkout.
    if (compareVersions(candidate.base.trim(), candidate.base.trim()) !== 0) {
      throw invalidState(path)
    }
    if (
      typeof candidate.counter !== 'number' ||
      !Number.isInteger(candidate.counter) ||
      candidate.counter < 1
    ) {
      throw invalidState(path)
    }
    const retainedArtifacts = Array.isArray(candidate.retainedArtifacts)
      ? candidate.retainedArtifacts.filter((entry): entry is string => typeof entry === 'string')
      : []
    const lastSha =
      typeof candidate.lastSha === 'string' && candidate.lastSha.length > 0
        ? candidate.lastSha
        : undefined
    const lastVersion =
      typeof candidate.lastVersion === 'string' && candidate.lastVersion.length > 0
        ? candidate.lastVersion
        : undefined
    const lastPublishedSha =
      typeof candidate.lastPublishedSha === 'string' && candidate.lastPublishedSha.length > 0
        ? candidate.lastPublishedSha
        : undefined
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined
    const lastBuildId = text(candidate.lastBuildId)
    const lastPublishedBuildId = text(candidate.lastPublishedBuildId)
    return {
      base: candidate.base.trim(),
      counter: candidate.counter,
      retainedArtifacts,
      ...(lastSha ? { lastSha } : {}),
      ...(lastVersion ? { lastVersion } : {}),
      ...(lastPublishedSha ? { lastPublishedSha } : {}),
      ...(lastBuildId ? { lastBuildId } : {}),
      ...(lastPublishedBuildId ? { lastPublishedBuildId } : {}),
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `invalid persisted development publisher state at ${path}`
    ) {
      throw error
    }
    throw invalidState(path)
  }
}

export function devPublisherStatePath(dir: string = stateDir()): string {
  return join(dir, FILE_NAME)
}

/** Read publisher state, or `null` when this instance has never minted. */
export function readDevPublisherState(dir: string = stateDir()): PersistedDevPublisherState | null {
  const path = devPublisherStatePath(dir)
  try {
    return parsePersistedState(path, readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Persist publisher state atomically.
 *
 * A malformed existing file is an availability failure, not permission to
 * rewind the counter: replacing it with a fresh seed would mint versions the
 * fleet already saw as older.
 */
export function writeDevPublisherState(
  state: PersistedDevPublisherState,
  dir: string = stateDir(),
): void {
  mkdirSync(dir, { recursive: true })
  const path = devPublisherStatePath(dir)
  const tmp = `${path}.${process.pid}.tmp`
  const body = `${JSON.stringify(
    {
      base: state.base,
      counter: state.counter,
      retainedArtifacts: state.retainedArtifacts,
      ...(state.lastSha ? { lastSha: state.lastSha } : {}),
      ...(state.lastVersion ? { lastVersion: state.lastVersion } : {}),
      ...(state.lastPublishedSha ? { lastPublishedSha: state.lastPublishedSha } : {}),
      ...(state.lastBuildId ? { lastBuildId: state.lastBuildId } : {}),
      ...(state.lastPublishedBuildId ? { lastPublishedBuildId: state.lastPublishedBuildId } : {}),
    },
    null,
    2,
  )}\n`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
}

export function versionStateOf(
  persisted: PersistedDevPublisherState | null,
): DevPublisherVersionState | null {
  if (!persisted) return null
  return { base: persisted.base, counter: persisted.counter }
}
