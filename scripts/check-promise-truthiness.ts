/**
 * A PROMISE READ AS A YES/NO ANSWER (POD-3483; epic POD-3221, spec §6 rule 51).
 *
 * Run:
 *   bun run lint:promise-truthiness           # the gate — exit 1 on any finding
 *   bun run lint:promise-truthiness --probe   # prove the instrument can still fire
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 *
 * A promise is always truthy. So an expression whose type is `Promise<boolean>`,
 * read where a BOOLEAN is read, is a guard that has stopped deciding anything:
 * the true branch always runs and the false branch is unreachable. Nothing
 * type-errors, no test fails — a suite that already exercises the path stays
 * green, because the answer it asserts on is the one the guard now always gives.
 *
 * The async query flip (POD-3221) manufactures this class wholesale: a read that
 * returned `boolean` now returns `Promise<boolean>`, and every consumer that
 * forgot an `await` silently inverts into "always yes".
 *
 * POD-3487 is the worst instance and the reason this check exists. In
 * `applyAuthFromCeiling`:
 *
 *     if (ceiling.canSee({ kind: 'issue', id: message.toId })) return { ok: true } as const
 *     return { ok: false, reason: 'issue no longer exists' } as const
 *
 * `HumanCeiling.canSee` was declared `boolean | Promise<boolean>`, the server
 * supplied the async implementation, and this caller read it synchronously. The
 * refusal was unreachable: a message addressed to an issue beyond the delegating
 * human's ceiling was DELIVERED. That is an authorization bypass, and it survived
 * a suite that walks this exact path.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT THE EXISTING LINT, AND WHY BOTH STAY
 * ---------------------------------------------------------------------------
 *
 * `checkAsyncBooleanPredicate` in scripts/check-boundaries.ts catches ONE
 * spelling: an `async` callback handed to `.filter/.find/.some/.every/.sort`.
 * It is a pure syntax rule over a single file, which is why it costs nothing and
 * runs on every file in the repo — and why it is blind to POD-3487, an `if`.
 *
 * Neither check subsumes the other, and the reason is worth stating rather than
 * leaving to be rediscovered:
 *
 *   - The array-method rule fires on the SYNTAX `async` and needs no types, so
 *     it catches a case this one cannot: `arr.filter(async (x) => x.ok)` puts the
 *     promise in a boolean position INSIDE the array method's own contract, not
 *     in any conditional this walk visits.
 *   - This rule fires on the TYPE and needs no syntax, so it catches every case
 *     that one cannot: an `if`, a `!`, a ternary, a `&&` — and it catches them
 *     through a port, an alias, an interface member, a union, at any remove from
 *     the `async` keyword that produced the promise. POD-3487's `canSee` has no
 *     `async` anywhere in the offending file.
 *
 * So this file does NOT re-implement the array-method rule (POD-3486's prototype
 * did, and it double-reported). check-boundaries.ts owns it.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT JUST THE COMPILER — the boundary, measured
 * ---------------------------------------------------------------------------
 *
 * tsc has its own diagnostic for part of this class and it must be said plainly,
 * because a check sold as covering ground the compiler already covers is a check
 * nobody trusts the rest of. TS2801 — "This condition will always return true
 * since this 'Promise<boolean>' is always defined" — was run against every shape
 * in the probe fixture, under both `tsc` and the repo's `tsgo`.
 *
 * IT FIRES on `if (p)`, on `p ? a : b`, on `p && x`, on `x && p` in a condition,
 * and through a local (`const q = p; if (q)`). Those sites are already errors on
 * a green checkout, and this script agreeing with the compiler there is a
 * belt-and-braces, not the reason it exists.
 *
 * IT IS SILENT on exactly the list in {@link TSC_BLIND}:
 *
 *   - `boolean | Promise<boolean>` — THE UNION PORT. The diagnostic's own
 *     premise ("always defined") is false for a union, so it can never fire.
 *     This is the POD-3487 shape, and it is why the compiler had nothing to say
 *     about an authorization predicate that could not refuse.
 *   - `!promise`
 *   - `while (promise)`, `for (; promise; )`, `do … while (promise)`
 *
 * That list IS the value of this script, so the probe asserts it separately from
 * everything else: narrowing the check back to the compiler's coverage fails
 * loudly instead of looking like a tidy-up. And TS2801 only protects a checkout
 * whose typecheck is green — on a red lane, which is where a migration lives, it
 * protects nothing at all.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT typescript-eslint's no-misused-promises
 * ---------------------------------------------------------------------------
 *
 * `no-misused-promises` with `checksConditionals` is the obvious off-the-shelf
 * answer and it was evaluated first. Three reasons it is the wrong pick HERE,
 * in decreasing order of how much they'd hurt:
 *
 *  1. IT CANNOT MAKE THE TWO EXCLUSIONS BELOW, and without them the check gets
 *     switched off. `checksConditionals` is a boolean: it flags EVERY thenable in
 *     a conditional. On this repo at the pre-fix commit that is 22 findings, of
 *     which 20 are the single-flight idiom (`if (inFlight) return inFlight`) —
 *     a correct, deliberate presence test that has nothing to do with this
 *     defect. A gate that is 91% noise is a gate somebody disables, and the rule
 *     exposes no option to narrow it: there is no "awaited type must be boolean"
 *     setting and no way to spare a `Promise<T> | undefined` presence test.
 *     POD-3486 learned this the hard way; the two exclusions below are what took
 *     22 findings down to 2, both of them real.
 *  2. IT WOULD MEAN ADOPTING ESLINT. This repo lints with biome and has no
 *     eslint, no `@typescript-eslint`, and no flat config anywhere. Adding a
 *     second linter — plus its type-aware `parserOptions.project` plumbing, plus
 *     a config that disables every other rule so it does not collide with biome —
 *     to get one rule we would then have to suppress 20 times is a large, durable
 *     dependency for a small piece of analysis.
 *  3. THE PROBE. The repo's audit convention (`--probe`, and see the block below)
 *     is that a check proves it can still fire, on every run, against a fixture
 *     with a known answer. A third-party rule can be pinned but not made to
 *     watch itself, and "found nothing" vs "ran nothing" is the exact failure
 *     this issue is guarding against.
 *
 * What we give up by not using it: its `checksVoidReturn` half (a promise-
 * returning function passed where a `() => void` is expected) is a real and
 * adjacent defect class that this file does NOT cover. That is named as a gap,
 * not a claim.
 *
 * ---------------------------------------------------------------------------
 * THE TWO EXCLUSIONS, AND THEIR CEILING SAID OUT LOUD
 * ---------------------------------------------------------------------------
 *
 * 1. THE AWAITED TYPE MUST ACTUALLY BE BOOLEAN. `if (somePromise)` where the
 *    promise resolves to a row, a handle, a `void` — that is not this defect. It
 *    may be a bug, but it is not "a guard that stopped deciding"; the awaited
 *    value was never the answer to a yes/no question.
 *
 * 2. A UNION WITH `undefined`/`null` IS A PRESENCE TEST, NOT A VALUE TEST. The
 *    single-flight idiom
 *
 *        if (this.inFlight) return this.inFlight
 *        this.inFlight = compute().finally(() => { this.inFlight = undefined })
 *
 *    types as `Promise<T> | undefined`, and the condition genuinely asks whether
 *    the promise EXISTS. That question has an honest boolean answer, so it is not
 *    reported. This is where 20 of the 22 raw findings went.
 *
 *    ONE CARVE-OUT INSIDE THE CARVE-OUT: if the union ALSO contains a plain
 *    `boolean`, it is reported even though `undefined` is present. A
 *    `boolean | Promise<boolean> | undefined` slot is the POD-3487 union-port
 *    shape — the spelling that makes the sync read legal at the consumer and the
 *    async implementation legal at the provider — and there the value genuinely
 *    IS the answer, so a presence test cannot be what was meant.
 *
 *    THE CEILING: a `Promise<boolean> | undefined` member that is meant as a
 *    VALUE (an optional async predicate, `if (deps.mayWrite?.())`) is excluded
 *    and will not be reported. That is a known false negative, accepted
 *    deliberately: 20 false positives cost more than this one false negative,
 *    because the first number is what decides whether the check survives. Spec
 *    rule 52b is the structural answer to it — do not declare a union port.
 *
 * ---------------------------------------------------------------------------
 * WHAT ELSE THIS CANNOT SEE
 * ---------------------------------------------------------------------------
 *
 *  - A promise assigned to a variable typed `unknown`/`any` and read as a
 *    condition. The type is gone by then; nothing can recover it.
 *  - `Boolean(p)`, `p ? … : …` written as `!!p` inside a template — the first is
 *    a call, not a conditional, and is not visited.
 *  - A promise returned from a function DECLARED to return `boolean`. That one
 *    the compiler already refuses, so it needs no check.
 *  - Any file no scanned project reaches ({@link PROJECTS}).
 *
 * ---------------------------------------------------------------------------
 * WHY ITS OWN SCRIPT AND ITS OWN LANE
 * ---------------------------------------------------------------------------
 *
 * check-boundaries.ts builds a `ts.SourceFile` per file and no `ts.Program`, so
 * it has no type checker and runs the whole repo in about a second. This needs a
 * real `TypeChecker` — the question "is this expression's type a promise of a
 * boolean" is not answerable from syntax, which is the entire point — and a
 * Program costs tens of seconds per project. Folding it in would make the cheap
 * text lint expensive for every caller of it. Same split, and the same reason, as
 * `lint:span-effects` and `audit:hidden-reads`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const toPosix = (p: string) => p.split(path.sep).join('/')

// ---------------------------------------------------------------------------
// What gets scanned
// ---------------------------------------------------------------------------

/**
 * One `ts.Program` is built per entry. `customConditions: ["@podium/source"]`
 * (tooling/tsconfig/base.json) means `@podium/*` resolves to package SOURCE, so
 * an app's program already pulls in the package files it uses — POD-3487's site
 * is in apps/server but its `canSee` declaration is in packages/commands, and
 * the checker follows that edge inside a single program. The packages are listed
 * anyway so that a file NO app reaches is still scanned rather than silently
 * skipped; findings are deduplicated by file and line across programs.
 */
