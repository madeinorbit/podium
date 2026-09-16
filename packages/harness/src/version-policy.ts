/** Floors control admission; fixture verification is informational only. */
export interface HarnessVersionPolicy {
  minimum: { major: number; minor: number; patch?: number } | null
  verifiedThrough: string
  recordedAt?: string
}

export type HarnessVersionStatus = 'too-old' | 'verified' | 'unverified' | 'unparseable'

export interface HarnessVersion {
  raw: string
  major: number
  minor: number
  patch: number
}

export const CODEX_VERSION_POLICY = {
  minimum: { major: 0, minor: 147 },
  verifiedThrough: '0.151.0',
  recordedAt: '0.147.0',
} as const satisfies HarnessVersionPolicy

export const OPENCODE_VERSION_POLICY = {
  minimum: { major: 1, minor: 18 },
  verifiedThrough: '1.18.16',
  recordedAt: '1.18.16',
} as const satisfies HarnessVersionPolicy

export const GROK_ACP_VERSION_POLICY = {
  minimum: { major: 0, minor: 2, patch: 23 },
  verifiedThrough: '0.2.118',
  recordedAt: '0.2.118',
} as const satisfies HarnessVersionPolicy

export const HARNESS_VERSION_POLICIES = {
  codex: CODEX_VERSION_POLICY,
  opencode: OPENCODE_VERSION_POLICY,
  grok: GROK_ACP_VERSION_POLICY,
} as const

/** Accept CLI banners, v prefixes and build/prerelease suffixes. */
export function parseHarnessVersion(output: string): HarnessVersion | null {
  const match = /(?:^|[\sv-])(\d+)\.(\d+)\.(\d+)(?=$|[\s+-])/u.exec(output.trim())
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { raw: output.trim(), major, minor, patch }
}

function compareVersion(
  left: { major: number; minor: number; patch?: number },
  right: { major: number; minor: number; patch?: number },
): number {
  return (
    left.major - right.major || left.minor - right.minor || (left.patch ?? 0) - (right.patch ?? 0)
  )
}

export function harnessVersionFloor(policy: HarnessVersionPolicy): string {
  const floor = policy.minimum
  return floor
    ? `>=${floor.major}.${floor.minor}${floor.patch === undefined ? '' : `.${floor.patch}`}`
    : '*'
}

export function gateHarnessVersion(
  policy: HarnessVersionPolicy,
  output: string,
): HarnessVersionStatus {
  const version = parseHarnessVersion(output)
  if (!version) return 'unparseable'
  if (policy.minimum && compareVersion(version, policy.minimum) < 0) return 'too-old'
  const verified = parseHarnessVersion(policy.verifiedThrough)
  return verified && compareVersion(version, verified) <= 0 ? 'verified' : 'unverified'
}

export interface HarnessVersionDiagnostic {
  code: string
  title: string
  body: string
  observedVersion: string
}

/** A notice is separate from admission: only a too-old status refuses. */
export function harnessVersionDiagnostic(
  harness: string,
  policy: HarnessVersionPolicy,
  output: string,
): HarnessVersionDiagnostic | null {
  const status = gateHarnessVersion(policy, output)
  if (status === 'verified') return null
  const observedVersion = output.trim() || '(no output)'
  if (status === 'too-old') {
    return {
      code: `${harness}-version-too-old`,
      title: `${harness} is too old`,
      body: `Install ${harness} ${harnessVersionFloor(policy).slice(2)} or newer. Observed ${observedVersion}.`,
      observedVersion,
    }
  }
  return {
    code: `${harness}-version-${status}`,
    title: `${harness} version has not been verified`,
    body:
      status === 'unverified'
        ? `${harness} ${observedVersion} is newer than Podium has verified (through ${policy.verifiedThrough}). The session runs normally with the full driver. If something looks wrong, report the behavior and this harness version.`
        : `Podium could not read the ${harness} version; the probe may have timed out or the banner may have changed. The session runs normally with the full driver. If something looks wrong, report the behavior and the output of ${harness} --version. Observed: ${observedVersion}.`,
    observedVersion,
  }
}
