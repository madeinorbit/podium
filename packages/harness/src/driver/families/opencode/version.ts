import { gateHarnessVersion, type HarnessVersion, type HarnessVersionDiagnostic, harnessVersionDiagnostic, OPENCODE_VERSION_POLICY, parseHarnessVersion } from '../../../version-policy.js'

export type OpencodeVersion = HarnessVersion
export type OpencodeVersionDiagnostic = HarnessVersionDiagnostic
export const parseOpencodeVersion = parseHarnessVersion
/** Compatibility export; the shared policy owns admission and fixture metadata. */
export const SUPPORTED_OPENCODE = OPENCODE_VERSION_POLICY

export function supportsOpencodeServerDriver(version: OpencodeVersion): boolean {
  return (
    gateHarnessVersion(
      OPENCODE_VERSION_POLICY,
      `${version.major}.${version.minor}.${version.patch}`,
    ) !== 'too-old'
  )
}

/** Refusal-only API for inventory and existing driver consumers. */
export function gateOpencodeVersion(output: string): OpencodeVersionDiagnostic | null {
  return gateHarnessVersion(OPENCODE_VERSION_POLICY, output) === 'too-old'
    ? harnessVersionDiagnostic('opencode', OPENCODE_VERSION_POLICY, output)
    : null
}

export { AGENT_VERSION_PROBE_TIMEOUT_MS as OPENCODE_VERSION_PROBE_TIMEOUT_MS } from '../../../version-probe.js'
