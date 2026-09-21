import { AGENT_MANIFESTS } from '../../../registry.js'
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
 * CREDENTIALS THAT MUST NOT REACH A CODEX CHILD (POD-1761 W6).
 *
 * ONE HOME, AND IT IS THE MANIFEST (POD-2823). The list first lived here beside
 * the gate, for a defect that had already happened once — the daemon host held
 * it and `live.test.ts` restated it, and the restatement was already missing
 * `OPENAI_ORG_ID` (POD-2024 review, finding 8). The same defect then happened
 * AGAIN one level up: `codex.inventory.foreignCredentialEnv` answers the same
 * question for every non-app-server codex spawn, and it had drifted three
 * entries behind this array. "Beside the gate so it cannot drift" was the right
 * instinct pointed at the wrong home — the honest one is the manifest, which is
 * where every OTHER harness already answers this, and where the spawn path,
 * the login probes and this driver can all read the same array.
 *
 * WHY THE LIST EXISTS, and why `OPENAI_BASE_URL` is on it though it is not a
 * credential, are recorded with the declaration. Existing importers keep this
 * name.
 */
export const STRIPPED_CODEX_CREDENTIALS = AGENT_MANIFESTS.codex.inventory.foreignCredentialEnv
