import { GROK_ACP_VERSION_POLICY, gateHarnessVersion, type HarnessVersion, type HarnessVersionDiagnostic, harnessVersionDiagnostic, parseHarnessVersion } from '../../../version-policy.js'

export type GrokVersion = HarnessVersion
export type GrokVersionDiagnostic = HarnessVersionDiagnostic
export const parseGrokVersion = parseHarnessVersion
export const MINIMUM_GROK_ACP = GROK_ACP_VERSION_POLICY.minimum

export function supportsGrokAcpDriver(version: GrokVersion): boolean {
  return (
    gateHarnessVersion(
      GROK_ACP_VERSION_POLICY,
      `${version.major}.${version.minor}.${version.patch}`,
    ) !== 'too-old'
  )
}

/** Refusal-only API for inventory and existing driver consumers. */
export function gateGrokVersion(output: string): GrokVersionDiagnostic | null {
  return gateHarnessVersion(GROK_ACP_VERSION_POLICY, output) === 'too-old'
    ? harnessVersionDiagnostic('grok', GROK_ACP_VERSION_POLICY, output)
    : null
}
