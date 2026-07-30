/**
 * THE REDEFINED SESSION/ISSUE VOCABULARY DETECTOR — POD-368, closing POD-302.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OLD DETECTOR WAS REPLACED RATHER THAN EXTENDED
 * ---------------------------------------------------------------------------
 *
 * `session-shapes` and `issue-shapes` were `^export (interface|type|class) X`
 * over a HARDCODED LIST of nine and seven names. POD-367 measured what that could
 * see and the answer was **4 of 17 issue representations, with half of what it
 * counted not a counted representation at all** — `packages/model`'s own canonical
 * declarations counted as debt, while `RefIssueLike` went from a hand-written
 * 22-key interface to a `Pick` and the audit printed the identical number before
 * and after.
 *
 * The list was deliberately NOT extended to the full set, and that judgement is
 * carried forward here. A longer literal list reproduces the defect one
 * generation later and leaves the criterion **zeroable by renaming an
 * identifier**. So this detector keys on the thing that cannot be renamed away:
 * the ENTITY VOCABULARY ITSELF, read at runtime out of `packages/model`'s field
 * groups. Rename `RefIssueLike` to anything you like and it still declares
 * `worktreePath`, `closedReason` and `blockedBy`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COUNTS, AND THE LIMIT THAT DEFINES THE UNIT
 * ---------------------------------------------------------------------------
 *
 * It counts **a hand-restated session or issue field list that is not accounted
 * for in `packages/model`'s retained-representation registry.**
 *
 * The limit is structural and must be stated, because it is the reason the
 * registry exists and is not derived from this detector: **a composed
 * representation is INVISIBLE here, by construction.** `Pick<IssueWire, …>` and
 * `IssueRefHead.extend(…)` leave no key list behind to count. So this detector
 * can enumerate RESTATEMENTS; it can never enumerate REPRESENTATIONS. Reading a
 * falling count as "more representations are composed" is valid; reading a zero
 * as "these are all the representations there are" is not.
 *
 * Both directions of the loop are therefore closed:
 *
 *   - **tree → registry**: an entity-shaped restatement nobody registered counts
 *     as debt ({@link unregisteredRestatements}).
 *   - **registry → tree**: a registry entry whose site or symbol no longer exists
 *     counts too ({@link danglingRegistryEntries}), so the registry cannot rot
 *     into a list of retired names while reporting green.
 *
 * ---------------------------------------------------------------------------
 * PROVING THE INSTRUMENT CAN SAY YES
 * ---------------------------------------------------------------------------
 *
 * `representation-audit.test.ts` asserts this detector FINDS a planted
 * hand-restated shape, STAYS SILENT on the composed form of the same shape,
 * survives reformatting, and — the check that matters most — that it still finds
 * the shape after the symbol is RENAMED. A detector whose zero could only mean
 * "the regex broke" is the audit's own worst failure mode
 * (`docs/rearch-deletion-audit.md`), so `entityShapedDeclarations` THROWS if the
 * vocabulary it loads is empty rather than reporting a serene zero.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IssueAggregate } from '../packages/model/src/aggregates/issue'
import { PER_USER_STATE_KEYS } from '../packages/model/src/aggregates/registry'
import { SessionAggregate } from '../packages/model/src/aggregates/session'
import { IssueWire } from '../packages/model/src/entities/issue'
import { SessionMeta } from '../packages/model/src/entities/session'
import { RETAINED_REPRESENTATIONS } from '../packages/model/src/representations/registry'
import type { AuditContext, AuditSite } from './rearch-audit'

// ---------------------------------------------------------------------------
// The vocabulary — read from the model, never restated here
// ---------------------------------------------------------------------------

/** Every key the canonical session aggregate or its wire projection declares. */
export const SESSION_VOCABULARY: ReadonlySet<string> = new Set([
  ...Object.keys(SessionAggregate.shape),
  ...Object.keys(SessionMeta.shape),
])

/** Every key the canonical issue aggregate or its wire projection declares. */
export const ISSUE_VOCABULARY: ReadonlySet<string> = new Set([
  ...Object.keys(IssueAggregate.shape),
  ...Object.keys(IssueWire.shape),
])

