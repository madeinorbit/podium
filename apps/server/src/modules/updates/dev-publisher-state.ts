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
import { stateDir } from '@podium/runtime/config'
import type { DevPublisherVersionState } from '@podium/protocol'

const FILE_NAME = 'dev-publisher-version.json'

export interface PersistedDevPublisherState extends DevPublisherVersionState {
  /**
   * Artifact basenames still referenced by retained manifests / recent publishes.
   * Newest first. The on-disk sweep keeps exactly this set (plus an explicit
   * protect list), never a stamp-ordered guess.
   */
  retainedArtifacts: string[]
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
    }
    if (typeof candidate.base !== 'string' || candidate.base.trim().length === 0) {
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
    return {
      base: candidate.base.trim(),
      counter: candidate.counter,
      retainedArtifacts,
    }
  } catch (error) {
    if (error instanceof Error && error.message === `invalid persisted development publisher state at ${path}`) {
      throw error
    }
    throw invalidState(path)
  }
}

export function devPublisherStatePath(dir: string = stateDir()): string {
  return join(dir, FILE_NAME)
}

/** Read publisher state, or `null` when this instance has never minted. */
export function readDevPublisherState(
  dir: string = stateDir(),
): PersistedDevPublisherState | null {
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
  const body = JSON.stringify(
    {
      base: state.base,
      counter: state.counter,
      retainedArtifacts: state.retainedArtifacts,
    },
    null,
    2,
  ) + '\n'
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, path)
}

export function versionStateOf(
  persisted: PersistedDevPublisherState | null,
): DevPublisherVersionState | null {
  if (!persisted) return null
  return { base: persisted.base, counter: persisted.counter }
}
