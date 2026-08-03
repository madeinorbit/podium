/**
 * The SESSION field schemas — `docs/rearch-field-schema-inventory.md` §6.2.
 *
 * POD-364 counted **24 session-shaped representations** carrying **121 distinct
 * keys** between them, where the epic assumed about eight. This file is the
 * vocabulary that collapses them: fifteen named field groups, each defined once,
 * that the canonical aggregate (`../aggregates/session.ts`) and every projection
 * (POD-366) compose instead of restating.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is **not** a replacement for `../entities/session.ts`. `SessionMeta` is the
 * R4 wire/read projection and stays exactly as it is — byte-identical, pinned by
 * `packages/protocol/src/messages/wire-golden.json`. **No consumer changes in
 * this issue**; POD-366 re-derives `SessionMeta`, `SessionRow`, the `Session`
 * class and the R5 ports FROM these groups, and the golden fixtures are its gate.
 *
 * It is **not one universal record**. ADR 4 D1 is explicit that the canonical
 * durable aggregate, live state, the storage row and the wire projections stay
 * DISTINCT types. {@link SessionLiveOverlay} and {@link SessionDerived} exist in
 * this file precisely so they can be named and then kept OUT of R1 — a live
 * field on the durable aggregate would be D3.7 non-compliance, and a derived one
 * would be a second write path (D3.6).
 *
 * ---------------------------------------------------------------------------
 * THE DISAGREEMENTS THIS FILE RESOLVES (inventory §5.5)
 * ---------------------------------------------------------------------------
 *
 * Each is resolved by having ONE name for one fact, and the resolution is noted
 * on the group that carries it:
 *
 *   D-1  `id`/`sessionId`, `agent`/`agentKind`, `label`/`name`/`title`
 *   D-3  four spellings of `resume`, two encodings of `origin`
 *   D-5  stored/derived twins (`displayRef`, `resumable`, `machineName`)
 *   D-6  three spellings of one clock
 *   D-9  five fields published on `SessionMeta` with NO storage column
 *   D-11 `workingMsTotal` with two homes
 *   D-12 the spawn tuple, restated four times
 *   D-17 `spawnedBy` as an unparsed tagged union in a freeform string
 *
 * ---------------------------------------------------------------------------
 * BRANDING, AND THE ONE PLACE IT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 *
 * Ids use the FIELD-position schemas (brand only, no added validation), so a
 * payload that parses today still parses — `machineId` included. It was the one
 * exception while `MachineId.parse('local')` SUCCEEDED and branding a site that
 * could hold a sentinel would have LAUNDERED it (ADR 1 Amendment 2 D16.2).
 * POD-318 retired both sentinels and made the boundary schema refuse them.
 */

import { z } from 'zod'
import {
  AccountIdField,
  asAutomationId,
  asIssueId,
  asSessionId,
  asThreadId,
  AutomationIdField,
  ConversationIdField,
  IssueIdField,
  MachineIdField,
  type SessionId,
  SessionIdField,
  ThreadIdField,
} from '../ids'
import { AgentKind } from '../entities/agent'
import {
  AgentRuntimeState,
  Geometry,
  ResumeRef,
  SessionOrigin,
  SessionStatus,
  WorkState,
} from '../entities/session'
import { Attribution, StampedAttribution } from './attribution'
import { OpStreamDocument } from './op-stream'

// Re-exported so a consumer composing the groups gets the value objects they
// reference from the same import, rather than reaching into `entities/`.
export { AgentRuntimeState, Geometry, ResumeRef, SessionOrigin, SessionStatus, WorkState }

// ---------------------------------------------------------------------------
// Provenance — `spawnedBy` as a parsed union (D-17)
// ---------------------------------------------------------------------------

