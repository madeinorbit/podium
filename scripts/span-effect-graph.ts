/**
 * The span-effect call graph (POD-3332, epic POD-3221).
 *
 * WHAT THIS ANSWERS. Spec §6 rule 19 draws a line through a transaction body:
 * *if the transaction rolled back, would anything outside this process be wrong
 * for having seen this?* A `log.warn` recording a quarantined column: no, and it
 * stays. An event, a mail nudge, a cache mirror, a git round trip: yes, and it
 * moves to one of §3.3's post-commit mechanisms. POD-3260 classified every span
 * by hand and said plainly in its ledger §F that two spans
 * (`IssueAttachOrchestrator.execute`, `MaintenanceService.write`) have a fan-out
 * too deep to certify that way. This module is the tool that can.
 *
 * WHY A TYPE CHECKER AND NOT A SCAN. The execution method records POD-3257's
 * proof that a name-matching scan cannot carry a rule of this shape: it loses a
 * site the moment the call goes through a local `const` or a closure, and it
 * floods on `Map.get`. So every callee here is resolved with
 * `checker.getResolvedSignature(...).declaration` — the declaration, not the
 * text. A call through a local const resolves to the arrow it was assigned;
 * `Map.get` resolves into `lib.es*.d.ts` and is dropped by origin rather than by
 * a name list.
 *
 * THE SHAPE. Three passes, and the middle one is what makes it affordable:
 *
 *  1. **Index.** Every function-like node in the scanned files becomes a node
 *     carrying its call edges and its DIRECT capability hits. Nested functions
 *     are folded into their enclosing node (conservative: a callback that only
 *     runs later is still charged to the body that created it) with ONE
 *     exception — the argument subtree of `afterCommit`/`postCommit` and the
 *     registry's own `effect`/`followUp`/`commitApplication` is NOT walked,
 *     because that is precisely the code that has already been moved out.
 *  2. **Propagate.** Capability sets flow along the reversed call edges to a
 *     fixpoint, so a cycle converges instead of recursing and one union is
 *     shared by every root that reaches it. Each capability keeps the edge it
 *     arrived on, so a finding can print the call path that reaches it.
 *  3. **Roots.** Every call whose resolved callee is one of the declared span
 *     openers contributes its body callback as a root; a root reporting an
 *     observable capability is a finding.
 *
 * WHAT IT DELIBERATELY CANNOT SEE, stated here rather than discovered later:
 *
 *  - **A call through an interface or a function-typed property stops at the
 *    declaration.** `this.deps.artifacts.remove(...)` resolves to the port's
 *    member, not to whichever implementation the composition root injected.
 *    Following it would mean choosing an implementation the type does not name.
 *    So a port member is a LEAF, classified by {@link PORT_CAPABILITIES}, and a
 *    port member that is not classified is reported as `unknown` rather than
 *    silently passed. That is the honest boundary, and it is why the residue is
 *    a ledger and not a hidden assumption.
 *  - **Dynamic dispatch.** A callee reached only through `any`, a computed
 *    member, or a value the checker cannot give a signature for, is counted as
 *    `unresolved` and reported in the summary. It is not silently exempt.
 *  - **Reachability, not execution.** An edge is a call the body could make, not
 *    one it does make; a branch that never runs in practice still counts. The
 *    rule is deliberately over-approximate in that direction: a span body that
 *    CAN reach an observable effect is a span body somebody will one day drive
 *    into it.
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/**
 * How a call's callee was classified once resolved — rule 19's question, asked
 * once per callee rather than once per call site.
 */
export type CapabilityKind =
  /**
   * If the transaction rolled back, something outside this process would be
   * wrong for having seen this. Rule 19 moves it to a post-commit mechanism.
   */
  | 'observable'
  /**
   * Nothing outside the process can tell it ran: a database statement, a pure
   * computation, a read, a write that is part of the same unit of work.
   */
  | 'contained'
  /**
   * Not observable under rule 19 (a diagnostic log), or observable but owned by
   * a DIFFERENT issue's model, which this rule must not pre-empt.
   */
  | 'exempt'
  /**
   * A callback-typed port member. The checker resolves the call to the port's
   * signature and there is no body to follow, so what runs is chosen by whoever
   * injected it. Stated rather than assumed: this is the analysis's edge.
   */
  | 'opaque'
  /** A port member nobody has classified yet. Reported, never assumed safe. */
  | 'unknown'

/** One classified capability a body can reach. */
export interface Capability {
  /** Stable identity: `<origin>:<name>`, e.g. `node:child_process.spawn`. */
  readonly key: string
  readonly kind: CapabilityKind
  /** One line a human can act on. */
  readonly what: string
  /** Where the callee is DECLARED — the thing a classification is made about. */
  readonly declaredAt: string
}

/** Where a capability was reached from, for the printed call path. */
export interface CapabilityArrival {
  readonly capability: Capability
  /** The node the edge left from, or undefined when the hit is direct. */
  readonly through: string | undefined
  readonly at: SourceSite
}

export interface SourceSite {
  /** Repo-relative, POSIX separators. */
  readonly file: string
  readonly line: number
}

/** A function-like node in the scanned source. */
interface GraphNode {
  readonly id: string
  readonly name: string
  readonly site: SourceSite
  readonly callees: Set<string>
  /** Capability key -> arrival. Mutated to a fixpoint by {@link propagate}. */
  readonly reached: Map<string, CapabilityArrival>
  /** Calls the checker could not resolve at all. */
  unresolved: number
}

/** A span body found at a call site of a declared opener. */
export interface SpanRoot {
  readonly id: string
  /**
   * Set on an opaque root whose body came in as a PARAMETER of the enclosing
   * function — `transact: (fn) => this.store.transact(fn)`, or
   * `write: () => this.store.transact(operation)`.
   *
   * It is a fact, not an all-clear. Where the caller writes the function down
   * (relay.ts's four port adapters) the body IS analysed, at that call site.
   * Where the caller passes a value chosen at runtime —
   * `MaintenanceService.write`, whose job is whichever one the command named —
   * the fan-out is genuinely not followed, and the gate doc says so.
   */
  readonly forwarded?: boolean
  /** The opener that created it, e.g. `SessionStore.transact`. */
  readonly opener: string
  /** The enclosing named function, for a human-readable span name. */
  readonly enclosing: string
  readonly site: SourceSite
}

export interface SpanFinding {
  readonly root: SpanRoot
  readonly capability: Capability
  /** Call path from the span body to the capability, innermost last. */
  readonly path: readonly SourceSite[]
}

/** One span body and everything it can reach. */
export interface RootReport {
  readonly root: SpanRoot
  readonly capabilities: readonly SpanFinding[]
  /** Calls under this body the checker could give no signature for. */
  readonly unresolved: number
}

export interface AnalysisResult {
  readonly roots: readonly SpanRoot[]
  /** One entry per root, carrying every capability kind it reaches. */
  readonly reports: readonly RootReport[]
  readonly findings: readonly SpanFinding[]
  /** Every `unknown` capability a root reaches, with the roots that reach it. */
  readonly unclassified: ReadonlyMap<string, readonly SpanRoot[]>
  /** Openers the table declares that resolved to nothing in this program. */
  readonly deadOpeners: readonly string[]
  /** `transact`/`transaction`-named declarations neither table names. */
  readonly uncoveredOpeners: readonly SourceSite[]
  /**
   * Span openers whose body argument is a VALUE, not a written-down function —
   * `store.transact(operation)` where `operation` is a parameter. The span
   * exists and the rule cannot see inside it.
   */
  readonly opaqueRoots: readonly SpanRoot[]
  readonly unresolvedCalls: number
  /**
   * Calls REACHABLE FROM A SPAN BODY that the checker could give no signature
   * for, by file, worst first. This is where the rule is blind INSIDE its own
   * scope, so it is the number that bounds the gate — an `any`-typed port
   * defeats a type-checker rule exactly as a name-matching scan is defeated by a
   * closure.
   */
  readonly blindSpots: readonly { readonly file: string; readonly calls: number }[]
}

