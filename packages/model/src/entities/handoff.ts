/**
 * The handoff manifest — representation **R6, portable export** (ADR 4 D2/D4).
 * Relocated verbatim from `@podium/protocol`'s `messages/handoff.ts` at POD-300,
 * including its containment refinement. Byte-identical on the wire, pinned by
 * `packages/protocol/src/messages/wire-golden.json` (which also asserts the
 * refinement still rejects escaping paths after the move).
 *
 * ===========================================================================
 * REPRESENTATION ENTRY (POD-368 convention: purpose · why it differs · what it
 * picks). POD-643 owns this vocabulary.
 * ===========================================================================
 *
 * PURPOSE — **portable export.** A manifest is the header of a bundle that
 * LEAVES the live system: written to a file, carried to another machine,
 * accepted by a different server. Nothing about it is a delivery detail, so
 * every fact in it must be durable (this is why `sourceMachineId` and
 * `exportedAt` stay on the entity rather than moving to
 * `provenance/envelope.ts` — see the ownership matrix's `handoff-bundle` row,
 * and `provenance/envelope.test.ts`, which fails anyone who moves them).
 *
 * WHY ITS SEMANTICS GENUINELY DIFFER from the canonical session aggregate —
 * three reasons, none of them "a slightly different field list":
 *
 *   1. It describes a session that is being MOVED, not one that is running.
 *      `headSha` / `snapshotSha` / `snapshotFlattened` / `bundleBase` are facts
 *      about the packaged git state at export time — they have no meaning on a
 *      live session and must not be added to one.
 *   2. It is versioned independently of the wire. `format: 1` is a FILE format:
 *      an old bundle must still parse after the protocol has moved on, which is
 *      not a property any wire projection has or wants.
 *   3. Its `agentKind` is deliberately NARROWER than the shared
 *      {@link AgentKind} — a two-member union (`claude-code` | `codex`),
 *      because only those two harnesses are exportable. Widening it would make
 *      the schema accept a bundle no importer can resume. Recorded as a
 *      DECISION here (POD-364 §6.4 asked for one), not an accident of copying.
 *
 * WHAT IT PICKS from the shared field schemas — resolved against POD-365's
 * landed group names (69d1cfc6 / ce014033), which is why this list is more
 * specific than POD-364 §6.4's sketch:
 *
 *   - Session groups — `sessionId`, `agentKind`, `resume`, `title`, `issueId`.
 *     `agentKind` narrows via `SessionIdentity.omit({agentKind: true})
 *     .extend({agentKind: z.enum(['claude-code','codex'])})`; the group is a
 *     plain `z.object`, so the narrowing is expressible rather than a fork.
 *     `resume` composes `SessionResume`, which carries the SAME `ResumeRef`
 *     this file already imports — re-exported from `fields/session.ts` so a
 *     consumer gets it from one import instead of reaching into `entities/`.
 *   - `repoId` from **`IssueIdentity`**, not from `IssueWorkspace`.
 *   - `branch` from **`IssueWorkspace`** (`{worktreePath, branch, parentBranch,
 *     machineId}`).
 *   - ON THE `format: 2` ARM ONLY (POD-1153, and see the format-bump block
 *     below for why it cannot be on v1): attribution from the single
 *     `Attribution` schema — `{actor: ActorRef,
 *     onBehalfOf: UserIdField.nullable()}` — plus `Ownership` (`{owner,
 *     visibility}`) for the owner half. `onBehalfOf` is NULLABLE, not optional,
 *     and that distinction is load-bearing: `null` is a representable "no human
 *     behind this" for the machine and system arms, while ABSENT would mean
 *     "nobody threaded it". Those are different facts.
 *
 * Bundle-local, and confirmed by POD-365 as defined nowhere in the shared set:
 * `format`, `transcriptFilename`, `transcriptRelativeDir`, `headSha`,
 * `snapshotSha`, `snapshotFlattened`, `bundleBase` — facts about a packaged git
 * state, with no meaning on a live session. `worktreeName`,
 * `worktreeRelativePath` and `cwdSubpath` join them: they are NOT members of
 * `IssueWorkspace`, and they are bundle-local path facts in the same sense.
 *
 * > **COMPOSITION STATUS (POD-643) — DONE for the session/issue half.** Every
 * > field above is now the SHARED SCHEMA INSTANCE, reached through POD-365's
 * > groups (landed on integration at e62e5f23, merged here on the coordinator's
 * > ruling). Three of them are `.unwrap()`ed and one is re-`.optional()`ed — see
 * > the block above the schema for why an export is stricter than a live session.
 * > `handoff.test.ts` asserts the composition by REFERENCE IDENTITY, which is the
 * > only instrument that catches a fresh restatement: swapping one composed field
 * > for an equivalent `z.string()` reds that test and NOTHING else out of 185,
 * > golden corpora included.
 * >
 * > AND AS OF POD-1153, DONE for the attribution half too: `Attribution` and
 * > `Ownership` are composed into a `format: 2` arm, by the reasoning below. The
 * > one thing still missing is a PRODUCER — the exporter has no principal to
 * > stamp from yet; see {@link HandoffManifestV2}'s note, which names the issues
 * > that own it.
 *
 * ---------------------------------------------------------------------------
 * ATTRIBUTION WAS A FORMAT BUMP, NOT AN ADDITIVE FIELD — POD-643 decided this,
 * POD-1153 landed it. Kept in full because the obvious move breaks every bundle
 * in the wild, and the next reader's first instinct is that obvious move.
 * ---------------------------------------------------------------------------
 *
 * POD-365 made the attribution pair STRUCTURALLY UNSPLITTABLE at its three
 * session sites (`NeedsHuman.asked`, `SessionTombstone.deleted`,
 * `SessionNaming.namedBy`): the timestamp is nested INSIDE the object carrying
 * the actor, so a half-filled value does not typecheck. That is the right shape
 * and this representation should not get a weaker one — but applying it here is
 * not additive, and there are exactly three ways to get it wrong:
 *
 *   1. NESTING THE EXISTING KEYS under an attribution object. `exportedAt` and
 *      `sourceMachineId` are top-level today, and this schema is a FILE format:
 *      every bundle already written on disk has them flat. Re-nesting them is
 *      not a wire change to negotiate, it is a reader that can no longer open
 *      yesterday's export.
 *   2. ADDING A NESTED PAIR BESIDE the flat `exportedAt`. Then the export
 *      timestamp has TWO spellings in one schema — the flat key and the nested
 *      `at` — which is precisely the drift POD-302 exists to kill, introduced by
 *      the issue that exists to kill it.
 *   3. NESTING THE ACTOR ONLY and leaving the timestamp flat. This keeps one
 *      spelling but discards the property POD-365 built the nesting for: a
 *      half-filled attribution becomes representable again.
 *
 * THE RESOLUTION, recorded from the pack rather than improvised: attribution
 * arrives with **`format: 2`**. `format` is a FILE version, versioned
 * independently of the wire — that is reason 2 above for why this
 * representation's semantics genuinely differ from a wire projection, and a
 * version field's whole purpose is to make a shape change readable. A v2
 * manifest carries POD-365's nested unsplittable attribution, whose timestamp
 * IS the export timestamp (one spelling); v1 keeps parsing through a
 * discriminated union on `format`, upgraded in the read path.
 *
 * HOW IT LANDED (POD-1153), so the shape is auditable against that decision:
 * `HandoffManifestV1` is byte-for-byte the old schema — same instances, same key
 * order — `HandoffManifestV2` replaces flat `exportedAt` with `exported: {at,
 * by}` plus `owner`/`visibility`, and `HandoffManifest` is the discriminated
 * union over the two. The v1 arm and its golden fixtures are PERMANENT: they are
 * the proof old bundles still open, and deleting them would silently retire the
 * compatibility promise while every remaining test stayed green.
 *
 * `exportedAt` and `sourceMachineId` remain, per POD-364 §9, DEVICE-level facts
 * — which machine, when. They are not the attribution pair and must not be
 * mistaken for it: neither names a principal.
 *
 * ===========================================================================
 * OWNERSHIP, VISIBILITY AND THE ONE THING THAT MUST NEVER BE IN A BUNDLE
 * ===========================================================================
 *
 * VISIBILITY CLASS — **personal.** A handoff bundle is in the PERSONAL set of
 * `docs/multi-user-readiness.md` §3.1.1 (private to owner, shareable) and
 * inherits the scoping of the session it packages. Its owner is the
 * ON-BEHALF-OF human of whoever minted it, with the minting agent or session as
 * ACTOR (ADR 9 D5 A4). See the matrix row `handoff-bundle` for the full
 * declaration; do not re-derive it here.
 *
 * **`owner` ON A MANIFEST IS PROVENANCE, NEVER AN AUTHORIZATION INPUT.** This
 * is worth stating flatly, because a field literally named `owner` invites
 * exactly the wrong reading on the import path. ADR 3 D7 is absolute: the
 * principal comes from the AUTHENTICATED TRANSPORT, never from payload — and a
 * bundle IS payload, from a machine outside this trust domain. So:
 *
 *   - the manifest's owner records WHO EXPORTED IT, which is a durable fact;
 *   - an imported bundle claiming an owner MUST NOT thereby confer ownership or
 *     visibility on the importing side. The import path decides ownership from
 *     its OWN principal, and a bundle that names someone else's user id is
 *     information, not an instruction.
 *
 * **NO CAPABILITY SNAPSHOT — the load-bearing constraint.** The manifest
 * carries IDENTITY AND PROVENANCE only. It must never serialize what the
 * session was ALLOWED to do: effective rights are its scope intersected with
 * its human's CURRENT rights, resolved live at every apply (ADR 9 D5 A1, ADR 3
 * D8), and a snapshot leaves an unattended agent running with rights its human
 * no longer holds, with no cleanup trigger. The target resolves rights from its
 * transport principal at apply time. Nothing is lost by refusing to copy them:
 * per ADR 9 D5 A5 the agent principal's lifecycle IS `SessionBinding`, which is
 * why delegation survives cross-machine handoff for free. Enforced, not merely
 * documented, by `findCapabilitySnapshotKeys` in `handoff.test.ts`.
 *
 * PER-MACHINE FACTS INHERIT MACHINE SCOPING. `transcriptFilename` /
 * `transcriptRelativeDir`, `worktreeName`, `worktreeRelativePath`,
 * `cwdSubpath`, `bundleBase` and the repo checkout are facts ABOUT A MACHINE;
 * per ADR 9 D3 they inherit that machine's scoping rather than carrying a
 * visibility of their own, so they are NOT classified field by field.
 * `sourceMachineId` is the one exception in kind: it is a REFERENCE to a
 * machine, not a fact about one, which is also why it stays here rather than
 * joining `entities/machine.ts`'s group.
 *
 * ONLY the manifest lives here. The 8 handoff request/result frames — four
 * request/result pairs: export, chunkRead, importChunk, import — stay in
 * `@podium/protocol` as frames and import this schema (ADR 4 D4). The manifest
 * is the entity-shaped member of that family; the rest are transport. (POD-643's
 * brief says "seven"; the file has eight, matching ADR 4 D4's count.)
 *
 * No visibility/grant/instance_id field was added, and ADR 1 D5 stands: this is
 * multi-user, not multi-tenancy.
 */

