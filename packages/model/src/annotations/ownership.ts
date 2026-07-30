/**
 * The ownership-matrix VOCABULARY — POD-304, the code side of ADR 1
 * (`docs/adr/0001-authority-ownership.md`) as amended by Amendment 1
 * (owner / visibility / grants as normative columns) and Amendment 2 (the four
 * identity axes), with the taxonomy owned by ADR 9.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR
 * ---------------------------------------------------------------------------
 *
 * The answers to "who may write this, who may see it, and what happens when two
 * writes race" used to be IMPLICIT — spread through the retired upstream dialer's
 * apply logic and the forwarder's per-proc patch switch (both deleted at POD-309),
 * where they could only be read by tracing code. This module makes them DATA: one
 * closed vocabulary
 * here, one row per aggregate/field group in `matrix.ts`, and a totality test
 * that fails when a durable class arrives without them.
 *
 * ---------------------------------------------------------------------------
 * TWO RULES THAT SHAPE EVERY TYPE BELOW
 * ---------------------------------------------------------------------------
 *
 * 1. **The Replica never arbitrates** (ADR 1 D1). These annotations are INPUTS
 *    TO THE AUTHORITY, not merge rules a client may run. That is enforced, not
 *    asserted: `arbitration-direction.test.ts` scans the repo and fails when
 *    replica-side code reads the arbitration surface. A conflict rule visible
 *    to a replica is a replica that can be made to merge.
 *
 * 2. **Default-closed, and the default is not the test** (ADR 9 D4, ADR 1
 *    Amendment 1 D9). An unclassified class is `personal`/private. Two separate
 *    mechanisms carry this and neither substitutes for the other:
 *      - {@link visibilityClassOf} resolves an unknown class to `personal` —
 *        the SEMANTIC backstop, which holds even if every test were deleted;
 *      - the totality test fails the build for the missing declaration.
 *    `matrix.test.ts` plants an unclassified fixture class and proves BOTH.
 *
 * Nothing here decides policy. Every value is transcribed from the ADR pack,
 * and where the pack leaves a question open the row says so by naming the
 * canonical open item (ADR 9 §3's O1–O6) rather than guessing.
 */

import { assertUnreachable } from '../exhaustive'

// ---------------------------------------------------------------------------
// ADR 1 D4's eight original columns
// ---------------------------------------------------------------------------

/**
 * The role that may COMMIT truth (ADR 1 D4, and the "Vocabulary: homes and
 * writers" table). Named as a role RELATIVE TO THE FEED, not as an OS process,
 * so D7's federation seam survives without rewriting columns.
 */
export type HomeAuthority =
  | 'server'
  | 'daemon-then-server'
  | 'runtime-local'
  | 'client-local'
  /** Handoff (matrix §9): the source server mints the export, the target accepts. */
  | 'source-server-then-target-server'

/** Who may PROPOSE a mutation — role classes only (ADR 1 D4). WHICH PERSON is
 *  accountable is the separate owner/actor/on-behalf-of triple below (Amendment
 *  1 D8 rule 2): these two questions must not be collapsed. */
export type WriterRole = 'operator' | 'agent-session' | 'daemon' | 'system'

/** ADR 1 D4's closed replication set. Plane qualifications ("bytes bulk/lazy",
 *  "live planes") are NOT members — they are ADR 7's concern and ride
 *  {@link MatrixRow.replicationNote}, so this set stays exactly the five D4
 *  declares. */
export type ReplicationDirection =
  | 'server-to-clients'
  | 'daemon-to-server-to-clients'
  | 'client-to-server-to-clients'
  | 'none'
  | 'export-only'

/**
 * The conflict vocabulary. The first six are ADR 1 Amendment 1 D12's
 * arbitration set — `op-stream` is the sixth, RESERVED AND NOT BUILT (see
 * {@link MatrixRow.reservedConflict}, which is where it is expressed; no row
 * may carry it as its live rule). `live-ephemeral` and `n/a` are D4's markers
 * for things that are not durable conflicts at all.
 */
export type ConflictRule =
  | 'exp-rev'
  | 'cmd'
  | 'field-LWW'
  | 'single-writer'
  | 'append'
  | 'op-stream'
  | 'live-ephemeral'
  | 'n/a'

