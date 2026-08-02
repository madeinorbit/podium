/**
 * THE GOD-OBJECT AUDIT — POD-1385, for the POD-425 Phase 4 exit criterion
 * "god-object audit items zero".
 *
 * Run:
 *   bun run audit:god-objects          # the gate — exit 1 on any finding
 *   bun run audit:god-objects --json
 *   bun run audit:god-objects --sizes  # the raw screen, no verdicts
 *   bun run audit:god-objects --probe  # prove every check can say YES
 *
 * The gate also runs as a TEST (`audit-god-objects.test.ts`) so CI executes it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CRITERION ACTUALLY SAYS, AND WHY THAT SHAPES THIS FILE
 * ---------------------------------------------------------------------------
 *
 * The epic's rule is that module size is a REVIEW SIGNAL WITH JUSTIFIED
 * EXCEPTIONS, not a hard limit (`docs/architecture/pod-355-boundary-ownership-
 * review.md`: steward at 1080 lines is "a review signal, not a defect"; the
 * Phase 4 ledger accepts the 600-plus session-state module by name). POD-425
 * refused candidate 6fc75d09 because 28 modules were over the line and the
 * answer to each was **prose in six different documents, or nothing at all** —
 * it recorded "no same-candidate audit result with exit code".
 *
 * So the failure this instrument exists to make impossible is NOT "a big file".
 * It is **a big file nobody has answered for**. An audit item is:
 *
 *     a production module over the threshold that is either UNDECOMPOSED
 *     (no argument for its size) or UNEXPLAINED (an argument that is not
 *     checkable, is stale, or has silently stopped being true).
 *
 * Zero items means: every module over the line has an entry here, the entry
 * makes a claim, and THE CLAIM IS MACHINE-CHECKED against the file today.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY EXCEPTION KIND CARRIES A PREDICATE
 * ---------------------------------------------------------------------------
 *
 * A ledger of free prose is a rubber stamp: it passes forever, because prose
 * cannot notice that the file it describes has changed underneath it. Every
 * `kind` below therefore pairs the written argument with a STRUCTURAL PREDICATE
 * the audit re-derives from the source on every run. `type-declarations` is
 * false the moment the file grows a runtime export. `documented` is false the
 * moment the code (not the comments) crosses the line. `cohesive-owner` names
 * the protected fields and fails if one stops being private — which is exactly
 * the event that turns a cohesive owner back into a god object.
 *
 * The argument is still required and still human. The predicate is what stops
 * the argument from outliving its truth.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS INSTRUMENT CANNOT SEE — READ BEFORE QUOTING A GREEN
 * ---------------------------------------------------------------------------
 *
 * A clean run here means "no module over the line is unexplained". It does NOT
 * mean the decomposition is sound, and the gate must not read it that way.
 *
 * This audit measures ONE FILE AT A TIME. Every coupling defect — the entire
 * class of failure this epic actually exists to remove — is between files, and
 * is therefore invisible to it. Three shapes, all real in this tree:
 *
 *  1. A MODULE OWNING ASYNC WORK THAT OUTLIVES ITS OWNER. POD-1390 found that
 *     `SessionRegistry.dispose()` never touches `modules.memory`, so
 *     memory-owned work survives the close and a ranged daemon read resolves
 *     ~10s AFTER the SQLite handle is shut. No line count would ever surface
 *     that, and the fix is ONE line. A short file with this defect is worse
 *     than a long file without it.
 *
 *  2. PROTECTED STATE SHARED BY REFERENCE ACROSS A BOUNDARY. `observationLeases`
 *     is a raw `Map` passed into both `SessionRepository` and
 *     `SessionDaemonLifecycle`, and all three modules read AND write it
 *     (POD-1396). Three files, each individually defensible; one shared mutable
 *     map between them. Splitting a god object while leaving a map shared makes
 *     the audit greener and the design worse.
 *
 *  3. A SPLIT THAT ONLY LOOKS LIKE ONE. Two files reaching into each other's
 *     internals pass every predicate below, because each is measured alone.
 *
 * So the honest reading of a green is narrow: nobody is carrying an unargued
 * god object. Acyclicity is `scripts/server-composition-graph.ts`; construction
 * order is `scripts/server-construction-order.ts`; lifecycle ownership has NO
 * instrument at all today and is checked only by review. This file is one of
 * four inputs to the criterion and the weakest of them — it is the one that
 * proves an argument EXISTS, not that the argument describes a good design.
 *
 * ---------------------------------------------------------------------------
 * AND WHY THERE IS NO `--update`
 * ---------------------------------------------------------------------------
 *
 * Every entry carries a `budget`: the size past which its review is void and a
 * human has to look again. A flag that rewrote budgets to whatever the tree
 * currently measures would launder growth into an accepted baseline — the same
 * failure mode POD-425 named when it warned that regenerating an artifact
 * converts "what the code now produces" into "what was reviewed". Budgets are
 * set by hand, in a commit, by whoever made the argument. `--sizes` prints the
 * measurements so that edit is informed; it never performs it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The review threshold, in physical lines.
 *
 * PHYSICAL lines, deliberately: it is the number POD-425's screen reported and
 * the number a reviewer sees when they open the file, so the audit's population
 * and the gate's screen are the same set with no reconciliation step. Comment
 * density is then answered by the `documented` kind, which re-measures the same
 * file with comments removed — a file does not escape REVIEW by being well
 * documented, it just has a short and checkable answer once reviewed.
 */
export const THRESHOLD = 600

/** Production server TypeScript. Tests are excluded — the criterion is about
 *  the shipped module graph, and a long table-driven test file is not a god
 *  object by any reading of it. */
const PRODUCTION_ROOTS = ['apps/server/src']

export interface Finding {
  /** Which obligation failed — the acceptance criterion, in one token. */
  check: string
  /** The module the finding is about. */
  where: string
  detail: string
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface Measurement {
  readonly file: string
  /** `wc -l`. The gate's screen and the reviewer's scrollbar. */
  readonly physical: number
  /** Physical minus blank lines minus comment-only lines. */
  readonly code: number
  /** Exported symbols that exist at runtime (const/function/class/enum/let/var). */
  readonly runtimeExports: readonly string[]
  /** Exported classes, by name. */
  readonly exportedClasses: readonly string[]
  /** `class X extends Y` — inheritance, which POD-320 dissolved on purpose. */
  readonly hasInheritance: boolean
  /** Control-flow keywords in code (comments and strings stripped). */
  readonly controlFlow: number
  /** Module specifiers this file imports from. */
  readonly imports: readonly string[]
  /** Private/readonly-private field names declared on a class in this file. */
  readonly privateFields: readonly string[]
  /**
   * Private fields that hold MUTABLE state, as opposed to an injected
   * collaborator. This is the number that separates a surface from an owner:
   * a repository with thirty-nine methods and no mutable field is not a god of
   * anything, because it holds nothing.
   */
  readonly privateStateFields: readonly string[]
  /** Method/accessor declarations at class-body indentation. */
  readonly methodCount: number
  /** Mean and max physical span of those methods. */
  readonly meanMethodLines: number
  readonly maxMethodLines: number
  /** Top-level statements that execute at import time. */
  readonly topLevelStatements: number
}

/** Strip block and line comments so the structural counts below see code only.
 *  Not a parser: it keeps string contents (replaced by a placeholder) so that a
 *  `//` inside a string literal cannot blank the rest of a line of real code. */
export const stripComments = (src: string): string => {
  let out = ''
  let i = 0
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (mode === 'code') {
      if (two === '//') {
        mode = 'line'
        i += 2
        continue
      }
      if (two === '/*') {
        mode = 'block'
        i += 2
        continue
      }
      if (src[i] === "'") mode = 'single'
      else if (src[i] === '"') mode = 'double'
      else if (src[i] === '`') mode = 'template'
      out += src[i]
      i += 1
      continue
    }
    if (mode === 'line') {
      if (src[i] === '\n') {
        mode = 'code'
        out += '\n'
      }
      i += 1
      continue
    }
    if (mode === 'block') {
      if (two === '*/') {
        mode = 'code'
        i += 2
        continue
      }
      // Preserve newlines so line numbers and blank-line counts stay aligned.
      if (src[i] === '\n') out += '\n'
      i += 1
      continue
    }
    // Inside a string: copy through, honouring escapes, until it closes.
    if (src[i] === '\\') {
      out += src[i] + (src[i + 1] ?? '')
      i += 2
      continue
    }
    const closes =
      (mode === 'single' && src[i] === "'") ||
      (mode === 'double' && src[i] === '"') ||
      (mode === 'template' && src[i] === '`')
    out += src[i]
    if (closes) mode = 'code'
    i += 1
  }
  return out
}