import { z } from 'zod'
import { Attribution } from '../fields/attribution'
import { IssueIdentity, IssueWorkspace } from '../fields/issue'
import { Ownership } from '../fields/ownership'
import { SessionIdentity, SessionNaming, SessionPlacement, SessionResume } from '../fields/session'
import { MachineIdField } from '../ids'

// ---------------------------------------------------------------------------
// THE THREE TIGHTENINGS, and why a `Pick` alone would have been wrong
// ---------------------------------------------------------------------------
//
// The manifest is NOT simply a subset of the session aggregate: it is a subset
// with STRICTER obligations, because an export is a CHECKPOINT. Three shared
// fields are optional or nullable precisely because a LIVE session may lack
// them, and a bundle that lacked them would be unusable on arrival:
//
//   `resume`  — a session with no resume ref yet is normal; a bundle with none
//               cannot resume the agent, which is the only reason it exists.
//   `repoId`  — a session may run outside a known repo; a bundle names the repo
//               its branch and worktree belong to, or the import has no target.
//   `branch`  — nullable on a live issue workspace; an export always packages a
//               branch, and `headSha`/`bundleBase` below are relative to it.
//
// So each composes the SHARED field schema and then `.unwrap()`s it. That keeps
// the brand, the meaning and the drift-following property — change the group and
// this changes with it — while stating the stricter obligation at the one place
// it is true. Restating `z.string()` here instead would have silently forked the
// vocabulary, which is the whole failure POD-302 exists to end.
//
// `title` goes the other way: required on a live session, optional in a bundle,
// so the manifest wraps the shared inner schema in its own `.optional()`.
//
// Wire-identical by construction: every composed field parses exactly what its
// hand-written predecessor parsed, and the KEY ORDER below is unchanged. Both
// halves are pinned — `handoff.test.ts` asserts reference identity against the
// shared groups, and the golden corpora assert the bytes.

