/**
 * THE VERSION GATE (POD-1761 W5; plan §1 "Version gate").
 *
 * ---------------------------------------------------------------------------
 * WHY A DRIVER PINS A VERSION AT ALL
 * ---------------------------------------------------------------------------
 *
 * This driver is written against shapes READ OFF a live `GET /doc`, not against
 * a published contract opencode promises to keep. Two of the three endpoints the
 * plan called "repo-unconfirmed" turned out to have moved since the reference
 * doc was written — the permission reply route in particular is now
 * `POST /permission/{id}/reply` where the older `POST /session/{id}/permissions/
 * {id}` still exists beside it. An API that has already drifted once will drift
 * again, and the failure mode of an unpinned client is the worst kind: a request
 * that 404s or, far worse, one that succeeds against a route whose MEANING
 * changed.
 *
 * So the driver refuses to drive an opencode outside the range it was exercised
 * against, and says so in a machine-readable diagnostic rather than failing at
 * the first mismatched field.
 *
 * ---------------------------------------------------------------------------
 * THE PATTERN IS CODEX-HOOKS', THE PREDICATE IS NOT
 * ---------------------------------------------------------------------------
 *
 * `apps/daemon/src/codex-hooks.ts` is the house pattern for this: a version
 * range constant, a tolerant parser, a `supports*` predicate, and a typed
 * diagnostic carrying the observed version. This file mirrors all four.
 *
 * What it deliberately does NOT mirror is the predicate itself. The codex gate
 * reads `major === 0 && minor in [142, 146]` because Codex is pre-1.0 and its
 * minor is its breaking-change axis. opencode is at 1.x, where the MINOR is the
 * feature axis and the major is the breaking one — copying the codex predicate
 * literally would reject every opencode that exists.
 */

/** How the range is written, so a bump is one edit in one place. */
export interface OpencodeVersion {
  raw: string
  major: number
  minor: number
  patch: number
}

/**
 * The window this driver was exercised against.
 *
 * `min` IS THE VERSION EVERY FIXTURE IN `./__fixtures__` WAS RECORDED FROM, and
 * that is the whole justification for the number — not a guess about when the
 * API stabilized. `max` is an inclusive MINOR ceiling within the same major:
 * opencode ships minors weekly, so pinning to the exact recorded patch would
 * make the driver refuse the machine it is installed on within a week, and a
 * gate people routinely widen to get their work done is not a gate.
 *
 * The major is exact. A major bump is the one signal upstream gives that the
 * shapes below changed, and it must reach a human rather than a retry.
 */
export const SUPPORTED_OPENCODE = {
  major: 1,
  minMinor: 18,
  maxMinor: 24,
  /** What the fixtures were recorded from, for the diagnostic's body. */
  recordedAt: '1.18.16',
} as const

/**
 * Parse `opencode --version` output.
 *
 * TOLERANT ON PURPOSE: the command prints a bare `1.18.16` today, but every
 * other version probe in this repo has at some point met a banner, a `v` prefix
 * or a trailing build tag. It finds the first dotted triple and ignores the
 * rest; a line with no triple in it is `null`, which the caller treats as
 * "unknown", never as "fine".
 */
export function parseOpencodeVersion(output: string): OpencodeVersion | null {
  const match = /(?:^|[\sv])(\d+)\.(\d+)\.(\d+)/u.exec(output.trim())
  if (!match) return null
  return {
    raw: output.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function supportsOpencodeServerDriver(version: OpencodeVersion): boolean {
  return (
    version.major === SUPPORTED_OPENCODE.major &&
    version.minor >= SUPPORTED_OPENCODE.minMinor &&
    version.minor <= SUPPORTED_OPENCODE.maxMinor
  )
}

/**
 * What an out-of-range opencode produces instead of a driver.
 *
 * A VALUE, NOT A THROWN STRING. The spawn path has to decide what to do with it
 * — refuse the session, fall back to the terminal driver, surface it — and a
 * caller cannot branch on a message. The shape mirrors `CodexHookDiagnostic`
 * so a surface that already renders one renders this.
 */
export interface OpencodeVersionDiagnostic {
  code: 'opencode-version-unsupported'
  title: 'opencode server driver needs review'
  body: string
  observedVersion: string
}

/**
 * `null` when this opencode may be driven; a diagnostic when it may not.
 *
 * AN UNPARSEABLE VERSION IS A REFUSAL, not a pass. The alternative — drive it
 * and hope — is exactly the behaviour the gate exists to prevent, and it fails
 * later and less legibly than refusing here.
 */
export function gateOpencodeVersion(output: string): OpencodeVersionDiagnostic | null {
  const version = parseOpencodeVersion(output)
  const range = `${SUPPORTED_OPENCODE.major}.${SUPPORTED_OPENCODE.minMinor}.x – ${SUPPORTED_OPENCODE.major}.${SUPPORTED_OPENCODE.maxMinor}.x`
  if (!version) {
    return {
      code: 'opencode-version-unsupported',
      title: 'opencode server driver needs review',
      body: `Could not read a version from \`opencode --version\`. The server driver speaks ${range} and refuses to drive an opencode it cannot identify — spawn this session on the terminal driver, or fix the binary on PATH.`,
      observedVersion: output.trim() || '(no output)',
    }
  }
  if (supportsOpencodeServerDriver(version)) return null
  return {
    code: 'opencode-version-unsupported',
    title: 'opencode server driver needs review',
    body: `opencode ${version.major}.${version.minor}.${version.patch} is outside the range this driver was exercised against (${range}; fixtures recorded from ${SUPPORTED_OPENCODE.recordedAt}). Re-record the fixtures in packages/agent-runtime/src/drivers/opencode/__fixtures__ against the new version and widen SUPPORTED_OPENCODE, or spawn this session on the terminal driver.`,
    observedVersion: version.raw,
  }
}