/* ------------------------------------------------------------------ openers */

/**
 * Where a span opener takes its body.
 *
 * `arg0`/`arg1` is a positional callback; `prop:write` is a property of an
 * options object literal — the shape `ledger.commit`, `authority.commit` and
 * `funnel.run` use, where the body is one field of the op.
 */
type BodyPosition = 'arg0' | 'arg1' | { readonly props: readonly string[] }

export interface OpenerSpec {
  /** Repo-relative path of the file the callee is DECLARED in. */
  readonly file: string
  /** The declaration's own name, or the name of the property it types. */
  readonly symbol: string
  readonly body: BodyPosition
  /** What to call this opener in a finding. */
  readonly label: string
}

/**
 * The four kinds POD-3260's ledger enumerates, by DECLARATION SITE.
 *
 * A declaration site rather than a name because two unrelated `transact`s must
 * not collapse into one rule, and because a rename should make this table fail
 * loudly — {@link AnalysisResult.deadOpeners} reports an entry that matched
 * nothing, and {@link AnalysisResult.uncoveredOpeners} reports a `transact` the
 * table does not name. Neither can go quiet on its own.
 */
export const SPAN_OPENERS: readonly OpenerSpec[] = [
  {
    file: 'apps/server/src/store.ts',
    symbol: 'transact',
    body: 'arg0',
    label: 'SessionStore.transact',
  },
  {
    file: 'apps/server/src/store/executor/synchronous-span.ts',
    symbol: 'runSynchronousSpan',
    body: 'arg0',
    label: 'runSynchronousSpan',
  },
  {
    file: 'packages/runtime/src/sqlite/transaction.ts',
    symbol: 'transaction',
    body: 'arg1',
    label: 'transaction(db, fn)',
  },
  {
    file: 'apps/server/src/modules/lock/service.ts',
    symbol: 'transact',
    body: 'arg0',
    label: 'LockDeps.transact',
  },
  {
    file: 'apps/server/src/application/issue-attach-orchestrator.ts',
    symbol: 'transact',
    body: 'arg0',
    label: 'IssueAttachPorts.transact',
  },
  {
    file: 'apps/server/src/modules/messages/service.ts',
    symbol: 'transact',
    body: 'arg0',
    label: 'MessagesDeps.transact',
  },
  {
    // The sync adapter's port over the store's transaction [POD-3338 for the
    // port, POD-3416 for what it carries]. It IS an opener: the server fills it
    // with the nesting-safe runtime helper over the executor's connection, so a
    // body handed to it runs inside a unit of work — or inside a savepoint when
    // a caller already opened one. Declared here rather than in
    // NOT_A_SPAN_OPENER because a package cannot name the server's binding, so
    // this declaration is the only place the call site can be recognised from.
    file: 'packages/sync/src/adapters/sqlite/store-queries.ts',
    symbol: 'transact',
    body: 'arg0',
    label: 'SyncQueries.transact',
  },
  {
    // The SERVER's own SyncQueries.transact — the structural twin of the entry
    // above, and unnamed until now. POD-3416 found it while declaring its port:
    // it is the same shape, on the same connection, and the only reason the sync
    // one was declared first is that a package cannot name the server's binding.
    // Mine had no such excuse.
    file: 'apps/server/src/store/executor/sync-drizzle.ts',
    symbol: 'transact',
    body: 'arg0',
    label: 'SyncQueries.transact (server)',
  },
  {
    file: 'packages/sync/src/authority/ports.ts',
    symbol: 'TransactPort',
    body: 'arg0',
    label: 'Authority transact port',
  },
  {
    file: 'packages/sync/src/ledger.ts',
    symbol: 'commit',
    body: { props: ['write', 'changes'] },
    label: 'Ledger.commit',
  },
  {
    file: 'packages/sync/src/authority/authority.ts',
    symbol: 'commit',
    body: { props: ['write', 'changes'] },
    label: 'Authority.commit',
  },
  {
    // The issues service's own narrow face on the same Ledger. Without it a
    // nested commit's write body is attributed to the outer span only, and the
    // ledger's finding 3 — a nested commit publishing inside an outer
    // transaction — has no root of its own to report against.
    file: 'apps/server/src/modules/issues/service/types.ts',
    symbol: 'commit',
    body: { props: ['write', 'changes'] },
    label: 'IssueLedger.commit',
  },
  {
    file: 'apps/server/src/modules/funnel.ts',
    symbol: 'run',
    body: { props: ['write'] },
    label: 'WriteFunnel.run',
  },
  {
    file: 'packages/sync/src/span.ts',
    symbol: 'transact',
    body: 'arg0',
    label: 'SyncUnitOfWork.transact',
  },
]

/**
 * `transact`/`transaction` declarations that are deliberately NOT span openers.
 *
 * The completeness check on {@link SPAN_OPENERS} reports every declaration with
 * one of those names that the opener table does not carry, so that a new one
 * cannot appear unnoticed. These are the answers already given. Each is pinned
 * by LINE, so moving one is a reported change rather than a silent one.
 */
const NOT_A_SPAN_OPENER: readonly (SourceSite & { readonly why: string })[] = [
  {
    file: 'apps/server/src/store/executor/executor.ts',
    line: 70,
    why: "the ASYNC executor's own transact. It opens Stage B's spans, not today's; at the flip it replaces SessionStore.transact and this table entry goes with the bridge (POD-3327).",
  },
  {
    file: 'apps/server/src/store/executor/executor.ts',
    line: 680,
    why: "the same declaration's implementation. (Was 676; POD-3345's idle-gap clock moved it, and the lint REPORTED the move rather than following it silently, which is what pinning by line is for.)",
  },
  {
    file: 'packages/sync/src/authority/authority.ts',
    line: 131,
    why: 'the property that HOLDS the transact port; the port itself is named by its own entry in packages/sync/src/authority/ports.ts.',
  },
  {
    file: 'packages/sync/src/ledger.ts',
    line: 115,
    why: 'the Ledger deps property; it is handed straight to the Authority, so every call goes through the port entry above.',
  },
  {
    file: 'packages/sync/src/adapters/indexeddb/idb.ts',
    line: 39,
    why: "IndexedDB's own transaction helper: a browser adapter, no server span.",
  },
  {
    file: 'packages/sync/src/adapters/indexeddb/idb.ts',
    line: 62,
    why: "IndexedDB's own transaction helper: a browser adapter, no server span.",
  },
]

/**
 * Calls whose FUNCTION ARGUMENTS are not part of the span body.
 *
 * This is the one structural exemption, and it is the whole point of the
 * mechanisms: work registered here runs after the outermost commit, so it is
 * outside the transaction by construction. Everything else nested in a body is
 * folded into it.
 */
