/**
 * COMPOSITE KEYS — the single home for every key built out of more than one id.
 *
 * Moved here from `@podium/protocol`'s `ids.ts` at POD-361 (the escaping core
 * and the two legacy shapes, verbatim), and extended with the two shapes
 * `docs/multi-user-readiness.md` requires to be first-class rather than strings
 * a caller assembles.
 *
 * WHY A HOME AT ALL. Ad-hoc concatenation is injective only while the parts
 * never contain the separator. The helpers here escape the separator (and the
 * escape character), so `join ∘ parse` round-trips for EVERY input — hostile
 * parts included — and two distinct part tuples can never collide on one key.
 * For the common case (parts free of `\` and the separator) the output is
 * byte-identical to the legacy ad-hoc keys, so adopting the helper in
 * `packages/sync`'s `mirror.ts` / this package's `identity/session-identity.ts`
 * does not invalidate existing in-memory keys.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a caller never concatenates. If a new
 * key needs a third part, it gains a part HERE — it does not get built on top of
 * another helper's output. `docs/multi-user-readiness.md` §3.3 and ADR 4
 * Amendment 1 D10.2 are explicit that `pins`, `tab_order`, `session_drafts`,
 * `snoozes` and the `read_at` columns each invented their own keying, and that
 * POD-1076 is forbidden from inventing a sixth. That is only enforceable if
 * extension has an obvious place, which is why {@link joinKeyParts} is exported.
 *
 * ADOPTION STATUS, stated because mechanism presence is not coverage: POD-361
 * moves and extends these helpers and adopts NONE of them — POD-362 (server +
 * daemon) and POD-363 (clients + CLI) are the adoption sweeps, and POD-360's
 * inventory found the eight `\n`-separated machine-scoped sites that must move
 * together (`packages/sync/src/mirror.ts`, `transcript-indexer.ts` ×4,
 * `search.ts`, plus this package's two `session-identity.ts` sites). Adopting
 * one alone is a half-migration.
 */

import type {
  AccountId,
  ArtifactId,
  AutomationId,
  AutomationRunId,
  ConversationId,
  IssueDepId,
  IssueId,
  MachineId,
  RepoId,
  SessionId,
  ThreadId,
  UserId,
} from './brands'
import { asIssueDepId, asMachineId } from './brands'

// ---------------------------------------------------------------------------
// The escaping core
// ---------------------------------------------------------------------------

/** Escape `\` and the separator so the separator's raw occurrence marks ONLY the join point. */
const escapePart = (part: string, sep: string): string =>
  part.replaceAll('\\', '\\\\').replaceAll(sep, `\\${sep}`)

/**
 * Split on raw (unescaped) `sep` occurrences and unescape each part. STRICT:
 * a dangling trailing `\` or an escape of anything but `\`/`sep` throws, so a
 * malformed key has no silently-accepted non-canonical alias of a valid one.
 */