const PROJECTS = [
  'apps/server',
  'apps/daemon',
  'apps/cli',
  'apps/web',
  'packages/agent-runtime',
  'packages/client-core',
  'packages/commands',
  'packages/composer',
  'packages/harness',
  'packages/issue-client',
  'packages/janitor',
  'packages/model',
  'packages/protocol',
  'packages/pty',
  'packages/runtime',
  'packages/sync',
  'packages/telemetry',
  'packages/terminal-client',
  'packages/transcript',
] as const

/** Only findings under these prefixes are reported. */
const REPORTED_ROOTS = ['apps/', 'packages/'] as const

/**
 * Known findings that are NOT fixed here, each with the issue that owns the fix.
 * A ratchet entry, not an exemption: the check still reports it, in its own
 * section, and the gate stays green only while the set matches exactly. An entry
 * whose site has been fixed FAILS the run, so the allowlist cannot rot.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  // Empty, and the check FAILS on a stale entry, so it cannot rot into a
  // permanent exemption. The one entry this shipped with named POD-3495
  // (ResourceLease.renew) — fixed by POD-3488 and landed as 961dffbc1 before
  // this check merged, which is exactly the staleness the ratchet is for.
])

// ---------------------------------------------------------------------------
// The type question
// ---------------------------------------------------------------------------

export type Reason = 'promise-of-boolean' | 'union-port'

export interface Finding {
  readonly file: string
  readonly line: number
  readonly position: string
  readonly reason: Reason
  readonly text: string
}

const isBooleanLike = (t: ts.Type) => (t.flags & ts.TypeFlags.BooleanLike) !== 0

const isAbsent = (t: ts.Type) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0

/** A bare (non-union) `Promise<boolean>`, resolved through the checker. */
function isPromiseOfBoolean(checker: ts.TypeChecker, t: ts.Type): boolean {
  if (t.getSymbol()?.getName() !== 'Promise') return false
  const awaited = checker.getAwaitedType?.(t)
  if (!awaited) return false
  if (isBooleanLike(awaited)) return true
  // `boolean` itself is the union `true | false`, so a resolved boolean arrives
  // here as a union whose every constituent is boolean-like.
  return awaited.isUnion() && awaited.types.every(isBooleanLike)
}