const POST_COMMIT_REGISTRARS: readonly { readonly file: string; readonly symbol: string }[] = [
  { file: 'apps/server/src/store/executor/synchronous-span.ts', symbol: 'afterCommit' },
  { file: 'apps/server/src/store/executor/post-commit.ts', symbol: 'effect' },
  { file: 'apps/server/src/store/executor/post-commit.ts', symbol: 'followUp' },
  { file: 'apps/server/src/store/executor/post-commit.ts', symbol: 'commitApplication' },
  { file: 'apps/server/src/store/executor/context.ts', symbol: 'postCommit' },
  // The replica's own protocol for the same thing, which POD-3260's ledger
  // names as the shape the server-side rows were copied from.
  { file: 'packages/sync/src/span.ts', symbol: 'onCommit' },
  // POD-3328's baseline fold, registered as a commit application so a batch
  // whose span never committed is never promoted. Same category as the rows
  // above: the callback is code already moved OUT of the transaction, so its
  // argument subtree is deliberately not walked.
  { file: 'packages/sync/src/authority/ports.ts', symbol: 'onCommit' },
  // POD-3328's baseline fold, registered as a commit application so a batch
  // whose span never committed is never promoted. Same category as the rows
  // above: the callback is code already moved OUT of the transaction, so its
  // argument subtree is deliberately not walked.
]

/* ------------------------------------------------------- capability tables */

/**
 * Node builtins, by module, answering rule 19's question rather than "is this
 * IO". `node:path` computes; `node:fs` changes something a second process can
 * see the moment it runs, and a rollback cannot take it back.
 */
const NODE_MODULE_KIND: Readonly<Record<string, CapabilityKind>> = {
  fs: 'observable',
  'fs/promises': 'observable',
  child_process: 'observable',
  net: 'observable',
  http: 'observable',
  https: 'observable',
  http2: 'observable',
  dgram: 'observable',
  dns: 'observable',
  tls: 'observable',
  cluster: 'observable',
  worker_threads: 'observable',
  readline: 'observable',
  repl: 'observable',
  inspector: 'observable',
  // Computation. Nothing outside the process can tell these ran.
  path: 'contained',
  url: 'contained',
  util: 'contained',
  crypto: 'contained',
  buffer: 'contained',
  string_decoder: 'contained',
  querystring: 'contained',
  assert: 'contained',
  os: 'contained',
  zlib: 'contained',
  events: 'contained',
  stream: 'contained',
  'web-globals/timers': 'exempt',
  'web-globals/events': 'contained',
  'web-globals/abort': 'contained',
  // A timer inside a span is POD-3258's ledger, not this rule's: it schedules,
  // it does not publish. Flagging it here would duplicate that issue's answer
  // with a different one.
  timers: 'exempt',
  'timers/promises': 'exempt',
  perf_hooks: 'exempt',
  async_hooks: 'exempt',
}

/** Globals with no module to key on. */
const GLOBAL_CAPABILITIES: Readonly<Record<string, CapabilityKind>> = {
  fetch: 'observable',
  setTimeout: 'exempt',
  setInterval: 'exempt',
  setImmediate: 'exempt',
  clearTimeout: 'exempt',
  clearInterval: 'exempt',
  queueMicrotask: 'exempt',
  // Rule 11 already owns console; it is a diagnostic under rule 19 either way.
  console: 'exempt',
}

/** Workspace packages a call can land in, and what reaching one means. */
const PACKAGE_KIND: Readonly<Record<string, CapabilityKind>> = {
  'drizzle-orm': 'contained',
  'bun:sqlite': 'contained',
  '@libsql/client': 'contained',
  // Schema validation is pure: it decides, it does not publish.
  zod: 'contained',
  // RULE 19'S NAMED EXEMPTION. A diagnostic has no observer inside the system,
  // and deferring it past a rollback would lose the very diagnostic a corrupt
  // row is being reported for. The store's quarantine warnings live here.
  '@podium/logger': 'exempt',
}

/** A port member's classification, and the sentence that justifies it. */
export interface PortRule {
  readonly kind: CapabilityKind
  readonly why: string
}

/**
 * Port members the structural search could not resolve to a body — an external
 * interface, a callback-typed property, an optional hook the composition root
 * injects. This is where rule 19's question is answered by a human, once, per
 * port member, in the open, instead of once per call site in a reviewer's head.
 *
 * A member NOT listed here is `unknown` and appears in the report. That is
 * deliberate and it is the anti-rot property: a port member added tomorrow is
 * unclassified tomorrow, and nobody has to remember to come back.
 *
 * Keyed `<repo-relative file>#<Owner>.<member>`, so two ports that happen to
 * share a member name cannot collapse into one answer.
 */