/**
 * WHO OR WHAT CAUSED THIS SESSION TO EXIST — as a closed discriminated union
 * (inventory D-17).
 *
 * `SessionMeta.spawnedBy` is still `z.string().optional()` on the wire — the tag
 * is pinned by `wire-golden.json` and does not change. What POD-1133 changed is
 * that NOTHING formats or reads that tag by hand any more.
 *
 * POD-360 measured what the freeform tag cost: the DOCUMENTED arm set and the
 * PRODUCED arm set differed in BOTH directions (`'steward'` was documented and
 * never written; `automation:<id>` and bare `'agent'`/`'system'`/`'superagent'`
 * were written and never documented), exactly ONE consumer parsed the string, and
 * SEVEN rebuilt the template literal to compare — FIVE of them gating
 * parent-session authorization. A tag-format change therefore made those five
 * silently answer "not the parent" rather than failing loudly.
 *
 * A brand does not fix that: it still permits seven hand-built strings. What
 * fixes it is a union that ships with the only functions allowed to write, read
 * or compare the tag — {@link spawnedByTag}, {@link parseSpawnedBy},
 * {@link spawnedByParentSessionId} and {@link isSpawnedBy}. Every producer and
 * every comparison site in the repo now routes through them, so a format change
 * is one edit here rather than eight silent divergences.
 *
 * THE ARM SET IS CLOSED, and that is the point: a new provenance is a member
 * added here, which makes `spawnedByTag`'s switch non-exhaustive — a compile
 * error, verified by adding an arm and watching it fail — and so reaches every
 * writer through the one function they all call. It is never an eighth literal.
 *
 * `'steward'` is DROPPED: no producer writes it.
 *
 * WHERE POD-1075's on-behalf-of GOES. Per `docs/multi-user-readiness.md` §3.1.3
 * A3 this site gains the human a spawn acted for. It is a MEMBER on the arms that
 * can have one — not a second value appended to the tag — which is why the union
 * had to land before POD-1075 rather than after it.
 */
export const SpawnedByRef = z.discriminatedUnion('kind', [
  /** A person, directly. */
  z.object({ kind: z.literal('user') }),
  /** An in-process job with no human behind it (ADR 9 D8 S5). `job` names which
   *  one (steward, expiry, boot reconcile), matching `Attribution`'s system
   *  actor. Optional because the bare `'system'` tag predates it, and "which job"
   *  must stay distinguishable from "a job, unrecorded". */
  z.object({ kind: z.literal('system'), job: z.string().optional() }),
  /** An agent, where the producer recorded no finer identity than the role. */
  z.object({ kind: z.literal('agent') }),
  /** A parent session. */
  z.object({ kind: z.literal('session'), id: SessionIdField }),
  /** An issue's start/spawn path. */
  z.object({ kind: z.literal('issue'), id: IssueIdField }),
  /** A superagent thread (ADR 9 D8 S1: per-user, a broad-scope delegation). */
  z.object({ kind: z.literal('superagent'), threadId: ThreadIdField.optional() }),
  /** A scheduled automation (ADR 9 D8 S6: runs as its creator, live rights). */
  z.object({ kind: z.literal('automation'), id: AutomationIdField }),
])
export type SpawnedByRef = z.infer<typeof SpawnedByRef>

/** THE only writer of the tag string. Every producer goes through it.
 *
 *  The switch has no `default`, so adding an arm to {@link SpawnedByRef} fails to
 *  compile here first. That is the mechanism the issue asked for: a new
 *  provenance cannot reach storage as an unrecognised string. */
export const spawnedByTag = (ref: SpawnedByRef): string => {
  switch (ref.kind) {
    case 'user':
    case 'agent':
      return ref.kind
    case 'system':
      return ref.job ? `system:${ref.job}` : 'system'
    case 'session':
      return `session:${ref.id}`
    case 'issue':
      return `issue:${ref.id}`
    case 'superagent':
      return ref.threadId ? `superagent:${ref.threadId}` : 'superagent'
    case 'automation':
      return `automation:${ref.id}`
  }
}

/** THE only reader of the tag string. FAILS CLOSED: returns `null` for anything
 *  it does not recognise — an unknown arm, a tagged arm with no value, a
 *  malformed tag — rather than guessing or half-filling one. A parser that
 *  invented a `kind` would be worse than the seven hand-built comparisons it
 *  replaces, because it would be trusted. */