/**
 * @returns why this type is a finding in a boolean position, or `undefined`.
 * The two exclusions of the header block live here and nowhere else.
 */
export function classify(checker: ts.TypeChecker, t: ts.Type): Reason | undefined {
  if (!t.isUnion()) return isPromiseOfBoolean(checker, t) ? 'promise-of-boolean' : undefined
  if (!t.types.some((x) => isPromiseOfBoolean(checker, x))) return undefined
  // A union that offers BOTH spellings is the union port (spec rule 52b): the
  // sync read is legal at the consumer, the async impl legal at the provider,
  // and the boolean position always takes the truthy branch. Reported even when
  // `undefined` is also present — the value is the answer, so a presence test
  // cannot be the intent.
  if (t.types.some(isBooleanLike)) return 'union-port'
  // Otherwise `undefined`/`null` in the union means the condition is asking
  // whether the promise EXISTS — the single-flight idiom. Not this defect.
  if (t.types.some(isAbsent)) return undefined
  return 'promise-of-boolean'
}

// ---------------------------------------------------------------------------
// Where a boolean is read
// ---------------------------------------------------------------------------

/**
 * Walks every expression read as a truth value. `&&`/`||` are the only subtle
 * ones: `a && b` reads `a` as a boolean ALWAYS, but reads `b` as a boolean only
 * if the whole expression is itself in a boolean position — `const x = a && b`
 * yields `b`'s value, so a promise there is a legitimate result, not a broken
 * guard. POD-3486's prototype only ever checked the left operand; propagating
 * the context is what makes `if (ready && canSee())` a finding.
 */