export const PORT_CAPABILITIES: Readonly<Record<string, PortRule>> = {
  'packages/sync/src/ledger.ts#LedgerCommitOp.changes': {
    kind: 'contained',
    why: "a pure derivation: it maps the write's result to the change specs that describe it. It reads the value the write returned and computes; it performs no database call and no effect of any kind, so a rollback leaves nothing for anything outside the process to have seen.",
  },
  /* --- POD-3366's shared staged layer -------------------------------------- */
  'packages/sync/src/authority/staged-projection.ts#StagedOverlay.commit': {
    kind: 'contained',
    why: "the promotion step of the shared staged layer: it writes ONE already-committed entry into whatever in-memory projection its holder keeps. Constructor-injected, and every holder's implementation is a map write — change-log's baseline, the session repository's durable states, the issue row map. Nothing outside the process can tell it ran, and it runs only from a commit application, i.e. after the outermost commit has already happened.",
  },
  /* --- POD-3328's baseline fold port -------------------------------------- */
  'packages/sync/src/authority/ports.ts#BaselineFoldPort.spanOpen': {
    kind: 'contained',
    why: 'a predicate asking whether an enclosing unit of work is open. It reads the ambient span state and returns a boolean; it writes nothing, and nothing outside the process can tell it was called. Its ANSWER decides whether the fold applies at once or waits for the outermost commit, which is the rule-19 judgement — but asking the question is not itself an effect.',
  },
  'packages/sync/src/authority/ports.ts#CommitRegistration.live': {
    kind: 'contained',
    why: 'a predicate asking whether ONE registered commit application is still going to run, which is `BaselineFoldPort.spanOpen` at frame granularity [POD-3364]. It reads a flag the registry cleared on the rollback path and returns a boolean; it writes nothing, registers nothing, and nothing outside the process can tell it was called. Its ANSWER decides whether a staged entry is dropped on the way in — the same rule-19 judgement `spanOpen` carries, and asking the question is not itself an effect.',
  },
  /* --- the sync adapter's narrow port over the store's query capability
         [POD-3338 for the port, POD-3416 for what it carries] --------------- */
  'packages/sync/src/adapters/sqlite/store-queries.ts#SyncQueries.transact': {
    kind: 'contained',
    why: "the sync adapter's port over the store's transaction. The server's implementation is the nesting-safe runtime helper over the SAME connection the composition root's own spans run on, so this OPENS a unit of work or degrades to a savepoint inside one; it performs no effect of its own and nothing outside the process can tell it ran until the outermost commit. Declared separately from the server's `SyncQueries` only because a package may not import an app.",
  },
  'apps/server/src/store/executor/sync-drizzle.ts#SyncQueries.transact': {
    kind: 'contained',
    why: "the store's own synchronous span, and the twin of the sync adapter's port above. It runs the nesting-safe runtime helper over the executor's connection, so it OPENS a unit of work or degrades to a savepoint inside one; it performs no effect of its own and nothing outside the process can tell it ran until the outermost commit.",
  },
  /* --- the raw SQLite handle, still in place until the flip ---------------- */
  'packages/runtime/src/sqlite/types.ts#SqlStatement.run': {
    kind: 'contained',
    why: 'a SQL statement',
  },
  'packages/runtime/src/sqlite/types.ts#SqlStatement.get': {
    kind: 'contained',
    why: 'a SQL statement',
  },
  'packages/runtime/src/sqlite/types.ts#SqlStatement.all': {
    kind: 'contained',
    why: 'a SQL statement',
  },
  'packages/runtime/src/sqlite/types.ts#SqlStatement.values': {
    kind: 'contained',
    why: 'a SQL statement',
  },
  'packages/runtime/src/sqlite/types.ts#SqlDatabase.prepare': {
    kind: 'contained',
    why: 'a SQL statement',
  },
  'packages/runtime/src/sqlite/types.ts#SqlDatabase.exec': {
    kind: 'contained',
    why: 'a SQL statement',
  },
  'packages/runtime/src/sqlite/types.ts#SqlDatabase.close': {
    kind: 'contained',
    why: 'the connection, not an effect a caller outside the process observes',
  },

  /* --- the executor's own scope ------------------------------------------- */
  'apps/server/src/store/executor/read-scope.ts#ReadScope.slot': {
    kind: 'contained',
    why: 'a read scope slot: a cache of query results inside the frame',
  },
  'apps/server/src/store/executor/read-scope.ts#ReadScopeSlotKey.create': {
    kind: 'contained',
    why: 'a read scope slot key: pure',
  },

  /* --- pure resolvers and predicates a method hands back ------------------ */
  'apps/server/src/store/issues.ts#IssuesRepository.resolveRepoIdForPath': {
    kind: 'contained',
    why: 'a pure repo-id resolver injected at construction',
  },
  'apps/server/src/store/repos.ts#ReposRepository.repoIdResolver()': {
    kind: 'contained',
    why: 'the resolver closure repoIdResolver() returns: pure over a snapshot',
  },
  'apps/server/src/modules/issues/service/core.ts#IssueStore.repoScopeFilter()': {
    kind: 'contained',
    why: 'the predicate repoScopeFilter() returns: pure',
  },

  /* --- lazy module accessors: `() => Module`, so the call is the getter ---- */
  'apps/server/src/modules/issues/service/attention.ts#IssueAttentionModule.crud': {
    kind: 'contained',
    why: 'a lazy module accessor; the module it returns is followed structurally',
  },
  'apps/server/src/modules/issues/service/attention.ts#IssueAttentionModule.hierarchy': {
    kind: 'contained',
    why: 'a lazy module accessor; the module it returns is followed structurally',
  },
  'apps/server/src/modules/issues/service/attention.ts#IssueAttentionModule.reports': {
    kind: 'contained',
    why: 'a lazy module accessor; the module it returns is followed structurally',
  },
  'apps/server/src/modules/issues/service/crud.ts#IssueCrudModule.hierarchy': {
    kind: 'contained',
    why: 'a lazy module accessor; the module it returns is followed structurally',
  },
  'apps/server/src/modules/issues/service/crud.ts#IssueCrudModule.attention': {
    kind: 'contained',
    why: 'a lazy module accessor; the module it returns is followed structurally',
  },
  'apps/server/src/modules/issues/service/crud.ts#IssueCrudModule.gitWorkflow': {
    kind: 'contained',
    why: 'a lazy module accessor; the module it returns is followed structurally',
  },

  /* --- reads, clocks and same-unit writes --------------------------------- */
  'apps/server/src/modules/lock/service.ts#LockServiceDeps.now': {
    kind: 'contained',
    why: 'a clock read',
  },
  'apps/server/src/modules/lock/service.ts#LockServiceDeps.sessionAlive': {
    kind: 'contained',
    why: 'an in-process liveness read',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.now': {
    kind: 'contained',
    why: 'a clock read',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.getSettings': {
    kind: 'contained',
    why: 'a settings read',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.listSessions': {
    kind: 'contained',
    why: 'a session read',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.listSessionsForIssue': {
    kind: 'contained',
    why: 'a session read',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.getSessionIssueId': {
    kind: 'contained',
    why: 'a session read',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.resolveMachine': {
    kind: 'contained',
    why: 'a machine-identity read',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.requireIssueHomeMachine': {
    kind: 'contained',
    why: 'an authorization check: it refuses, it does not publish',
  },
  'apps/server/src/modules/machines/rpc.ts#DaemonRpcDeps.resolveMachine': {
    kind: 'contained',
    why: 'a machine-identity read',
  },
  'packages/sync/src/change-log.ts#ChangeLogStore.appendChanges': {
    kind: 'contained',
    why: 'the durable change append: mechanism 1, atomic with the entity write',
  },
  'packages/sync/src/replica/overlay.ts#OptimisticOverlayPort.retire': {
    kind: 'contained',
    why: "the replica's own overlay bookkeeping, retired inside its own span",
  },
  'packages/sync/src/authority/ports.ts#AuthorityClock.AuthorityClock': {
    kind: 'contained',
    why: 'a clock read',
  },
  'packages/sync/src/authority/arbitration.ts#CommandArbitrationRule.CommandArbitrationRule': {
    kind: 'contained',
    why: 'an arbitration decision: pure, and it publishes nothing',
  },

  /* --- OBSERVABLE: rule 19 moves these ------------------------------------ */
  'apps/server/src/store/events.ts#EventAppendListener.EventAppendListener': {
    kind: 'observable',
    why: 'the feed announcement itself; A row 1 is exactly this call deferred',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.onIssueCreated': {
    kind: 'observable',
    why: "its own doc: 'for a composition root that publishes it'",
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.onIssueClosed': {
    kind: 'observable',
    why: 'starts session teardown, which tears down processes outside this one',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.onMailSent': {
    kind: 'observable',
    why: 'the mail delivery nudge — POD-3260 ledger A row 2',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.onWorktreesChanged': {
    kind: 'observable',
    why: 'tells connected clients to re-fetch repos',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.repoOp': {
    kind: 'observable',
    why: "a git round trip to a machine; a rollback cannot take the repo's state back",
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.snapshot': {
    kind: 'observable',
    why: 'writes bytes into the permanent artifact store',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.remove': {
    kind: 'observable',
    why: "deletes an artifact's stored bytes; nothing rolls that back",
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.removeIssue': {
    kind: 'observable',
    why: "deletes an issue's artifact directory; nothing rolls that back",
  },
  'apps/server/src/modules/sessions/session.ts#Send.Send': {
    kind: 'observable',
    why: 'writes to a live agent process',
  },
  'apps/server/src/gateway/daemon-ports.ts#ControlSend.ControlSend': {
    kind: 'observable',
    why: 'sends a control frame to a daemon',
  },
  'packages/sync/src/authority/ports.ts#ChangeSubscriber.ChangeSubscriber': {
    kind: 'observable',
    why: 'subscriber delivery — POD-3260 ledger A row 3',
  },

  /* --- the two choke points POD-3260 already fixed ------------------------ */
  /*
   * BOTH OF THESE READ AS OBSERVABLE AND ARE NOT, and the reason is the whole
   * value of POD-3260's ledger: the effect they used to carry has already been
   * moved, INSIDE the implementation, at a choke point. What is left at the port
   * is a durable write that belongs to the unit of work.
   *
   * The rule does not have to take that on trust everywhere. Both
   * implementations are reached directly, body and all, from the repository
   * spans that call them without going through a deps port — so deleting either
   * `afterCommit` turns the deferred call back into a direct hit and the lint
   * fires. It is only THROUGH these two wide deps interfaces that the mechanism
   * is asserted rather than seen.
   */
  'apps/server/src/modules/lock/service.ts#LockServiceDeps.sendMail': {
    kind: 'contained',
    why: 'the durable mail row is mechanism 1; its nudge moved to afterCommit (ledger A row 2)',
  },
  'apps/server/src/modules/lock/service.ts#LockServiceDeps.appendEvent': {
    kind: 'contained',
    why: 'the event row is a database write; its announcement moved to afterCommit (ledger A row 1)',
  },

  /* --- EXEMPT: another issue owns the model, or it IS the mechanism -------- */
  'packages/sync/src/authority/ports.ts#PostCommitEffectPort.PostCommitEffectPort': {
    kind: 'exempt',
    why: 'the post-commit port itself: registering here is the fix, not the defect',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.setSessionIssueId': {
    kind: 'exempt',
    why: 'in-process live-session state, which POD-3259 owns (POD-3260 ledger §D)',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.setSessionArchived': {
    kind: 'exempt',
    why: 'in-process live-session state, which POD-3259 owns (POD-3260 ledger §D)',
  },
  'apps/server/src/modules/issues/service/types.ts#IssueDeps.clearSessionOffer': {
    kind: 'exempt',
    why: 'in-process live-session state, which POD-3259 owns (POD-3260 ledger §D)',
  },

  /* --- OPAQUE: a callback the analysis cannot follow ----------------------- */
  'apps/server/src/modules/issues/service/crud.ts#IssueLifecyclePlan.write': {
    kind: 'opaque',
    why: 'the plan callback; its body is supplied by whoever built the plan',
  },
  'apps/server/src/modules/issues/service/crud.ts#IssueLifecyclePlan.changes': {
    kind: 'opaque',
    why: 'the plan callback; its body is supplied by whoever built the plan',
  },
  'apps/server/src/modules/issues/service/core.ts#IssueStore.write': {
    kind: 'opaque',
    why: 'a persist-options callback, supplied at the call site inside the span',
  },
  'apps/server/src/modules/issues/service/core.ts#IssueStore.events': {
    kind: 'opaque',
    why: 'a persist-options callback, supplied at the call site inside the span',
  },
  'apps/server/src/modules/issues/service/core.ts#IssueStore.extraWrite': {
    kind: 'opaque',
    why: 'a persist-options callback, supplied at the call site inside the span',
  },
  'apps/server/src/modules/issues/service/core.ts#IssueStore.extraChanges': {
    kind: 'opaque',
    why: 'a persist-options callback, supplied at the call site inside the span',
  },
  'packages/sync/src/authority/ports.ts#AuthorityCommit.write': {
    kind: 'opaque',
    why: "the commit's own write body; it is a SPAN ROOT in its own right",
  },
  'packages/sync/src/authority/ports.ts#AuthorityCommit.current': {
    kind: 'opaque',
    why: 'an arbitration read supplied by the caller',
  },
  'packages/sync/src/ledger.ts#Ledger.changes': {
    kind: 'opaque',
    why: "the commit's own changes body; it is a SPAN ROOT in its own right",
  },
  'packages/sync/src/replica/replica.ts#Replica.write': {
    kind: 'opaque',
    why: "the replica's own write body, passed to commitRegions",
  },
  'apps/server/src/modules/server-transfer/portable-fence.ts#PortableStateFence.writer': {
    kind: 'opaque',
    why: 'the fenced writer callback, supplied by the caller',
  },
  'apps/server/src/modules/server-transfer/portable-fence.ts#PortableStateFence.<anonymous>': {
    kind: 'contained',
    why: 'a waiter continuation held in a Set',
  },
}

