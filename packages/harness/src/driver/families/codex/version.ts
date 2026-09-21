import { CODEX_VERSION_POLICY, gateHarnessVersion, type HarnessVersion, type HarnessVersionDiagnostic, harnessVersionDiagnostic, parseHarnessVersion } from '../../../version-policy.js'

export type CodexVersion = HarnessVersion
export type CodexVersionDiagnostic = HarnessVersionDiagnostic
export const parseCodexVersion = parseHarnessVersion
/** Compatibility export; the shared policy owns admission and fixture metadata. */
export const SUPPORTED_CODEX = CODEX_VERSION_POLICY

export function supportsCodexAppServerDriver(version: CodexVersion): boolean {
  return (
    gateHarnessVersion(
      CODEX_VERSION_POLICY,
      `${version.major}.${version.minor}.${version.patch}`,
    ) !== 'too-old'
  )
}

/** Refusal-only API for inventory and existing driver consumers. */
export function gateCodexVersion(output: string): CodexVersionDiagnostic | null {
  return gateHarnessVersion(CODEX_VERSION_POLICY, output) === 'too-old'
    ? harnessVersionDiagnostic('codex', CODEX_VERSION_POLICY, output)
    : null
}

/**
 * CREDENTIALS THAT MUST NOT REACH A CODEX CHILD (POD-1761 W6) LIVE IN THE
 * MANIFEST — `codex.inventory.foreignCredentialEnv` — AND NOWHERE ELSE
 * (POD-4494).
 *
 * This module used to re-export that array as `STRIPPED_CODEX_CREDENTIALS`,
 * which made a mechanism import the closed registry to answer a question the
 * composition root already hands it inside the engine facts (`stripEnv`).
 * Reading it through the registry here is the dependency direction spec §5
 * forbids, restating it here is the drift POD-2823 measured twice, and
 * importing the codex adapter directly is the specific-adapter import the
 * same section forbids — so the re-export is gone. Tests read the manifest
 * themselves (they are not mechanisms); production code reads the facts.
 *
 * WHY THE LIST EXISTS, and why `OPENAI_BASE_URL` is on it though it is not a
 * credential, are recorded with the declaration.
 */