export const parseSpawnedBy = (tag: string | undefined | null): SpawnedByRef | null => {
  if (!tag) return null
  if (tag === 'user' || tag === 'system' || tag === 'agent') return { kind: tag }
  if (tag === 'superagent') return { kind: 'superagent' }
  const sep = tag.indexOf(':')
  if (sep <= 0) return null
  // Only the FIRST colon separates: an id that contains one is carried whole
  // rather than silently truncated to its prefix.
  const value = tag.slice(sep + 1)
  if (!value) return null
  switch (tag.slice(0, sep)) {
    case 'session':
      return { kind: 'session', id: asSessionId(value) }
    case 'issue':
      return { kind: 'issue', id: asIssueId(value) }
    case 'superagent':
      return { kind: 'superagent', threadId: asThreadId(value) }
    case 'automation':
      return { kind: 'automation', id: asAutomationId(value) }
    case 'system':
      return { kind: 'system', job: value }
    default:
      return null
  }
}

/**
 * THE PARENT SESSION a tag names, or `undefined` for every other arm.
 *
 * This is what the sidebar grouping and the steward's parent-wake both wanted
 * out of the tag, and each had grown its own regex/`startsWith` to get it. Both
 * now call this, so the extraction and the tag format cannot drift apart — and
 * the result is a `SessionId` at the source rather than a `string` branded by a
 * cast at whichever boundary happened to need one (POD-361 left exactly such a
 * cast in `session-groups.ts`; routing through here is what retires it).
 *
 * `undefined` — not a throw — because "spawned by something that is not a
 * session" is an ordinary answer, not an error.
 */
export const spawnedByParentSessionId = (tag: string | undefined | null): SessionId | undefined => {
  const ref = parseSpawnedBy(tag)
  return ref?.kind === 'session' ? ref.id : undefined
}

/**
 * WHETHER A TAG NAMES EXACTLY THIS PROVENANCE — the comparison the five authz
 * gates were making by rebuilding the template literal.
 *
 * It parses and compares STRUCTURE rather than comparing two formatted strings,
 * so a caller cannot accidentally compare against a shape the writer no longer
 * emits: there is one format function and one parse function, and this sits on
 * top of the parse side.
 *
 * An absent or unrecognised tag is `false`. For an authz gate that IS the closed
 * answer — an unreadable provenance grants nothing — and it is reached only for
 * a tag no producer in this repo can write, because they all go through
 * {@link spawnedByTag}.
 */
export const isSpawnedBy = (tag: string | undefined | null, ref: SpawnedByRef): boolean => {
  const parsed = parseSpawnedBy(tag)
  // Both sides go through the ONE formatter, on a value the ONE parser produced.
  // `spawnedByTag` is injective over the union — no two arms share a spelling —
  // so equal tags mean equal provenance, and neither side is hand-built.
  return parsed !== null && spawnedByTag(parsed) === spawnedByTag(ref)
}

export const SessionProvenance = z.object({
  /** WHO OR WHAT spawned this session. Parsed, not a freeform tag (D-17).
   *  Optional because sessions created before the field existed have no value —
   *  and "unknown" must stay distinguishable from `{ kind: 'user' }`. */
  spawnedBy: SpawnedByRef.optional(),
})
export type SessionProvenance = z.infer<typeof SessionProvenance>

// ---------------------------------------------------------------------------
// Identity, placement, launch
// ---------------------------------------------------------------------------

/** WHICH SESSION, of what kind, born when and how (D-1: `id`/`sessionId` and
 *  `agent`/`agentKind` become one name each; D-3: `origin` gets one encoding —
 *  `originKind` + `conversationId` become an R3 mapping detail, not a field). */
export const SessionIdentity = z.object({
  sessionId: SessionIdField,
  agentKind: AgentKind,
  createdAt: z.string(),
  origin: SessionOrigin,
  /** A HEADLESS harness session: driven turn-by-turn by the daemon, no PTY.
   *  Absent = a normal PTY session. */
  headless: z.boolean().optional(),
})
export type SessionIdentity = z.infer<typeof SessionIdentity>