/**
 * A syntactic pre-filter, and the reason this script finishes in minutes rather
 * than an hour: `checker.getTypeAtLocation` is the expensive call, and most
 * boolean positions in a real codebase are shapes that CANNOT hold a promise —
 * a comparison, a `typeof`, a literal, an already-negated expression. Asking the
 * checker about those is pure waste.
 *
 * SOUNDNESS is the only thing that matters here: this may only exclude nodes
 * whose type provably is not a thenable. Every excluded kind produces `boolean`,
 * `string` or a literal by the language's own rules, so nothing is lost — and the
 * probe's `quiet.ts`/`loud.ts` pair fails if a widening slips in here, because
 * the planted findings run through this filter too.
 */
function couldBeAPromise(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) {
    switch (node.operatorToken.kind) {
      // Comparisons and `in`/`instanceof` are boolean by definition.
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.LessThanToken:
      case ts.SyntaxKind.LessThanEqualsToken:
      case ts.SyntaxKind.GreaterThanToken:
      case ts.SyntaxKind.GreaterThanEqualsToken:
      case ts.SyntaxKind.InKeyword:
      case ts.SyntaxKind.InstanceOfKeyword:
        return false
      default:
        return true
    }
  }
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateExpression:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.ObjectLiteralExpression:
    case ts.SyntaxKind.ArrayLiteralExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.TypeOfExpression:
    case ts.SyntaxKind.VoidExpression:
    case ts.SyntaxKind.DeleteExpression:
      return false
    default:
      break
  }
  // `!x`, `+x`, `-x`, `~x` are all primitives; `await x` has been resolved.
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return false
  if (ts.isAwaitExpression(node)) return false
  return true
}

export function analyze(
  program: ts.Program,
  root: string,
  projectLabel: string,
  alreadyAnalyzed?: Set<string>,
): Finding[] {
  const checker = program.getTypeChecker()
  const findings: Finding[] = []
  const seen = new Set<ts.Node>()

  const record = (node: ts.Node, position: string, sf: ts.SourceFile) => {
    if (seen.has(node)) return
    if (!couldBeAPromise(node)) return
    const reason = classify(checker, checker.getTypeAtLocation(node))
    if (!reason) return
    seen.add(node)
    findings.push({
      file: toPosix(path.relative(root, sf.fileName)),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      position,
      reason,
      text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
    })
  }

  const visitSourceFile = (sf: ts.SourceFile) => {
    /** @param asBoolean whether `node` itself is read as a truth value. */
    const walk = (node: ts.Node, asBoolean: string | undefined): void => {
      if (asBoolean !== undefined && ts.isExpression(node)) {
        if (ts.isParenthesizedExpression(node)) {
          walk(node.expression, asBoolean)
          return
        }
        if (
          ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        ) {
          walk(node.left, 'logical-operand')
          // Inherits THIS expression's context: only in a boolean position is
          // the right operand read as a truth value.
          walk(node.right, asBoolean)
          return
        }
        record(node, asBoolean, sf)
      }

      if (ts.isIfStatement(node)) walk(node.expression, 'if-condition')
      else if (ts.isWhileStatement(node) || ts.isDoStatement(node))
        walk(node.expression, 'loop-condition')
      else if (ts.isForStatement(node) && node.condition) walk(node.condition, 'loop-condition')
      else if (ts.isConditionalExpression(node)) walk(node.condition, 'ternary-condition')
      else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
        walk(node.operand, 'negation')
      else if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        // Reached OUTSIDE a boolean position: the left operand is still read as
        // one, the right one is the expression's value.
        walk(node.left, 'logical-operand')
      }

      ts.forEachChild(node, (child) => {
        walk(child, undefined)
      })
    }
    walk(sf, undefined)
  }

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue
    const rel = toPosix(path.relative(root, sf.fileName))
    if (rel.startsWith('..') || rel.includes('node_modules/')) continue
    if (!REPORTED_ROOTS.some((r) => rel.startsWith(r))) continue
    // The projects OVERLAP heavily — `customConditions: ["@podium/source"]`
    // pulls package source into every app's program, so a shared file is in a
    // dozen of them. Its type is the same in each (one declaration, one set of
    // declared types), so analysing it once is not a shortcut, it is the whole
    // saving: without this the walk does several times the work of the file
    // count it reports.
    if (alreadyAnalyzed) {
      if (alreadyAnalyzed.has(rel)) continue
      alreadyAnalyzed.add(rel)
    }
    visitSourceFile(sf)
  }
  void projectLabel
  return findings
}

