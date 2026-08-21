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
   * Artifact basenames still referenced by retained manifests / recent publishes.
   * Newest first. The on-disk sweep keeps exactly this set (plus an explicit
   * protect list), never a stamp-ordered guess.
   */
  retainedArtifacts: string[]
  /**
   * Most recently allocated mint — reused when the same HEAD is advertised as
   * an identity target and later built, so identity and bundle share one N.
   */
  lastSha?: string
  lastVersion?: string
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
    return {
      base: candidate.base.trim(),
      counter: candidate.counter,
      retainedArtifacts,
      ...(lastSha ? { lastSha } : {}),
      ...(lastVersion ? { lastVersion } : {}),
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
