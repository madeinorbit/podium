/**
 * Human-facing reference ids for issues and sessions (#474).
 *
 * Every issue/session keeps its guaranteed-unique internal id (`iss_<uuid>`,
 * session UUID) as the join key, and gains a presentable, stable, human-facing
 * reference used consistently across CLI, agent output, and every UI surface.
 *
 * Grammar:
 *   - issue:            `PREFIX-seq`            e.g. `POD-13`
 *   - session:          `PREFIX-seq-LETTER`     e.g. `POD-13-A`
 *   - issueless session: `PREFIX-DRAFT-n`       e.g. `POD-DRAFT-3`
 *
 * PREFIX is 2–5 uppercase ASCII letters, unique across the server (see
 * `repos.prefix`). LETTER is a spreadsheet-style column label (A..Z, AA..).
 *
 * This module is pure and dependency-free so it can be shared verbatim by the
 * server (agent-facing text, resolveRef, CLI) and the web client (render sites,
 * markdown/terminal linkify).
 */

// ---------------------------------------------------------------------------
// Prefix validation + derivation
// ---------------------------------------------------------------------------

/** A valid repo prefix: 2–5 uppercase ASCII letters. */
export const PREFIX_RE = /^[A-Z]{2,5}$/

export function isValidPrefix(s: string): boolean {
  return PREFIX_RE.test(s)
}

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U'])

/** Uppercase the string and keep only ASCII letters. */
function lettersOnly(s: string): string {
  return s.toUpperCase().replace(/[^A-Z]/g, '')
}

/** Pad a too-short seed to the minimum prefix length with 'X'. */
function padPrefix(seed: string): string {
  let out = seed.slice(0, 5)
  while (out.length < 2) out += 'X'
  return out
}

/**
 * Increment a prefix like an odometer over A..Z (last letter first). When every
 * letter is 'Z' it grows by one letter (up to the 5-letter cap, then wraps).
 */
function bumpPrefix(prefix: string): string {
  const arr = prefix.split('')
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === 'Z') {
      arr[i] = 'A'
      continue
    }
    arr[i] = String.fromCharCode(arr[i]!.charCodeAt(0) + 1)
    return arr.join('')
  }
  // All letters were 'Z' — grow (or wrap at the 5-letter cap).
  if (arr.length < 5) return `A${arr.join('')}`
  return 'AA'
}

/**
 * Derive a unique repo prefix from a repo name.
 *
 * Order of attempts (first one `isTaken` returns false for wins):
 *  1. First 3 letters of the name, uppercased (`podium → POD`).
 *  2. Consonant-skip variant: first letter + following consonants (`podium → PDM`).
 *  3. Odometer bump of the base until a free prefix is found.
 *
 * `isTaken` reports server-wide prefix collisions. Deterministic and total:
 * the bump loop is bounded and always terminates on a free prefix.
 */
export function derivePrefix(repoName: string, isTaken: (prefix: string) => boolean): string {
  const letters = lettersOnly(repoName)
  const base = padPrefix(letters.slice(0, 3))

  if (!isTaken(base)) return base

  // Consonant-skip variant.
  if (letters.length > 0) {
    const first = letters[0]!
    const consonants = [...letters.slice(1)].filter((c) => !VOWELS.has(c))
    const skip = padPrefix((first + consonants.join('')).slice(0, 3))
    if (skip !== base && !isTaken(skip)) return skip
  }

  // Odometer bump from the base until free (bounded — the prefix space is finite).
  let candidate = base
  for (let i = 0; i < 26 ** 5; i++) {
    candidate = bumpPrefix(candidate)
    if (!isTaken(candidate)) return candidate
  }
  // Practically unreachable (would require the whole 2–5 letter space taken).
  return base
}

// ---------------------------------------------------------------------------
// Letter allocation (spreadsheet-style column labels: A..Z, AA, AB, ...)
// ---------------------------------------------------------------------------

/** 0 → 'A', 25 → 'Z', 26 → 'AA', 27 → 'AB', … */
export function letterForIndex(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`letterForIndex: index must be a non-negative integer (got ${index})`)
  }
  let n = index
  let out = ''
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return out
}

/** Inverse of {@link letterForIndex}. 'A' → 0, 'Z' → 25, 'AA' → 26. */
export function indexForLetter(letter: string): number {
  if (!/^[A-Z]+$/.test(letter)) {
    throw new Error(`indexForLetter: expected A..Z letters (got ${JSON.stringify(letter)})`)
  }
  let n = 0
  for (const ch of letter) n = n * 26 + (ch.charCodeAt(0) - 65 + 1)
  return n - 1
}

// ---------------------------------------------------------------------------
// Ref grammar — parse + format
// ---------------------------------------------------------------------------

export interface IssueRef {
  prefix: string
  seq: number
}