// ---------------------------------------------------------------------------
// THE CORE, DEFINED ONCE AND SHARED BY BOTH FORMAT ARMS
// ---------------------------------------------------------------------------
//
// Everything both formats agree on lives here, as ONE set of schema instances
// that both arms spread. Two properties fall out of that, and both were the
// reason for doing it this way rather than writing v2 out again:
//
//   1. v1's KEY ORDER is untouched — `format`, this core in order, then
//      `exportedAt` last, exactly as before — so v1's encoded bytes cannot move.
//      `.omit().extend()` would have been shorter and would have moved `format`
//      to the END of v2, which is a readability loss for no gain.
//   2. v2 cannot DRIFT from v1 on a shared member. A hand-copied v2 would be
//      byte-plausible and invisible to every golden fixture (the POD-302 class,
//      and rule 9: branding is compile-time). Here the two arms hold the SAME
//      instance, and `handoff.test.ts` asserts that by reference — including the
//      `worktreeRelativePath` containment refinement, which therefore cannot be
//      present on v1 and missing on v2.
const HANDOFF_BUNDLE_CORE = {
  sessionId: SessionIdentity.shape.sessionId,
  agentKind: z.enum(['claude-code', 'codex']),
  resume: SessionResume.shape.resume.unwrap(),
  transcriptFilename: z.string(),
  transcriptRelativeDir: z.string().optional(),
  repoId: IssueIdentity.shape.repoId.unwrap(),
  branch: IssueWorkspace.shape.branch.unwrap(),
  headSha: z.string(),
  snapshotSha: z.string().nullable(),
  snapshotFlattened: z.literal(true),
  worktreeName: z.string(),
  /** Repository-relative checkout location, using `/` separators. New exporters
   *  include it when the linked worktree lives below the primary checkout;
   *  older packages omit it and import under `.worktrees/<worktreeName>`.
   *  [spec:SP-3f7a] */
  worktreeRelativePath: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      'worktreeRelativePath must stay inside the repository',
    )
    .optional(),
  /** Where the agent sat inside the worktree, relative to its root ([spec:SP-3f7a]).
   *  Absent = the root. The import lands the resumed agent in the equivalent
   *  subdir, or the root when the target tree has no such directory. */
  cwdSubpath: z.string().optional(),
  bundleBase: z.array(z.string()),
  title: SessionNaming.shape.title.optional(),
  issueId: SessionPlacement.shape.issueId,
  /** CARVED OUT of the brand flip (ADR 1 Amendment 2 D16.2): an exporter running
   *  on the bundled local daemon stamps LOCAL_MACHINE_ID = 'local' here, and a
   *  length-only brand would launder that sentinel into a well-typed identity.
   *  POD-318 retires it; this becomes MachineIdField then. */
  sourceMachineId: MachineIdField,
} as const

