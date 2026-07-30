/**
 * THE RETAINED-REPRESENTATION REGISTRY — POD-368, the closing child of POD-302.
 *
 * ADR 4 D1: one vocabulary, **not** one universal record. The canonical durable
 * aggregate (R1), live state (R2), the storage row (R3), the wire and read
 * projections (R4), the narrow ports (R5) and the portable export (R6) stay
 * DISTINCT types that `Pick` from the same field groups. So the end state of 1.4
 * is not "one shape"; it is "every shape justified, classified, and composed".
 *
 * This file is the justified-and-classified half. Each entry answers the three
 * questions this issue's convention requires — what it is FOR, why its semantics
 * genuinely differ from the canonical aggregate, and what it composes — and
 * declares its ADR 9 D3 visibility class against an ADR 1 matrix row.
 *
 * ---------------------------------------------------------------------------
 * THE SET, AND WHY IT IS 43 AND NOT POD-364'S 41
 * ---------------------------------------------------------------------------
 *
 * POD-364 counted 24 session + 17 issue representations at `0e583f44`. The live
 * set is 26 session + 17 issue, and both halves of that difference are recorded
 * rather than reconciled away.
 *
 * TWO WERE DELETED rather than documented, which is the convention working as
 * intended:
 *
 *   - `BtwSessionInfo` (§2.1 #14) — a strict subset of `ConciergeSessionInfo`,
 *     re-declared. Retired by POD-366; `btw.ts` now names #13 directly.
 *   - `StatusWire` (§2.1 #22) — a key-for-key hand copy of `SessionStatusResult`
 *     whose own comment named its source. Retired by POD-366; the CLI reads the
 *     shared projection in `../projections/session-read.ts`.
 *
 * Neither could answer `distinctSemantics`, so neither is here. **A
 * representation that cannot justify itself in this form is a drifted duplicate
 * and belongs deleted, not registered.**
 *
 * FOUR MORE WERE FOUND that POD-364's hand pass missed:
 * `SessionInstructionContext`, `SessionSpawnResult`, `SessionInfo` (the session
 * twin of the `IssueInfo` POD-367 corrected, in the same file) and
 * `OptimisticSpawnArgs`. POD-364 enumerated by READING; `scripts/
 * representation-audit.ts` enumerates by KEY SET, and no excluded category covers
 * these four. **The set is not claimed to be complete even now**: a composed
 * representation leaves no key list behind, so no structural detector can
 * enumerate one, and the registry is what enumerates them instead.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE `pending` ENTRIES MEAN, AND WHY THEY ARE NOT LAUNDERED
 * ---------------------------------------------------------------------------
 *
 * Some entries still hand-restate their key list. Each declares a NAMED owner and
 * a NAMED blocker, and `scripts/rearch-audit.ts` counts them as debt under that
 * owner's phase — not under POD-302, and not at zero. Three blockers recur, and
 * all three are architectural rather than anyone's omission:
 *
 *   1. **A circular import.** `../fields/issue.ts` imports six vocabularies FROM
 *      `../entities/issue.ts`, so the entity cannot import the groups back. Being
 *      zod VALUES this fails at RUNTIME (`undefined is not an object (evaluating
 *      'IssueStage.optional')`), not at lint. POD-1141 owns it, with 44 of
 *      `IssueWire`'s 78 keys already measured type-identical and byte-safe.
 *   2. **No shared home the consumer may import.** `packages/issue-client` and
 *      `apps/cli` cannot import `apps/server`, which is WHY those copies were
 *      hand-written. Deleting the copy requires the definition to sit in a
 *      package both sides may depend on.
 *   3. **An entity-in-entity embed whose removal has no receiver.** POD-308 owns
 *      all three embeds for one shared reason recorded in POD-367 §3.2, and it is
 *      a scoped-feed prerequisite rather than a perf note: an embedded child
 *      carries a visibility class of its own, so a nested session the reader may
 *      not see cannot be filtered out of the parent projection without either
 *      lying about the parent or leaking the child.
 */

import { HandoffManifest } from '../entities/handoff'
import { IssueGraphNode, IssueWire, OrphanIssue } from '../entities/issue'
import { SessionMeta } from '../entities/session'
import { ROW } from '../annotations/matrix'
import type { RetainedRepresentation } from './checks'

/** Recurring blocker strings, written once so they cannot drift between the
 *  entries that share them. */
const CYCLE_BLOCKER =
  'fields/issue.ts imports six vocabularies from entities/issue.ts, so the entity cannot import ' +
  'the groups back; being zod values it fails at runtime, not at lint (POD-367 §4a)'
const NO_SHARED_HOME =
  'packages/issue-client and apps/cli cannot import apps/server, so the single definition must ' +
  'first sit in a package both sides may depend on'
const EMBED_BLOCKER =
  'de-nesting has no receiver until the feed is scoped: the CLI holds no session collection to ' +
  'resolve ids against, so sessionIds would render as bare ids (POD-367 §3.2)'

// ---------------------------------------------------------------------------
// Session — 26 retained representations (POD-364 §2.1 minus the two deleted, plus
// the four its hand pass missed)
// ---------------------------------------------------------------------------