/* --------------------------------------------------------------- utilities */

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function siteOf(node: ts.Node, repoRoot: string): SourceSite {
  const file = node.getSourceFile()
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
  return { file: toPosix(relative(repoRoot, file.fileName)), line: line + 1 }
}

function idOf(node: ts.Node, repoRoot: string): string {
  const site = siteOf(node, repoRoot)
  return `${site.file}:${node.getStart(node.getSourceFile())}`
}

/** The nearest enclosing declaration a human would name this function by. */
function nameOf(node: ts.Node): string {
  let current: ts.Node | undefined = node
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isMethodSignature(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      const owner = current.parent?.parent
      const cls =
        owner && (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) && owner.name
          ? `${owner.name.text}.`
          : ''
      return `${cls}${current.name.text}`
    }
    current = current.parent
  }
  return '<anonymous>'
}

function isFunctionWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined
}

/** The module specifier a `@types/node` declaration belongs to. */
function nodeModuleOf(fileName: string): string | undefined {
  const match = /node_modules\/@types\/node\/(.+)\.d\.ts$/.exec(toPosix(fileName))
  if (!match) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  return name.replace(/\/index$/, '')
}

/** The workspace or npm package a declaration belongs to. */
function packageOf(fileName: string, repoRoot: string): string | undefined {
  const posix = toPosix(fileName)
  const nm = posix.lastIndexOf('node_modules/')
  if (nm >= 0) {
    const rest = posix.slice(nm + 'node_modules/'.length)
    const parts = rest.split('/')
    return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  }
  const rel = toPosix(relative(repoRoot, fileName))
  const workspace = /^packages\/([^/]+)\//.exec(rel)
  if (workspace) return `@podium/${workspace[1]}`
  return undefined
}

/* ------------------------------------------------------------------ engine */

export interface AnalyzeOptions {
  readonly repoRoot: string
  /**
   * Repo-relative directory prefixes whose span bodies are ROOTS. B0.5's
   * acceptance sentence names `apps/server/src` and `packages/sync/src`.
   */
  readonly roots: readonly string[]
  /**
   * Repo-relative directory prefixes the walk may FOLLOW INTO. Wider than the
   * roots on purpose: a span body in the server reaches `@podium/model` and
   * `@podium/protocol`, and stopping at the package boundary would turn every
   * one of those calls into an unclassified port.
   */
  readonly walk: readonly string[]
  readonly openers?: readonly OpenerSpec[]
  readonly ports?: Readonly<Record<string, PortRule>>
}