/**
 * **FORMAT 1 — every bundle written before POD-1153, and still every bundle
 * this daemon writes.** Frozen, deliberately: this arm is the compatibility
 * promise, and its only job is to keep opening files that already exist. It
 * carries the export timestamp FLAT and no principal at all.
 *
 * Do not "tidy" it. A narrowing here (an `.unwrap()`, a `.min(1)`) is invisible
 * to every golden fixture — those pin the bytes of values someone chose to
 * write, not the inputs the schema used to accept — and turns a bundle on
 * someone's disk into a parse failure. `handoff.test.ts`'s acceptance-boundary
 * suite is the guard that runs in the other direction.
 */
export const HandoffManifestV1 = z.object({
  format: z.literal(1),
  ...HANDOFF_BUNDLE_CORE,
  exportedAt: z.string(),
})
export type HandoffManifestV1 = z.infer<typeof HandoffManifestV1>

/**
 * **FORMAT 2 — the attribution pair and the owner (POD-1153).**
 *
 * WHY A NEW FORMAT AND NOT THREE MORE KEYS: the block above. In one line —
 * POD-365's pair is unsplittable because the timestamp nests INSIDE the object
 * carrying the actor, and there is no additive way to get that here without
 * either breaking yesterday's bundle or giving the export timestamp two
 * spellings in one schema.
 *
 * WHAT CHANGES, and nothing else changes:
 *
 *   - flat `exportedAt` is GONE, replaced by `exported: {at, by}`. One spelling
 *     of the export time, and it lives inside the object naming the principal —
 *     so a v2 manifest that records WHEN without recording WHO does not
 *     typecheck and does not parse. That is the whole point of the bump.
 *   - `owner` + `visibility` arrive from `Ownership`.
 *
 * `{at, by: Attribution}` is POD-365's own nesting IDIOM, not a shape invented
 * here: `SessionTombstone.deleted` and the issue-side site are spelled exactly
 * this way. (The idiom is hand-written at each of those sites — there is no
 * shared `{at, by}` schema to compose yet. Filed as a proposal rather than
 * invented here, because a fourth site is the evidence for one, and `Attribution`
 * itself — the part that carries the principal — IS composed.)
 *
 * `sourceMachineId` stays flat and stays OUT of the pair: per POD-364 §9 it and
 * the export time are DEVICE-level facts — which machine, when. `sourceMachineId`
 * names a machine, not a principal, so folding it into attribution would claim
 * the daemon acted for someone.
 *
 * WHO IS THE OWNER (ADR 9 D5 A4): the ON-BEHALF-OF HUMAN of whoever minted the
 * bundle — never the agent. The minting agent or session is the ACTOR, in
 * `exported.by.actor`. So for the ordinary case the two are: actor
 * `{kind: 'agent', id}`, `onBehalfOf` and `owner` the same human.
 *
 * **AND IT IS PROVENANCE, NEVER AN AUTHORIZATION INPUT.** Restated at the field
 * rather than only in the header, because the header is what an import path
 * skims: see `owner` below and the ADR 3 D7 block above.
 *
 * The handoff exporter writes this format from an authenticated export frame.
 * Import treats every identity-shaped value here as untrusted provenance: the
 * manifest may describe who exported it, but it cannot confer authority.
 */