/** WHERE the session runs, and what it is attached to.
 *
 *  `machineId` visibility is INHERITED from the machine (ADR 9 D3 rule 3): a
 *  fact about a machine takes that machine's scoping rather than carrying its
 *  own. Placement WRITES are additionally gated by `use` on the target machine
 *  (ADR 9 D6 M1) — `use` is a code-execution boundary, not a privacy one, and
 *  the gate lives in the command layer, never in this schema. */
export const SessionPlacement = z.object({
  cwd: z.string(),
  /** Carved out of the brand flip — see the file header. */
  machineId: MachineIdField.optional(),
  /** Explicit issue attachment (issue-as-workspace). Absent = unattached. */
  issueId: IssueIdField.optional(),
})
export type SessionPlacement = z.infer<typeof SessionPlacement>

/** THE SPAWN TUPLE, once (D-12). Four sites restate it today — including the
 *  `automation-schedule` approval op's `target.fresh`. One definition retires
 *  all four; the restatements are POD-366's to re-point. */
export const SessionLaunchConfig = z.object({
  model: z.string().optional(),
  effort: z.string().optional(),
  accountId: AccountIdField.optional(),
  /** The durable label requested at spawn. NOT a name — see {@link SessionNaming}. */
  durableLabel: z.string().optional(),
})
export type SessionLaunchConfig = z.infer<typeof SessionLaunchConfig>

/**
 * WHAT THE SESSION IS CALLED, and WHO named it (D-1 retires `label` and
 * `durableLabel`-as-a-name).
 *
 * `nameSource` is an AUTHORIZATION rule wearing a two-value enum: human-set
 * `name` outranks agent-set, so no agent may overwrite a user-set name
 * ([spec:SP-eb60]). Inventory §9 is explicit that a role class is not a person —
 * so the group carries the attribution PAIR beside it, and the two travel
 * together in a nested object so that "who named it" cannot be half-recorded.
 * `namedBy` is optional as a WHOLE; it is never partially present.
 */
export const SessionNaming = z.object({
  /** The live terminal title. */
  title: z.string(),
  /** Curated name; wins over `title` wherever both are shown. */
  name: z.string().optional(),
  /** The ROLE CLASS that set `name` — the outranking rule's input. Absent =
   *  unnamed. Kept as the enum it is today so the wire is unchanged. */
  nameSource: z.enum(['user', 'agent']).optional(),
  /** WHICH PRINCIPAL set it — the pair `nameSource` cannot express (ADR 9 D5
   *  A3). All-or-nothing by construction. */
  namedBy: Attribution.optional(),
})
export type SessionNaming = z.infer<typeof SessionNaming>

/** THE HUMAN-FACING BIRTH NAME's inputs (#474). `displayRef` is DERIVED from
 *  these plus the repo prefix and is never stored (D-5) — it lives on
 *  {@link SessionDerived}. The birth name is PERMANENT: re-attaching to another
 *  issue never renames. */
export const SessionRef = z.object({
  refIssueId: IssueIdField.optional(),
  refLetter: z.string().optional(),
  /** The issueless DRAFT ordinal (`POD-DRAFT-3`). */
  refDraft: z.number().int().optional(),
})
export type SessionRef = z.infer<typeof SessionRef>

/** ONE ENCODING of the native resume ref (D-3 retires all four spellings).
 *  `resumable` is DERIVED — "a resume ref is known" — and lives on
 *  {@link SessionDerived}, not here; a stored boolean beside the thing it is
 *  computed from is the stored/derived twin D-5 catalogues. */
export const SessionResume = z.object({
  resume: ResumeRef.optional(),
})
export type SessionResume = z.infer<typeof SessionResume>

// ---------------------------------------------------------------------------
// Lifecycle, activity, work
// ---------------------------------------------------------------------------

/** IS THE PROCESS ALIVE, and how did it stop. Distinct from
 *  {@link AgentRuntimeState}, which says what the agent INSIDE it is doing.
 *  `closed`-style booleans stay derived. */