/** ADR 1 D4's four dispositions plus `n/a`. Row-specific mechanics (a lock's
 *  expiry, a token rotation) are notes on the row, not new members. */
export type TombstoneRule = 'soft-delete' | 'remove' | 'hard-delete' | 'never-delete' | 'n/a'

/** ADR 1 D4 / the offline-behaviour summary. Projects onto ADR 3's three
 *  delivery classes; ADR 3 owns those semantics. */
export type OfflineClass =
  | 'offline-eligible'
  | 'online-only'
  | 'live-path-required'
  | 'never-enqueue'
  | 'observe-only'
  | 'n/a'

/** ADR 1 D4 / D6. `secret-value` never replicates and never enqueues. */
export type SecretClass =
  | 'public'
  | 'preference'
  | 'secret-presence'
  | 'secret-value'
  | 'credential-local'

// ---------------------------------------------------------------------------
// Amendment 1 D8's three further columns
// ---------------------------------------------------------------------------

/**
 * ADR 9 D3's five classes, as DATA. Exactly one per class; there is no sixth,
 * and no "unset" — an absent declaration resolves to `personal` (D4).
 *
 * A `const` array rather than a bare union because POD-365 needs the same five
 * members as a zod enum for the `Ownership` FIELD schema entities carry
 * (`fields/ownership.ts`). Deriving both from this one list is what makes
 * "exactly one visibility-class vocabulary" a structural fact rather than a
 * convention two files agree to follow.
 */
export const VISIBILITY_CLASSES = [
  'personal',
  'per-user-state',
  'owned-compute',
  'deployment-substrate',
  'secret',
] as const

export type VisibilityClass = (typeof VISIBILITY_CLASSES)[number]

/**
 * ADR 9 D2 / D6's closed verb set: `read`/`write` for personal classes,
 * `see`/`use`/`manage` for owned compute. `use` is a CODE-EXECUTION boundary
 * (D6 M2) and must never be annotated as if it were a personal `read`.
 *
 * A `const` array rather than a bare union for the same reason
 * {@link VISIBILITY_CLASSES} is one: POD-1075's grant-edge aggregate
 * (`identity/grant.ts`) needs the same five members as a zod enum, and deriving
 * both from this one list makes "there is exactly one verb vocabulary" a
 * structural fact rather than two files agreeing to stay in step.
 */
export const GRANT_VERBS = ['read', 'write', 'see', 'use', 'manage'] as const

export type GrantVerb = (typeof GRANT_VERBS)[number]

/**
 * How the owner of a row is determined. Amendment 1 D8: the value is a `UserId`
 * — or a DECLARED reason there is none. "Blank" is not a value.
 *
 * The `UserId` brand itself is POD-1075's (it lives transitionally in
 * `@podium/protocol`'s principal module, which L0 may not import). That is why
 * this is a RULE, not an id: the matrix declares *which person* owns a row, and
 * POD-1075 supplies the branded field the row carries. Its arrival is purely
 * additive to everything here.
 */
export type OwnerRule =
  | { readonly kind: 'user'; readonly resolves: OwnerResolution; readonly note?: string }
  | { readonly kind: 'inherits'; readonly from: MatrixRowId; readonly note?: string }
  | {
      readonly kind: 'none'
      readonly reason: 'substrate' | 'secret' | 'derived'
      readonly note: string
    }

/** Which person the `user` kind resolves to. Closed so a new row cannot invent
 *  a principal the pack has not defined. */
export type OwnerResolution =
  /** ADR 9 D5 A4: entities an agent creates are owned by its `onBehalfOf` human,
   *  with the agent as actor. The human case degenerates to the same person. */
  | 'on-behalf-of-human'
  /** ADR 9 D8 S6: an automation/workflow definition is owned by its CREATOR and
   *  runs as that person with that person's CURRENT rights. */
  | 'creating-user'
  /** The user in a `(userId, entityId)` key — per-user state (D10). */
  | 'the-user-in-the-key'
  /** ADR 9 D6 M3: whoever paired the machine. */
  | 'pairer'
  /** ADR 1 Amendment 1 D13.4: the all-in-one host belongs to whoever installed. */
  | 'instance-installer'
  /** Amendment 1 §3 §11: a grant's accountable party is its granter. */
  | 'granter'
  /** Amendment 1 §3 §7: an approval is owned by the human it is routed to. */
  | 'routed-to-human'
  /** Device-local rows: the authenticated principal on that device. */
  | 'authenticated-principal-on-device'
  /** The user aggregate owns itself. */
  | 'self'