export const HandoffManifestV2 = z.object({
  format: z.literal(2),
  ...HANDOFF_BUNDLE_CORE,
  /** WHEN the bundle was exported and WHO exported it, inseparably (ADR 9 D5
   *  A3). `at` is THE export timestamp — v1's `exportedAt` moved in here rather
   *  than being duplicated beside it, so this schema has exactly one spelling
   *  of it. `by` is the shared {@link Attribution} instance: `actor` = the
   *  minting agent/session, `onBehalfOf` = the human it acted for (`null` only
   *  for the machine and system arms, which is a representable fact and never a
   *  default). */
  exported: z.object({
    at: z.string(),
    by: Attribution,
  }),
  /** The ON-BEHALF-OF HUMAN of the minting principal (ADR 9 D5 A4) — the same
   *  person as `exported.by.onBehalfOf` for an agent-minted bundle.
   *
   *  PROVENANCE ONLY. A bundle is PAYLOAD from outside this trust domain, so ADR
   *  3 D7 applies at full force: an importer MUST decide ownership from its own
   *  authenticated transport principal and MUST NOT confer ownership,
   *  visibility or any right because a file claims this value. Reading it as an
   *  authorization input is the one mistake a key named `owner` invites. */
  owner: Ownership.shape.owner,
  /** The bundle's visibility class — `personal` for every bundle today (matrix
   *  row `handoff-bundle`), and the shared five-member field rather than a
   *  `z.literal('personal')`, because a FILE format that could only ever say
   *  one word would have to be versioned again the first time a shared bundle
   *  exists. Tightening a persisted format is a compatibility decision, not a
   *  free test-time one. Same caveat as `owner`: it records what the exporter
   *  believed, and confers nothing on import. */
  visibility: Ownership.shape.visibility,
})
export type HandoffManifestV2 = z.infer<typeof HandoffManifestV2>