// ---------------------------------------------------------------------------
// THE PROBE — the instrument proves it can still fire, on every run
// ---------------------------------------------------------------------------
//
// A scan that found nothing and a scan that ran nothing print the same thing.
// This one is therefore not trusted to report zero until it has just reported
// the right non-zero answer over a fixture whose findings are known by hand —
// and the fixture carries the QUIET cases too, because a check that fires on
// everything is equally useless. It runs before the real scan on every
// invocation and exits 2 (never 1) if it is broken, so "the instrument is dead"
// can never be mistaken for "the instrument fired".

const PROBE_ROOT = '/probe'

const FIXTURE = new Map<string, string>([
  [
    'packages/probe/src/ports.ts',
    `export interface Ceiling {
       /** The POD-3487 shape: legal to implement async, legal to read sync. */
       canSee(id: string): boolean | Promise<boolean>
     }
     export interface NarrowCeiling {
       canSee(id: string): Promise<boolean>
     }
     export async function isReady(): Promise<boolean> { return true }
     export async function loadRow(): Promise<{ id: string }> { return { id: 'x' } }
     export function plainlyTrue(): boolean { return true }`,
  ],
  [
    'apps/probe/src/loud.ts',
    // Every one of these must be reported.
    `import { type Ceiling, type NarrowCeiling, isReady } from '@probe/ports'
     export function ifCondition(c: NarrowCeiling): string {
       if (c.canSee('a')) return 'yes'
       return 'no'
     }
     export function unionPort(c: Ceiling): string {
       if (c.canSee('a')) return 'yes'
       return 'no'
     }
     export function negation(): boolean { return !isReady() }
     export function ternary(): string { return isReady() ? 'y' : 'n' }
     export function loop(): number { let n = 0; while (isReady()) { n++; break } return n }
     export function forLoop(): number { let n = 0; for (; isReady(); ) { n++; break } return n }
     export function leftOperand(other: boolean): boolean { return isReady() && other }
     export function rightOperandInCondition(other: boolean): string {
       if (other && isReady()) return 'y'
       return 'n'
     }
     export function parenthesised(): string { if ((isReady())) return 'y'; return 'n' }
     export function doWhile(): number { let n = 0; do { n++ } while (isReady()); return n }`,
  ],
  [
    'apps/probe/src/quiet.ts',
    // None of these may be reported.
    `import { isReady, loadRow, plainlyTrue } from '@probe/ports'
     let inFlight: Promise<boolean> | undefined
     export function singleFlight(): Promise<boolean> {
       if (inFlight) return inFlight
       inFlight = isReady()
       return inFlight
     }
     export async function awaited(): Promise<string> {
       if (await isReady()) return 'y'
       return 'n'
     }
     export function notABoolean(): string {
       const row = loadRow()
       if (row) return 'y'
       return 'n'
     }
     export function synchronous(): string { if (plainlyTrue()) return 'y'; return 'n' }
     export function rightOperandAsValue(other: boolean): boolean | Promise<boolean> {
       return other && isReady()
     }`,
  ],
])

/** Reported by hand from {@link FIXTURE}: file:line -> reason. */
const PROBE_EXPECTED: ReadonlyMap<string, Reason> = new Map<string, Reason>([
  ['apps/probe/src/loud.ts:3', 'promise-of-boolean'],
  ['apps/probe/src/loud.ts:7', 'union-port'],
  ['apps/probe/src/loud.ts:10', 'promise-of-boolean'],
  ['apps/probe/src/loud.ts:11', 'promise-of-boolean'],
  ['apps/probe/src/loud.ts:12', 'promise-of-boolean'],
  ['apps/probe/src/loud.ts:13', 'promise-of-boolean'],
  ['apps/probe/src/loud.ts:14', 'promise-of-boolean'],
  ['apps/probe/src/loud.ts:16', 'promise-of-boolean'],
  ['apps/probe/src/loud.ts:19', 'promise-of-boolean'],
  ['apps/probe/src/loud.ts:20', 'promise-of-boolean'],
])

/**
 * The correct sites in `apps/probe/src/quiet.ts`, named so the "stays quiet"
 * half of the probe is a stated count rather than an absence. Any finding
 * outside {@link PROBE_EXPECTED} fails the probe, so this list is documentation;
 * the enforcement is the exhaustive comparison in {@link probe}.
 */