/** Whether the class participates in the grant edge table, and with which
 *  verbs (Amendment 1 D8). Per-user state, substrate and secrets take NONE —
 *  and their reason is declared, not implied. */
export type GrantRule =
  | { readonly kind: 'verbs'; readonly verbs: readonly GrantVerb[]; readonly note?: string }
  | { readonly kind: 'inherits'; readonly from: MatrixRowId; readonly note?: string }
  | {
      readonly kind: 'none'
      readonly reason:
        | 'per-user-state-non-grantable'
        | 'substrate'
        | 'secret-admin-grade'
        | 'derived'
      readonly note?: string
    }

// ---------------------------------------------------------------------------
// The columns this issue adds because the pack's open items need them recorded
// ---------------------------------------------------------------------------

/**
 * Owner and grant inheritance ON CREATE — ADR 9 §3 O4, whose annotation SHAPE
 * is assigned to this issue ("annotation shape at Phase 1 (POD-304)").
 *
 * Amendment 1 §3's `inherits X` cells encode the EXPECTATION that the parent
 * wins; they are explicitly not a resolution of O4. So this is a per-class
 * DECLARATION with the same totality obligation as the rest — a class may
 * declare that the actor wins, but it must say so.
 */
export type InheritanceOnCreate =
  /** The child takes the parent's owner AND grants — sharing an issue shares its work. */
  | { readonly kind: 'parent'; readonly from: MatrixRowId; readonly note?: string }
  /** ADR 9 D5 A4: the creating principal's on-behalf-of human owns it; the agent is actor. */
  | { readonly kind: 'on-behalf-of-human'; readonly note?: string }
  /** Per-user state: the row is created by and for the user in its key. */
  | { readonly kind: 'the-user-in-the-key'; readonly note?: string }
  /** Nothing to inherit: substrate, secrets, derived rows. Reason required. */
  | { readonly kind: 'not-applicable'; readonly reason: string }

/**
 * Whether a principal's ability to SEE this class can change after create, and
 * by which verb — the inventory Phase 2 (POD-1077) needs.
 *
 * ADR 9 D2 rule 5: a visibility change is not an entity change. Granting or
 * revoking makes rows appear or disappear for a principal WITHOUT the entity's
 * revision moving, which is exactly why POD-1077 must build watermarks plus a
 * rescope/evict signal distinct from `remove`. This issue does not build any of
 * that; it records which classes have the property, because that set is the
 * input to Phase 2's scoped-feed conformance suite.
 */
export interface VisibilityMutability {
  readonly mutable: boolean
  /** The acts that change who can see it. Empty iff `mutable` is false. */
  readonly verbs: readonly VisibilityChangingVerb[]
  readonly note: string
}

export type VisibilityChangingVerb =
  | 'share'
  | 'unshare'
  | 'transfer-owner'
  | 'grant-see'
  | 'grant-use'
  | 'grant-manage'
  | 'revoke'
  | 'reparent'
  | 'pair'
  | 'unpair'
  | 'account-role-change'
  | 'account-disable'

/**
 * ADR 3 D7 / ADR 9 D5 A3's attribution pair, per row. TWO annotations, never
 * one: `nameSource`'s human-outranks-agent rule ([spec:SP-eb60]) and
 * server-authoritative `humanQuestionAskedBy` both exist so that "did a person
 * or an agent do this?" stays answerable, and a single collapsed id cannot
 * answer it.
 *
 * `onBehalfOf: 'none-representable'` is the machine/system case: explicitly
 * absent, NEVER defaulted to an operator or to the row's owner.
 */