export const SessionLifecycle = z.object({
  status: SessionStatus,
  /** Present only when `status === 'exited'`. */
  exitCode: z.number().int().optional(),
  /** Daemon diagnosis for `exitCode === -1` (spawn never started). */
  spawnFailure: z.string().optional(),
  stoppedAt: z.string().optional(),
  stopReason: z.enum(['self', 'parent', 'forced', 'exited']).optional(),
  /** A SHARED session fact, `exp-rev` — ADR 1 Amendment 1 D10, recorded again at
   *  inventory §7.2 Q1 and NOT reopened: `archived` sits beside `deletedAt` and
   *  means "this session is retired", which is identical for every viewer. A
   *  per-viewer "hide this from MY sidebar" would be a NEW per-user row (D10's
   *  open follow-on, POD-1076's call), never a reclassification of this field. */
  archived: z.boolean(),
})
export type SessionLifecycle = z.infer<typeof SessionLifecycle>

/**
 * WHEN things last happened — ONE CLOCK REPRESENTATION (D-6).
 *
 * Three spellings of one clock exist today (ISO strings here, `*AtMs` epoch
 * fields on `HostSessionView`, and `Instant` in the predicates). ADR 4 D3's
 * rejected-alternative section settles it: epoch-ms views are an ADAPTER AT THE
 * PORT, not a second field family. The strings stay strings here so the wire is
 * unchanged; `../clock.ts` owns the conversion.
 */
export const SessionActivity = z.object({
  /** Recency signal for the home board. */
  lastActiveAt: z.string(),
  /** Last human (controller) input, when one has happened. */
  lastInputAt: z.string().optional(),
  lastOutputAt: z.string().optional(),
  lastResumedAt: z.string().optional(),
  inputCount: z.number().int().nonnegative().optional(),
  outputCount: z.number().int().nonnegative().optional(),
  activityCount: z.number().int().nonnegative().optional(),
})
export type SessionActivity = z.infer<typeof SessionActivity>

/** THE KANBAN COLUMN. A SHARED session fact, `exp-rev` — ADR 1 Amendment 1 D10
 *  and inventory §7.2 Q2, recorded and not reopened: `WorkState`'s values are
 *  claims about the WORK and are identical for every viewer. */
export const SessionWorkState = z.object({
  workState: WorkState.optional(),
})
export type SessionWorkState = z.infer<typeof SessionWorkState>

/** EXTERNAL COORDINATOR PASS-THROUGH. Unbranded BY DECISION: these name rows in
 *  an external coordinator's id space and the substrate never interprets them,
 *  so a brand would assert a namespace we neither own nor mint. */
export const SessionWorkflowLink = z.object({
  workflowRunId: z.string().optional(),
  workflowStepId: z.string().optional(),
  executionProfileId: z.string().optional(),
})
export type SessionWorkflowLink = z.infer<typeof SessionWorkflowLink>

/**
 * SOFT-DELETE.
 *
 * `deletionSource` is a code-PATH label — *which deletion path ran* — and
 * inventory §9 is emphatic that it is **not** an attribution field and must not
 * be read as one: taking "typed label, so attribution is handled" at face value
 * would leave session deletion with NO ACTOR AT ALL. So the pair sits beside it,
 * and the two are nested together with `deletedAt` so a tombstone cannot record
 * *when* while recording nothing about *who* — the same split POD-367 found on
 * the needs-human overlay.
 *
 * `at` and `by` ARE {@link StampedAttribution}'s two members, named here
 * POSITIONALLY rather than by `.extend()` (POD-1156). This object interleaves its
 * own keys with the pair's — `{at, source, by, byIssueId}` — and `.extend()`
 * appends, so it would re-emit this shape as `{at, by, source, byIssueId}`. That
 * is a REORDERING of a persisted, replicated object: no type changes, no golden
 * fixture that pins a written value changes, and the bytes move. Placement is how
 * an interleaving site composes the pair without paying for that.
 */
export const SessionTombstone = z.object({
  deleted: z
    .object({
      at: StampedAttribution.shape.at,
      /** WHICH PATH ran. A reason, not a principal. */
      source: z.enum(['issue', 'standalone']),
      /** WHICH PRINCIPAL ran it (ADR 9 D5 A3). */
      by: StampedAttribution.shape.by,
      /** The cascading issue, on the issue-delete path. */
      byIssueId: IssueIdField.optional(),
    })
    .optional(),
})
export type SessionTombstone = z.infer<typeof SessionTombstone>