/** Comment-only and blank lines, counted the way a reader would: a line whose
 *  content is entirely inside a comment, plus a line with nothing on it. */
const countCodeLines = (src: string): number => {
  const stripped = stripComments(src).split('\n')
  return stripped.filter((l) => l.trim() !== '').length
}

export const measure = (file: string, src: string): Measurement => {
  const physical = src.split('\n').length - (src.endsWith('\n') ? 1 : 0)
  const code = countCodeLines(src)
  const bare = stripComments(src)
  const runtimeExports = [
    ...bare.matchAll(
      /^export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|enum)\s+(\w+)/gm,
    ),
  ].map((m) => m[1] as string)
  const exportedClasses = [...bare.matchAll(/^export\s+(?:abstract\s+)?class\s+(\w+)/gm)].map(
    (m) => m[1] as string,
  )
  const imports = [...bare.matchAll(/^import\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] as string,
  )
  const privateFields = [
    ...bare.matchAll(/^\s{2}(?:private\s+)(?:readonly\s+)?(\w+)\s*[:=]/gm),
  ].map((m) => m[1] as string)
  // `private readonly x` is an injected collaborator held for the object's
  // lifetime; `private x = new Map()` / `private x: T` (reassigned) is state.
  // Only the second kind makes a module an owner rather than a surface.
  const privateStateFields = [
    ...bare.matchAll(/^\s{2}private\s+(?!readonly\s+\w+\s*:)(?:readonly\s+)?(\w+)\s*[:=]/gm),
  ]
    .map((m) => m[1] as string)
    .filter((name) => {
      const decl = new RegExp(`^\\s{2}private\\s+readonly\\s+${name}\\s*[:=]\\s*new\\s`, 'm')
      const plain = new RegExp(`^\\s{2}private\\s+(?!readonly)${name}\\s*[:=]`, 'm')
      return decl.test(bare) || plain.test(bare)
    })
  const controlFlow = [...bare.matchAll(/\b(?:if|for|while|switch|catch)\s*\(/g)].length
  // Method spans, measured between successive class-body declarations. Physical
  // lines, because the question is what a reader has to hold in their head.
  const rawLines = src.split('\n')
  const methodStarts: number[] = []
  rawLines.forEach((l, i) => {
    if (
      /^ {2}(?:(?:private|public|protected|readonly|static|async|get|set)\s+)*[a-zA-Z_]\w*\s*[(<]/.test(
        l,
      )
    )
      methodStarts.push(i)
  })
  const spans = methodStarts.slice(1).map((s, i) => s - (methodStarts[i] as number))
  const meanMethodLines = spans.length === 0 ? 0 : spans.reduce((a, b) => a + b, 0) / spans.length
  const maxMethodLines = spans.length === 0 ? 0 : Math.max(...spans)
  // A top-level statement is a line at column 0 that is not a declaration,
  // an import/export, a closing brace, or a continuation.
  const topLevelStatements = bare
    .split('\n')
    .filter((l) => /^[a-z]/.test(l))
    .filter(
      (l) =>
        !/^(import|export|type|interface|const|let|var|function|class|enum|declare|from)\b/.test(l),
    ).length
  return {
    file,
    physical,
    code,
    runtimeExports,
    exportedClasses,
    hasInheritance: /\bclass\s+\w+\s+extends\s+/.test(bare),
    controlFlow,
    imports,
    privateFields,
    privateStateFields,
    methodCount: methodStarts.length,
    meanMethodLines,
    maxMethodLines,
    topLevelStatements,
  }
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (
      name.endsWith('.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.spec.ts') &&
      !full.includes('/__tests__/')
    )
      out.push(full)
  }
  return out
}

/** The screen: every production module at or over the threshold, largest first. */
export const screen = (root = ROOT): Measurement[] =>
  PRODUCTION_ROOTS.flatMap((r) => walk(join(root, r)))
    .map((full) => measure(relative(root, full), readFileSync(full, 'utf8')))
    .filter((m) => m.physical > THRESHOLD)
    .sort((a, b) => b.physical - a.physical)

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export type ExceptionKind =
  /**
   * The module declares types and nothing else. It has no runtime existence at
   * all, so it cannot be an object of any kind, god or otherwise.
   * PREDICATE: zero runtime exports.
   */
  | 'type-declarations'
  /**
   * The module is a table: declarations of data, one row per thing, with no
   * behaviour to distribute. Splitting a table moves rows between files and
   * changes no coupling — the reason POD-425's own reviewer said a generated
   * schema at 1404 lines is not a god object.
   * PREDICATE: no exported class, no owned mutable state, and the named table
   * export exists.
   *
   * NOT control-flow density, which was tried and does not discriminate: the
   * candidate's command registry measures 6.0% and `sessions/lifecycle.ts` —
   * the flagship god object — measures 5.8%. A table whose entries carry small
   * per-entry guards branches about as much as a service does. What actually
   * separates them is that a table holds no state and exposes no object: every
   * entry is independently readable, and the file's size is the number of rows.
   */
  | 'declaration-table'
  /**
   * The composition root. Its size is the SIZE OF THE SYSTEM — one named
   * construction per module — and splitting it into sub-roots would hide edges
   * from the very generator that proves the graph acyclic.
   * PREDICATE: it is the single declared root, and the committed
   * construction-order record reports 0 forward dependencies, 0 deferred
   * service closures and 0 non-null late bindings.
   */
  | 'composition-root'
  /**
   * The module is under the threshold in CODE; the rest is the written record
   * of why it does what it does. Counting documentation as bulk would punish
   * exactly the thing this gate asks for everywhere else.
   * PREDICATE: code lines (blank and comment removed) below the threshold.
   */
  | 'documented'
  /**
   * MANY OPERATIONS, NO SHARED STATE. A repository with thirty-nine methods and
   * no mutable field is long because the aggregate it fronts has thirty-nine
   * operations, not because anything accreted: there is no state for the
   * methods to entangle through, so no subset of them can be lifted out and
   * become independently meaningful. Splitting one produces two files that must
   * both be imported at every call site.
   * PREDICATE: exactly one exported class, at most `MAX_SURFACE_STATE` private
   * mutable fields, and no single method longer than `MAX_METHOD_LINES` — one
   * long method inside a short-method file is accretion hiding in a surface.
   */
  | 'operation-surface'
  /**
   * One owner holds mutually-coupled protected state. Splitting it would share
   * those maps across siblings, which is the coupling the decomposition exists
   * to remove — the argument the Phase 4 ledger already accepted by name for
   * the session-state service.
   * PREDICATE: exactly one exported class; every field named in
   * `protectedState` is still declared private on it; EVERY private mutable
   * field in the file is named in that list (state you did not declare is state
   * nobody reviewed); and the list is at most `MAX_COUPLED_STATE` long, because
   * past that "one owner of coupled state" stops being a description of the
   * file and starts being an excuse for it.
   */
  | 'cohesive-owner'
  /**
   * A service that composes capability modules over ONE store, with no
   * inheritance — POD-320's shape. The line count is the sum of the
   * capabilities it composes, and each capability is separately addressable.
   * PREDICATE: no `extends` anywhere in the file, and every module named in
   * `capabilities` is actually imported by it.
   */
  | 'capability-composition'