const PROBE_QUIET: readonly string[] = [
  'the single-flight presence test (`if (inFlight) return inFlight`)',
  'an awaited promise (`if (await isReady())`)',
  'a promise of something that is not a boolean',
  'a plain synchronous boolean',
  'the right operand of `&&` read as a VALUE rather than as a condition',
]

/**
 * The planted sites TS2801 does NOT report, verified against both `tsc` and the
 * repo's `tsgo` at POD-3483. Everything else in {@link PROBE_EXPECTED} the
 * compiler also catches, so on a checkout whose typecheck is green this script's
 * value is exactly this list — most of all the union port, which is POD-3487.
 */
const TSC_BLIND: readonly string[] = [
  'apps/probe/src/loud.ts:7', // union port: `boolean | Promise<boolean>` is not "always defined"
  'apps/probe/src/loud.ts:10', // `!promise`
  'apps/probe/src/loud.ts:12', // `while (promise)`
  'apps/probe/src/loud.ts:13', // `for (; promise; )`
  'apps/probe/src/loud.ts:20', // `do … while (promise)`
]

function probeProgram(): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts'],
    strict: true,
    noEmit: true,
    paths: { '@probe/ports': ['packages/probe/src/ports.ts'] },
    baseUrl: PROBE_ROOT,
  }
  const abs = (p: string) => `${PROBE_ROOT}/${p}`
  const source = (fileName: string) => FIXTURE.get(toPosix(path.relative(PROBE_ROOT, fileName)))
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text =
        source(fileName) ?? (ts.sys.fileExists(fileName) ? ts.sys.readFile(fileName) : undefined)
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true)
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => {},
    getCurrentDirectory: () => PROBE_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => source(fileName) !== undefined || ts.sys.fileExists(fileName),
    readFile: (fileName) => source(fileName) ?? ts.sys.readFile(fileName),
  }
  return ts.createProgram([...FIXTURE.keys()].map(abs), options, host)
}

/** @returns the reasons the instrument is broken; empty means it works. */
export function probe(): string[] {
  const program = probeProgram()
  const syntactic = program.getSyntacticDiagnostics()
  if (syntactic[0]) {
    return [
      `the probe fixture does not parse: ${ts.flattenDiagnosticMessageText(syntactic[0].messageText, ' ')}`,
    ]
  }
  // A fixture that stopped type-checking would make every `getTypeAtLocation`
  // return `any` and the whole probe would go quiet for the wrong reason. TS2801
  // is exempt because it is the compiler AGREEING with the fixture on the sites
  // it can see — see {@link TSC_BLIND}.
  const semantic = program
    .getSemanticDiagnostics()
    .filter((d) => d.code !== 2801)
    .filter((d) => d.file && FIXTURE.has(toPosix(path.relative(PROBE_ROOT, d.file.fileName))))
  if (semantic[0]) {
    return [
      `the probe fixture does not type-check: ${ts.flattenDiagnosticMessageText(semantic[0].messageText, ' ')}`,
    ]
  }

  const broken: string[] = []
  const found = new Map(
    analyze(program, PROBE_ROOT, 'probe').map((f) => [`${f.file}:${f.line}`, f.reason]),
  )
  for (const [at, reason] of PROBE_EXPECTED) {
    const got = found.get(at)
    if (got === undefined) broken.push(`missed the planted finding at ${at} (${reason})`)
    else if (got !== reason) broken.push(`classified ${at} as '${got}', expected '${reason}'`)
  }
  for (const at of found.keys()) {
    if (!PROBE_EXPECTED.has(at)) broken.push(`fired on a site the fixture says is correct: ${at}`)
  }
  // The reason this script exists rather than leaning on the compiler. Asserted
  // separately from the list above so that narrowing the check back to the
  // subset tsc already reports fails the probe LOUDLY instead of looking like a
  // tidy-up.
  for (const at of TSC_BLIND) {
    if (!found.has(at)) {
      broken.push(`lost a site the COMPILER cannot see (TS2801 is blind to it): ${at}`)
    }
  }
  return broken
}