export interface AttributionRule {
  readonly actor: 'required' | 'not-applicable'
  readonly onBehalfOf: 'required' | 'none-representable' | 'not-applicable'
  readonly note?: string
}

/**
 * The `system` writer class's rule, stated per row rather than once in prose —
 * readiness §3.1.6 S5 / ADR 9 D8 S5. `may-write` rows carry
 * {@link SYSTEM_WRITER_RULE} verbatim, which is what makes it checkable.
 */
export type SystemWriterDisposition = 'may-write' | 'never-writes'

/**
 * The rule, once. Attached to every row a system principal may write.
 *
 * Note what it does NOT say: system principals get no human, no widening, and
 * no impersonation. A service *user* account would have all three (ADR 9 D8's
 * rejected alternatives), which is why `system` is a writer class and not an
 * identity.
 */
export const SYSTEM_WRITER_RULE =
  'System principals may READ across owners, but every write is attributed as `system` and lands ' +
  'in the scope of whatever it acted on. They never widen anyone’s visibility and never act AS a ' +
  'person (readiness §3.1.6 S5 / ADR 9 D8 S5).'

/**
 * ADR 1 Amendment 1 D12 part 3, attached to every row that reserves
 * `op-stream`. Recorded ON the annotation because the interaction it names is
 * invisible from inside either ADR alone: the naive implementation (a pure,
 * head-pruned op log) silently breaks ADR 2 D5's retention proof.
 */
export const OP_STREAM_COMPACTION_CONSTRAINT =
  'RESERVED, NOT BUILT. ADR 2 D5’s retention-safety proof depends on the bootstrap snapshot being ' +
  'POSITIVE STATE, so op-streams stay compatible only if ops COMPACT INTO A MATERIALIZED DOCUMENT ' +
  'SNAPSHOT — a document entity carrying its materialized value plus a bounded recent-op tail. ' +
  'A document reconstructed by replaying an unbounded op log needs the log-compaction ADR that ' +
  'ADR 2 D5 already parks, and must not be built without it (ADR 1 Amendment 1 D12 part 3).'

/** ADR 9 §3's canonical open list. A row cites a number; it never answers one. */
export type OpenQuestion = 'O1' | 'O2' | 'O3' | 'O4' | 'O5' | 'O6'

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** Stable id of a matrix row, so `inherits` is a typed edge and not a string
 *  that can point at nothing. Declared in `matrix.ts`. */
export type MatrixRowId = string & { readonly __brand: 'MatrixRowId' }
export const asMatrixRowId = (s: string): MatrixRowId => s as MatrixRowId

/**
 * One aggregate or field group, completely annotated. Every field is REQUIRED:
 * optionality is how a column silently stops being filled in, and the totality
 * test only has teeth if the type has no holes for it to miss.
 *
 * The one deliberate exception is {@link reservedConflict}, whose absence is
 * meaningful ("this row reserves no future class") and whose presence is
 * checked against a closed membership list.
 */
export interface MatrixRow {
  readonly id: MatrixRowId
  /** ADR 1 matrix section this row belongs to, for auditability against the doc. */
  readonly section: MatrixSection
  /** The row's name as the ADR writes it. */
  readonly title: string
  /** Where the fields actually live today, so a reviewer can check the claim. */
  readonly sites: readonly string[]

  // ADR 1 D4's eight.
  readonly home: HomeAuthority
  readonly idMinting: string
  readonly writers: readonly WriterRole[]
  readonly replication: ReplicationDirection
  readonly replicationNote?: string
  readonly conflict: ConflictRule
  /**
   * The conflict class this row is DECLARED to move to later, with the
   * constraint that makes the move safe. Only `op-stream` is reservable, and
   * only for D12's named member set.
   */
  readonly reservedConflict?: { readonly rule: 'op-stream'; readonly constraint: string }
  /**
   * Required for `field-LWW` (ADR 1 D3 conditions 1 and 2: the defined clock and
   * the independence/invariant note) and for any row reserving `op-stream`.
   */
  readonly conflictNote?: string
  readonly tombstone: TombstoneRule
  readonly tombstoneNote?: string
  readonly offline: OfflineClass
  readonly secret: SecretClass
  readonly secretNote?: string