export interface LedgerEntry {
  /** Repo-relative path. */
  readonly file: string
  readonly kind: ExceptionKind
  /**
   * Physical lines past which this review is VOID and must be redone. Set by
   * hand when the argument is made. There is no flag that rewrites it.
   *
   * DELIBERATELY LOOSE — roughly 15–25% above the reviewed size, not the
   * reviewed size itself. This is NOT a ratchet, and the difference matters:
   * a bound pinned to today's number would fire on every ordinary additive
   * change a neighbouring issue makes, and a gate that must be re-baselined on
   * every merge teaches everyone to re-baseline it without reading it — at
   * which point the number is noise and the argument beside it stops being
   * read too. The `kind` predicate is what catches a module CHANGING SHAPE
   * (growing state, growing a class, growing a long method); this only catches
   * growth so large that the reviewer's mental model of the file is simply
   * gone. Two different failures, two different mechanisms.
   */
  readonly budget: number
  /** The issue or document where the argument was reviewed. */
  readonly review: string
  /** The argument. Prose, required, and checked for length — a shrug is not one. */
  readonly argument: string
  /** `cohesive-owner`: the coupled fields that may not be split apart. */
  readonly protectedState?: readonly string[]
  /** `capability-composition`: the capability modules composed here. */
  readonly capabilities?: readonly string[]
  /** `declaration-table`: the export that IS the table. */
  readonly table?: string
}

const MIN_ARGUMENT = 180

/**
 * The bounds the two behavioural kinds are held to.
 *
 * These are the only numbers in this file that could be accused of being
 * arbitrary, so they are calibrated against the tree rather than chosen.
 * Measured at the candidate (`--sizes`), counting only OWNED state and not
 * injected collaborators:
 *
 *   store/issues.ts, store/workflows.ts, machines/rpc.ts, crud, reads,
 *   workflows/service.ts, automations, server.ts .............  0 fields
 *   store/sessions.ts, settings/service.ts, steward.ts .......  1 field
 *   issues/service/core.ts, machines/service.ts ..............  4 fields
 *   superagent/service.ts ....................................  7 fields
 *   session-state/service.ts (the ledger's named exception) ..  10 fields
 *   messaging/service.ts .....................................  11 fields
 *   -------------------------------------------------------------------
 *   messages/service.ts ......................................  18 fields
 *
 * There is a clean gap between 11 and 18, and `messages/service.ts` — six
 * delivery timers, three target sets, a retry cursor and a spawn budget in one
 * object — is on the far side of it. `MAX_COUPLED_STATE` sits in that gap.
 *
 * A NOTE ON WHAT THESE BOUNDS DO NOT CATCH, so nobody reads a pass as more than
 * it is: `sessions/lifecycle.ts` owns only 3 fields and would clear the state
 * bound comfortably. Its problem is not hoarded state, it is that ninety-six
 * methods across six responsibilities hang off those three fields. No structural
 * bound in this file detects that; the WRITTEN ARGUMENT is what detects it,
 * because nobody can truthfully write "this module does one job" about it. The
 * predicates stop an accepted argument from rotting. They do not manufacture one.
 */
const MAX_SURFACE_STATE = 2
const MAX_COUPLED_STATE = 12
/**
 * One 200-line method in a file of 20-line methods is not a surface.
 *
 * Applied to `operation-surface` ONLY, and deliberately not to
 * `cohesive-owner`. The surface claim IS "many small independent operations",
 * so a single long method falsifies it directly. The owner claim is about state
 * coupling and says nothing about method length — applying this bound there
 * would silently overturn `steward.ts`, an exception POD-355 reviewed and
 * accepted on cohesion grounds, on a criterion that review never considered.
 */
const MAX_METHOD_LINES = 180

/**
 * THE LEDGER. One entry per production module over the threshold.
 *
 * A module over the line and absent from this list is an audit item. Adding an
 * entry means writing an argument and choosing a kind whose predicate the file
 * can actually satisfy — which is why the honest way to clear an item is often
 * to decompose the module instead.
 */