/**
 * Keys that ARE entity vocabulary but are not EVIDENCE of an entity shape.
 *
 * `id`, `title`, `status` and `createdAt` appear on half the declarations in the
 * repo. Counting them makes every result shape and every unrelated row look
 * session-shaped, and a detector with that many false positives gets an
 * allowlist so long that the allowlist becomes the real detector.
 *
 * This list is the one JUDGEMENT in the detector, so it is stated rather than
 * buried, and `representation-audit.test.ts` pins its membership.
 */
export const GENERIC_KEYS: ReadonlySet<string> = new Set([
  'id',
  'title',
  'name',
  'type',
  'kind',
  'value',
  'path',
  'status',
  'createdAt',
  'updatedAt',
  'color',
  'model',
  'effort',
  'priority',
  'labels',
  'archived',
  'deletedAt',
  'description',
  'notes',
  'brief',
  'closed',
  'blocked',
  'ready',
  'assignee',
  'prefix',
  'seq',
  'stage',
  // The ownership and attribution members: shared by every owned class, so their
  // presence says nothing about WHICH entity a shape represents. They have their
  // own audit item (one definition site) and their own exemption from the
  // capability audit.
  'owner',
  'visibility',
  'actor',
  'onBehalfOf',
])

/** How many distinct, non-generic vocabulary keys make a declaration
 *  entity-shaped. POD-364's inventory predicate says "≥2 top-level
 *  entity-concept keys"; this detector uses 3 because it has no human reading
 *  each candidate, and reports the count per site so the threshold is auditable
 *  rather than implicit. */
export const ENTITY_SHAPE_THRESHOLD = 3

// ---------------------------------------------------------------------------
// Declaration parsing
// ---------------------------------------------------------------------------

const DECL = /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(interface|type|class|const)\s+(\w+)/

/** A member that is a method or a function type. A representation's members are
 *  DATA; a declaration with behaviour is a port or a service. */
const FUNCTION_MEMBER = /^\s+(?:readonly\s+)?\w+\??\s*(?:\([^)]*\)\s*:|:\s*\([^)]*\)\s*=>)/m

export interface EntityShapedDecl {
  readonly file: string
  readonly line: number
  readonly symbol: string
  /**
   * Distinct non-generic vocabulary keys this declaration RESTATES — i.e. writes
   * out as a property with its own type. Composed keys are deliberately absent:
   * `Pick<IssueWire, 'readAt'>` names a key but restates no type, so it is not a
   * restatement. These are what the `session-shapes` / `issue-shapes` counts read.
   */
  readonly sessionKeys: readonly string[]
  readonly issueKeys: readonly string[]
  /**
   * Every key the declaration NAMES, restated or merely picked. The
   * forbidden-key-class checks read these, because a projection that *picks*
   * `readAt` still ships one person's read state, and one that picks a capability
   * still serializes authority.
   */
  readonly keys: readonly string[]
}

/**
 * Refuse to run on an empty vocabulary.
 *
 * A broken import would otherwise make every count fall to zero and the ratchet
 * would print "counts went DOWN — nice, lock the win in" (`docs/
 * rearch-deletion-audit.md`: "a detector that stops matching is not a
 * deletion"). Extracted and exported so a test can watch it REFUSE — an
 * unexercised guard is indistinguishable from an absent one.
 */
export function assertVocabularyLoaded(
  session: ReadonlySet<string>,
  issue: ReadonlySet<string>,
): void {
  if (session.size === 0 || issue.size === 0) {
    throw new Error(
      'representation-audit: the entity vocabulary loaded EMPTY from @podium/model. Every count ' +
        'would be zero and the ratchet would read it as a deletion. Fix the import; do not ' +
        'rebaseline.',
    )
  }
}

/**
 * Every top-level declaration under `apps/` + `packages/` that hand-declares at
 * least {@link ENTITY_SHAPE_THRESHOLD} distinct non-generic session or issue keys.
 *
 * Throws if the vocabulary is empty: a broken import would otherwise make every
 * count fall to zero and the ratchet would offer to bank the win
 * (`docs/rearch-deletion-audit.md`, "a detector that stops matching is not a
 * deletion").
 */