/**
 * Canonical portable session package ([spec:SP-3f7a]) — **the discriminated
 * union over file formats**, and the schema every reader should parse with.
 *
 * Discriminated on `format`, so a bundle is read as the version it says it is:
 * a v1 file cannot satisfy the v2 arm (its `format` literal refuses), which is
 * what stops "upgrade" from silently meaning "assume it had attribution all
 * along". `handoff.test.ts` pins that negative directly.
 *
 * A format this reader has never heard of (`format: 3`) is REFUSED, not
 * best-effort read. That is unchanged behaviour, not a new restriction — the
 * single `z.literal(1)` refused it too — and it is the correct direction for a
 * file whose meaning depends on its version: guessing at an unknown format is
 * how a reader silently drops a field it did not know was load-bearing. The
 * read path is responsible for saying so legibly; see
 * `apps/daemon/src/handoff-package.ts`.
 */
export const HandoffManifest = z.discriminatedUnion('format', [
  HandoffManifestV1,
  HandoffManifestV2,
])
export type HandoffManifest = z.infer<typeof HandoffManifest>

/**
 * Why a handoff was refused — the closed set that keeps a fail-closed handoff
 * from reading as a broken one (ADR 9 D6 M5, ADR 1 Am1 D13.7).
 *
 * `use` on a machine — spawn, reattach, attach a PTY, run harness commands,
 * read/write files, take a worktree — is OWNER-ONLY until granted, so a handoff
 * to a machine the principal may not use is DENIED, never silently retargeted.
 * The failure must then say WHICH kind it is: "denied" and "offline" otherwise
 * produce the same empty list, and a user who cannot tell them apart retries
 * forever against a machine that will never accept.
 *
 * The three arms, and the reason there are exactly three:
 *
 *   - `unauthorized` — the principal can `see` the target and it is reachable,
 *     but lacks `use`. Asking again will not help; someone must grant.
 *   - `unreachable` — the principal may use the target; the target is offline.
 *     Retrying later is the correct response.
 *   - `unknown-target` — the FAIL-IDENTICALLY arm, and the one that makes this
 *     union safe. A machine OUTSIDE the principal's `see` set and a machine id
 *     that does not exist must produce the SAME refusal. The other two arms are
 *     distinguishable only INSIDE `see`, where existence is already disclosed;
 *     without this arm the refusal becomes an existence oracle, which is the
 *     §3.1.2 existence-leak class arriving at a concrete site (compare the
 *     same rule on `mailSend`, §3.1.5's consistent-error rule).
 *
 * VOCABULARY ONLY. This issue defines the union and threads it through the
 * handoff result frames so a refusal CAN be expressed; the enforcement that
 * populates it — checking `use` on the target before accepting — belongs to
 * POD-1079 and the handoff work under POD-323 / POD-644, and is handed to them
 * in writing. Nothing here authorizes anything.
 */
export const HandoffRefusalReason = z.enum(['unauthorized', 'unreachable', 'unknown-target'])
export type HandoffRefusalReason = z.infer<typeof HandoffRefusalReason>