export const GOD_OBJECT_LEDGER: readonly LedgerEntry[] = [
  // -- Declarations: no behaviour to distribute -------------------------------
  {
    file: 'apps/server/src/store/types.ts',
    kind: 'type-declarations',
    budget: 750,
    review: 'POD-1385',
    argument:
      'Row and domain types shared by the per-aggregate repositories and re-exported from `../store`. It has no runtime existence whatsoever — every export is a `type` or an `interface`, so the compiled module is empty. Splitting it would distribute a vocabulary across files without changing a single edge in the module graph, and would break the one import path (`../store`) that every repository already reads it by.',
  },
  {
    file: 'apps/server/src/migrations/schema.ts',
    kind: 'declaration-table',
    budget: 1600,
    review: 'POD-1385 / [spec:SP-4428]',
    table: 'sessions',
    argument:
      'The server schema as drizzle-kit schema-as-code: 65 table declarations, no classes, no state, no control flow at all. It is the declared source of truth for `drizzle-kit generate` and `check`, which resolve ONE schema entry point — splitting it would either break that contract or require a barrel that re-exports every table, moving the same 65 declarations behind an extra hop. Its length is the number of tables the product has.',
  },
  {
    file: 'apps/server/src/composition/reactions.ts',
    kind: 'declaration-table',
    budget: 800,
    review: 'POD-1385 / POD-355',
    table: 'REACTIONS',
    argument:
      'The total operational contract for every semantically asynchronous reaction, deliberately expressed as data rather than as prose beside a subscriber: each entry must choose its principal, replay mode and identity properties before it can exist, and `assertReactionRegistryTotal` re-checks that totality at runtime so a generated definition cannot bypass the compiler. The file is one row per reaction. Splitting the registry would split the totality check, which is the only thing making the contract exhaustive.',
  },
  {
    file: 'apps/server/src/modules/superagent/tools.ts',
    kind: 'declaration-table',
    budget: 1100,
    review: 'POD-1385',
    table: 'buildSuperagentTools',
    argument:
      'The orchestrator tool belt: one entry per tool, each a spec plus the implementation the MCP surface and the harness allowlist both read. It exports no class and owns no state; every tool is independently readable and independently removable, and the file length is the number of tools the superagent has. Grouping the tools into themed files would create several import sites for one allowlist that must stay exhaustive, which is the property `harnessAllowedTools` depends on.',
  },
  {
    file: 'apps/server/src/modules/issues/registry.ts',
    kind: 'declaration-table',
    budget: 1400,
    review: 'POD-1398',
    table: 'issueRegistry',
    argument:
      'One row per issue command: the handler, the tRPC `kind` it mounts as, and the target extractor, joined by `def()` to the L1 contract that owns its schema and policy. POD-1398 removed the two objects this file also shipped — `IssueCommandCtx` (what a handler is handed) went to `command-ctx.ts` and `IssueCommandDispatcher` (how a row is chosen and run) to `dispatcher.ts`, in that dependency order, so the table now imports the context as a TYPE only and nothing imports the table back. What is left holds no state and exports no object; its length is the number of commands the issue tracker has, and every row is independently readable. Splitting the rows into themed files would split the `satisfies Record<IssueContractName, AnyIssueCommandDef>` pin, which is the only thing making handler-to-contract coverage total in both directions.',
  },

  // -- The composition root ---------------------------------------------------
  {
    file: 'apps/server/src/relay.ts',
    kind: 'composition-root',
    // Extra headroom on purpose: POD-1386 is landing an additive dispatch arm
    // here beside the quota arm. A budget that refused a neighbour's in-flight
    // additive change would be an audit that blocks the work it exists to
    // describe, and would be re-baselined rather than read.
    budget: 2300,
    review: 'POD-1385 / POD-321 / POD-734',
    argument:
      'The server composition root: `SessionRegistry` names and constructs every runtime module once, in dependency order, inside one constructor. Its size is the size of the system rather than an accretion of responsibility — it decides nothing, it only wires, and the one piece of domain logic it still holds is flagged separately below. Splitting it into sub-roots is the specific move that would defeat the guarantee: `scripts/server-construction-order.ts` proves the order is topological by walking THIS constructor, and edges moved into a sub-root would leave its view. The committed record reports 52 declarations, 0 forward dependencies, 0 deferred service closures and 0 non-null late bindings, and this entry is void the moment any of those stops being zero.',
  },

  // -- Surfaces: many operations, nothing shared to entangle through ----------
  {
    file: 'apps/server/src/modules/machines/rpc.ts',
    kind: 'operation-surface',
    budget: 1000,
    review: 'POD-1385',
    argument:
      'Every server-to-daemon round-trip as an ordinary awaited method, and nothing else: it owns NO correlation state at all — the twenty-three pending maps it used to hold are one shared registry in `modules/daemon-request.ts` since that decomposition already happened. What is left is 38 independent calls, each naming which control message it builds, which machine it targets and what a timeout means for that caller. There is no shared state for any subset of them to entangle through, so no subset can be lifted out and mean anything on its own.',
  },
  {
    file: 'apps/server/src/store/issues.ts',
    kind: 'operation-surface',
    budget: 1000,
    review: 'POD-1385',
    argument:
      'The issues aggregate: the `issues` table and its child tables (`issue_labels`, `issue_deps`, `issue_comments`, `issue_messages`) behind 39 query methods and zero fields. A repository with no state cannot be a god of anything — its length is the number of queries the aggregate answers. Splitting by child table would put a single aggregate transaction across several objects, which is the one thing an aggregate boundary exists to prevent.',
  },
  {
    file: 'apps/server/src/store/sessions.ts',
    kind: 'operation-surface',
    budget: 900,
    review: 'POD-1385',
    argument:
      'The sessions aggregate: the `sessions` table plus its UI-adjacent satellites (`pins`, `snoozes`, `tab_order`, `session_drafts`), which share its soft-deletion and purge semantics and therefore cannot be owned elsewhere without duplicating that rule. 37 query methods over a single cached column-shape probe; no other state. Its length is the number of queries, not a count of jobs.',
  },
  {
    file: 'apps/server/src/store/workflows.ts',
    kind: 'operation-surface',
    budget: 750,
    review: 'POD-1385 / POD-362',
    argument:
      'The workflows aggregate: run rows and their state transitions behind 28 stateless query methods. A large share of the file is the discriminated `WorkflowActor` union POD-362 introduced so that the operator arm cannot carry a session id — declarations that make an illegal pair unrepresentable, not behaviour. Nothing is shared between the methods, so nothing can be separated out of them.',
  },
  {
    file: 'apps/server/src/modules/issues/service/crud.ts',
    kind: 'operation-surface',
    budget: 950,
    review: 'POD-1385 / POD-320',
    argument:
      'One of the capability modules POD-320 composed over the single `IssueStore` when it dissolved the IssueService inheritance chain — the create/update/delete half, reached through narrow constructor ports and holding no state of its own. This file IS the result of the decomposition the Phase 4 criterion asks for; re-splitting a capability that already sits behind its own port would add a module boundary without moving a responsibility, and the issue brief names preserving this one-store capability composition as a constraint.',
  },
  {
    file: 'apps/server/src/modules/issues/service/reads.ts',
    kind: 'operation-surface',
    budget: 850,
    review: 'POD-1385 / POD-320',
    argument:
      'The read/report capability of the same POD-320 composition: search, stats, graph, lint and doctor projections over the shared `IssueStore`, with no state and no method longer than 80 lines. Reads are grouped here precisely so that the visibility policy (`DEFAULT_ISSUE_REPORT_VISIBILITY`) has one place to be applied rather than one per report; splitting the reports apart would put that policy on several files and make a missed application invisible.',
  },
  {
    file: 'apps/server/src/modules/workflows/service.ts',
    kind: 'operation-surface',
    budget: 850,
    review: 'POD-1385 / POD-732',
    argument:
      'The workflow engine surface: 40 small methods implementing the run arithmetic and the state machine, deliberately exposed to handlers through the narrower `WorkflowEngine` interface so that a handler cannot reach a guard by accident — authorization arrives through `ctx.access` or not at all. The interface is a written list of what still has to move when POD-732 finishes its cut, placed where the next reader finds it. No owned state; no method over 101 lines.',
  },
  {
    file: 'apps/server/src/modules/automations/service.ts',
    kind: 'operation-surface',
    budget: 800,
    review: 'POD-1385',
    argument:
      "The scheduled-automations surface: 30 stateless methods covering definition CRUD, cron evaluation and run dispatch for the Automations tab. The scheduler timer that would be this module's state lives on the composition root, which owns process-lifetime timers so that shutdown can cancel them in one place; what is left here holds nothing and shares nothing between its methods.",
  },
  {
    file: 'apps/server/src/server.ts',
    kind: 'operation-surface',
    budget: 800,
    review: 'POD-1385',
    argument:
      'HTTP server startup: bind-host resolution, port-in-use classification, route registration and the returned handle. 21 short functions, no owned state, longest 77 lines. Its length comes from the number of routes the server registers, and each registration is independently readable. Splitting route registration from lifecycle would separate `startServer` from the routes whose failures it must classify and report through `PortInUseError`.',
  },
  {
    file: 'apps/server/src/modules/settings/service.ts',
    kind: 'operation-surface',
    budget: 850,
    review: 'POD-1385',
    argument:
      'The settings surface: 32 short accessors and mutators over the settings store, plus the Telegram setup handshake and its one in-flight map. Half of the file — 354 of its 713 physical lines — is the written record of why the handshake polls the way it does and which principal each setting resolves for; the code itself is 359 lines, comfortably under the threshold. Removing that record to make a number smaller would delete the only explanation of a protocol nobody else in the tree implements.',
  },

  {
    file: 'apps/server/src/modules/sessions/command-plane.ts',
    kind: 'documented',
    budget: 800,
    review: 'POD-1385 / POD-381 / POD-379',
    argument:
      "The L3 session command handlers: 321 lines of code behind a 328-line written record, which is why it crosses a physical-line screen at all. That record is load-bearing rather than decorative — it states which half of each command the CONTRACT owns (authz, idempotency, envelope) and which half the HANDLER owns (the daemon control leg), which is the split that stopped tRPC and relay from authorizing `sessions.sendText` two different ways; and it pins every not-found shape POD-379's oracle fixed, per command, so a future edit cannot quietly turn a silent no-op into a thrown error. Deleting the explanation to pass a line count would delete the only statement of the invariant the file exists to hold.",
  },

  // -- Owners: coupled state that a split would have to share ----------------
  {
    file: 'apps/server/src/modules/issues/service/core.ts',
    kind: 'cohesive-owner',
    budget: 1050,
    review: 'POD-1385 / POD-320',
    protectedState: ['hydrated', 'viewerState', 'wireCache', 'issueInputsGen'],
    argument:
      'The single `IssueStore` that POD-320\'s six capability modules compose over — the "one store" the issue brief names as the shape to preserve. Its four fields are one mechanism, not four: `wireCache` is a projection of the hydrated rows, `issueInputsGen` is the generation counter that invalidates it, `viewerState` is the per-viewer overlay merged into the same projection, and `hydrated` gates all three before load. Splitting them would put a cache, its invalidation counter and its overlay in different objects and require the capabilities to keep them coherent, which is exactly the coupling the store exists to hold. 510 of its 934 lines are code.',
  },
  {
    file: 'apps/server/src/modules/machines/service.ts',
    kind: 'cohesive-owner',
    budget: 800,
    review: 'POD-1385',
    protectedState: ['daemons', 'pendingByMachine', 'machineRecordsCache', 'machineNameCache'],
    argument:
      'Machine INVENTORY in one owner: the live daemon set, the offline queue, the row caches, and the selection/routing that reads them. `daemons` is the live connection map and `pendingByMachine` is the queue for a machine that is briefly offline — a message must move between them atomically or it is dropped or doubled, so they cannot be separated. The two caches are derived from the same rows and invalidated on the same writes. POD-1467 re-reviewed this after POD-1114/POD-1125 grew the file past 800 and found a SECOND job had accreted: the credential lifecycle (pair/hello, the D19.4 verdict for an absent row, ledger→row owner projection), which touches none of the four protected fields. It now lives in `machines/enrollment.ts` and reaches this owner only through the `EnrollmentHost` port — deps plus the two inventory effects a credential write has. `revokeMachine` deliberately stayed here: it deletes the live socket out of `daemons`. POD-1505 applied that same seam a second time: `transferMachineOwnership` (POD-1480) and `adoptMachine` (POD-1494) had landed here after the cut and pushed the file two lines past the budget, and an ownership transition is identity over time rather than inventory — both append an owner event to the enrollment ledger and project it onto the row, which is what `enrollment.ts` already does. They moved there behind the same `EnrollmentHost` port, leaving one-line delegates on this class for its callers. The budget is UNCHANGED at 800 across both decompositions and the file is 434 lines of code under it.',
  },
  {
    file: 'apps/server/src/modules/issues/service/workflow.ts',
    kind: 'cohesive-owner',
    budget: 1300,
    review: 'POD-1385 / POD-320',
    protectedState: [
      'integratingEpics',
      'assistantTimers',
      'gitRefreshes',
      'gitCommitsBySession',
      'gitTouchedBySession',
    ],
    argument:
      'The git-workflow capability of the POD-320 composition: branch/worktree lifecycle and the per-session git projection. Its five fields are one debounce mechanism over one subject — `gitRefreshes` holds the in-flight refresh per repo, and `gitCommitsBySession`/`gitTouchedBySession` are the per-session accumulations that refresh coalesces and publishes. Splitting the accumulators from the debounce would let a refresh publish a half-accumulated projection, a race with no local test that could catch it.',
  },
  {
    file: 'apps/server/src/steward.ts',
    kind: 'cohesive-owner',
    budget: 1200,
    review: 'POD-355 (boundary ownership review) / POD-1385',
    protectedState: ['timer'],
    argument:
      'REVIEWED AND ACCEPTED BY POD-355, preserved here rather than re-decided: the steward is the trigger/subscription engine over the event log, at 1080 physical and 701 code lines, and POD-355 measured it against the two nouns a proposal wanted to split out. Attention stays inside IssueService because extracting it would re-introduce a cross-service edge to read rows it owns locally; telemetry stays standalone because folding an 82-line leaf into this module would strictly reduce cohesion. POD-355 recorded the measurement that would overturn this — a direct dependency edge between any two of the three nouns, or a second consumer of attention — and neither exists. It holds one field, its poll timer.',
  },
  {
    file: 'apps/server/src/modules/superagent/service.ts',
    kind: 'cohesive-owner',
    budget: 1350,
    review: 'POD-1385',
    protectedState: [
      'turnInFlight',
      'dispatchedTurnIds',
      'preparingInputs',
      'mcpEndpoint',
      'mcpTokenToThread',
      'mcpThreadToToken',
      'issueTools',
    ],
    argument:
      'One superagent turn at a time, and the MCP identity that turn is reachable through. `turnInFlight`, `dispatchedTurnIds` and `preparingInputs` are a single-flight guard in three parts — admitting a turn, remembering it was dispatched, and holding its input while it is prepared — and a duplicate dispatch is the failure they exist to prevent, so they must be read and written together. `mcpTokenToThread` and `mcpThreadToToken` are two directions of one binding and must never disagree. Splitting either pair creates a window where a turn is in one map and not the other.',
  },
  {
    file: 'apps/server/src/modules/sessions/session-state/service.ts',
    kind: 'cohesive-owner',
    budget: 800,
    review: 'POD-393 Phase 4 ledger entry / POD-1385',
    protectedState: [
      'overlays',
      'drafts',
      'draftDocs',
      'draftTimes',
      'draftWriteTimers',
      'draftDocWriteTimers',
      'draftInjectTimers',
      'draftSendSuppressUntil',
      'draftSyncEnabled_',
      'lastPriority',
    ],
    argument:
      'THE EXCEPTION THE PHASE 4 LEDGER ALREADY ACCEPTED BY NAME, recorded here in checkable form. POD-393: "one owner must hold the mutually coupled overlay cache, draft document/timers and priority dedupe cache; splitting those protected maps back across lifecycle/inbox siblings would recreate the god-object coupling." The ten fields are three coupled groups — the overlay cache, the draft document with its four write/inject timers and suppression window, and the priority dedupe cache — and the siblings reach none of them: they receive callbacks through explicit ports. 44 methods with a longest span of 40 lines, which is what a file of small operations over protected state looks like.',
  },
  {
    file: 'apps/server/src/modules/messaging/service.ts',
    kind: 'cohesive-owner',
    budget: 950,
    review: 'POD-1385 / [spec:SP-5d81] / [spec:SP-62c3]',
    protectedState: [
      'adapter',
      'adapterKey',
      'lastInboundRefByChat',
      'queues',
      'awaiting',
      'dispatching',
      'topicThreadByRef',
      'topicRefByIssue',
      'typingLeases',
      'ambientTypingBySession',
      'lastActivityByThreadRef',
    ],
    argument:
      "The two-way chat bridge, whose eleven fields are one live connection's bookkeeping: the adapter and its key, the per-thread dispatch queues with their awaiting/dispatching guards, the two directions of the issue-topic binding, and the typing leases. The leases are the reason the pieces cannot separate — the superagent-turn path and the ambient working-signal path share one per-topic lease specifically so the two never double-fire, which only works while one object holds both. The topic maps are two directions of one binding and must not disagree.",
  },
  {
    file: 'apps/server/src/modules/sessions/session.ts',
    kind: 'cohesive-owner',
    budget: 850,
    review: 'POD-1385',
    protectedState: ['onUnreadRearm', 'workingMsTotal', 'incomingWorkingMsTotal'],
    argument:
      'The session entity itself — the in-memory object every other sessions module holds a reference to, carrying its durable fields, its volatile terminal counters and the publication authority. Its three fields are the working-time accumulators and the unread re-arm hook, which advance together on the same state transitions. This is a domain object rather than a service: splitting it would mean splitting the identity that the maps in lifecycle, repository and state are all keyed on. 507 of its 716 lines are code.',
  },
  {
    file: 'apps/server/src/modules/messages/service.ts',
    kind: 'cohesive-owner',
    budget: 2100,
    review: 'POD-1397 / POD-1385',
    protectedState: ['turnHop', 'requeueCounts', 'attentionEmitted', 'sessionIssueTargets'],
    argument:
      "The push path: admit a send (clamp matrix, brakes, hop), write the row, resolve the recipient AT DELIVERY TIME, inject or spawn or dead-letter, and confirm. POD-1397 took eighteen owned fields down to four by giving four capabilities their own owners — rendering and the confirmation mode that follows from it (render.ts), containment brakes 1 and 2 with their timers (brakes.ts), the three entry paths into delivery scheduling with theirs (scheduler.ts), and the pull path of reads, replies and bounded waits (mailbox.ts). Each took its state with it; none of them holds a reference to a map or a timer owned by another, and every RETAINED timer in the module now has exactly one disposer — the two bounded polls in `mailbox.ts` are per-call and deliberately outside the disposal contract, which their header says. The four fields that remain are what stops the residue splitting further: `sessionIssueTargets` is the session→issue resolution that admission, delivery, the brake keys and the eligibility events all read, `turnHop` is written at injection and read by the next send from that session, `requeueCounts` bounds the lost-echo loop between prepare and confirm, and `attentionEmitted` dedupes needs-attention across the spawn, delivery and dead-letter paths. Cutting admission from delivery, or either from the eligibility events, would share all four by reference — the observationLeases shape this audit warns a split can hide. 1190 of its 1797 lines are code; `send()` is the one long method at 210 physical / 148 code (the next is `attemptDelivery` at 158), and the `cohesive-owner` kind deliberately does not bound method length — MAX_METHOD_LINES belongs to `operation-surface`, whose claim is 'many small operations'. Stated because a ledger entry is what the next reviewer trusts instead of re-measuring: `send()` is over the surface bound and is not held to it. [POD-1385 review]",
  },
]

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** §1 Every module over the threshold has an entry. This is the criterion. */
export const checkUnexplained = (
  measured: readonly Measurement[],
  ledger: readonly LedgerEntry[],
): Finding[] => {
  const known = new Set(ledger.map((e) => e.file))
  return measured
    .filter((m) => !known.has(m.file))
    .map((m) => ({
      check: 'unexplained-god-object',
      where: m.file,
      detail: `${m.physical} physical lines (${m.code} code) is over the ${THRESHOLD}-line review threshold and no ledger entry answers for it. Decompose it, or add an entry whose kind the file can satisfy.`,
    }))
}