export interface SessionRef {
  prefix: string
  /** Present for issue-born sessions. */
  seq?: number
  /** Column letter for issue-born sessions. */
  letter?: string
  /** Present for issueless (draft-namespace) sessions. */
  draft?: number
}

/** `^([A-Z]{2,5})-(\d+)$` — the issue ref grammar. */
export const ISSUE_REF_RE = /^([A-Z]{2,5})-(\d+)$/
/** `PREFIX-DRAFT-n` — issueless session. */
export const SESSION_DRAFT_RE = /^([A-Z]{2,5})-DRAFT-(\d+)$/
/** `PREFIX-seq-LETTER` — issue-born session. */
export const SESSION_REF_RE = /^([A-Z]{2,5})-(\d+)-([A-Z]+)$/

export function formatIssueRef(prefix: string, seq: number): string {
  return `${prefix}-${seq}`
}

export function formatSessionRef(ref: SessionRef): string {
  if (ref.draft !== undefined) return `${ref.prefix}-DRAFT-${ref.draft}`
  return `${ref.prefix}-${ref.seq}-${ref.letter}`
}

export function parseIssueRef(s: string): IssueRef | null {
  const m = ISSUE_REF_RE.exec(s.trim())
  if (!m) return null
  return { prefix: m[1]!, seq: Number(m[2]) }
}

export function parseSessionRef(s: string): SessionRef | null {
  const trimmed = s.trim()
  const draft = SESSION_DRAFT_RE.exec(trimmed)
  if (draft) return { prefix: draft[1]!, draft: Number(draft[2]) }
  const born = SESSION_REF_RE.exec(trimmed)
  if (born) return { prefix: born[1]!, seq: Number(born[2]), letter: born[3]! }
  return null
}

/**
 * Resolve a session's internal UUID or permanent human-facing birth ref.
 *
 * [spec:SP-cdc1] Human-facing session refs are identifiers, not display-only
 * labels. Keep this lookup shared so server command targets and client
 * navigation cannot drift into supporting different identifier sets.
 */
export function resolveSessionIdentifier<T extends { sessionId: string; displayRef?: string }>(
  identifier: string,
  sessions: readonly T[],
): T | undefined {
  const direct = sessions.find((session) => session.sessionId === identifier)
  if (direct) return direct

  const ref = identifier.trim()
  if (!parseSessionRef(ref)) return undefined
  return sessions.find((session) => session.displayRef === ref)
}

/**
 * Any ref token (issue or session). Session forms are tried first so that the
 * `PREFIX-seq-LETTER` and `PREFIX-DRAFT-n` shapes are not misread as an issue.
 */
export type AnyRef =
  | ({ kind: 'issue' } & IssueRef)
  | ({ kind: 'session' } & SessionRef)

export function parseAnyRef(s: string): AnyRef | null {
  const session = parseSessionRef(s)
  if (session) return { kind: 'session', ...session }
  const issue = parseIssueRef(s)
  if (issue) return { kind: 'issue', ...issue }
  return null
}

/**
 * A single regex matching any ref token, for linkify passes (markdown/terminal).
 * DRAFT sessions, issue-born sessions, and bare issues in one alternation. The
 * caller must still confirm the captured prefix belongs to a registered repo
 * (avoids false positives like `UTF-8`).
 *
 * Group 1 is the prefix in all branches.
 */
export const ANY_REF_SOURCE = '([A-Z]{2,5})-(?:DRAFT-\\d+|\\d+-[A-Z]+|\\d+)'

/** A fresh global+boundary matcher for the any-ref grammar (for linkify scans). */
export function anyRefMatcher(): RegExp {
  // \b at both ends keeps `UTF-8` and mid-word hits out.
  return new RegExp(`\\b${ANY_REF_SOURCE}\\b`, 'g')
}

// ---------------------------------------------------------------------------
// Canonical display formats
// ---------------------------------------------------------------------------

/** Default title truncation budget for the long form. */
export const LONG_TITLE_MAX = 40

/** Truncate a title to `max` chars, appending an ellipsis when it was cut. */
export function truncateTitle(title: string, max = LONG_TITLE_MAX): string {
  const t = title.trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** short: `POD-13` / `POD-13-A`. Just the ref itself. */
export function formatShort(ref: string): string {
  return ref
}

/** long: `POD-13 · <title>` with the title truncated at ~40 chars. */
export function formatLong(ref: string, title: string | null | undefined, max = LONG_TITLE_MAX): string {
  const t = (title ?? '').trim()
  if (!t) return ref
  return `${ref} · ${truncateTitle(t, max)}`
}

/**
 * The human-facing reference for an issue-like wire object. Prefers the
 * server-derived `displayRef`; falls back to `#seq` for legacy/mock payloads
 * that predate the field. The single accessor every UI render site should use.
 */
export function issueDisplayRef(issue: { displayRef?: string; seq: number }): string {
  return issue.displayRef ?? `#${issue.seq}`
}