export function analyze(program: ts.Program, options: AnalyzeOptions): AnalysisResult {
  const checker = program.getTypeChecker()
  const repoRoot = options.repoRoot
  const openers = options.openers ?? SPAN_OPENERS
  const ports = options.ports ?? PORT_CAPABILITIES

  const openerByKey = new Map<string, OpenerSpec>()
  for (const spec of openers) openerByKey.set(`${spec.file}#${spec.symbol}`, spec)
  const matchedOpeners = new Set<string>()
  const registrarKeys = new Set(
    POST_COMMIT_REGISTRARS.map((entry) => `${entry.file}#${entry.symbol}`),
  )

  const nodes = new Map<string, GraphNode>()
  const reverse = new Map<string, Set<string>>()
  /** Every class in the walk scope, for the structural implementation search. */
  const classes: ts.ClassDeclaration[] = []
  /** Port declaration -> the implementing methods found for it, memoised. */
  const implementations = new Map<ts.Declaration, ts.FunctionLikeDeclaration[]>()
  const roots: SpanRoot[] = []
  const opaqueRoots: SpanRoot[] = []
  const uncoveredOpeners: SourceSite[] = []
  let unresolvedCalls = 0

  const relOf = (fileName: string): string => toPosix(relative(repoRoot, fileName))
  const inWalk = (fileName: string): boolean => {
    const rel = relOf(fileName)
    return !isTestPath(rel) && options.walk.some((prefix) => rel.startsWith(prefix))
  }
  const inRoots = (fileName: string): boolean => {
    const rel = relOf(fileName)
    return !isTestPath(rel) && options.roots.some((prefix) => rel.startsWith(prefix))
  }

  /* -- pass 1: index every function-like node in scope ---------------------- */

  const declKey = (decl: ts.Node): string => {
    const rel = toPosix(relative(repoRoot, decl.getSourceFile().fileName))
    return `${rel}#${declaredName(decl)}`
  }

  const sourceFiles = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && inWalk(file.fileName))
  const rootFiles = sourceFiles.filter((file) => inRoots(file.fileName))

  for (const file of sourceFiles) {
    collectClasses(file)
  }
  for (const file of sourceFiles) {
    indexFile(file)
  }

  function collectClasses(file: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) classes.push(node)
      node.forEachChild(visit)
    }
    visit(file)
  }

  /**
   * The bodies a call through a PORT can actually reach.
   *
   * A narrow internal port — `IssueCrudAttentionPort`, `IssueLedger` — is an
   * interface the same codebase satisfies with a class; the checker resolves the
   * call to the signature and stops, and stopping there is what would push the
   * judgement back onto a hand-maintained table. So the port's OWNER TYPE is
   * matched structurally against every class in the walk scope, and each
   * assignable class's same-named method becomes a call edge. That is how the
   * orchestrator's span reaches `IssueAttentionModule` and `IssueCrudModule` at
   * all.
   *
   * WHOLE-INTERFACE, NOT MEMBER-BY-MEMBER, and the difference is not stylistic.
   * Matching a port member against every same-named class method that is
   * signature-assignable was tried and it FLOODS: `run`, `get`, `send` and
   * `handler` are everywhere, the graph joins up into one component, and 95 span
   * bodies each reach 72 capabilities — a result no reader can act on. Whole
   * interfaces are specific enough to mean something.
   *
   * THE COST, stated rather than discovered: a wide deps interface satisfied by
   * an object literal a composition root builds out of several modules —
   * `LockServiceDeps`, `IssueDeps` — has no assignable class, so its members
   * stay leaves and are answered in {@link PORT_CAPABILITIES} by hand. Those
   * entries are the hand-judged part of this rule, and each carries its reason.
   */
  function implementationsFor(decl: ts.Declaration): ts.FunctionLikeDeclaration[] {
    const cached = implementations.get(decl)
    if (cached) return cached
    implementations.set(decl, [])
    const member = decl as ts.NamedDeclaration
    if (!member.name || !ts.isIdentifier(member.name)) return []
    const memberName = member.name.text
    const owner = decl.parent
    if (
      !owner ||
      !(ts.isInterfaceDeclaration(owner) || ts.isTypeLiteralNode(owner)) ||
      !inWalk(owner.getSourceFile().fileName)
    ) {
      return []
    }
    const portType = checker.getTypeAtLocation(owner)
    const found: ts.FunctionLikeDeclaration[] = []
    for (const cls of classes) {
      const method = cls.members.find(
        (m) =>
          (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) &&
          m.name !== undefined &&
          ts.isIdentifier(m.name) &&
          m.name.text === memberName,
      )
      if (!method) continue
      const symbol = cls.name ? checker.getSymbolAtLocation(cls.name) : undefined
      if (!symbol) continue
      const declared = checker.getDeclaredTypeOfSymbol(symbol)
      if (!declared || !checker.isTypeAssignableTo(declared, portType)) continue
      if (isFunctionWithBody(method)) found.push(method)
      else if (
        ts.isPropertyDeclaration(method) &&
        method.initializer &&
        isFunctionWithBody(method.initializer)
      ) {
        found.push(method.initializer)
      }
    }
    implementations.set(decl, found)
    return found
  }

  function indexFile(file: ts.SourceFile): void {
    // The module's own top level is a node too: a span opener can be called
    // from it, and so can a capability.
    const topLevel = createNode(file, `${toPosix(relative(repoRoot, file.fileName))}#<module>`)
    walk(file, topLevel)

    function walk(node: ts.Node, owner: GraphNode): void {
      node.forEachChild((child) => {
        if (isFunctionWithBody(child)) {
          const inner = createNode(child, idOf(child, repoRoot))
          // A nested function is charged to whoever created it: it closes over
          // the body's state and, unless it was handed to a registrar, nothing
          // says it runs later.
          owner.callees.add(inner.id)
          addReverse(inner.id, owner.id)
          walk(child, inner)
          return
        }
        if (ts.isCallExpression(child)) {
          visitCall(child, owner)
          return
        }
        walk(child, owner)
      })
    }

    function visitCall(call: ts.CallExpression, owner: GraphNode): void {
      const decl = resolveCallee(call)
      const key = decl ? declKey(decl) : undefined

      // A span opener: its body callback becomes a root, and the CALL itself is
      // not an edge — the body is walked as a root, and the opener's own
      // machinery is not part of anybody's span.
      const opener = key ? openerByKey.get(key) : undefined
      if (opener && decl) {
        matchedOpeners.add(key as string)
        if (inRoots(file.fileName)) collectRoot(call, opener, owner)
        walk(call.expression, owner)
        for (const arg of call.arguments) walk(arg, owner)
        return
      }

      // A registrar: everything in its argument list has already been moved out
      // of the span, so it is not walked at all.
      if (key && registrarKeys.has(key)) {
        walk(call.expression, owner)
        return
      }

      if (!decl) {
        unresolvedCalls += 1
        owner.unresolved += 1
        walkArgs(call, owner)
        return
      }

      if (isFunctionWithBody(decl) && inWalk(decl.getSourceFile().fileName)) {
        const calleeId = idOf(decl, repoRoot)
        owner.callees.add(calleeId)
        addReverse(calleeId, owner.id)
        walkArgs(call, owner)
        return
      }

      const impls = implementationsFor(decl)
      if (impls.length > 0) {
        for (const impl of impls) {
          if (!inWalk(impl.getSourceFile().fileName)) continue
          const implId = idOf(impl, repoRoot)
          owner.callees.add(implId)
          addReverse(implId, owner.id)
        }
        walkArgs(call, owner)
        return
      }

      const capability = classify(decl, call, ports, repoRoot)
      if (capability) {
        record(owner, capability, undefined, siteOf(call, repoRoot))
      }
      walkArgs(call, owner)
    }

    function walkArgs(call: ts.CallExpression, owner: GraphNode): void {
      walk(call.expression, owner)
      for (const arg of call.arguments) walk(arg, owner)
    }

    function collectRoot(call: ts.CallExpression, opener: OpenerSpec, owner: GraphNode): void {
      for (const body of bodyArguments(call, opener.body)) {
        const target = resolveFunction(body)
        if (!target) {
          // `MaintenanceService.write` is the live example: the job is whichever
          // function the command named, so the callee is a value and there is no
          // body to walk. Counted, never quietly dropped.
          opaqueRoots.push({
            id: idOf(call, repoRoot),
            opener: opener.label,
            enclosing: owner.name,
            site: siteOf(call, repoRoot),
            forwarded: isForwardedParameter(body),
          })
          continue
        }
        const id = idOf(target, repoRoot)
        if (!nodes.has(id)) {
          const created = createNode(target, id)
          walk(target, created)
        }
        roots.push({
          id,
          opener: opener.label,
          enclosing: owner.name,
          site: siteOf(call, repoRoot),
        })
      }
    }
  }

  function createNode(node: ts.Node, id: string): GraphNode {
    const existing = nodes.get(id)
    if (existing) return existing
    const created: GraphNode = {
      id,
      name: ts.isSourceFile(node) ? '<module>' : nameOf(node),
      site: siteOf(node, repoRoot),
      callees: new Set(),
      reached: new Map(),
      unresolved: 0,
    }
    nodes.set(id, created)
    return created
  }

  function addReverse(callee: string, caller: string): void {
    let callers = reverse.get(callee)
    if (!callers) {
      callers = new Set()
      reverse.set(callee, callers)
    }
    callers.add(caller)
  }

  function record(
    owner: GraphNode,
    capability: Capability,
    through: string | undefined,
    at: SourceSite,
  ): boolean {
    if (owner.reached.has(capability.key)) return false
    owner.reached.set(capability.key, { capability, through, at })
    return true
  }

  function resolveCallee(call: ts.CallExpression): ts.Declaration | undefined {
    const signature = checker.getResolvedSignature(call)
    const declared = signature?.declaration
    if (declared) return declared as ts.Declaration
    // No signature: an `any`, a computed member, or a union the checker gave up
    // on. Fall back to the symbol, which still resolves a plain identifier.
    let symbol = checker.getSymbolAtLocation(call.expression)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    return symbol?.declarations?.[0]
  }

  /** Is this body argument simply the enclosing function's own parameter? */
  function isForwardedParameter(node: ts.Expression): boolean {
    const base = ts.isPropertyAccessExpression(node) ? node.expression : node
    if (!ts.isIdentifier(base)) return false
    const symbol = checker.getSymbolAtLocation(base)
    return (symbol?.declarations ?? []).some((decl) => ts.isParameter(decl))
  }

  function resolveFunction(node: ts.Expression): ts.FunctionLikeDeclaration | undefined {
    if (isFunctionWithBody(node)) return node
    let symbol = checker.getSymbolAtLocation(node)
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    for (const decl of symbol?.declarations ?? []) {
      if (isFunctionWithBody(decl)) return decl
      if (
        ts.isVariableDeclaration(decl) &&
        decl.initializer &&
        isFunctionWithBody(decl.initializer)
      )
        return decl.initializer
      if (ts.isPropertyAssignment(decl) && decl.initializer && isFunctionWithBody(decl.initializer))
        return decl.initializer
    }
    return undefined
  }

  /* -- pass 1b: the opener table's own completeness ------------------------ */

  for (const file of rootFiles) {
    findUncoveredOpeners(file)
  }

  function findUncoveredOpeners(file: ts.SourceFile): void {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isMethodDeclaration(node) ||
          ts.isMethodSignature(node) ||
          ts.isPropertySignature(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isTypeAliasDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        (node.name.text === 'transact' || node.name.text === 'transaction')
      ) {
        const site = siteOf(node, repoRoot)
        const key = `${site.file}#${node.name.text}`
        const known =
          openerByKey.has(key) ||
          openerByKey.has(`${site.file}#TransactPort`) ||
          NOT_A_SPAN_OPENER.some((entry) => entry.file === site.file && entry.line === site.line)
        if (!known) uncoveredOpeners.push(site)
      }
      node.forEachChild(visit)
    }
    visit(file)
  }

  /* -- pass 2: propagate to a fixpoint ------------------------------------- */

  propagate(nodes, reverse)

  /* -- pass 3: findings ---------------------------------------------------- */

  const findings: SpanFinding[] = []
  const reports: RootReport[] = []
  const unclassified = new Map<string, SpanRoot[]>()
  for (const root of roots) {
    const node = nodes.get(root.id)
    if (!node) continue
    const capabilities: SpanFinding[] = []
    for (const arrival of node.reached.values()) {
      const entry = {
        root,
        capability: arrival.capability,
        path: pathTo(nodes, node, arrival),
      }
      capabilities.push(entry)
      if (arrival.capability.kind === 'observable') findings.push(entry)
      else if (arrival.capability.kind === 'unknown') {
        const seen = unclassified.get(arrival.capability.key) ?? []
        seen.push(root)
        unclassified.set(arrival.capability.key, seen)
      }
    }
    reports.push({ root, capabilities, unresolved: node.unresolved })
  }

  const deadOpeners = [...openerByKey.keys()].filter((key) => !matchedOpeners.has(key))

  const blind = new Map<string, number>()
  const seenNodes = new Set<string>()
  const stack = roots.map((root) => root.id)
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seenNodes.has(id)) continue
    seenNodes.add(id)
    const node = nodes.get(id)
    if (!node) continue
    if (node.unresolved > 0) {
      blind.set(node.site.file, (blind.get(node.site.file) ?? 0) + node.unresolved)
    }
    for (const callee of node.callees) stack.push(callee)
  }
  const blindSpots = [...blind.entries()]
    .map(([file, calls]) => ({ file, calls }))
    .sort((a, b) => b.calls - a.calls)

  return {
    roots,
    reports,
    findings,
    unclassified,
    deadOpeners,
    uncoveredOpeners,
    opaqueRoots: dedupeSites(opaqueRoots),
    unresolvedCalls,
    blindSpots,
  }
}

