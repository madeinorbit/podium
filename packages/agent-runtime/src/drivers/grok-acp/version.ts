/** Version gate for the ACP surface shipped by Grok. */
export interface GrokVersion {
  raw: string
  major: number
  minor: number
  patch: number
}

/** Operator-set floor: 0.2.23 is the first build Podium may drive over ACP. */
export const MINIMUM_GROK_ACP = { major: 0, minor: 2, patch: 23 } as const

export function parseGrokVersion(output: string): GrokVersion | null {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|[-+])/i.exec(output.trim())
  if (!match) return null
  return {
    raw: output.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function supportsGrokAcpDriver(version: GrokVersion): boolean {
  const floor = MINIMUM_GROK_ACP
  if (version.major !== floor.major) return version.major > floor.major
  if (version.minor !== floor.minor) return version.minor > floor.minor
  return version.patch >= floor.patch
}

export interface GrokVersionDiagnostic {
  code: 'grok-acp-version-unsupported'
  title: string
  body: string
  observedVersion: string
}

export function gateGrokVersion(output: string): GrokVersionDiagnostic | null {
  const version = parseGrokVersion(output)
  if (!version) {
    return {
      code: 'grok-acp-version-unsupported',
      title: 'Grok ACP driver needs a recognizable version',
      body: `Expected \`grok --version\` to report a semantic version at or above ${MINIMUM_GROK_ACP.major}.${MINIMUM_GROK_ACP.minor}.${MINIMUM_GROK_ACP.patch}; observed: ${output.trim() || '(empty output)'}`,
      observedVersion: output.trim() || '(unrecognized)',
    }
  }
  if (supportsGrokAcpDriver(version)) return null
  return {
    code: 'grok-acp-version-unsupported',
    title: 'Grok is too old for the ACP driver',
    body: `Install Grok ${MINIMUM_GROK_ACP.major}.${MINIMUM_GROK_ACP.minor}.${MINIMUM_GROK_ACP.patch} or newer. Observed ${version.raw}.`,
    observedVersion: version.raw,
  }
}