// ---------------------------------------------------------------------------
// The two groups that are named HERE so they can be kept OUT of R1
// ---------------------------------------------------------------------------

/**
 * LIVE-ONLY state — R2 and R4, **never** R1 (ADR 4 D3.7).
 *
 * This is where inventory **D-9**'s five column-less fields belong: `titleLocked`,
 * `agentColor`, `observedModel`, `observedEffort` and `transcriptAvailable` are
 * published on `SessionMeta` today and have **no storage column in any
 * migration**. A durable aggregate member that nothing persists is a lie about
 * the entity; naming them as an overlay is the fix, and it is why this group
 * exists in a file about durable vocabulary.
 *
 * `controllerId` is a WEBSOCKET CLIENT id, not a session id and not a person —
 * its brand is ADR 9's `DeviceId` family (POD-1075's). Identity on control is
 * Phase 5 work; it is listed here so nobody mistakes it for attribution.
 */
export const SessionLiveOverlay = z.object({
  controllerId: z.string().nullable().optional(),
  clientCount: z.number().int().nonnegative().optional(),
  epoch: z.number().int().nonnegative().optional(),
  /** Renamed from `shellBusy` / `shellCommandRunning`, which were two names for
   *  one fact. True while the session is actively writing to its PTY. */
  busy: z.boolean().optional(),
  /** Transient move overlay; a display LABEL, not an id. */
  handoffTarget: z.string().optional(),
  titleLocked: z.boolean().optional(),
  agentColor: z.string().optional(),
  observedModel: z.string().optional(),
  observedEffort: z.string().optional(),
  transcriptAvailable: z.boolean().optional(),
  /** Live authority for terminal size. */
  geometry: Geometry.optional(),
  activityDirty: z.boolean().optional(),
})
export type SessionLiveOverlay = z.infer<typeof SessionLiveOverlay>

/**
 * SERVER-DERIVED reads — pure functions over R1 (+ live inputs), **never a
 * second write path** (ADR 4 D3.6).
 *
 * Named here so D-5's stored/derived twins have somewhere to go that is not the
 * aggregate. `unread` is the interesting member: it is derived from `readAt`,
 * which is PER-USER STATE (POD-1076), so under multi-user this becomes a
 * per-principal derivation — one of the concrete places the scoped feed's
 * per-principal projection will land (README rule 2). Nothing here builds that.
 */
export const SessionDerived = z.object({
  /** From {@link SessionRef} + the repo prefix. */
  displayRef: z.string().optional(),
  /** From {@link SessionResume}: "a resume ref is known". */
  resumable: z.boolean().optional(),
  /** From the reader's per-user `readAt` vs `lastActiveAt`. Per-principal. */
  unread: z.boolean().optional(),
  /** Server-resolved from the machines table. */
  machineName: z.string().optional(),
  conversationPodiumId: ConversationIdField.optional(),
  queuedMessageCount: z.number().int().nonnegative().optional(),
})
export type SessionDerived = z.infer<typeof SessionDerived>

// ---------------------------------------------------------------------------
// Reserved op-stream member
// ---------------------------------------------------------------------------

/**
 * THE COMPOSER DRAFT — reserved `op-stream`, not built (`fields/op-stream.ts`).
 *
 * NOT per-user state, and inventory §7.2 Q3 says so explicitly: absorbing it
 * into POD-1076's family would silently DELETE the collaboration feature rather
 * than defer it (ADR 1 Am1 D10, rejected alternative 2). It stays `field-LWW`
 * today with D10's named interim defect: before session sharing ships it must
 * either move to `op-stream` or be gated to a single writer via the existing
 * `controllerId` / `requestControl` model.
 *
 * NOT an R1 member of the session either — the body lives in `session_drafts`,
 * keyed by session, and this group is the vocabulary for it. Only
 * `draftUpdatedAt` rides `SessionMeta` today, and it stays a derived overlay.
 */
export const SessionComposerDraft = z.object({
  body: OpStreamDocument,
  updatedAt: z.string().optional(),
})
export type SessionComposerDraft = z.infer<typeof SessionComposerDraft>