export function entityShapedDeclarations(ctx: AuditContext): EntityShapedDecl[] {
  assertVocabularyLoaded(SESSION_VOCABULARY, ISSUE_VOCABULARY)

  const out: EntityShapedDecl[] = []
  for (const f of ctx.files) {
    if (f.isTest) continue
    // Past migrations are immutable history and generated files are rebuilt from
    // them; neither may be edited to satisfy a vocabulary audit.
    if (f.file.includes('/migrations/') || f.file.endsWith('.generated.ts')) continue
    // Wire fixtures are captured PAYLOADS, not declarations of a shape.
    if (f.file.endsWith('.fixtures.ts')) continue
    // `packages/model/src/fields/` IS the shared vocabulary: a field group has no
    // entity identity of its own and is composed BY representations (inventory
    // §2.2 / §3). Counting the definition as a restatement of itself is circular.
    if (f.file.startsWith('packages/model/src/fields/')) continue

    const lines = f.stripped.split('\n')
    for (let n = 0; n < lines.length; n++) {
      const line = lines[n] as string
      const m = DECL.exec(line)
      if (!m) continue
      // A class's members are behaviour, and its field list is typed from the
      // interfaces beside it — which this detector already sees.
      if (m[1] === 'class') continue
      // `const X = [...] as const` is a list of key NAMES. The quoted literals it
      // holds are the very vocabulary this detector matches on, so counting it
      // would make the audit's own key lists into audit findings.
      if (/=\s*\[/.test(line)) continue

      const text = declarationText(lines, n)
      // A declaration must have either an object body or a TYPE OPERATOR
      // (`Pick<…>`, `Omit<…>`, a mapped type) to be a shape at all. Without this
      // a string-literal union — `type SessionVolatileField = 'geometry' |
      // 'status' | 'machineId'` — reads as a three-key session shape, because its
      // quoted members are field NAMES rather than fields. The operator form is
      // admitted deliberately: a `Pick` restates no TYPES, so it is never counted
      // as a restatement, but it does NAME its members, and a projection that
      // picks `readAt` still ships one person's read state.
      if (!text.includes('{') && !/[A-Za-z]</.test(text)) continue
      if (FUNCTION_MEMBER.test(text)) continue

      const { properties, named } = declaredKeys(text)
      const restated = properties.filter((k) => !GENERIC_KEYS.has(k))
      const sessionKeys = restated.filter((k) => SESSION_VOCABULARY.has(k))
      const issueKeys = restated.filter((k) => ISSUE_VOCABULARY.has(k))
      // Admitted to the population if EITHER measure clears the threshold: the
      // restated set drives the restatement counts, the named set drives the
      // forbidden-key classes, and a composed projection clears only the second.
      const namedVocab = named
        .filter((k) => !GENERIC_KEYS.has(k))
        .filter((k) => SESSION_VOCABULARY.has(k) || ISSUE_VOCABULARY.has(k))
      if (
        sessionKeys.length < ENTITY_SHAPE_THRESHOLD &&
        issueKeys.length < ENTITY_SHAPE_THRESHOLD &&
        namedVocab.length < ENTITY_SHAPE_THRESHOLD
      ) {
        continue
      }
      out.push({
        file: f.file,
        line: n + 1,
        symbol: m[2] as string,
        sessionKeys,
        issueKeys,
        keys: named,
      })
    }
  }
  return out
}

/** Anything that ends a declaration's text: the next top-level declaration, or a
 *  function — whose inline parameter object would otherwise be read as the
 *  PRECEDING declaration's members. That was a real defect in this detector's
 *  first revision: `type ExitedAction = 'restart' | 'resume' | 'remove'` opens no
 *  brace, so the window ran on and attributed the six-key `opts` parameter of the
 *  `exitedRecovery` function below it to the alias, reporting a string union as a
 *  four-key session restatement. */
const DECL_BREAK = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^(?:export\s+)?enum\b/

/** The declaration's own text: to the close of its first brace group, or — if it
 *  opens none — no further than the statement it sits on. Bounded, so a file
 *  whose braces do not balance cannot swallow the rest of the module. */
function declarationText(lines: readonly string[], start: number): string {
  const body: string[] = []
  let depth = 0
  let opened = false
  for (let k = start; k < Math.min(lines.length, start + 220); k++) {
    const line = lines[k] as string
    if (k > start && !opened && (DECL.test(line) || DECL_BREAK.test(line))) break
    body.push(line)
    for (const ch of line) {
      if (ch === '{') {
        depth++
        opened = true
      } else if (ch === '}') depth--
    }
    if (opened && depth <= 0) break
    // A statement that opened no brace and is not obviously continuing ends
    // here. Without this, every brace-less alias absorbs its neighbours.
    if (!opened && !/[=&|,<([+]\s*$/.test(line)) break
  }
  return body.join('\n')
}

/**
 * Key names the declaration writes out by hand.
 *
 * Two forms, because both are hand-restatement: a property (`worktreePath?:
 * string`) and a quoted key inside a type operator (`Pick<X, 'a' | 'b'>`). The
 * second is included on purpose — a `Pick` still NAMES its members, so it is
 * visible to the forbidden-key-class checks below even though it is not a
 * restatement of their types.
 *
 * The property pattern is anchored on the SEPARATOR (`{`, `;`, `,` or a
 * newline), not on the start of a line. Anchoring on the line breaks the moment
 * biome reflows a short interface onto one line — `interface X { a: string; b:
 * string }` — and the count then silently DROPS, which is this audit's own worst
 * failure mode (`docs/rearch-deletion-audit.md`: "not on formatting"). Caught by
 * the reformatting case in the test file rather than reasoned about.
 */
function declaredKeys(text: string): { properties: string[]; named: string[] } {
  const properties = new Set<string>()
  for (const m of text.matchAll(/[{;,\n]\s*(?:readonly\s+)?(\w+)\??\s*[:(]/g)) {
    properties.add(m[1] as string)
  }
  const named = new Set(properties)
  for (const m of text.matchAll(/'(\w+)'/g)) named.add(m[1] as string)
  return { properties: [...properties], named: [...named] }
}

// ---------------------------------------------------------------------------
// Not a representation — the declared exclusions, each with its reason
// ---------------------------------------------------------------------------

/**
 * Declarations the detector finds that are NOT session or issue representations.
 *
 * Keyed on the exact `(file, symbol)` PAIR, never on a path prefix: a
 * path-scoped exclusion is as blind as a path-scoped detector, and this repo has
 * already shipped that bug twice (a `git mv` read as a deletion; a boundary rule
 * that scanned 4 names instead of 48). A new shape in an excluded file is
 * counted.
 *
 * Every reason cites the rule that excludes it, so the list can be audited
 * against `docs/rearch-field-schema-inventory.md` rather than trusted.
 */
export const NOT_A_REPRESENTATION: readonly {
  readonly file: string
  readonly symbol: string
  readonly reason: string
}[] = [
  // --- L1 transport frames (inventory §2.3): a frame is a transport envelope,
  // not a representation of an entity. ADR 4 D4 keeps them in packages/protocol.
  ...(
    [
      ['packages/protocol/src/messages/terminal.ts', 'SpawnMessage'],
      ['packages/protocol/src/messages/terminal.ts', 'ReattachMessage'],
      ['packages/protocol/src/messages/terminal.ts', 'BindMessage'],
      ['packages/protocol/src/messages/terminal.ts', 'AttachedMessage'],
      ['packages/protocol/src/messages/terminal.ts', 'ControllerChangedMessage'],
      ['packages/protocol/src/messages/transcript.ts', 'TranscriptReadRequestMessage'],
      ['packages/protocol/src/messages/handoff.ts', 'HandoffExportRequestMessage'],
      ['packages/protocol/src/messages/headless.ts', 'HeadlessBindMessage'],
    ] as const
  ).map(([file, symbol]) => ({
    file,
    symbol,
    reason:
      'L1 transport frame (inventory §2.3, ADR 4 D4). Its entity-shaped subset owes §6.4 rule ' +
      '1 — a Pick from model plus transport keys only — which is POD-308 wire work, not a ' +
      'representation of an entity.',
  })),

  // --- The two composition BASES the provenance split created (POD-304).
  {
    file: 'packages/model/src/entities/session.ts',
    symbol: 'SessionMetaEntity',
    reason:
      'the provenance-free half that `SessionMeta` composes with the flat provenance group so ' +
      'the wire did not move (POD-304 as-built). It is a composition base, not a second wire ' +
      'shape; the representation is `SessionMeta`, which IS registered.',
  },
  {
    file: 'packages/model/src/entities/handoff.ts',
    symbol: 'HANDOFF_BUNDLE_CORE',
    reason:
      'the shape BOTH format arms of `HandoffManifest` spread (POD-1153), so the manifest can be ' +
      'versioned as a file without v2 drifting from v1 on a shared member. Same class as ' +
      '`SessionMetaEntity` and `IssueWireCore`: a composition base, not a second representation — ' +
      'the representation is `HandoffManifest`, which IS registered, and it is the union over the ' +
      'two arms. Nothing here is hand-RESTATED: every member is the shared field instance reached ' +
      "through POD-365's groups, which `entities/handoff.test.ts` asserts by reference identity " +
      'for both arms. That is the distinction this detector structurally cannot draw — it reads ' +
      'key NAMES in a declaration and cannot see whether the values beside them are the shared ' +
      'schemas or fresh restatements (reported to POD-368, which owns the detector).',
  },
  {
    file: 'packages/model/src/entities/issue.ts',
    symbol: 'IssueWireCore',
    reason:
      'the provenance-free half that `IssueWire` composes, and the head every composed issue ' +
      'projection picks from. Same class as `SessionMetaEntity`; the representation is ' +
      '`IssueWire`, which IS registered.',
  },

  // --- Adjacent entities and their rows: OTHER aggregates that happen to carry a
  // session or issue foreign key. Inventory §12 scopes them out by name, to
  // POD-304's matrix rows and later phases.
  ...(
    [
      ['apps/server/src/store/approvals.ts', 'ApprovalRow'],
      ['packages/protocol/src/messages/approvals.ts', 'ApprovalWire'],
      ['apps/server/src/store/types.ts', 'IssueMessageRow'],
      ['packages/client-core/src/viewmodels/types.ts', 'WorktreeView'],
      ['packages/client-core/src/viewmodels/dock-panel.ts', 'ActiveWorktree'],
      ['packages/model/src/entities/machine.ts', 'GitRepositoryWire'],
      ['packages/client-core/src/spawn-agent.ts', 'SpawnTarget'],
      ['apps/server/src/store/types.ts', 'TerminalCandidateFacts'],
      ['packages/terminal-client/src/connection.ts', 'ConnectionState'],
    ] as const
  ).map(([file, symbol]) => ({
    file,
    symbol,
    reason:
      'a representation of an ADJACENT entity (approvals, tracker mail, worktrees, repos, ' +
      'machines, session binding, live connection) that carries a session or issue foreign key. ' +
      'Inventory §12 scopes these out of 1.4 by name — they are POD-304 matrix rows and later ' +
      "phases' work, and their own vocabularies are not session/issue vocabulary.",
  })),

  {
    file: 'apps/server/src/modules/bus.ts',
    symbol: 'EventMap',
    reason:
      'the in-process EVENT PAYLOAD map: one declared payload per event name, deliberately not ' +
      'stringly-typed. Its entity-carrying events pass whole representations by reference ' +
      '(`{ sessions: SessionMeta[] }`, `{ issue: IssueWire }`) and its own members are event ' +
      'facts (`prev`/`next`/`code`), so it is the same class as an L1 frame. Its ATTRIBUTION ' +
      'obligations are tracked separately — inventory §9 enumerates the event-payload principal ' +
      'keys that a column-shaped search could not see.',
  },

  // --- Query, filter and external-payload shapes: they NAME entity fields
  // without representing an entity.
  {
    file: 'packages/model/src/entities/issue.ts',
    symbol: 'IssueSearchFilter',
    reason:
      'a QUERY, not a projection: its members are the fields to filter ON, and `open`/`deferred` ' +
      'are predicates rather than issue facts. A filter that composed the entity would have to ' +
      'accept every field as a criterion.',
  },
  {
    file: 'packages/model/src/predicates/issue-stage.ts',
    symbol: 'ClosedPatchFields',
    reason:
      'the patch fragment the closed/stage machine writes — a command-input FRAGMENT of ' +
      '`IssuePatch` (which is registered), used to keep the machine honest about which three ' +
      'fields a close may touch.',
  },
  {
    file: 'apps/server/src/issueAssistant.ts',
    symbol: 'AssistantResult',
    reason:
      "an EXTERNAL model's output, mapped into an `IssuePatch` at one site. Same treatment as " +
      '`LinearIssue` and `CloudAgentSourceSession`: a foreign shape must not become ours.',
  },

  // --- L1 COMMAND CONTRACT inputs (POD-728). Same class as a tRPC procedure
  // input, and this pair MOVED rather than appeared: `spawnAgentInput` was
  // excluded at `apps/server/src/modules/messages/gate.ts` until the L1/L3 split
  // relocated the schema to its contract. The exclusion is keyed on the
  // (file, symbol) PAIR on purpose, so a move shows up as one item GREW and has
  // to be re-declared here — which is the detector working, not a false
  // positive, and is why the baseline was not touched.
  {
    file: 'packages/commands/src/mail/contracts.ts',
    symbol: 'spawnAgentInput',
    reason:
      'a command CONTRACT input (ADR 3 D1): it declares the ARGUMENTS OF A CALL, not a ' +
      'representation of a session. Its three session-shaped keys (workflowRunId, workflowStepId, ' +
      'executionProfileId) are spawn parameters the caller supplies, and its entity-shaped subset ' +
      'owes inventory §6.4 rule 1 — a Pick from model plus transport keys — which is POD-308 wire ' +
      'work. Same class as the tRPC procedure inputs below, and it carried that exclusion at its ' +
      'previous site in apps/server/src/modules/messages/gate.ts.',
  },

  // --- tRPC procedure inputs and the client API surface: the transport edge.
  ...(
    [
      ['apps/server/src/router.ts', 'appRouter'],
      ['apps/server/src/router.ts', 'cloudSourceSessionInput'],
      // POD-381 moved sessions.create / sessions.resume's procedure inputs OUT of
      // `appRouter` and onto their command contracts, which the router then uses
      // as its `.input()` — the same declarations, in the same role, at a new
      // address. They are excluded for the reason `appRouter` already was, not
      // for a new one; excluding them by their old container only would have made
      // the audit's answer depend on which file the transport edge happens to
      // live in.
      ['packages/protocol/src/session-command-plane.ts', 'createInput'],
      ['packages/protocol/src/session-command-plane.ts', 'resumeInput'],
      ['apps/server/src/modules/workflows/service.ts', 'workflowInputs'],
      ['packages/client-core/src/api.ts', 'PodiumClientApi'],
      ['apps/mobile/src/client/trpc.ts', 'MobileTrpcExtras'],
    ] as const
  ).map(([file, symbol]) => ({
    file,
    symbol,
    reason:
      'a tRPC procedure input or client API surface — the transport edge, same class as an L1 ' +
      'frame (inventory §2.3). It declares the arguments of a CALL, and its entity-shaped ' +
      'subsets owe §6.4 rule 1 rather than a registry entry.',
  })),

  // --- Characterization and demo fixtures. Inventory §3 excludes 5 test
  // fixtures by rule; these two live in files `isTestFile` does not match.
  ...(
    [
      ['apps/server/src/modules/messages/characterization-support.ts', 'SessionFixture'],
      ['apps/mobile/src/client/demoData.ts', 'DEMO_SESSIONS'],
    ] as const
  ).map(([file, symbol]) => ({
    file,
    symbol,
    reason:
      'a test/demo fixture that legitimately constructs a double of the shape it exercises ' +
      '(inventory §3, and the audit\'s own "tests are excluded" counting rule). It lives in a ' +
      'file `isTestFile` does not match, so it is excluded by name instead of by path.',
  })),
]

const excluded = new Set(NOT_A_REPRESENTATION.map((e) => `${e.file}::${e.symbol}`))
const registeredSymbols = new Set(RETAINED_REPRESENTATIONS.map((r) => r.symbol))

// ---------------------------------------------------------------------------
// The three checks
// ---------------------------------------------------------------------------

/**
 * ITEM: a hand-restated session/issue field list that `packages/model`'s registry
 * does not account for.
 *
 * Zero means every restatement is either composed away, registered with its
 * justification, or excluded with a reason that cites the inventory rule. It does
 * NOT mean the registry is complete — see the module header.
 */
export function unregisteredRestatements(
  ctx: AuditContext,
  entity: 'session' | 'issue',
): AuditSite[] {
  const sites: AuditSite[] = []
  for (const d of entityShapedDeclarations(ctx)) {
    if (excluded.has(`${d.file}::${d.symbol}`)) continue
    if (registeredSymbols.has(d.symbol)) continue
    const mine =
      entity === 'session'
        ? d.sessionKeys.length >= ENTITY_SHAPE_THRESHOLD &&
          d.sessionKeys.length >= d.issueKeys.length
        : d.issueKeys.length >= ENTITY_SHAPE_THRESHOLD && d.issueKeys.length > d.sessionKeys.length
    if (!mine) continue
    const keys = entity === 'session' ? d.sessionKeys : d.issueKeys
    sites.push({
      file: d.file,
      line: d.line,
      text: `${d.symbol} hand-declares ${keys.length} ${entity} keys: ${keys.slice(0, 6).join(', ')}`,
    })
  }
  return sites
}

/**
 * ITEM: a registry entry whose declaration is gone.
 *
 * The other direction of the loop. Without it the registry can rot into a list of
 * retired names while every other check reports green — the same shape as a
 * detector that stops matching.
 */
export function danglingRegistryEntries(
  repoRoot: string,
  representations: readonly {
    readonly symbol: string
    readonly site: string
  }[] = RETAINED_REPRESENTATIONS,
): AuditSite[] {
  const sites: AuditSite[] = []
  for (const rep of representations) {
    const abs = join(repoRoot, rep.site)
    if (!existsSync(abs)) {
      sites.push({
        file: rep.site,
        line: 1,
        text: `${rep.symbol}: registered site does not exist`,
      })
      continue
    }
    const src = readFileSync(abs, 'utf8').replace(/\0/g, '')
    // The symbol must still be DECLARED there. A mention in a comment is not a
    // declaration, which is why this anchors on the declaration keyword — and why
    // NUL bytes are stripped first, since `grep` answers "no match" on a file
    // containing one and this check must not inherit that lie.
    const declared = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?` +
        `(?:interface|type|class|const)\\s+${rep.symbol}\\b`,
    )
    if (!declared.test(src)) {
      sites.push({
        file: rep.site,
        line: 1,
        text: `${rep.symbol}: registered but no longer declared at this site`,
      })
    }
  }
  return sites
}

/**
 * ITEM: a per-user-state member surviving as a SINGLETON field on a session or
 * issue representation (ADR 4 Amendment 1 D10, inventory §7.1).
 *
 * A ratchet, not a regression guard: five ride the wire today. They are
 * inherited — 1.4 added none and blessed none — and POD-1076 owns re-keying them
 * to `(userId, entityId)`. Each one left behind is later a table migration PLUS a
 * wire change PLUS a replica migration.
 */
export function perUserSingletons(ctx: AuditContext): AuditSite[] {
  const sites: AuditSite[] = []
  for (const d of entityShapedDeclarations(ctx)) {
    if (excluded.has(`${d.file}::${d.symbol}`)) continue
    for (const key of PER_USER_STATE_KEYS) {
      if (d.keys.includes(key)) {
        sites.push({
          file: d.file,
          line: d.line,
          text: `${d.symbol}.${key}`,
        })
      }
    }
  }
  return sites
}

/**
 * ITEM: a serialized effective-capability snapshot on a session or issue
 * representation (ADR 9 D5 A1).
 *
 * Expected zero, kept as a REGRESSION GUARD — the whole point is that it will
 * look like a harmless denormalization to whoever adds it. `owner`, `actor` and
 * `onBehalfOf` are deliberately absent from the pattern: attribution is a durable
 * fact that must survive export, and forbidding it would forbid what ADR 1's
 * matrix requires.
 */
const SERIALIZED_AUTHORITY_KEY =
  /^(?:.*capabilit|.*effectiveright|rights?|.*permission|.*privileg|.*entitlement|grants?|scopes?|roles?|acl)/i

export function capabilitySnapshots(ctx: AuditContext): AuditSite[] {
  const sites: AuditSite[] = []
  for (const d of entityShapedDeclarations(ctx)) {
    if (excluded.has(`${d.file}::${d.symbol}`)) continue
    for (const key of d.keys) {
      if (SERIALIZED_AUTHORITY_KEY.test(key)) {
        sites.push({ file: d.file, line: d.line, text: `${d.symbol}.${key}` })
      }
    }
  }
  return sites
}

/**
 * ITEM: an instance or tenant partition on a session or issue representation.
 *
 * ADR 1 D5 stands and Amendment 2 fences it: multi-user lives INSIDE one instance
 * and the dimension it adds is OWNER, not tenant. Expected zero, kept as a
 * regression guard, because "multi-user" and "multi-tenant" are the two words
 * this programme most needs kept apart.
 */
const INSTANCE_PARTITION_KEY = /^(instance_?id|tenant_?id)$/i

/**
 * A drizzle table declaration: `export const sessions = sqliteTable("sessions", {`.
 *
 * The dialect prefix is left open (`sqlite`/`pg`/`mysql`) because the concept —
 * a physical table declared as code — is what this reads, not today's engine.
 */
const PHYSICAL_TABLE =
  /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:\w+\.)?(?:sqlite|pg|mysql)Table\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/

/**
 * One column inside such a table body: `machineId: text("machine_id").notNull()`.
 *
 * The SQL name argument is OPTIONAL — `id: text()` names its column after the
 * key — so both the key and the quoted name have to be read, and either one may
 * be the spelling that carries the partition.
 */
const PHYSICAL_COLUMN = /^\s*(\w+)\s*:\s*(?:\w+\.)?\w+\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)?/

/**
 * The body of the columns object as `(segment, offset)` pairs — one per
 * top-level member, split on commas at depth 1 so a nested call or object
 * cannot end a column early. Quoted spans are walked as text: a brace or paren
 * inside a string literal must not move the depth.
 *
 * Returns `null` if the object never closes, which is a truncated file rather
 * than a clean tree.
 */
function objectMembers(src: string, open: number): { text: string; at: number }[] | null {
  const members: { text: string; at: number }[] = []
  let depth = 0
  let start = open + 1
  let quote: string | null = null
  for (let i = open; i < src.length; i++) {
    const ch = src[i] as string
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth === 0) {
        members.push({ text: src.slice(start, i), at: start })
        return members
      }
    } else if (ch === ',' && depth === 1) {
      members.push({ text: src.slice(start, i), at: start })
      start = i + 1
    }
  }
  return null
}

export interface PhysicalColumn {
  readonly file: string
  readonly line: number
  /** The SQL table name as declared in the call's first argument. */
  readonly table: string
  /** The TypeScript property key. */
  readonly key: string
  /** The SQL column name — the quoted argument, or the key when it is omitted. */
  readonly column: string
}

/**
 * Every column of every physical table declared as drizzle schema-as-code.
 *
 * `entityShapedDeclarations` cannot see these: a table is a CALL EXPRESSION with
 * an object literal argument, not a declaration whose own keys are the shape, so
 * its columns are never enumerated as keys. That is one concept — "a partition
 * column" — written in a second syntax, and a detector that covers only the
 * first is indistinguishable from a clean tree (POD-1162 P4 planted
 * `instance_id` on `sessions` and every gate stayed green).
 *
 * Brace depth is tracked from the table call so the columns object is
 * distinguished from a trailing `(t) => [...]` constraint callback.
 */
export function physicalTableColumns(ctx: AuditContext): PhysicalColumn[] {
  const out: PhysicalColumn[] = []
  const table = new RegExp(PHYSICAL_TABLE.source, 'gm')
  for (const f of ctx.files) {
    if (f.isTest) continue
    // The timestamped SQL under `migrations/drizzle/` is immutable history and
    // generated files are rebuilt from it; neither is where a column is authored.
    if (f.file.includes('/migrations/drizzle/') || f.file.endsWith('.generated.ts')) continue

    const src = f.stripped
    table.lastIndex = 0
    for (let m = table.exec(src); m; m = table.exec(src)) {
      const name = (m[2] ?? m[3] ?? m[4]) as string
      const open = src.indexOf('{', m.index + m[0].length)
      if (open === -1) continue
      const members = objectMembers(src, open)
      if (!members) continue
      for (const member of members) {
        const col = PHYSICAL_COLUMN.exec(member.text)
        if (!col) continue
        const key = col[1] as string
        const offset = member.at + (col.index + col[0].indexOf(key))
        out.push({
          file: f.file,
          line: src.slice(0, offset).split('\n').length,
          table: name,
          key,
          column: col[2] ?? col[3] ?? col[4] ?? key,
        })
      }
    }
  }
  return out
}

export function instancePartitions(ctx: AuditContext): AuditSite[] {
  const sites: AuditSite[] = []
  for (const d of entityShapedDeclarations(ctx)) {
    if (excluded.has(`${d.file}::${d.symbol}`)) continue
    for (const key of d.keys) {
      if (INSTANCE_PARTITION_KEY.test(key)) {
        sites.push({ file: d.file, line: d.line, text: `${d.symbol}.${key}` })
      }
    }
  }
  // The same concept, written as a column on a physical table. Both spellings
  // are read — a snake_case column under a camelCase key, or the reverse — and
  // the SAME pattern decides, so there is one rule here and not two.
  for (const c of physicalTableColumns(ctx)) {
    if (INSTANCE_PARTITION_KEY.test(c.key) || INSTANCE_PARTITION_KEY.test(c.column)) {
      sites.push({ file: c.file, line: c.line, text: `${c.table}.${c.column} (column)` })
    }
  }
  return sites
}