// ---------------------------------------------------------------------------
// THE SPREAD PROBE — rule 55's four cases, and why two of them say nothing
// ---------------------------------------------------------------------------
//
// SPREADING a value that might be a promise is a SEPARATE defect from reading
// one as a condition, and this script does not detect it: a promise has no own
// enumerable properties, so `{ ...resolveAsync() }` copies NOTHING from the
// provider and the object arrives missing every required field. POD-3499 hit it
// at `shipping/service.test.ts:535`, where a test resolver overrode one field of
// an async provider and silently dropped `validationProfile`.
//
// Only EXCESS PROPERTY CHECKING catches it, and only while the object literal is
// still FRESH — checked directly against an annotation. So of rule 55's four
// cases, TWO ARE EXPECTED TO BE SILENT, and that is the whole point of keeping
// them here:
//
//   case 1  annotated target, extra property      TS2353   flagged
//   case 2  annotated target, no extra property   SILENT   nothing is "excess"
//   case 3  port impl, INFERRED return            SILENT   freshness already lost
//   case 4  port impl, ANNOTATED return           TS2353   freshness restored
//
// CASES 2 AND 3 ARE NOT BUGS IN THIS FIXTURE AND MUST NOT BE "FIXED". Case 3 is
// the dangerous one and the reason the pair is recorded: it is a port written the
// ordinary way, with no return annotation, and the spread of a promise carries
// `then`, `catch`, `finally` and `Symbol.toStringTag`, so it structurally IS a
// `Promise<Policy>` and passes. The discriminator is INFERRED-VERSUS-ANNOTATED
// RETURN, not the union — which is why widening a port to `Promise<T>` (rule 56)
// does not by itself make this class visible.
//
// This probe asserts the compiler still behaves that way. If a future TypeScript
// starts reporting case 2 or 3, this fails LOUDLY rather than letting the repo
// keep a stale rule 55 in the spec.

const SPREAD_FIXTURE_FILE = 'packages/probe/src/spread.ts'

/**
 * Line numbers below are into this text; keep them in step when editing it. They
 * anchor on the OFFENDING PROPERTY, not on the declaration — TS2353 points at the
 * excess property, which for a multi-line literal is a later line than the `const`
 * (case 4 is line 19, not 17). The silent cases are anchored the same way, at the
 * line their diagnostic WOULD occupy, so that a case which stops being silent is
 * reported as rule 55 breaking rather than as an unplanned line.
 */
const SPREAD_FIXTURE = `export interface Policy {
  validationProfile: string
  evidenceOptional: boolean
}

declare function resolveAsync(): Promise<Policy>

export const one: Promise<Policy> = { ...resolveAsync(), evidenceOptional: false }

export const two: Promise<Policy> = { ...resolveAsync() }

export const three: () => Promise<Policy> = () => ({
  ...resolveAsync(),
  evidenceOptional: false,
})

export const four: () => Promise<Policy> = (): Promise<Policy> => ({
  ...resolveAsync(),
  evidenceOptional: false,
})
`

/** The cases excess-property checking DOES reach, by line, with rule 55's label. */
const SPREAD_FLAGGED = new Map<number, string>([
  [8, 'case 1 — annotated target, extra property'],
  [19, 'case 4 — port impl with an ANNOTATED return'],
])

/**
 * The cases that say nothing, and MUST keep saying nothing. A checkout where
 * these start reporting has changed the rule, not fixed the fixture.
 */
const SPREAD_SILENT = new Map<number, string>([
  [10, 'case 2 — annotated target, no excess property to report'],
  [14, 'case 3 — port impl with an INFERRED return; freshness is already lost'],
])