/** One entry per source position: the same call reached twice is one site. */
function dedupeSites(roots: readonly SpanRoot[]): SpanRoot[] {
  const seen = new Map<string, SpanRoot>()
  for (const root of roots) {
    const key = `${root.site.file}:${root.site.line}:${root.opener}`
    if (!seen.has(key)) seen.set(key, root)
  }
  return [...seen.values()]
}

function propagate(nodes: Map<string, GraphNode>, reverse: Map<string, Set<string>>): void {
  const work: string[] = [...nodes.keys()]
  while (work.length > 0) {
    const id = work.pop() as string
    const node = nodes.get(id)
    if (!node) continue
    for (const caller of reverse.get(id) ?? []) {
      const target = nodes.get(caller)
      if (!target) continue
      let changed = false
      for (const arrival of node.reached.values()) {
        if (target.reached.has(arrival.capability.key)) continue
        target.reached.set(arrival.capability.key, {
          capability: arrival.capability,
          through: id,
          at: node.site,
        })
        changed = true
      }
      if (changed) work.push(caller)
    }
  }
}

function pathTo(
  nodes: Map<string, GraphNode>,
  from: GraphNode,
  arrival: CapabilityArrival,
): SourceSite[] {
  const path: SourceSite[] = [from.site]
  let current = arrival
  const guard = new Set<string>([from.id])
  while (current.through) {
    const next = nodes.get(current.through)
    if (!next || guard.has(next.id)) break
    guard.add(next.id)
    path.push(next.site)
    const onward = next.reached.get(current.capability.key)
    if (!onward) break
    current = onward
  }
  path.push(current.at)
  return path
}

/** The name a declaration is keyed by in the opener/port tables. */
function declaredName(decl: ts.Node): string {
  if (ts.isFunctionTypeNode(decl)) {
    // `transact: TransactPort` resolves here: name it by the alias or the
    // property that declares it, whichever the source wrote. A function arm of
    // a union (`(() => T) | T`) is named for the property, not for the union.
    let parent: ts.Node = decl.parent
    while (ts.isUnionTypeNode(parent) || ts.isParenthesizedTypeNode(parent)) parent = parent.parent
    if (ts.isTypeAliasDeclaration(parent)) return parent.name.text
    if (
      (ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isParameter(parent)) &&
      ts.isIdentifier(parent.name)
    )
      return parent.name.text
    if (ts.isMethodSignature(parent) || ts.isMethodDeclaration(parent)) {
      // A method's RETURN type is a function type: name it for the method that
      // hands it out, which is how a reader finds it (`repoIdResolver()`).
      if (parent.name && ts.isIdentifier(parent.name)) return `${parent.name.text}()`
    }
  }
  const named = decl as ts.NamedDeclaration
  if (named.name && ts.isIdentifier(named.name)) return named.name.text
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) return decl.name.text
  const parent = decl.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
    return parent.name.text
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name))
    return parent.name.text
  if (
    parent &&
    (ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isParameter(parent)) &&
    parent.name &&
    ts.isIdentifier(parent.name)
  )
    return parent.name.text
  return '<anonymous>'
}