const splitEscaped = (key: string, sep: string): string[] => {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < key.length; i++) {
    const ch = key[i]
    if (ch === '\\') {
      const next = i + 1 < key.length ? key[i + 1] : undefined
      if (next !== '\\' && next !== sep) {
        throw new Error(`malformed escape in key: ${JSON.stringify(key)}`)
      }
      current += next
      i += 1
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

/**
 * Join N parts on `sep`, escaping each. THE extension point: a key that needs
 * one more part calls this with one more part — it never concatenates onto
 * another key's output, which would make the outer key's separator ambiguous
 * with an escaped inner one and is precisely the ad-hoc convention this module
 * replaces.
 */
export const joinKeyParts = (sep: string, parts: readonly string[]): string =>
  parts.map((p) => escapePart(p, sep)).join(sep)

/**
 * Inverse of {@link joinKeyParts} for a key of known arity. Throws when the
 * arity is wrong or the escaping is malformed: a composite key with a
 * representable "nearly valid" form is a key space with aliases.
 */
export const splitKeyParts = (sep: string, key: string, arity: number): string[] => {
  const parts = splitEscaped(key, sep)
  if (parts.length !== arity) {
    throw new Error(`expected ${arity} parts, got ${parts.length}: ${JSON.stringify(key)}`)
  }
  return parts
}

// ---------------------------------------------------------------------------
// Entity references — what a key may NAME
// ---------------------------------------------------------------------------

/**
 * A reference to one entity: its KIND plus its branded id.
 *
 * THE KIND IS NOT DECORATION. Ids are unique per kind, not globally: a
 * `SessionId` and an `IssueId` can be byte-equal, so a key built from the id
 * alone would let one user's `readAt` on a session collide with their `readAt`
 * on an issue. `keys.test.ts` pins that with the same id under two kinds.
 *
 * A TYPE, NOT A SCHEMA, and deliberately so: `@podium/protocol`'s
 * `MetadataEntityKind` is a WIRE enum inside a discriminated union, and a second
 * zod enum of entity kinds in this package would be the drift class Phase 1
 * exists to delete. This union is a compile-time discriminator for key
 * construction, it never crosses the wire, and its members are a SUPERSET of
 * that enum's five (a key may name an artifact; a `metadataDelta` may not).
 *
 * Adding a member means adding it in BOTH places below; {@link ENTITY_KINDS} is
 * the runtime half and `assertKindsMatch` makes a mismatch a compile error, so
 * the parser can never accept a kind the constructor cannot build.
 */
export const ENTITY_KINDS = [
  'session',
  'issue',
  'conversation',
  'repo',
  'automation',
  'automationRun',
  'artifact',
  'account',
  'thread',
  'machine',
] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

const isEntityKind = (v: string): v is EntityKind => (ENTITY_KINDS as readonly string[]).includes(v)

/** @see ENTITY_KINDS */
export type EntityRef =
  | { kind: 'session'; id: SessionId }
  | { kind: 'issue'; id: IssueId }
  | { kind: 'conversation'; id: ConversationId }
  | { kind: 'repo'; id: RepoId }
  | { kind: 'automation'; id: AutomationId }
  | { kind: 'automationRun'; id: AutomationRunId }
  | { kind: 'artifact'; id: ArtifactId }
  | { kind: 'account'; id: AccountId }
  | { kind: 'thread'; id: ThreadId }
  /**
   * ORDERING CONSTRAINT — ADR 1 Amendment 2 D16.2, DISCHARGED by POD-318. A machine
   * resource is representable here because ADR 9 D6 gives machines an owner and a
   * per-verb grant list, so `(subject, machine, verb)` is a real edge. It was not
   * MINTABLE while a `MachineId` could still be the sentinel `'local'` /
   * `'__local__'`, because a grant would then be keyed on a value naming different
   * hardware in every instance. Both sentinels are retired and `MachineId` now
   * refuses them, so a machine grant edge names one machine, everywhere.
   */
  | { kind: 'machine'; id: MachineId }

/** The type-level half of the {@link ENTITY_KINDS} / {@link EntityRef} pairing:
 *  either list gaining a member the other lacks fails to compile HERE, so the
 *  runtime guard and the constructor union cannot drift. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
export const ENTITY_KINDS_MATCH_ENTITY_REF: Equals<EntityKind, EntityRef['kind']> = true

/** The subject half of a grant edge. ADR 9 D2: the grantee is a `UserId` today;
 *  *"a group grantee is an additive change to the grantee column"*, so this is a
 *  discriminated union of one rather than a bare `UserId` — adding `{ kind:
 *  'group' }` then fails to compile at every match instead of silently widening,
 *  the same closed-set discipline `authz/issue-authz.ts`'s `IssueScope` uses. */
export type GrantSubject = { kind: 'user'; id: UserId }

// ---------------------------------------------------------------------------
// (userId, entityId) — the per-user state key (POD-1076)
// ---------------------------------------------------------------------------

const USER_ENTITY_SEP = ':'

/**
 * THE key for the per-user state family: `readAt`, snooze, pins, tab order,
 * sidebar/tab layout and personal preferences, one row per `(user, entity)`
 * (`docs/multi-user-readiness.md` §3.3; ADR 4 Amendment 1 D10; ADR 9 D3.4).
 *
 * This is the FIRST key in the system joining two BRANDED types — POD-360
 * flagged that every previous helper was `(brand, raw)` and warned that POD-1076
 * would otherwise adopt one with a cast. Both parts are branded here, and the
 * entity part carries its kind (see {@link EntityRef}).
 *
 * Not a schema and not a wire value: a per-user row's key. Per ADR 4 D10.1 a
 * per-user value never rides the shared entity's broadcast projection, so this
 * string must never appear on the wire as an entity field.
 */
export const userEntityKey = (user: UserId, entity: EntityRef): string => {
  // The constructor and the parser share one accepted domain, so `parse ∘ join`
  // is total on everything this function will build. An empty part is refused on
  // BOTH sides rather than being buildable and unparseable — a constructor
  // output its own parser rejects is how a key space acquires unreachable rows.
  requireNonEmpty(user, 'user')
  requireNonEmpty(entity.id, `${entity.kind} id`)
  return joinKeyParts(USER_ENTITY_SEP, [user, entity.kind, entity.id])
}

const requireNonEmpty = (part: string, what: string): void => {
  if (part === '') throw new Error(`composite key part ${what} must not be empty`)
}

/** Inverse of {@link userEntityKey}. The `id` comes back as a plain string: the
 *  KIND is the runtime evidence of which brand it is, so the caller narrows on
 *  `kind` and applies its own `as<Brand>` — a cast here would have to invent a
 *  kind→brand map that the type system already expresses in {@link EntityRef}. */
export const parseUserEntityKey = (key: string): { user: UserId; kind: EntityKind; id: string } => {
  const [user, kind, id] = splitKeyParts(USER_ENTITY_SEP, key, 3) as [string, string, string]
  if (user === '') throw new Error(`malformed user-entity key (empty user): ${JSON.stringify(key)}`)
  // Fails CLOSED on a kind this build cannot build: an unrecognized kind
  // returned as if it were an EntityKind is a well-typed lie, and the caller
  // narrows on it to choose a brand.
  if (!isEntityKind(kind)) throw new Error(`unknown entity kind ${JSON.stringify(kind)}`)
  if (id === '') throw new Error(`malformed user-entity key (empty id): ${JSON.stringify(key)}`)
  return { user: user as UserId, kind, id }
}

// ---------------------------------------------------------------------------
// (subject, resource) — the grants-edge key (ADR 9 D2, §3.1.4 M1)
// ---------------------------------------------------------------------------

const SUBJECT_RESOURCE_SEP = ':'

/**
 * THE key for ADR 9 D2's grant edge `(entityRef, granteeUserId, verb)` and for
 * §3.1.4 M1's per-machine `see` / `use` / `manage` grant list.
 *
 * THE VERB IS DELIBERATELY NOT IN THIS KEY, and that is a decision, not an
 * omission. ADR 3 D2 already carries `read` / `write` / `manage`, and
 * `authz/issue-authz.ts` records that *"how those three verbs map onto the
 * existing actions is POD-1079's call, not this scaffold's"* — so picking a verb
 * vocabulary here would be inventing the thing two issues are assigned to
 * decide. A per-verb key is a THREE-part key, and when POD-1079 needs one it
 * adds the part via {@link joinKeyParts} (`[subject, kind, id, verb]`) rather
 * than concatenating a verb onto this function's output. That is the whole point
 * of the "single home" rule: extension is a new part, never a new convention.
 */
export const subjectResourceKey = (subject: GrantSubject, resource: EntityRef): string => {
  requireNonEmpty(subject.id, 'subject id')
  requireNonEmpty(resource.id, `${resource.kind} id`)
  return joinKeyParts(SUBJECT_RESOURCE_SEP, [subject.kind, subject.id, resource.kind, resource.id])
}

/** Inverse of {@link subjectResourceKey}. Like {@link parseUserEntityKey}, ids
 *  come back as plain strings — the two `kind` values are the runtime evidence. */
export const parseSubjectResourceKey = (
  key: string,
): {
  subject: { kind: GrantSubject['kind']; id: string }
  resource: { kind: EntityKind; id: string }
} => {
  const [subjectKind, subjectId, resourceKind, resourceId] = splitKeyParts(
    SUBJECT_RESOURCE_SEP,
    key,
    4,
  ) as [string, string, string, string]
  if (subjectKind !== 'user') {
    throw new Error(`unknown grant subject kind ${JSON.stringify(subjectKind)}`)
  }
  if (subjectId === '') {
    throw new Error(`malformed grant key (empty subject): ${JSON.stringify(key)}`)
  }
  // Same fail-closed rule as parseUserEntityKey: an unknown resource kind is
  // refused, never returned as if this build knew it.
  if (!isEntityKind(resourceKind)) {
    throw new Error(`unknown entity kind ${JSON.stringify(resourceKind)}`)
  }
  if (resourceId === '') {
    throw new Error(`malformed grant key (empty resource id): ${JSON.stringify(key)}`)
  }
  return {
    subject: { kind: subjectKind, id: subjectId },
    resource: { kind: resourceKind, id: resourceId },
  }
}

// ---------------------------------------------------------------------------
// The two legacy shapes — moved verbatim from @podium/protocol's ids.ts
// ---------------------------------------------------------------------------

const MACHINE_SCOPED_SEP = '\n'

/** A (machineId, nativeId) key — the typed successor of `mirror.ts`'s
 *  `${machineId}\n${nativeId}` (and of the same `\n` key in
 *  `transcript-indexer.ts` ×4 and `search.ts`, which POD-360 found sharing the
 *  collision surface). `nativeId` is raw by design: it is harness-minted, so it
 *  has no brand (see `brands.ts`). */
/**
 * POD-362 WIDENED `machineId` FROM `MachineId` TO `string`, and it is a pushback,
 * not a shortcut. As shipped, this signature was UNSATISFIABLE by any live
 * producer: `MachineId` was carved out at every field, and the three tables
 * DEFAULTED the column to `'__local__'`. So the only way to call this was
 * `asMachineId(machineId)` — which LAUNDERED the exact sentinel the carve-out
 * existed to keep flaggable. A helper nobody can call without committing the error
 * it exists to prevent is not adopted; it is bypassed, which is why it had ZERO
 * production callers before that issue.
 *
 * POD-318 removed the LAUNDERING RISK — the sentinels are retired and `MachineId`
 * refuses them — but deliberately did NOT tighten this parameter. Its four live
 * callers (`transcript-indexer.ts`, `search.ts`, `sync/mirror.ts`) hold machine ids
 * that come out of the store as `string`, so tightening here would push a cast to
 * each of them, and a cast is what the widening was pushing back against. The
 * parameter tightens when those readers carry the brand; the sentinel is no longer
 * the reason it does not.
 *
 * The key's real value — escaping the separator, so the `\n`-collision assumption
 * at every ad-hoc site goes away — never depended on the brand at all.
 */
export const machineScopedKey = (machineId: string, nativeId: string): string =>
  joinKeyParts(MACHINE_SCOPED_SEP, [machineId, nativeId])

/** Inverse of {@link machineScopedKey}. Throws on a string that is not a well-formed key. */
export const parseMachineScopedKey = (key: string): { machineId: MachineId; nativeId: string } => {
  const parts = splitEscaped(key, MACHINE_SCOPED_SEP)
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined || parts[0] === '') {
    throw new Error(`malformed machine-scoped key: ${JSON.stringify(key)}`)
  }
  return { machineId: asMachineId(parts[0]), nativeId: parts[1] }
}

const RESUME_SEP = ':'

/** A (resume.kind, resume.value) key — the typed successor of
 *  `identity/session-identity.ts`'s `${resume.kind}:${resume.value}`. */
export const resumeKey = (kind: string, value: string): string =>
  joinKeyParts(RESUME_SEP, [kind, value])

/** Inverse of {@link resumeKey}. Throws on a string that is not a well-formed
 *  key. An EMPTY kind is accepted: ResumeRef schemas allow it, so the
 *  constructor can legitimately produce `:value` and the parser must
 *  round-trip every constructor output. */
export const parseResumeKey = (key: string): { kind: string; value: string } => {
  const parts = splitEscaped(key, RESUME_SEP)
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error(`malformed resume key: ${JSON.stringify(key)}`)
  }
  return { kind: parts[0], value: parts[1] }
}