  // Amendment 1 D8's three.
  readonly owner: OwnerRule
  readonly visibility: VisibilityClass
  readonly grants: GrantRule

  // The attribution triple and the system rule (Amendment 1 D8 rule 2, D9 §11).
  readonly attribution: AttributionRule
  readonly systemWriter: SystemWriterDisposition
  /** Verbatim {@link SYSTEM_WRITER_RULE} iff `systemWriter === 'may-write'`. */
  readonly systemWriterRule?: string

  // The two columns O4 and Phase 2 need.
  readonly inheritanceOnCreate: InheritanceOnCreate
  readonly visibilityMutability: VisibilityMutability

  /** Open items this row makes concrete. Recorded, never answered. */
  readonly open: readonly OpenQuestion[]
  /** Why an open item touches this row — required whenever `open` is non-empty. */
  readonly openNote?: string
  /**
   * A named, dated non-conformance with an expiry condition (Amendment 1 D10's
   * composer-draft interim is the archetype). Not a place to park drift: the
   * totality test requires an expiry condition, so "known bug" cannot be a
   * permanent state.
   */
  readonly interimDefect?: { readonly defect: string; readonly expiresWhen: string }
}

/** ADR 1's matrix sections, so a row can be audited against the document. */
export type MatrixSection =
  | 'identity-and-deployment-scope'
  | 'sessions'
  | 'issues-and-tracker'
  | 'conversations-and-transcripts'
  | 'repos-pins-tabs'
  | 'settings-secrets-accounts'
  | 'coordination'
  | 'messaging-and-superagent'
  | 'handoff'
  | 'sync-infrastructure'
  | 'multi-user-classes'

// ---------------------------------------------------------------------------
// Resolution — the semantic default, which is NOT the test
// ---------------------------------------------------------------------------

/**
 * The visibility class of an entity class, resolved DEFAULT-CLOSED.
 *
 * An unknown or undeclared class is `personal` — private to its owner, never
 * tenant-visible, never substrate (ADR 9 D4, readiness §3.1.1 rule 1). This is
 * the semantic backstop for anything that slips past the totality test; it is
 * deliberately a total function with no "unclassified" outcome a caller could
 * mishandle, and no thrown error a caller could catch and treat as permissive.
 *
 * It must keep working with every test deleted. `matrix.test.ts` proves that by
 * calling it on a class that is not in the matrix at all.
 */
export function visibilityClassOf(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = MATRIX_INDEX_HOLDER.index,
): VisibilityClass {
  return index.get(rowId)?.visibility ?? 'personal'
}

/**
 * Is this class tenant-visible? The question a scoped feed actually asks.
 *
 * Phrased POSITIVELY on `deployment-substrate` on purpose: the only way to be
 * tenant-visible is to be explicitly declared substrate. Every other
 * answer — including "I have never heard of this class" — is `false`.
 */
export function isTenantVisible(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = MATRIX_INDEX_HOLDER.index,
): boolean {
  return visibilityClassOf(rowId, index) === 'deployment-substrate'
}

/** Whether a class participates in grants at all, resolved through inheritance. */
export function grantVerbsOf(
  rowId: string,
  index: ReadonlyMap<string, MatrixRow> = MATRIX_INDEX_HOLDER.index,
  seen: ReadonlySet<string> = new Set(),
): readonly GrantVerb[] {
  const row = index.get(rowId)
  if (!row || seen.has(rowId)) return []
  const rule = row.grants
  switch (rule.kind) {
    case 'verbs':
      return rule.verbs
    case 'none':
      return []
    case 'inherits':
      return grantVerbsOf(rule.from, index, new Set([...seen, rowId]))
    default:
      return assertUnreachable(rule)
  }
}

/**
 * Late-bound index so the resolvers above can live beside the vocabulary while
 * the DATA lives in `matrix.ts` — the alternative is an import cycle, and the
 * alternative to that is putting the resolvers in the data file, where the
 * default-closed rule would be easy to miss while reading rows.
 */
export const MATRIX_INDEX_HOLDER: { index: ReadonlyMap<string, MatrixRow> } = {
  index: new Map(),
}