function bodyArguments(call: ts.CallExpression, position: BodyPosition): ts.Expression[] {
  if (position === 'arg0') return call.arguments[0] ? [call.arguments[0]] : []
  if (position === 'arg1') return call.arguments[1] ? [call.arguments[1]] : []
  const options = call.arguments[0]
  if (!options || !ts.isObjectLiteralExpression(options)) return []
  const found: ts.Expression[] = []
  for (const property of options.properties) {
    if (!property.name || !ts.isIdentifier(property.name)) continue
    if (!position.props.includes(property.name.text)) continue
    if (ts.isPropertyAssignment(property)) found.push(property.initializer)
    else if (ts.isShorthandPropertyAssignment(property)) found.push(property.name)
    else if (ts.isMethodDeclaration(property)) found.push(property as unknown as ts.Expression)
  }
  return found
}

function classify(
  decl: ts.Declaration,
  call: ts.CallExpression,
  ports: Readonly<Record<string, PortRule>>,
  repoRoot: string,
): Capability | undefined {
  const fileName = decl.getSourceFile().fileName
  const name = declaredName(decl)

  const nodeModule = nodeModuleOf(fileName)
  if (nodeModule !== undefined) {
    const kind = NODE_MODULE_KIND[nodeModule] ?? 'unknown'
    return {
      key: `node:${nodeModule}.${name}`,
      kind,
      what: `node:${nodeModule} ${name}()`,
      declaredAt: `node:${nodeModule}`,
    }
  }

  if (/\/lib\.[a-z0-9.]*d\.ts$/.test(toPosix(fileName))) {
    // A standard-library call. Only the handful of globals that reach outside
    // the process matter; `Map.get` and `Array.map` land here and are dropped.
    const global = GLOBAL_CAPABILITIES[name] ?? rootObjectOf(call)
    if (typeof global === 'string' && global !== 'exempt' && global !== 'contained') {
      return { key: `global.${name}`, kind: global, what: `global ${name}()`, declaredAt: 'global' }
    }
    return undefined
  }

  const pkg = packageOf(fileName, repoRoot)
  if (pkg && (toPosix(fileName).includes('node_modules/') || PACKAGE_KIND[pkg])) {
    // A third-party dependency. It has no port to classify member by member, so
    // the whole package carries one answer and an unlisted one is `unknown`.
    const kind = PACKAGE_KIND[pkg] ?? 'unknown'
    return { key: `${pkg}.${name}`, kind, what: `${pkg} ${name}()`, declaredAt: pkg }
  }

  // A project declaration with no body: an interface member, a function-typed
  // property, an overload signature. This is the port boundary.
  const rel = toPosix(relative(repoRoot, fileName))
  const owner = ownerNameOf(decl)
  const key = `${owner}.${name}`
  const rule = ports[`${rel}#${key}`]
  const { line } = decl
    .getSourceFile()
    .getLineAndCharacterOfPosition(decl.getStart(decl.getSourceFile()))
  return {
    key: `${rel}#${key}`,
    kind: rule?.kind ?? 'unknown',
    what: rule ? `${key} — ${rule.why}` : `${key} — UNCLASSIFIED port member`,
    declaredAt: `${rel}:${line + 1}`,
  }
}

/** `fetch(...)` has no module; a bare identifier call names its own capability. */
function rootObjectOf(call: ts.CallExpression): CapabilityKind | undefined {
  const expression = call.expression
  if (ts.isIdentifier(expression)) return GLOBAL_CAPABILITIES[expression.text]
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression))
    return GLOBAL_CAPABILITIES[expression.expression.text]
  return undefined
}

function ownerNameOf(decl: ts.Node): string {
  let current: ts.Node | undefined = decl
  while (current) {
    if (
      (ts.isInterfaceDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isTypeAliasDeclaration(current)) &&
      current.name
    ) {
      return current.name.text
    }
    current = current.parent
  }
  return '<module>'
}

export function isTestPath(rel: string): boolean {
  return (
    rel.endsWith('.test.ts') ||
    rel.includes('/test-support/') ||
    rel.includes('/fixtures/') ||
    rel.includes('/conformance/') ||
    rel.includes('test-doubles') ||
    rel.includes('test-plumbing') ||
    rel.includes('characterization-support')
  )
}

/* --------------------------------------------------------- program loading */

export function createProjectProgram(repoRoot: string, tsconfig: string): ts.Program {
  const configPath = resolve(repoRoot, tsconfig)
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'))
  if (config.error) {
    throw new Error(
      `could not read ${tsconfig}: ${ts.flattenDiagnosticMessageText(config.error.messageText, ' ')}`,
    )
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
}

/** The virtual repo root the fixture program is rooted at. */
export const FIXTURE_ROOT = '/repo'

/**
 * Build a program from in-memory sources, for the fixture suite.
 *
 * The paths are the REAL repo-relative ones — `apps/server/src/store.ts`,
 * `packages/logger/src/logger.ts` — because the opener, registrar and package
 * tables all key on a declaration's path. A fixture on invented paths would
 * exercise a parallel lookup and pin nothing about the production run.
 *
 * Module resolution is done here rather than left to the compiler host: the
 * virtual files exist nowhere on disk, so a relative specifier is resolved
 * against the virtual map and a `@podium/<name>` specifier against
 * `packages/<name>/src/<name>.ts`, which is where the real ones live.
 */
export function createFixtureProgram(files: Readonly<Record<string, string>>): ts.Program {
  const root = FIXTURE_ROOT
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  }
  const virtual = new Map<string, string>()
  for (const [path, text] of Object.entries(files)) {
    virtual.set(toPosix(isAbsolute(path) ? path : `${root}/${path}`), text)
  }
  const host = ts.createCompilerHost(options, true)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtual.get(toPosix(fileName))
    if (text !== undefined) {
      return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS)
    }
    return original(fileName, languageVersion, onError, shouldCreate)
  }
  const originalExists = host.fileExists.bind(host)
  host.fileExists = (fileName) => virtual.has(toPosix(fileName)) || originalExists(fileName)
  const originalRead = host.readFile.bind(host)
  host.readFile = (fileName) => virtual.get(toPosix(fileName)) ?? originalRead(fileName)
  host.getCurrentDirectory = () => root

  const resolve = (specifier: string, containingFile: string): string | undefined => {
    const candidates: string[] = []
    if (specifier.startsWith('.')) {
      const base = toPosix(join(dirname(containingFile), specifier))
      candidates.push(base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, '.ts'))
    } else if (specifier.startsWith('@podium/')) {
      const name = specifier.slice('@podium/'.length)
      candidates.push(
        `${root}/packages/${name}/src/${name}.ts`,
        `${root}/packages/${name}/src/index.ts`,
      )
    }
    return candidates.find((candidate) => virtual.has(candidate))
  }
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      const resolvedFileName = resolve(literal.text, containingFile)
      if (!resolvedFileName) return { resolvedModule: undefined }
      return { resolvedModule: { resolvedFileName, extension: ts.Extension.Ts } }
    })

  return ts.createProgram({ rootNames: [...virtual.keys()], options, host })
}
