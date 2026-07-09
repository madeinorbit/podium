import { z } from 'zod'

/**
 * Branded entity ids [spec:SP-3fe2] — the contract foundation for the P2
 * replication ledger and the P3 command registry. Each id is a zod-branded
 * string: structurally a string on the wire, but nominally distinct in the
 * type system so a SessionId can't silently flow into a MachineId parameter.
 *
 * Two ways in:
 *   - `MachineId.parse(s)` — validating boundary (wire/db input);
 *   - `asMachineId(s)` — plain cast for boundaries where the string is
 *     already trusted (it came out of our own store or a parsed envelope).
 *
 * P1 is additive-only: nothing adopts these yet; later phases migrate call
 * sites incrementally.
 */

export const MachineId = z.string().min(1).brand<'MachineId'>()
export type MachineId = z.infer<typeof MachineId>
export const asMachineId = (s: string): MachineId => s as MachineId

export const SessionId = z.string().min(1).brand<'SessionId'>()
export type SessionId = z.infer<typeof SessionId>
export const asSessionId = (s: string): SessionId => s as SessionId

export const IssueId = z.string().min(1).brand<'IssueId'>()
export type IssueId = z.infer<typeof IssueId>
export const asIssueId = (s: string): IssueId => s as IssueId

export const RepoId = z.string().min(1).brand<'RepoId'>()
export type RepoId = z.infer<typeof RepoId>
export const asRepoId = (s: string): RepoId => s as RepoId

export const ConversationId = z.string().min(1).brand<'ConversationId'>()
export type ConversationId = z.infer<typeof ConversationId>
export const asConversationId = (s: string): ConversationId => s as ConversationId

export const MutationId = z.string().min(1).brand<'MutationId'>()
export type MutationId = z.infer<typeof MutationId>
export const asMutationId = (s: string): MutationId => s as MutationId

export const ThreadId = z.string().min(1).brand<'ThreadId'>()
export type ThreadId = z.infer<typeof ThreadId>
export const asThreadId = (s: string): ThreadId => s as ThreadId

// ---- Composite keys ---------------------------------------------------------
//
// Structured replacements for the ad-hoc string concatenations scattered around
// the codebase (packages/sync/src/mirror.ts `${machineId}\n${nativeId}`,
// packages/domain/src/session-identity.ts `${resume.kind}:${resume.value}`).
// Ad-hoc concatenation is injective only while the parts never contain the
// separator; these helpers escape the separator (and the escape character), so
// join∘parse round-trips for EVERY input — hostile parts included — and two
// distinct part tuples can never collide on one key.
//
// For the common case (parts free of `\` and the separator) the output is
// byte-identical to the legacy ad-hoc keys, so later adoption in mirror.ts /
// session-identity.ts does not invalidate existing in-memory keys.

/** Escape `\` and the separator so the separator's raw occurrence marks ONLY the join point. */
const escapePart = (part: string, sep: string): string =>
  part.replaceAll('\\', '\\\\').replaceAll(sep, `\\${sep}`)

/** Split on raw (unescaped) `sep` occurrences and unescape each part. */
const splitEscaped = (key: string, sep: string): string[] => {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]
    if (ch === '\\' && i + 1 < key.length) {
      const next = key[i + 1]
      if (next === '\\' || next === sep) {
        current += next
        i += 1
        continue
      }
      current += ch
    } else if (ch === sep) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

const MACHINE_SCOPED_SEP = '\n'

/** A (machineId, nativeId) key — the typed successor of mirror.ts's `${machineId}\n${nativeId}`. */
export const machineScopedKey = (machineId: MachineId, nativeId: string): string =>
  `${escapePart(machineId, MACHINE_SCOPED_SEP)}${MACHINE_SCOPED_SEP}${escapePart(nativeId, MACHINE_SCOPED_SEP)}`

/** Inverse of {@link machineScopedKey}. Throws on a string that is not a well-formed key. */
export const parseMachineScopedKey = (key: string): { machineId: MachineId; nativeId: string } => {
  const parts = splitEscaped(key, MACHINE_SCOPED_SEP)
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined || parts[0] === '') {
    throw new Error(`malformed machine-scoped key: ${JSON.stringify(key)}`)
  }
  return { machineId: asMachineId(parts[0]), nativeId: parts[1] }
}

const RESUME_SEP = ':'

/** A (resume.kind, resume.value) key — the typed successor of session-identity.ts's
 *  `${resume.kind}:${resume.value}`. */
export const resumeKey = (kind: string, value: string): string =>
  `${escapePart(kind, RESUME_SEP)}${RESUME_SEP}${escapePart(value, RESUME_SEP)}`

/** Inverse of {@link resumeKey}. Throws on a string that is not a well-formed key. */
export const parseResumeKey = (key: string): { kind: string; value: string } => {
  const parts = splitEscaped(key, RESUME_SEP)
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined || parts[0] === '') {
    throw new Error(`malformed resume key: ${JSON.stringify(key)}`)
  }
  return { kind: parts[0], value: parts[1] }
}