const SESSION_REPRESENTATIONS: readonly RetainedRepresentation[] = [
  {
    symbol: 'sessions',
    entity: 'session',
    site: 'apps/server/src/migrations/schema.ts',
    role: 'R3',
    purpose:
      'The physical session table. Drizzle DDL: column types, nullability, indexes and the ' +
      'snake_case names the database actually carries.',
    distinctSemantics:
      'It is the only representation whose members are STORAGE facts rather than entity facts — ' +
      'a nullable column is a migration decision, and its splits (resume→2 columns, geometry→2, ' +
      'origin→2) are encodings the aggregate does not have.',
    composition: {
      state: 'declared-legitimate-restatement',
      reason:
        'ADR 4 D6: drizzle is R3 AUTHORING, not the vocabulary. A physical DDL cannot be a Pick ' +
        'from a zod group without inverting which artifact the migration files are generated ' +
        'from, and past migrations are immutable history.',
      enforcedBy:
        'migration:manifest --check plus the frozen-file rule in scripts/rearch-audit.ts — a ' +
        'migration is never edited to satisfy a vocabulary audit.',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionRow',
    entity: 'session',
    site: 'apps/server/src/store/types.ts',
    role: 'R3',
    purpose: 'The camelCase typed mirror of the `sessions` table that the store reads and writes.',
    distinctSemantics:
      'It carries the STORAGE nullability contract (`string | null` where the aggregate has an ' +
      'absent optional) and the split columns, so it is the one shape where "absent" and "NULL" ' +
      'are different facts.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker:
        'needs the one documented toStorage/fromStorage pair to own the encoding splits; the ' +
        "aggregate's renames make a straight Pick a store-wide change",
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'Session',
    entity: 'session',
    site: 'apps/server/src/modules/sessions/session.ts',
    role: 'R2',
    purpose:
      'The live in-process session: owns the PTY, the controller gate, client attachment and ' +
      'output scheduling.',
    distinctSemantics:
      'It holds facts no durable shape may hold (ADR 4 D3.7): `controllerId`, `clientCount`, ' +
      '`epoch`, live `geometry`, and the five fields SessionMeta publishes with no storage ' +
      'column in any migration. A durable member nothing persists is a lie about the entity.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker:
        'its field list is typed from SessionDurableState/SessionInit below; all three collapse ' +
        'together or not at all',
    },
    matrixRow: ROW.sessionLiveEphemeral,
    visibility: 'personal',
  },
  {
    symbol: 'SessionInit',
    entity: 'session',
    site: 'apps/server/src/modules/sessions/session.ts',
    role: 'R2',
    purpose: 'The constructor argument of the live class — what is known at spawn.',
    distinctSemantics:
      'Two members are live WIRING and belong to no entity at all (`toDaemon`, `onActivity`), ' +
      'and the rest is the at-birth subset: it must not carry anything only observation can ' +
      'supply.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker:
        'inventory §6.4 makes it Pick<SessionAggregate, …> & { toDaemon; onActivity }; landing ' +
        'that is the same edit as SessionDurableState and the class',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionDurableState',
    entity: 'session',
    site: 'apps/server/src/modules/sessions/session.ts',
    role: 'R2',
    purpose: "The live class's own contract for which of its fields are persisted and mutable.",
    distinctSemantics:
      'It is the MUTABLE-AFTER-CREATE subset — the complement of ' +
      '`SESSION_IMMUTABLE_AFTER_CREATE` — and it additionally carries the epoch-ms activity ' +
      'twins (`outputAtMs`, `inputAtMs`, `resumedAtMs`) the aggregate keeps as ISO strings.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker:
        'inventory D-8 makes it a Pick from the aggregate; it also still carries the singleton ' +
        'readAt/snoozedUntil that POD-1076 re-keys to (userId, entityId)',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionMeta',
    entity: 'session',
    site: 'packages/model/src/entities/session.ts',
    role: 'R4',
    purpose: 'The session as every replica receives it — the shape that rides the change feed.',
    distinctSemantics:
      'It is the one representation that must be BYTE-STABLE across this rewrite (POD-360 pins ' +
      'it), so it keeps provenance flat at its historical key position rather than nested, and ' +
      'it adds the derived reads (`displayRef`, `unread`, `machineName`) that R1 must never ' +
      'store beside the fields they are computed from (ADR 4 D3.6).',
    composition: {
      state: 'composed',
      from:
        'SessionMetaEntity extended with SESSION_FLAT_PROVENANCE_SHAPE — the provenance split ' +
        'landed at the DEFINITION site so the wire did not move (POD-304); POD-308 owns nesting ' +
        'the carrier',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
    schema: SessionMeta,
  },
  {
    symbol: 'HandoffManifest',
    entity: 'session',
    site: 'packages/model/src/entities/handoff.ts',
    role: 'R6',
    purpose:
      'The portable export: everything a DIFFERENT machine needs to resume this session, moved ' +
      'as a bundle.',
    distinctSemantics:
      'It is the only representation that leaves this trust domain, which changes two members ' +
      'from data into decisions: `sourceMachineId`/`exportedAt` are export provenance rather ' +
      'than replica-delivery facts, and its `owner` is PROVENANCE and never an authorization ' +
      'input — a bundle is payload from outside, so per ADR 3 D7 the import path decides ' +
      'ownership from its OWN transport principal.',
    composition: {
      state: 'composed',
      from:
        'Pick over the session identity/resume/naming members plus the IssueWorkspace subset ' +
        'and bundle-local keys (POD-643)',
    },
    matrixRow: ROW.handoffBundle,
    visibility: 'personal',
    schema: HandoffManifest,
  },
  {
    symbol: 'HostSessionView',
    entity: 'session',
    site: 'apps/server/src/modules/hosts/service.ts',
    role: 'R5',
    purpose: 'The fields the auto-hibernate candidate scan reads.',
    distinctSemantics:
      'The scan is a hot loop over every session, so it reads the epoch-ms twins of three ISO ' +
      'fields (inventory D-6) rather than parsing timestamps per candidate. Those are the same ' +
      'facts in a different encoding, which is exactly what a documented adapter is for.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker:
        'inventory §6.4 gives it a Pick plus an epoch-ms adapter for the three *AtMs reads; the ' +
        'adapter is the part that does not exist yet',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionNoticeInfo',
    entity: 'session',
    site: 'apps/server/src/modules/notify/service.ts',
    role: 'R5',
    purpose: 'The fields an attention notice renders, so the notify service never holds a live Session.',
    distinctSemantics:
      'A structural port by design: it is what keeps a delivery module from taking a dependency ' +
      'on the session registry, and its narrowness IS the boundary.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker: 'a straight Pick per inventory §6.4, batched with the other R5 ports',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'RpcSessionView',
    entity: 'session',
    site: 'apps/server/src/modules/machines/rpc.ts',
    role: 'R5',
    purpose: 'The fields the file and transcript RPCs resolve a request against.',
    distinctSemantics:
      'It is a port over the LIVE OBJECT, not over data: one member is a METHOD ' +
      '(`transcriptItems()`). No projection of a durable aggregate can supply that, which is ' +
      'why it cannot become a plain Pick.',
    composition: {
      state: 'declared-legitimate-restatement',
      reason:
        'a member that is a method makes this a structural port over R2, not a projection of ' +
        'R1; composing the data members from the aggregate is possible but the shape is ' +
        'irreducibly a live-object port.',
      enforcedBy:
        'the compiler at every call site — the port is satisfied only by the live class, and ' +
        'the RPC module has no other way to reach a transcript.',
    },
    matrixRow: ROW.sessionLiveEphemeral,
    visibility: 'personal',
  },
  {
    symbol: 'ResumableSession',
    entity: 'session',
    site: 'packages/model/src/identity/session-identity.ts',
    role: 'R5',
    purpose: 'The input of the dedupe predicate that collapses rows pointing at one agent conversation.',
    distinctSemantics:
      'It is deliberately WIDER than a Pick: `status: string` and a structural `resume: {kind, ' +
      'value}` let it accept rows from an older server over a remote relay. A predicate that ' +
      'tightened its input would start refusing the rows it exists to deduplicate.',
    composition: {
      state: 'declared-legitimate-restatement',
      reason:
        'a version-tolerant predicate input: it also extends HeadlessFields, so the one member ' +
        'that is shared vocabulary is already composed and the rest is deliberate tolerance.',
      enforcedBy:
        'identity/session-identity.test.ts, which feeds it rows carrying only the structural ' +
        'members and asserts the dedupe still collapses them.',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'HandoffSession',
    entity: 'session',
    site: 'packages/model/src/predicates/machine-selection.ts',
    role: 'R5',
    purpose: 'The three facts the handoff-target predicate needs to pick a machine.',
    distinctSemantics:
      'Every member is a placement fact, and `machineId` is a MACHINE fact whose exposure is ' +
      'inherited (ADR 9 D3 rule 3) rather than classified here — which is why the predicate ' +
      'must fail closed on a machine the principal cannot `use` (ADR 1 Am1 §9).',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker: 'a straight Pick per inventory §6.4, batched with the other R5 ports',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'ConciergeSessionInfo',
    entity: 'session',
    site: 'apps/server/src/modules/superagent/concierge.ts',
    role: 'R5',
    purpose: "The session line the superagent's prompt renders.",
    distinctSemantics:
      'It FLATTENS `agentState.phase` to `phase` and `issue.seq` to `issueSeq`, because a ' +
      'prompt line is text assembly and a nested read there is a null-check per field. Those ' +
      'flattenings are renames of shared facts, not new facts.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker:
        'a Pick plus two declared flattenings; FocusSessionInfo already extends it, so the two ' +
        'land together',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'FocusSessionInfo',
    entity: 'session',
    site: 'apps/server/src/modules/superagent/global.ts',
    role: 'R5',
    purpose: 'The concierge line plus the one extra member the focus block renders.',
    distinctSemantics:
      'Its distinct semantics are exactly one member (`status`) — and that is the point: it is ' +
      'the codebase\'s existing good composition example, `extends ConciergeSessionInfo`, so ' +
      'the shared members have one home already.',
    composition: {
      state: 'composed',
      from: 'extends ConciergeSessionInfo; adds `status` only (inventory §2.1 #15)',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'CloudAgentSourceSession',
    entity: 'session',
    site: 'apps/server/src/cloud-runtime.ts',
    role: 'R5',
    purpose: 'The session as an EXTERNAL cloud-agent API names it.',
    distinctSemantics:
      "It carries a foreign vocabulary on purpose: `agent` for `agentKind`, `resumeRef: string` " +
      'for `resume: ResumeRef`. Those are not our spellings and must not become our spellings — ' +
      'the same treatment as `LinearIssue`. POD-366 offered two placements for it and this is the ' +
      'one it permits explicitly: COUNTED, with the verdict "renames retained, by decision" rather ' +
      'than "drift outstanding". Counted rather than excluded because `LinearIssue` is THEIR type ' +
      'name while this is OUR declaration of their spelling — an excluded shape is invisible and ' +
      'undocumented, and a registered one with a declared reason is strictly more auditable.',
    composition: {
      state: 'declared-legitimate-restatement',
      reason:
        "an external system's shape, deliberately not ours: the whole request is JSON-POSTed to a " +
        'THIRD-PARTY cloud control plane, so renaming `agent`/`resumeRef` would ship a body the ' +
        'remote cannot parse — and nothing in this repo would fail, because the hosted provider is ' +
        'only ever exercised through a mocked fetch. What §6.5 rule 2 requires instead is that the ' +
        'two spellings be written in exactly ONE named mapper, not at each call site.',
      enforcedBy:
        '`toCloudAgentSourceSession` is that single documented mapper and the only place either ' +
        'external spelling appears, with the reasoning at the declaration site so a reader hits it ' +
        'before "fixing" it; `router.cloud.test.ts` pins the outbound body key-for-key and was not ' +
        'edited when the inline literal was replaced (POD-366).',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'LakeReadSession',
    entity: 'session',
    site: 'apps/server/src/modules/conversations/service.ts',
    role: 'R5',
    purpose: 'The fields the transcript-lake read resolves a segment path from.',
    distinctSemantics:
      'It is a placement-plus-resume port. It USED to narrow `resume` to `{value}` — inventory ' +
      "D-3's third incompatible resume spelling — and that narrowing bought nothing, so it was " +
      'deleted rather than documented.',
    composition: {
      state: 'composed',
      from: 'the full shared `ResumeRef` plus placement members; the third resume spelling is gone (POD-366)',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'RefSessionLike',
    entity: 'session',
    site: 'apps/web/src/lib/ref-miniview.ts',
    role: 'R5',
    purpose: 'The minimal session shape the client-side `@ref` resolver needs to render a miniview.',
    distinctSemantics:
      'Identity is required and every at-a-glance field is optional, so a lean fixture or a ' +
      'legacy row still resolves. That optionality is the projection\'s own decision and not a ' +
      'property of the entity.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker:
        'its issue twin RefIssueLike is already a Pick from IssueWire; the session half waits ' +
        'on the same batch of R5 ports',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'IssueTreeSession',
    entity: 'session',
    site: 'packages/model/src/projections/session-read.ts',
    role: 'R4',
    purpose: 'The compact session line the issue tree and `issue show` print.',
    distinctSemantics:
      'It is a DERIVED projection: `label` is `name ?? title` and `phase` is ' +
      '`agentState.phase`, both resolved server-side so the CLI — which holds no session ' +
      'collection — has nothing left to resolve.',
    composition: {
      state: 'composed',
      from:
        'lives in model precisely so `ShowSession` can intersect it instead of hand-copying its ' +
        'eight keys (POD-366); `toIssueTreeSession` is its one named mapper',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'ShowSession',
    entity: 'session',
    site: 'packages/issue-client/src/commands.ts',
    role: 'R4',
    purpose: 'The tree/show session line as the CLI client reads it off a possibly-older server.',
    distinctSemantics:
      'Its three extra members are VERSION SKEW, not vocabulary: a same-version server ' +
      'flattens `name`/`title` into `label` and `agentState.phase` into `phase` before sending, ' +
      'but this client also runs against a remote relay and can meet a server that does not. ' +
      'Tightening the read would be a behaviour change dressed as a refactor.',
    composition: {
      state: 'composed',
      from:
        '`IssueTreeSession & { …three skew keys }` — the eight shared keys come from model and ' +
        'the tolerance is documented AS tolerance (POD-366). Retiring the skew keys needs a ' +
        'version floor.',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionStatusResult',
    entity: 'session',
    site: 'packages/model/src/projections/session-read.ts',
    role: 'R4',
    purpose: 'The tier-1 status read model both the web and the CLI render.',
    distinctSemantics:
      'It is the read model with TWO consumers in different workspaces, which is why it lives ' +
      'in model: that is the only placement under which the CLI copy (`StatusWire`) could be ' +
      'deleted rather than kept in sync.',
    composition: {
      state: 'composed',
      from:
        'the shared home that let POD-366 delete `StatusWire` outright; it omits nothing, so ' +
        'narrowing here would just recreate the copy',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionAutoArchiveObservation',
    entity: 'session',
    site: 'packages/protocol/src/maintenance.ts',
    role: 'R4',
    purpose: "The steward's observation payload proposing that a session be auto-archived.",
    distinctSemantics:
      'Its members look like the aggregate\'s and are NOT the same schemas: the bounds are ' +
      'input limits on an untrusted payload, and the literal preconditions assert the state the ' +
      'steward SAW. Composing them from the entity would turn a gate that refuses a ' +
      'wrong-state payload into one that accepts it.',
    composition: {
      state: 'declared-legitimate-restatement',
      reason:
        'a validation gate over untrusted input. The divergence class is the point: an audit ' +
        'that counts this shape must count it as declared-legitimate, because "not yet ' +
        'composed" and "composing would be wrong" have opposite correct actions.',
      enforcedBy:
        'the refusal tests in packages/protocol, each mutating exactly one field of an ' +
        'otherwise-valid payload with the valid payload asserted to PASS first, at the bound ' +
        'exactly — so a wrongly-tightened bound cannot pass by accident (POD-367 §2).',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  // --- The four the hand inventory missed, found by the structural detector.
  //
  // POD-364 enumerated 24 session representations BY READING; `scripts/
  // representation-audit.ts` enumerates by KEY SET, and it found four more that
  // no excluded category covers. They are registered rather than allowlisted,
  // because each one restates session vocabulary at a producer and each answers
  // `distinctSemantics`. The count is 26, not 24, and that correction is the
  // detector earning its cost on its first run.
  {
    symbol: 'SessionInstructionContext',
    entity: 'session',
    site: 'apps/server/src/modules/sessions/instructions.ts',
    role: 'R5',
    purpose: 'What an instruction provider needs to know to compose a session\'s agent instructions.',
    distinctSemantics:
      'One member is not a session fact at all: `existingOnly` is a RESURRECTION rule — rehydrate ' +
      'only instructions already attached, never adopt a default that appeared after the ' +
      'conversation began. That is a policy input riding a session port.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker: 'a Pick plus the two provider-local members; batched with the other R5 ports',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionSpawnResult',
    entity: 'session',
    site: 'apps/server/src/modules/sessions/service.ts',
    role: 'R5',
    purpose: 'What the caller of a spawn is told about the session it just created.',
    distinctSemantics:
      'It reports the RESOLVED launch tuple — model/effort/account as the server actually chose ' +
      'them, which the request may have left to defaults — and it carries both `machine` and ' +
      '`machineId`, a duality the aggregate does not have and which a Pick must resolve rather ' +
      'than preserve.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker:
        'the machine/machineId duality has to collapse to one fact first; doing it here alone ' +
        'would change a spawn response shape',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionInfo',
    entity: 'session',
    site: 'apps/server/src/modules/workflows/service.ts',
    role: 'R5',
    purpose: 'The session facts a workflow step reads to decide placement and attribution.',
    distinctSemantics:
      'It is the session twin of `IssueInfo` in the same file, and it exists for the same reason: ' +
      'a workflow must resolve where a step will run without holding a live session. POD-367 ' +
      'corrected the issue half of this pair; the session half was missed by both passes.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker: 'a straight Pick; batched with the other R5 ports',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'OptimisticSpawnArgs',
    entity: 'session',
    site: 'packages/client-core/src/viewmodels/optimistic-spawn.ts',
    role: 'command-input',
    purpose:
      'The arguments a client-side optimistic spawn needs to render a session before the server ' +
      'has booted one.',
    distinctSemantics:
      'It carries `nowIso` — a clock injected so the builders stay pure — which is not a session ' +
      'fact but a testability seam. It is also a declared BRAND EDGE: the click handler hands ' +
      'plain strings, and POD-361 marked the cast here rather than branding inside the builder.',
    composition: {
      state: 'pending',
      owner: 'POD-363',
      blocker:
        'POD-361 left a marked edge-cast (POD-361-EDGE-CAST) to be resolved by branding this ' +
        'shape AT ITS SOURCE, which is POD-363\'s flip rather than a Pick here',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
  {
    symbol: 'SessionCardModel',
    entity: 'session',
    site: 'packages/client-core/src/viewmodels/session-card.ts',
    role: 'R4',
    purpose: 'The presentation model one session card renders, shared by web and mobile.',
    distinctSemantics:
      'Almost every member is PRESENTATION, computed and not stored: `subtitle`, `issueLabel`, ' +
      '`summary`, `group`, `dotTone`. It restates only `sessionId` and `title`, and a stored ' +
      'copy of any of the rest would be a second write path (ADR 4 D3.6).',
    composition: {
      state: 'composed',
      from:
        'takes `SessionMeta` as input and derives the rest; the two entity members are the only ' +
        'shared vocabulary it names (inventory §2.1 #24 — "already composes")',
    },
    matrixRow: ROW.sessionIdentity,
    visibility: 'personal',
  },
]

// ---------------------------------------------------------------------------
// Issue — 17 retained representations (POD-364 §3)
// ---------------------------------------------------------------------------

const ISSUE_REPRESENTATIONS: readonly RetainedRepresentation[] = [
  {
    symbol: 'issues',
    entity: 'issue',
    site: 'apps/server/src/migrations/schema.ts',
    role: 'R3',
    purpose: 'The physical issue table — 59 columns of drizzle DDL.',
    distinctSemantics:
      'Storage encodings the aggregate does not have: `blockedByNotes` as JSON text, `panel` as ' +
      'raw JSON, and nullable columns where the aggregate has absent optionals.',
    composition: {
      state: 'declared-legitimate-restatement',
      reason:
        'ADR 4 D6: drizzle is R3 authoring, not the vocabulary, and past migrations are ' +
        'immutable history that no phase may edit to satisfy an audit.',
      enforcedBy:
        'migration:manifest --check plus the frozen-file rule in scripts/rearch-audit.ts.',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'IssueRow',
    entity: 'issue',
    site: 'apps/server/src/store/types.ts',
    role: 'R3',
    purpose: 'The typed row the issue store reads and writes.',
    distinctSemantics:
      'It is where the JSON-encoded columns are still text, so it is the one shape in which ' +
      '`panel` and `blockedByNotes` are strings rather than structures.',
    composition: {
      state: 'declared-legitimate-restatement',
      reason:
        'R3 is the ENCODING, not the vocabulary — the same ADR 4 D6 verdict the `issues` DDL ' +
        'above carries, and this is that DDL\'s typed mirror. The R1 side IS composed: ' +
        '`StoredIssue` (apps/server/src/store/issue-storage.ts) is `IssueAggregate` minus the ' +
        'five members no column exists for, and the ONE documented toStorage/fromStorage pair ' +
        'ADR 4 §4.1 asks for maps between them per key. A per-key mapper is what a derivation ' +
        'cannot buy: `origin` and `audience` are both \'human\' | \'agent\', so a structural ' +
        'check cannot see them swapped (POD-1151).',
      enforcedBy:
        'apps/server/src/store/issue-storage.test.ts — schema-INSTANCE identity (`toBe`) per ' +
        'composed member, a strict round trip over a fixture whose type-identical pairs hold ' +
        'DIFFERENT values, and membership pins on both the omitted set and the case list. The ' +
        'origin/audience swap mutant reddens a NAMED test.',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'StoredIssue',
    entity: 'issue',
    site: 'apps/server/src/store/issue-storage.ts',
    // Role vocabulary note: this is the R1 SIDE of the R3 seam, and there is no
    // member for that. Filed under R3 because it exists only to serve the storage
    // boundary — inventing a role is an ADR 4 amendment, not a registry edit.
    role: 'R3',
    purpose:
      'The in-memory issue as far as storage can carry it — the R1 half of the one documented ' +
      'toStorage/fromStorage pair (ADR 4 §4.1) that bridges `IssueAggregate` and `IssueRow`.',
    distinctSemantics:
      'It is `IssueAggregate` MINUS the five members no column exists for (`owner`, ' +
      '`visibility`, `createdBy`, `lastLifecycleActor`, `labels`) and minus the `attribution` ' +
      'half of the needs-human `asked` group — a real storage gap owned by POD-1075, named as ' +
      'data rather than defaulted at the seam (ADR 9 D8 S5 forbids defaulting `onBehalfOf`). ' +
      'It also carries `askedLegacy`, the shape holding the pre-#53 combinations `asked` ' +
      'refuses BY DESIGN, so a question written without an asker is not silently dropped. It ' +
      'does NOT carry `readAt`/`tuckedAt`/`pinned`/`repoPath`: those are R3-only and stay ' +
      'declared once, on `IssueRow`.',
    composition: {
      state: 'composed',
      from: '`IssueAggregate.omit(…)` — every retained key is the shared field-group INSTANCE, ' +
        'asserted with `toBe` in apps/server/src/store/issue-storage.test.ts (POD-1151)',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'IssueWire',
    entity: 'issue',
    site: 'packages/model/src/entities/issue.ts',
    role: 'R4',
    purpose: 'The issue as every replica receives it — the shape that rides the change feed.',
    distinctSemantics:
      'Byte-stability is its contract (POD-360 pins 87 fixtures), so it keeps the pre-rewrite ' +
      'spellings the aggregate deliberately renamed (`blockedBy`, `origin`, `draft`), the ' +
      'flattened needs-human tuple, plain strings where the aggregate wraps documents, and the ' +
      'derived rollups R1 must not store.',
    composition: {
      state: 'pending',
      owner: 'POD-1141',
      blocker: CYCLE_BLOCKER,
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
    schema: IssueWire,
  },
  {
    symbol: 'IssuePatch',
    entity: 'issue',
    site: 'apps/server/src/modules/issues/service/types.ts',
    role: 'command-input',
    purpose: 'What an update command is allowed to change.',
    distinctSemantics:
      'Every member is optional BY CONSTRUCTION and that is a different fact from the ' +
      'aggregate\'s optionality: here absent means "not being changed", not "not known".',
    composition: {
      state: 'composed',
      from:
        '`Partial<Pick<IssueRow, …>>` — the compliant reference pattern inventory §6 ' +
        'generalizes from',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'CreateIssueInput',
    entity: 'issue',
    site: 'apps/server/src/modules/issues/service/types.ts',
    role: 'command-input',
    purpose: 'What a create command supplies.',
    distinctSemantics:
      'It is the at-birth subset: it must NOT accept the members the server mints (`seq`, ' +
      '`refLetter`, timestamps), so its key set is a real restriction rather than a view.',
    composition: {
      state: 'composed',
      from: '`Pick<IssueRow, …>` through a `CreatableRowFields<K>` mapped type (POD-367)',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'IssueTreeNode',
    entity: 'issue',
    // Moved to model by POD-1141, which gave the tree and show projections one
    // shared home; the server module now RE-EXPORTS it (boundary rule 7 permits a
    // re-export and flags only a new declaration under the same name). The site
    // is the DECLARATION, so it follows the symbol rather than its consumers.
    site: 'packages/model/src/projections/issue-read.ts',
    role: 'R4',
    purpose: 'One node of the epic-subtree payload the tree view and the CLI render.',
    distinctSemantics:
      'It is RECURSIVE (`children`) and carries tree-shaped facts no flat projection has: ' +
      '`omittedChildren` from the depth cap, and a 300-character description excerpt rather ' +
      'than the document.',
    composition: {
      state: 'pending',
      owner: 'POD-308',
      blocker: EMBED_BLOCKER,
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'TreeNode',
    entity: 'issue',
    site: 'packages/issue-client/src/commands.ts',
    role: 'R4',
    purpose: 'The tree node as the CLI client reads it.',
    distinctSemantics:
      'It drops the members the CLI never prints (`id`, `type`) — a genuine narrowing of the ' +
      'server payload rather than a second definition of it.',
    composition: {
      state: 'pending',
      owner: 'POD-308',
      blocker: NO_SHARED_HOME,
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    // Was `ShowWire` in packages/issue-client. POD-1141 renamed it and moved it
    // here, which RESOLVES the NO_SHARED_HOME half of its old blocker — that home
    // now exists and the tree projection shares it. The embed half stands.
    symbol: 'IssueShowWire',
    entity: 'issue',
    site: 'packages/model/src/projections/issue-read.ts',
    role: 'R4',
    purpose: 'The slice of an issue the `issue show` renderer reads.',
    distinctSemantics:
      'A version-tolerant read: every optional member may be absent because this client can meet ' +
      'an older server across a remote relay, and it reads `null` where the current server omits ' +
      'the key — so every optional member is `| null` too. A straight Pick<IssueWire, …> would ' +
      'declare a contract this client cannot rely on, and tightening the read would be a ' +
      'behaviour change dressed as a refactor. The key SET is the projection, spelled once.',
    composition: {
      state: 'pending',
      owner: 'POD-308',
      blocker: 'it embeds IssueTreeSession[], so ' + EMBED_BLOCKER,
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'OrphanIssue',
    entity: 'issue',
    site: 'packages/model/src/entities/issue.ts',
    role: 'R4',
    purpose: 'The narrow wire projection listing issues whose worktree has gone.',
    distinctSemantics:
      'Four members, and the narrowness is the feature: an orphan listing must be answerable ' +
      'without loading issue content.',
    composition: { state: 'composed', from: '`IssueRefHead.extend(…)` — identity from the shared head (POD-367)' },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
    schema: OrphanIssue,
  },
  {
    symbol: 'IssueGraphNode',
    entity: 'issue',
    site: 'packages/model/src/entities/issue.ts',
    role: 'R4',
    purpose: 'One node of the dependency-graph projection.',
    distinctSemantics:
      'Every member is REQUIRED, deliberately, so a suppressed node cannot be half-emitted ' +
      'with fields blanked — which is what keeps both cross-boundary edge answers expressible ' +
      '(hide the edge = omit the node; opaque reference = `.pick({id: true})`).',
    composition: {
      state: 'composed',
      from:
        '`IssueRefHead.extend(…)`, with content added by MASK so the identity-only pick stays ' +
        'leak-free (POD-367 §3.1)',
    },
    matrixRow: ROW.issueGraph,
    visibility: 'personal',
    schema: IssueGraphNode,
  },
  {
    symbol: 'HandoffIssue',
    entity: 'issue',
    site: 'packages/model/src/predicates/machine-selection.ts',
    role: 'R5',
    purpose: 'The two issue facts the handoff-target predicate reads.',
    distinctSemantics:
      'Both members are `| null` on top of the group\'s types, because the predicate must ' +
      'accept an issue with no worktree yet — the tolerance is the port working, not drift.',
    composition: {
      state: 'composed',
      from: 'a mapped type over `IssueWorkspace` (POD-367, inventory #11)',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'RefIssueLike',
    entity: 'issue',
    site: 'apps/web/src/lib/ref-miniview.ts',
    role: 'R5',
    purpose: 'The issue shape the client-side `@ref` miniview card renders.',
    distinctSemantics:
      'Identity required, everything else optional, and the panel is genuinely NARROWER than ' +
      'the wire carries — two of three groups and two members of an artifact. A card reads what ' +
      'it renders.',
    composition: {
      state: 'composed',
      from:
        '`Pick<IssueWire, …>` + `Partial<Pick<…>>` + panel member types from the panel group ' +
        'itself. It was the largest hand-written restatement in the repo (22 keys) and ' +
        'composing it caught eleven fixture sites that needed branded ids (POD-367)',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'FocusIssueInfo',
    entity: 'issue',
    site: 'apps/server/src/modules/superagent/global.ts',
    role: 'R5',
    purpose: "The issue members the superagent's focus block renders.",
    distinctSemantics:
      'Two members are always known to the caller and two are optional because a lean focus ' +
      'payload may omit them — an availability distinction the aggregate does not make.',
    composition: {
      state: 'composed',
      from:
        "`Pick<IssueWire, 'seq'|'title'> & Partial<Pick<IssueWire, 'stage'|'repoPath'>>`; " +
        '`stage` tightened from bare `string` to `IssueStage` as a side effect, which is the ' +
        'drift this removed (POD-367)',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'IssueInfo',
    entity: 'issue',
    site: 'apps/server/src/modules/workflows/service.ts',
    role: 'R5',
    purpose: 'The one fact a workflow needs to decide worktree placement.',
    distinctSemantics:
      'It is NOT a duplicate of `FocusIssueInfo`, and the inventory verdict that said so was ' +
      'corrected: the two share `repoPath` and nothing else, and this port\'s only read member ' +
      'is `worktreePath`. Collapsing them would force a port to carry members it never reads ' +
      'and lose the one it does.',
    composition: {
      state: 'composed',
      from: "`Pick<IssueRow, 'worktreePath'>` (POD-367 §2, verdict corrected)",
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'StartableIssueLike',
    entity: 'issue',
    site: 'apps/web/src/features/issues/issue-startable.ts',
    role: 'R5',
    purpose: 'The structural predicate port that decides whether an issue can be started now.',
    distinctSemantics:
      'It accepts `| null` on every member so a partially-loaded row can still be judged; the ' +
      'union is the predicate tolerating client-side reality, not drift.',
    composition: { state: 'composed', from: 'a `StartabilityFields<…>` mapped type over the wire members (POD-367)' },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'IssueAutoArchiveObservation',
    entity: 'issue',
    site: 'packages/protocol/src/maintenance.ts',
    role: 'R4',
    purpose: "The steward's observation payload proposing that an issue be auto-archived.",
    distinctSemantics:
      'Same class as its session twin: `.min(1).max(256)` are input bounds on an untrusted ' +
      'payload and `archived: z.literal(false)` / `deletedAt: z.null()` are preconditions about ' +
      'the state the steward saw. These are assertions, not entity fields.',
    composition: {
      state: 'declared-legitimate-restatement',
      reason:
        'a validation gate over untrusted input — composing it from IssueWire would turn a gate ' +
        'that refuses a wrong-state payload into one that accepts it, and an audit number is ' +
        'not worth loosening a gate.',
      enforcedBy:
        'five tests that make the gate refuse what it exists to refuse, each mutating exactly ' +
        'one field with the valid payload asserted to pass first, plus the reason recorded ON ' +
        'the schema (POD-367 §2).',
    },
    matrixRow: ROW.issueCore,
    visibility: 'personal',
  },
  {
    symbol: 'GitProbeTarget',
    entity: 'issue',
    site: 'apps/server/src/modules/issues/git-state.ts',
    role: 'R5',
    purpose: 'Where and how to probe git for an issue\'s merge/commit state.',
    distinctSemantics:
      'Every member is a MACHINE fact or a probe-local input, so its exposure is inherited from ' +
      'the machine (ADR 9 D3 rule 3) rather than classified as issue content. Two of its ' +
      'members are the trap type-identity cannot see: `IssueGitState.updatedAt` is a ' +
      'LAST-PROBE timestamp and `branch` is the branch the checkout is ACTUALLY on — ' +
      'type-identical to the issue\'s entity mtime and owned branch, and different facts.',
    composition: {
      state: 'composed',
      from:
        "`extends Pick<IssueWire, 'parentBranch'|'branch'|'machineId'>` plus probe-local " +
        'inputs (POD-367)',
    },
    matrixRow: ROW.machine,
    visibility: 'owned-compute',
  },
]

/**
 * THE retained representations. 43 today: 26 session + 17 issue.
 *
 * Membership is PINNED by a literal count in `registry.test.ts`, not derived from
 * this array, because a suite whose parameter list is the thing under test cannot
 * notice its own coverage shrinking — "43 passed" and "41 passed" read
 * identically.
 */
export const RETAINED_REPRESENTATIONS: readonly RetainedRepresentation[] = [
  ...SESSION_REPRESENTATIONS,
  ...ISSUE_REPRESENTATIONS,
]

/**
 * The two representations DELETED rather than documented, kept as a
 * regression record.
 *
 * They are named here so that re-adding either reads as what it is. Both failed
 * the same question — `distinctSemantics` — and the convention's answer to that
 * is deletion.
 */
export const DELETED_AS_DRIFTED_DUPLICATES: readonly {
  readonly symbol: string
  readonly was: string
  readonly retiredBy: string
}[] = [
  {
    symbol: 'BtwSessionInfo',
    was: 'a strict subset of ConciergeSessionInfo, re-declared (inventory §2.1 #14)',
    retiredBy: 'POD-366 — btw.ts now names ConciergeSessionInfo directly',
  },
  {
    symbol: 'StatusWire',
    was: 'a key-for-key hand copy of SessionStatusResult whose own comment named its source (§2.1 #22)',
    retiredBy: 'POD-366 — the CLI reads the shared projection in projections/session-read.ts',
  },
  // POD-366 retired THREE from `apps/cli/src/session-cli.ts`, not the one the
  // inventory counted. §2.1 lists only `StatusWire` because of the
  // one-role-per-symbol predicate, but all three were the same class in the same
  // file and went together. Recorded here so the retirement is not undercounted
  // as one — the inventory's own number would otherwise be the memory of it.
  {
    symbol: 'RecapWire',
    was: 'a key-for-key hand copy of SessionRecapResult; uncounted by §2.1, same class as StatusWire',
    retiredBy: 'POD-366 — the CLI reads projections/session-read.ts',
  },
  {
    symbol: 'ReadWire',
    was: 'a structural subset of SessionReadResult; uncounted by §2.1, same class as StatusWire',
    retiredBy: 'POD-366 — the CLI reads projections/session-read.ts',
  },
]

/**
 * Two read models in `../projections/session-read.ts` that are deliberately NOT
 * registered, recorded because their absence beside their sibling looks like an
 * omission and is not.
 *
 * `SessionReadResult` (a page of transcript items plus a cursor) and
 * `SessionRecapResult` (a recap plus its watermark) each name exactly ONE session
 * key — `sessionId` — and everything else is read-model payload: cursors,
 * watermarks, item counts, transcript text. They are read models keyed BY a
 * session rather than projections OF one, which is why they sit below the
 * entity-shaped threshold and why POD-364 did not count them either. Their
 * retired CLI copies (`RecapWire`, `ReadWire`) are above; the shared definitions
 * they replaced those copies with are these.
 */
export const KEYED_BY_SESSION_NOT_A_PROJECTION_OF_ONE = [
  'SessionReadResult',
  'SessionRecapResult',
] as const