/** @returns the reasons rule 55 no longer holds; empty means it still does. */
export function spreadProbe(): string[] {
  const abs = `${PROBE_ROOT}/${SPREAD_FIXTURE_FILE}`
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = fileName === abs ? SPREAD_FIXTURE : ts.sys.readFile(fileName)
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true)
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => {},
    getCurrentDirectory: () => PROBE_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => fileName === abs || ts.sys.fileExists(fileName),
    readFile: (fileName) => (fileName === abs ? SPREAD_FIXTURE : ts.sys.readFile(fileName)),
  }
  const program = ts.createProgram(
    [abs],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2023.d.ts'],
      strict: true,
      noEmit: true,
    },
    host,
  )
  const broken: string[] = []
  const syntactic = program.getSyntacticDiagnostics()
  if (syntactic[0]) {
    return [
      `the spread fixture does not parse: ${ts.flattenDiagnosticMessageText(syntactic[0].messageText, ' ')}`,
    ]
  }

  const reported = new Map<number, number>()
  for (const d of program.getSemanticDiagnostics()) {
    if (!d.file || d.file.fileName !== abs || d.start === undefined) continue
    reported.set(d.file.getLineAndCharacterOfPosition(d.start).line + 1, d.code)
  }

  for (const [line, label] of SPREAD_FLAGGED) {
    const code = reported.get(line)
    if (code === undefined) {
      broken.push(`rule 55 ${label}: expected TS2353 at line ${line}, the compiler said nothing`)
    } else if (code !== 2353) {
      broken.push(`rule 55 ${label}: expected TS2353 at line ${line}, got TS${code}`)
    }
  }
  // The half of rule 55 that a reader is most likely to "tidy up".
  for (const [line, label] of SPREAD_SILENT) {
    const code = reported.get(line)
    if (code !== undefined) {
      broken.push(
        `rule 55 ${label}: this case is EXPECTED to be silent, but the compiler now ` +
          `reports TS${code} at line ${line}. Rule 55 in docs/internal/pod-3221-spec.md is stale.`,
      )
    }
  }
  for (const line of reported.keys()) {
    if (!SPREAD_FLAGGED.has(line) && !SPREAD_SILENT.has(line)) {
      broken.push(`the spread fixture reported at an unplanned line ${line}`)
    }
  }
  return broken
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function scanCheckout(repoRoot: string): { findings: Finding[]; files: number } {
  const byLocation = new Map<string, Finding>()
  let files = 0
  const scannedFiles = new Set<string>()
  const analyzed = new Set<string>()
  for (const project of PROJECTS) {
    const configPath = path.join(repoRoot, project, 'tsconfig.json')
    const configFile = ts.readConfigFile(configPath, (p) => readFileSync(p, 'utf8'))
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
    )
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile) continue
      const rel = toPosix(path.relative(repoRoot, sf.fileName))
      if (rel.startsWith('..') || rel.includes('node_modules/')) continue
      if (REPORTED_ROOTS.some((r) => rel.startsWith(r))) scannedFiles.add(rel)
    }
    for (const f of analyze(program, repoRoot, project, analyzed)) {
      byLocation.set(`${f.file}:${f.line}`, f)
    }
  }
  files = scannedFiles.size
  return {
    findings: [...byLocation.values()].sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    ),
    files,
  }
}

const render = (rows: Finding[]) =>
  rows.map((f) => `${f.file}:${f.line}  ${f.position} [${f.reason}]  ->  ${f.text}`).join('\n')

function main(): void {
  const broken = [...probe(), ...spreadProbe()]
  if (broken.length > 0) {
    console.error('THE CHECK IS BROKEN — its own probe failed, so its answer means nothing:')
    for (const reason of broken) console.error(`  ${reason}`)
    console.error(
      '\nFix classify()/analyze() in scripts/check-promise-truthiness.ts before trusting any\n' +
        'result from this script. Exit code 2, not 1: a dead instrument is not a finding.',
    )
    process.exit(2)
  }
  if (process.argv.includes('--probe')) {
    console.log(
      `probe: fires on all ${PROBE_EXPECTED.size} planted sites (${TSC_BLIND.length} of them ` +
        `invisible to the compiler's own TS2801) and stays quiet on all ${PROBE_QUIET.length} ` +
        `correct ones, across ${FIXTURE.size} fixture files; rule 55's spread fixture holds ` +
        `on all ${SPREAD_FLAGGED.size + SPREAD_SILENT.size} cases (${SPREAD_SILENT.size} of them ` +
        `EXPECTED to be silent)`,
    )
    return
  }

  const repoRoot = path.resolve(import.meta.dirname, '..')
  const started = performance.now()
  const { findings, files } = scanCheckout(repoRoot)
  const elapsed = ((performance.now() - started) / 1000).toFixed(1)

  const known: Finding[] = []
  const shipping: Finding[] = []
  for (const f of findings) {
    ;(ALLOWLIST.has(`${f.file}:${f.line}`) ? known : shipping).push(f)
  }
  const stale = [...ALLOWLIST.keys()].filter(
    (at) => !findings.some((f) => `${f.file}:${f.line}` === at),
  )

  console.log('# A promise read as a yes/no answer')
  console.log(
    `\nscanned ${files} files across ${PROJECTS.length} projects in ${elapsed}s ` +
      `(probe green: the check just fired on all ${PROBE_EXPECTED.size} planted sites)`,
  )

  console.log(`\n## Shipping findings — must be empty (${shipping.length})`)
  console.log(shipping.length ? render(shipping) : '(none)')

  console.log(`\n## Known, owned elsewhere (${known.length})`)
  for (const f of known) console.log(`${render([f])}\n    ${ALLOWLIST.get(`${f.file}:${f.line}`)}`)
  if (known.length === 0) console.log('(none)')

  if (stale.length > 0) {
    console.error(`\n## STALE ALLOWLIST ENTRIES (${stale.length})`)
    for (const at of stale) console.error(`${at} — no longer a finding; delete this entry.`)
  }

  process.exit(shipping.length === 0 && stale.length === 0 ? 0 : 1)
}

if (import.meta.main) main()