/** §2 Every entry still describes a module that is over the threshold. A stale
 *  entry is how a ledger silently becomes fiction: the file was decomposed or
 *  deleted, and its argument now defends nothing. */
export const checkStale = (
  measured: readonly Measurement[],
  ledger: readonly LedgerEntry[],
): Finding[] => {
  const over = new Map(measured.map((m) => [m.file, m]))
  return ledger
    .filter((e) => !over.has(e.file))
    .map((e) => ({
      check: 'stale-ledger-entry',
      where: e.file,
      detail: `The ledger carries an exception for this module, but it is not over the ${THRESHOLD}-line threshold (it may have been decomposed, renamed or deleted). Remove the entry — an argument for a file that no longer needs one is not evidence, it is noise the next reviewer has to disprove.`,
    }))
}

/** §3 No entry has outgrown the review that justified it. */
export const checkBudget = (
  measured: readonly Measurement[],
  ledger: readonly LedgerEntry[],
): Finding[] => {
  const findings: Finding[] = []
  for (const entry of ledger) {
    const m = measured.find((x) => x.file === entry.file)
    if (!m) continue
    if (m.physical > entry.budget)
      findings.push({
        check: 'review-budget-exceeded',
        where: entry.file,
        detail: `${m.physical} physical lines is past the reviewed budget of ${entry.budget} (${entry.review}). Growth past the budget voids the argument: re-review the module, then either decompose it or raise the budget deliberately in a commit.`,
      })
  }
  return findings
}