// ---------------------------------------------------------------------------
// (fromId, toId, type) — the issue dependency edge's identity (POD-822)
// ---------------------------------------------------------------------------

const ISSUE_DEP_SEP = '|'

/**
 * THE issue dep edge's id, composed from its primary key
 * [POD-822; ported from main at the POD-1246 catch-up].
 *
 * WHY DERIVED RATHER THAN MINTED. sqlite keys `issue_deps` on
 * `(from_id, to_id, type)` and `addIssueDep` is an `INSERT OR IGNORE` on exactly
 * that key, so the same edge added twice is ONE row in the store. An id minted
 * per call would make it TWO rows on the feed — a phantom the store can never
 * remove, because `depRemove` deletes by the key and would only ever know one of
 * the ids. Deriving the id makes the feed's identity and the store's the same
 * identity by construction, which also makes emission idempotent: re-adding an
 * existing edge produces a byte-identical row that the ledger's dedup drops.
 *
 * MAIN THREW ON A SEPARATOR IN A PART; THIS ESCAPES IT, and the difference is
 * this file's whole rule rather than a liberty taken with the port. Main's
 * `issue/dep.ts` concatenated on `|` and refused any part containing it, because
 * an ambiguous edge id does not fail — it MERGES two distinct edges onto one
 * ledger row, so removing either removes the other's row from every replica.
 * {@link joinKeyParts} makes `parse ∘ join` injective for EVERY input, hostile
 * parts included, which is the property that refusal was protecting; the refusal
 * was the only tool available at a site that concatenated. For a separator-free
 * part — every production id (`iss_${randomUUID()}`) and every dep type
 * (lowercase and hyphens) — the output is byte-identical to main's, so the ids
 * on the feed do not change.
 *
 * The inverse is {@link parseIssueDepId}.
 */
export const issueDepId = (fromId: string, toId: string, type: string): IssueDepId => {
  requireNonEmpty(fromId, 'issue dep fromId')
  requireNonEmpty(toId, 'issue dep toId')
  requireNonEmpty(type, 'issue dep type')
  return asIssueDepId(joinKeyParts(ISSUE_DEP_SEP, [fromId, toId, type]))
}

/**
 * Inverse of {@link issueDepId}. `null` — never a throw and never a partial
 * answer — when the id was not composed by {@link issueDepId}: ids reach this
 * function from a hub mirror and from caller-supplied `input.id` on create,
 * whose grammar is not ours, and a consumer that reads an edge's parts must
 * handle a foreign spelling rather than index blindly into a split.
 */
export const parseIssueDepId = (
  id: string,
): { fromId: string; toId: string; type: string } | null => {
  let parts: string[]
  try {
    parts = splitEscaped(id, ISSUE_DEP_SEP)
  } catch {
    // Malformed escaping — a foreign spelling, not a key of ours.
    return null
  }
  if (parts.length !== 3) return null
  const [fromId, toId, type] = parts as [string, string, string]
  if (!fromId || !toId || !type) return null
  return { fromId, toId, type }
}
