/**
 * THE VERSION GATE (POD-1761 W6; plan §1 "version gate with machine diagnostic").
 *
 * ---------------------------------------------------------------------------
 * WHY CODEX NEEDS THIS MORE THAN opencode DID
 * ---------------------------------------------------------------------------
 *
 * The plan's own pitfall list opens with it: "Method names have churned —
 * approval methods were renamed once already." The manifest has said since W1
 * that an unverified range "would let a driver start against a protocol nobody
 * checked". A driver whose approval method name is wrong does not fail loudly;
 * it fails by never receiving an approval request, which presents as an agent
 * that hangs on its first tool call with no error anywhere.
 *
 * ---------------------------------------------------------------------------
 * THE PREDICATE IS THE CODEX-HOOKS ONE, AND HERE THAT IS RIGHT
 * ---------------------------------------------------------------------------
 *
 * `apps/daemon/src/codex-hooks.ts` gates on `major === 0 && minor in [a, b]`
 * because Codex is pre-1.0 and its MINOR is its breaking-change axis. W5 could
 * not copy that predicate — opencode is at 1.x, where the minor is the feature
 * axis — and said so. This driver is gating the SAME BINARY as the hook gate, so
 * it uses the same shape for the same reason, and the two ranges are deliberately
 * independent values: a codex that broke the hook protocol did not necessarily
 * break app-server, and pinning them together would make every widening of one a
 * silent widening of the other.
 */

import { AGENT_MANIFESTS } from '@podium/harness'

/** How the range is written, so a bump is one edit in one place. */
export interface CodexVersion {
  raw: string
  major: number
  minor: number
  patch: number
}

/**
 * The window this driver was exercised against.
 *
 * `recordedAt` IS THE VERSION EVERY FIXTURE IN `./__fixtures__` CAME FROM, and
 * that is the whole justification for these numbers — not a guess about when
 * app-server stabilized. The floor is the same minor: nothing below 0.147 was
 * tested, app-server is still marked `[experimental]` in `codex --help`, and a
 * floor set optimistically is a floor that admits a protocol nobody checked.
 *
 * The ceiling is a small forward allowance rather than an exact patch pin: Codex
 * ships minors frequently, and a gate people routinely widen to get their work
 * done is not a gate. It is deliberately NARROW anyway because
 * this protocol is the one the plan says has already renamed methods once.
 * 0.151.0 was re-proved against its generated bindings and the real
 * subscription live suite on 2026-08-30 (POD-3134).
 */
export const SUPPORTED_CODEX = {
  major: 0,
  minMinor: 147,
  maxMinor: 152,
  /** What the fixtures were recorded from, for the diagnostic's body. */
  recordedAt: '0.147.0',
  verifiedThrough: '0.151.0',
} as const

/**
 * Parse `codex --version` output.
 *
 * TOLERANT ON PURPOSE, and it has to be: the command prints `codex-cli 0.147.0`
 * — a BANNER followed by the triple, not a bare version. It finds the first
 * dotted triple and ignores the rest; a line with no triple is `null`, which the
 * caller treats as "unknown", never as "fine".
 */
export function parseCodexVersion(output: string): CodexVersion | null {
  const match = /(?:^|[\sv-])(\d+)\.(\d+)\.(\d+)/u.exec(output.trim())
  if (!match) return null
  return {
    raw: output.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function supportsCodexAppServerDriver(version: CodexVersion): boolean {
  return (
    version.major === SUPPORTED_CODEX.major &&
    version.minor >= SUPPORTED_CODEX.minMinor &&
    version.minor <= SUPPORTED_CODEX.maxMinor
  )
}

/**
 * What an out-of-range codex produces instead of a driver.
 *
 * A VALUE, NOT A THROWN STRING. The spawn path has to decide what to do with it
 * — refuse the session, fall back to the terminal driver, surface it — and a
 * caller cannot branch on a message. The shape mirrors `CodexHookDiagnostic` and
 * `OpencodeVersionDiagnostic` so a surface that renders one renders this.
 */
export interface CodexVersionDiagnostic {
  code: 'codex-app-server-version-unsupported'
  title: 'codex app-server driver needs review'
  body: string
  observedVersion: string
}

/**
 * `null` when this codex may be driven; a diagnostic when it may not.
 *
 * AN UNPARSEABLE VERSION IS A REFUSAL, not a pass. The alternative — drive it
 * and hope — is exactly the behaviour the gate exists to prevent, and for this
 * protocol it fails as a silent hang rather than an error.
 */
export function gateCodexVersion(output: string): CodexVersionDiagnostic | null {
  const version = parseCodexVersion(output)
  const range = `${SUPPORTED_CODEX.major}.${SUPPORTED_CODEX.minMinor}.x – ${SUPPORTED_CODEX.major}.${SUPPORTED_CODEX.maxMinor}.x`
  if (!version) {
    return {
      code: 'codex-app-server-version-unsupported',
      title: 'codex app-server driver needs review',
      body: `Could not read a version from \`codex --version\`. The app-server driver speaks ${range} and refuses to drive a codex it cannot identify — spawn this session on the terminal driver, or fix the binary on PATH.`,
      observedVersion: output.trim() || '(no output)',
    }
  }
  if (supportsCodexAppServerDriver(version)) return null
  return {
    code: 'codex-app-server-version-unsupported',
    title: 'codex app-server driver needs review',
    body: `codex ${version.major}.${version.minor}.${version.patch} is outside the range this driver was exercised against (${range}; fixtures recorded from ${SUPPORTED_CODEX.recordedAt}). Codex has renamed app-server approval methods before, and a driver whose approval method is wrong does not error — it never receives an approval and the session hangs on its first tool call. Re-record the fixtures in packages/agent-runtime/src/drivers/codex/__fixtures__ against the new version (\`codex app-server generate-ts --out DIR\` emits the protocol) and widen SUPPORTED_CODEX, or spawn this session on the terminal driver.`,
    observedVersion: version.raw,
  }
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