/** §4 Every argument is an argument. */
export const checkArgument = (ledger: readonly LedgerEntry[]): Finding[] => {
  const findings: Finding[] = []
  for (const entry of ledger) {
    if (entry.argument.trim().length < MIN_ARGUMENT)
      findings.push({
        check: 'argument-too-thin',
        where: entry.file,
        detail: `The argument is ${entry.argument.trim().length} characters; ${MIN_ARGUMENT} is the floor. State what the module owns, why that is one job, and what splitting it would couple — not that the file is big.`,
      })
    if (entry.review.trim() === '')
      findings.push({
        check: 'argument-unreviewed',
        where: entry.file,
        detail:
          'No review reference. Name the issue or document where this exception was accepted.',
      })
  }
  return findings
}

/** §5 The structural claim each kind makes is still true of the file today.
 *  This is the check that stops the ledger from being a rubber stamp. */
export const checkPredicate = (
  measured: readonly Measurement[],
  ledger: readonly LedgerEntry[],
  constructionOrderClean: boolean,
  declaredRoot: string,
): Finding[] => {
  const findings: Finding[] = []
  const fail = (where: string, detail: string) =>
    findings.push({ check: 'exception-predicate-failed', where, detail })

  for (const entry of ledger) {
    const m = measured.find((x) => x.file === entry.file)
    if (!m) continue
    switch (entry.kind) {
      case 'type-declarations':
        if (m.runtimeExports.length > 0)
          fail(
            entry.file,
            `Claims 'type-declarations', but exports ${m.runtimeExports.length} runtime symbol(s): ${m.runtimeExports.slice(0, 5).join(', ')}. The module now has runtime existence and the exception no longer holds.`,
          )
        break
      case 'declaration-table': {
        if (m.exportedClasses.length > 0)
          fail(
            entry.file,
            `Claims 'declaration-table', but exports ${m.exportedClasses.length} class(es) (${m.exportedClasses.join(', ')}). A table that also ships an object is two things in one file, and the object is the half nobody reviewed.`,
          )
        if (m.privateStateFields.length > 0)
          fail(
            entry.file,
            `Claims 'declaration-table', but holds owned mutable state (${m.privateStateFields.join(', ')}). A table with state is a service.`,
          )
        if (entry.table && !m.runtimeExports.includes(entry.table))
          fail(
            entry.file,
            `Claims 'declaration-table' with table export '${entry.table}', which the module does not export.`,
          )
        break
      }
      case 'composition-root':
        if (entry.file !== declaredRoot)
          fail(
            entry.file,
            `Claims 'composition-root', but the declared root is ${declaredRoot}. There is exactly one; a second root is a second place edges can hide.`,
          )
        else if (!constructionOrderClean)
          fail(
            entry.file,
            'Claims `composition-root`, but the committed construction-order record does not report 0 forward dependencies, 0 deferred service closures and 0 non-null late bindings. An unordered root is not a root, it is a god object with a topological excuse.',
          )
        break
      case 'documented':
        if (m.code > THRESHOLD)
          fail(
            entry.file,
            `Claims 'documented', but ${m.code} code lines is itself over the ${THRESHOLD}-line threshold. The bulk is no longer documentation.`,
          )
        break
      case 'operation-surface': {
        if (m.exportedClasses.length !== 1)
          fail(
            entry.file,
            `Claims 'operation-surface', but exports ${m.exportedClasses.length} classes (${m.exportedClasses.join(', ') || 'none'}). A surface is one class's operations.`,
          )
        if (m.privateStateFields.length > MAX_SURFACE_STATE)
          fail(
            entry.file,
            `Claims 'operation-surface', but holds ${m.privateStateFields.length} private mutable fields (${m.privateStateFields.slice(0, 6).join(', ')}); ${MAX_SURFACE_STATE} is the ceiling. Once the methods share state they can entangle through it, and the module is an owner that has to argue its cohesion.`,
          )
        if (m.maxMethodLines > MAX_METHOD_LINES)
          fail(
            entry.file,
            `Claims 'operation-surface', but its longest method spans ${m.maxMethodLines} lines (mean ${m.meanMethodLines.toFixed(0)}); ${MAX_METHOD_LINES} is the ceiling. A surface is many small operations — one long method among them is the accretion this audit looks for, hiding inside a file whose average looks fine.`,
          )
        break
      }
      case 'cohesive-owner': {
        if (m.exportedClasses.length !== 1)
          fail(
            entry.file,
            `Claims 'cohesive-owner', but exports ${m.exportedClasses.length} classes (${m.exportedClasses.join(', ') || 'none'}). One owner means one class.`,
          )
        const declared = entry.protectedState ?? []
        if (declared.length === 0)
          fail(
            entry.file,
            "Claims 'cohesive-owner' without naming the coupled state. Name the fields whose sharing the split would cause; that list is what the next reviewer checks.",
          )
        if (declared.length > MAX_COUPLED_STATE)
          fail(
            entry.file,
            `Claims 'cohesive-owner' over ${declared.length} coupled fields; ${MAX_COUPLED_STATE} is the ceiling. Past that the claim is no longer that one owner holds coupled state — it is that everything in the file happens to live there. Decompose it.`,
          )
        for (const field of declared)
          if (!m.privateFields.includes(field))
            fail(
              entry.file,
              `Claims '${field}' is protected state held by one owner, but it is not declared private on the class. Either it escaped, or the argument is out of date.`,
            )
        // State that is not declared is state nobody reviewed. Without this the
        // kind degrades into "name two fields and keep the other fourteen".
        for (const field of m.privateStateFields)
          if (!declared.includes(field))
            fail(
              entry.file,
              `Holds private mutable state '${field}' that the ledger entry does not name. Every piece of coupled state has to be on the list the reviewer read, or the argument is about a smaller module than the one on disk.`,
            )
        break
      }
      case 'capability-composition': {
        if (m.hasInheritance)
          fail(
            entry.file,
            "Claims 'capability-composition', but the file contains `class X extends Y`. POD-320 dissolved that inheritance deliberately; composition over one store is the shape being defended.",
          )
        const caps = entry.capabilities ?? []
        if (caps.length < 2)
          fail(
            entry.file,
            "Claims 'capability-composition' but names fewer than two capabilities. One capability is not a composition.",
          )
        for (const cap of caps)
          if (!m.imports.some((i) => i.includes(cap)))
            fail(
              entry.file,
              `Names capability '${cap}', which this module does not import. The composition described is not the composition compiled.`,
            )
        break
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Construction-order evidence (read, never regenerated here)
// ---------------------------------------------------------------------------

const CONSTRUCTION_ORDER_DOC = 'docs/architecture/server-construction-order.md'
const DECLARED_ROOT = 'apps/server/src/relay.ts'

export const readConstructionOrderClean = (root = ROOT): boolean => {
  try {
    const doc = readFileSync(join(root, CONSTRUCTION_ORDER_DOC), 'utf8')
    return (
      /Forward dependencies:\s*0\b/.test(doc) &&
      /Deferred service closures:\s*0\b/.test(doc) &&
      /Non-null late bindings:\s*0\b/.test(doc)
    )
  } catch {
    return false
  }
}

export const auditRepo = (root = ROOT): Finding[] => {
  const measured = screen(root)
  return [
    ...checkUnexplained(measured, GOD_OBJECT_LEDGER),
    ...checkStale(measured, GOD_OBJECT_LEDGER),
    ...checkBudget(measured, GOD_OBJECT_LEDGER),
    ...checkArgument(GOD_OBJECT_LEDGER),
    ...checkPredicate(measured, GOD_OBJECT_LEDGER, readConstructionOrderClean(root), DECLARED_ROOT),
  ]
}

// ---------------------------------------------------------------------------
// The probe — prove every check can say YES before believing it said NO
// ---------------------------------------------------------------------------

const M = (over: Partial<Measurement> = {}): Measurement => ({
  file: 'probe/module.ts',
  physical: 900,
  code: 700,
  runtimeExports: [],
  exportedClasses: ['One'],
  hasInheritance: false,
  controlFlow: 0,
  imports: [],
  privateFields: [],
  privateStateFields: [],
  methodCount: 10,
  meanMethodLines: 20,
  maxMethodLines: 40,
  topLevelStatements: 0,
  ...over,
})

const ENTRY = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  file: 'probe/module.ts',
  kind: 'operation-surface',
  budget: 1000,
  review: 'POD-1385',
  argument:
    'A probe fixture whose argument is deliberately long enough to clear the length floor, so that the length check is not what any other probe case is accidentally measuring when it expects a clean result.',
  ...over,
})

/** Every check, pointed at a planted violation and at a clean fixture. A check
 *  that cannot say YES is not evidence when it says NO. */
export const probe = (): Finding[] => {
  const broken: Finding[] = []
  const expect = (check: string, dirty: Finding[], clean: Finding[]): void => {
    if (!dirty.some((f) => f.check === check))
      broken.push({ check, where: '<probe>', detail: 'missed its planted violation' })
    if (clean.length > 0)
      broken.push({
        check,
        where: '<probe>',
        detail: `fired on the clean fixture: ${clean.map((f) => f.check).join(', ')}`,
      })
  }

  expect('unexplained-god-object', checkUnexplained([M()], []), checkUnexplained([M()], [ENTRY()]))

  expect('stale-ledger-entry', checkStale([], [ENTRY()]), checkStale([M()], [ENTRY()]))

  expect(
    'review-budget-exceeded',
    checkBudget([M({ physical: 1001 })], [ENTRY({ budget: 1000 })]),
    checkBudget([M({ physical: 999 })], [ENTRY({ budget: 1000 })]),
  )

  expect(
    'argument-too-thin',
    checkArgument([ENTRY({ argument: 'it is big' })]),
    checkArgument([ENTRY()]),
  )

  expect('argument-unreviewed', checkArgument([ENTRY({ review: '  ' })]), checkArgument([ENTRY()]))

  const pred = (m: Measurement, e: LedgerEntry, clean = true, root = DECLARED_ROOT): Finding[] =>
    checkPredicate([m], [e], clean, root)

  expect(
    'exception-predicate-failed',
    pred(M({ runtimeExports: ['thing'] }), ENTRY({ kind: 'type-declarations' })),
    pred(M({ runtimeExports: [], exportedClasses: [] }), ENTRY({ kind: 'type-declarations' })),
  )

  // Each remaining kind gets its own dirty/clean pair; they all report through
  // the same `check` token, so they are asserted one at a time.
  const kindCases: { name: string; dirty: Finding[]; clean: Finding[] }[] = [
    {
      name: 'declaration-table that also ships a class',
      dirty: pred(
        M({ exportedClasses: ['Dispatcher'], runtimeExports: ['TABLE', 'Dispatcher'] }),
        ENTRY({ kind: 'declaration-table', table: 'TABLE' }),
      ),
      clean: pred(
        M({ exportedClasses: [], runtimeExports: ['TABLE'] }),
        ENTRY({ kind: 'declaration-table', table: 'TABLE' }),
      ),
    },
    {
      name: 'declaration-table that grew state',
      dirty: pred(
        M({ exportedClasses: [], runtimeExports: ['TABLE'], privateStateFields: ['cache'] }),
        ENTRY({ kind: 'declaration-table', table: 'TABLE' }),
      ),
      clean: pred(
        M({ exportedClasses: [], runtimeExports: ['TABLE'] }),
        ENTRY({ kind: 'declaration-table', table: 'TABLE' }),
      ),
    },
    {
      name: 'declaration-table lost its table',
      dirty: pred(
        M({ exportedClasses: [], runtimeExports: [] }),
        ENTRY({ kind: 'declaration-table', table: 'TABLE' }),
      ),
      clean: pred(
        M({ exportedClasses: [], runtimeExports: ['TABLE'] }),
        ENTRY({ kind: 'declaration-table', table: 'TABLE' }),
      ),
    },
    {
      name: 'composition-root with an unordered construction record',
      dirty: pred(
        M({ file: DECLARED_ROOT }),
        ENTRY({ file: DECLARED_ROOT, kind: 'composition-root' }),
        false,
      ),
      clean: pred(
        M({ file: DECLARED_ROOT }),
        ENTRY({ file: DECLARED_ROOT, kind: 'composition-root' }),
        true,
      ),
    },
    {
      name: 'a second composition root',
      dirty: pred(
        M({ file: 'apps/server/src/other-root.ts' }),
        ENTRY({ file: 'apps/server/src/other-root.ts', kind: 'composition-root' }),
      ),
      clean: pred(
        M({ file: DECLARED_ROOT }),
        ENTRY({ file: DECLARED_ROOT, kind: 'composition-root' }),
      ),
    },
    {
      name: 'documented, but the code itself is over the line',
      dirty: pred(M({ code: THRESHOLD + 1 }), ENTRY({ kind: 'documented' })),
      clean: pred(M({ code: THRESHOLD - 1 }), ENTRY({ kind: 'documented' })),
    },
    {
      name: 'surface that grew state',
      dirty: pred(M({ privateStateFields: ['a', 'b', 'c'] }), ENTRY({ kind: 'operation-surface' })),
      clean: pred(M({ privateStateFields: ['a'] }), ENTRY({ kind: 'operation-surface' })),
    },
    {
      name: 'surface hiding one long method',
      dirty: pred(
        M({ maxMethodLines: MAX_METHOD_LINES + 1 }),
        ENTRY({ kind: 'operation-surface' }),
      ),
      clean: pred(M({ maxMethodLines: MAX_METHOD_LINES }), ENTRY({ kind: 'operation-surface' })),
    },
    {
      name: 'cohesive owner with undeclared state',
      dirty: pred(
        M({ privateFields: ['a', 'b'], privateStateFields: ['a', 'b'] }),
        ENTRY({ kind: 'cohesive-owner', protectedState: ['a'] }),
      ),
      clean: pred(
        M({ privateFields: ['a', 'b'], privateStateFields: ['a', 'b'] }),
        ENTRY({ kind: 'cohesive-owner', protectedState: ['a', 'b'] }),
      ),
    },
    {
      name: 'cohesive owner naming a field that is not private',
      dirty: pred(
        M({ privateFields: [], privateStateFields: [] }),
        ENTRY({ kind: 'cohesive-owner', protectedState: ['escaped'] }),
      ),
      clean: pred(
        M({ privateFields: ['held'], privateStateFields: ['held'] }),
        ENTRY({ kind: 'cohesive-owner', protectedState: ['held'] }),
      ),
    },
    {
      name: 'cohesive owner over the coupling ceiling',
      dirty: (() => {
        const many = Array.from({ length: MAX_COUPLED_STATE + 1 }, (_, i) => `f${i}`)
        return pred(
          M({ privateFields: many, privateStateFields: many }),
          ENTRY({ kind: 'cohesive-owner', protectedState: many }),
        )
      })(),
      clean: (() => {
        const many = Array.from({ length: MAX_COUPLED_STATE }, (_, i) => `f${i}`)
        return pred(
          M({ privateFields: many, privateStateFields: many }),
          ENTRY({ kind: 'cohesive-owner', protectedState: many }),
        )
      })(),
    },
    {
      name: 'capability composition that grew inheritance',
      dirty: pred(
        M({ hasInheritance: true, imports: ['./a', './b'] }),
        ENTRY({ kind: 'capability-composition', capabilities: ['./a', './b'] }),
      ),
      clean: pred(
        M({ hasInheritance: false, imports: ['./a', './b'] }),
        ENTRY({ kind: 'capability-composition', capabilities: ['./a', './b'] }),
      ),
    },
    {
      name: 'capability composition naming a capability it does not import',
      dirty: pred(
        M({ imports: ['./a'] }),
        ENTRY({ kind: 'capability-composition', capabilities: ['./a', './ghost'] }),
      ),
      clean: pred(
        M({ imports: ['./a', './ghost'] }),
        ENTRY({ kind: 'capability-composition', capabilities: ['./a', './ghost'] }),
      ),
    },
  ]
  for (const c of kindCases) {
    if (c.dirty.length === 0)
      broken.push({
        check: 'exception-predicate-failed',
        where: c.name,
        detail: 'missed its planted violation',
      })
    if (c.clean.length > 0)
      broken.push({
        check: 'exception-predicate-failed',
        where: c.name,
        detail: `fired on the clean fixture: ${c.clean.map((f) => f.detail).join(' | ')}`,
      })
  }

  // The measurement itself has to be able to say YES: a comment-only line must
  // not count as code, or `documented` would pass for any file at all.
  const measured = measure('probe.ts', '/* a\n b */\n// c\nconst x = 1\n\nconst y = 2\n')
  if (measured.code !== 2)
    broken.push({
      check: 'measure-code-lines',
      where: '<probe>',
      detail: `counted ${measured.code} code lines in a fixture with exactly 2`,
    })
  const stateProbe = measure(
    'probe.ts',
    'class A {\n  private readonly dep: Dep\n  private readonly cache = new Map()\n  private cursor = 0\n}\n',
  )
  if (stateProbe.privateStateFields.includes('dep'))
    broken.push({
      check: 'measure-private-state',
      where: '<probe>',
      detail: 'counted an injected collaborator as mutable state',
    })
  if (
    !stateProbe.privateStateFields.includes('cache') ||
    !stateProbe.privateStateFields.includes('cursor')
  )
    broken.push({
      check: 'measure-private-state',
      where: '<probe>',
      detail: `missed owned state: saw ${JSON.stringify(stateProbe.privateStateFields)}`,
    })

  return broken
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = (): boolean => {
  const entry = process.argv[1]
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const wants = (flag: string): boolean => process.argv.includes(flag)

  // The probe runs FIRST, always, even without the flag.
  const probeFailures = probe()
  if (probeFailures.length > 0) {
    console.error('god-object audit: THE INSTRUMENT IS BROKEN — checks that cannot say YES:')
    for (const f of probeFailures) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
    process.exit(2)
  }
  if (wants('--probe'))
    console.log('god-object audit: every check found its planted fixture and spared the clean one')

  if (wants('--sizes')) {
    for (const m of screen())
      console.log(
        `${String(m.physical).padStart(5)} physical ${String(m.code).padStart(5)} code  ` +
          `state=${m.privateStateFields.length} methods=${m.methodCount} ` +
          `maxMethod=${m.maxMethodLines} classes=${m.exportedClasses.length} ` +
          `runtimeExports=${m.runtimeExports.length} cf=${m.controlFlow}  ${m.file}`,
      )
    process.exit(0)
  }

  const findings = auditRepo()
  if (wants('--json')) {
    console.log(JSON.stringify({ threshold: THRESHOLD, findings }, null, 2))
  } else if (findings.length === 0) {
    console.log(
      `god-object audit: clean — ${screen().length} production modules over ${THRESHOLD} lines, every one carrying a reviewed exception whose structural claim still holds`,
    )
  } else {
    console.error(`god-object audit: ${findings.length} item(s)`)
    for (const f of findings) console.error(`  ${f.check}  ${f.where}\n      ${f.detail}`)
  }
  process.exit(findings.length === 0 ? 0 : 1)
}
