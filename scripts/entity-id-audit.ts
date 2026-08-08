/**
 * THE RAW-STRING ENTITY ID DETECTOR — POD-301, and the instrument POD-423 held
 * Phase 1 open for the absence of.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * POD-363's acceptance criterion said "the raw-string-entity-id audit item
 * reaches ZERO repo-wide" and POD-301's fourth criterion says the same. There
 * was **no such item**: `scripts/rearch-audit-baseline.json` had no key and
 * `scripts/rearch-audit.ts` had no detector, so the number reported as zero was
 * the `POD-361-EDGE-CAST` marker count — a different, genuinely-zero thing.
 * POD-423's formulation is the one this file implements:
 *
 * > AN AUDIT ITEM NAMED IN AN ACCEPTANCE CRITERION BUT ABSENT FROM THE BASELINE
 * > IS NOT A PASSING CHECK, IT IS AN UNMEASURED CLAIM.
 *
 * ---------------------------------------------------------------------------
 * ENUMERATE THE CONCEPT, NOT ONE SPELLING
 * ---------------------------------------------------------------------------
 *
 * POD-423 measured 66 sites with a grep over EIGHT field names
 * (`sessionId|issueId|machineId|repoId|conversationId|threadId|mutationId|userId`)
 * and said plainly that it could not see a ninth. A detector built the same way
 * inherits that blindness — which is exactly how POD-1168 happened, where
 * `instancePartitions` enumerated entity-shaped *declarations* and so never saw
 * a drizzle `sqliteTable(...)` call expression at all.
 *
 * So neither half of the predicate is a literal list:
 *
 *   - **The vocabulary is DERIVED**, at runtime, from `packages/model`'s own
 *     brand exports ({@link ID_BRANDS}). Adding a brand extends the detector;
 *     renaming one cannot silence it. A field denotes a brand when its name IS
 *     or ENDS IN `<brand>Id` — so `targetSessionId`, `lastSessionId`,
 *     `sourceMachineId` and `deletedByIssueId` are all in scope without anyone
 *     listing them. Measured: this finds **79** raw sites where the eight-name
 *     grep found 66, and the extra ones are real.
 *   - **The position is SCANNED, not line-matched.** Every `key:` field position
 *     in the comment-stripped source is enumerated and its right-hand side is
 *     classified into {@link IdFieldForm}. Classification is PER SITE, so a file
 *     that brands one field and leaves the next raw is counted honestly — that
 *     intra-file inconsistency is what rules out the innocent "this is a
 *     boundary parse" reading (POD-423 verified it by hand at
 *     `packages/commands/src/issues/contracts.ts`).
 *
 * All THREE spellings of "an entity id field" are enumerated:
 *
 *   1. a `<brand>Id`-suffixed key, at any depth;
 *   2. a bare `id:` key at the top level of a `z.object` whose declaration NAME
 *      denotes a brand (`Account.id` in `packages/runtime/src/settings.ts`,
 *      which an eight-name grep cannot see). See {@link REPRESENTATION_SUFFIXES}
 *      for where that inference stops — `IssueComment.id` is NOT an `IssueId`,
 *      and POD-423 named it as a defect in error; and
 *   3. a bare `id:` (or a self-referential `parentId`) in a file whose TENANT
 *      DIRECTORY names the brand — {@link brandOfPath}, added at POD-1212.
 *
 * Spelling 3 exists because spellings 1 and 2 both read a NAME, and a command
 * contract has neither: `const byId = z.object({ id: z.string() })` in
 * `packages/commands/src/issues/` is the id of an issue, and POD-1212 proved the
 * gap by flipping a branded field back to a bare string there and watching the
 * whole audit stay GREEN. 34 sites were invisible for that reason. A declaration
 * that names a DIFFERENT entity vetoes the directory ({@link declaresOtherEntity}),
 * so spelling 3 cannot outvote the judgement spelling 2 makes.
 *
 * ---------------------------------------------------------------------------
 * THE INSTRUMENT MUST BE ABLE TO SAY NO
 * ---------------------------------------------------------------------------
 *
 * Two zod walkers in this run found NOTHING and passed everything (POD-363 peeled
 * past the brand with `ZodBranded.unwrap()`; POD-640 keyed on
 * `safeParse().success`, which succeeds because zod STRIPS unknown keys). This
 * detector is the same shape, so:
 *
 *   - {@link assertBrandsLoaded} REFUSES to run on an empty brand vocabulary,
 *     rather than reporting a serene zero the ratchet would bank as a win.
 *   - {@link MIN_ID_FIELD_SITES} pins a non-trivial floor on the TOTAL
 *     population (branded + raw + carve-out + column + type). A walk that breaks
 *     anywhere collapses that number, and the audit fails loudly instead of
 *     going quiet. It is deliberately a floor on the population and NOT on the
 *     raw count, which must be free to fall to zero.
 *   - `entity-id-audit.test.ts` plants each spelling and requires it to be
 *     FOUND, then removes it and requires the finding to disappear.
 *
 * ---------------------------------------------------------------------------
 * THE THREE COUNTS, AND WHY THE DEBT IS SPLIT
 * ---------------------------------------------------------------------------
 *
 * {@link rawStringEntityIds} — POD-301's item. Every id field declared as a bare
 * zod string where the brand exists and nothing carves it out.
 *
 * {@link machineIdUnbrandedFields} — POD-318's item, kept separate from POD-301's
 * because ADR 1 Amendment 2 D16.2 made it a DIFFERENT debt with a different
 * precondition: `MachineId` could not be adopted anywhere until `'local'` and
 * `'__local__'` were retired, since branding a sentinel *launders* it rather than
 * flagging it. POD-318 retired them and adopted the brand, so this counts what it
 * always counted — a machine-id field still declared as a bare `z.string()` — with
 * the sanctioned carve-out marker no longer among the spellings, because it no
 * longer exists.
 *
 * {@link unbrandedByDecisionFields} — the escape hatch, counted so it cannot be
 * used quietly. A field is excused when its doc comment carries the uppercase
 * token `UNBRANDED`, which is the convention `packages/model` already used at
 * eleven sites before this detector existed (`entities/conversation.ts:38`,
 * `entities/session.ts:113`, `entities/transcript.ts:32`, …). Because the
 * excused set is ITSELF a ratcheted baseline key, adding a marker raises a
 * committed number and the audit fails until someone records why — so POD-301's
 * count cannot be driven to zero by sprinkling comments.
 *
 * ---------------------------------------------------------------------------
 * LIMITS — stated, because a grep audit is never sufficient
 * ---------------------------------------------------------------------------
 *
 *  1. **Only zod field positions are counted.** The same scan also classifies
 *     drizzle columns (`text("session_id")`, measured 68) and hand-written TS
 *     `sessionId: string` members (measured 754) and reports them under
 *     `--sites` via `bun scripts/entity-id-audit.ts`, but neither is in a
 *     baseline key. They are a different act: a
 *     column is branded with drizzle's `$type<>()` and most TS members are
 *     `z.infer`-derived and follow the zod flip for free. Reading a zero here as
 *     "no raw entity id exists anywhere" is not valid; reading it as "no zod
 *     schema declares one" is.
 *  2. **A POLYMORPHIC id is out of scope by design.** `workflowAssignInput
 *     .targetId` and `MessageRow.toId` name whichever entity `targetKind` says,
 *     so branding them at the declaration forces a false choice (POD-362's
 *     finding, upheld). Their names do not end in `<brand>Id`, so the detector
 *     does not reach them — that is the right answer, not a miss, and it is
 *     recorded here so a later sweep does not "fix" it. Spelling 3 DOES reach
 *     one such site (`pinSetInput.id`), which is why it carries an `UNBRANDED`
 *     marker; see the note above {@link declaresOtherEntity} for why that is a
 *     marker and not a structural rule.
 *  4. **An id whose name names NEITHER its brand nor a tenant is unreachable.**
 *     `duplicateInput.canonicalId` is an issue id and this detector cannot see
 *     it; nor can it see `causationId` (a `mutationId` by another name). The
 *     wider class — `requestId`, `runId`, `revisionId`, `stepId` and ~40 more,
 *     measured at 227 sites — is mostly NOT this item's debt, because those name
 *     entities with no brand in `packages/model` at all: there is nothing for
 *     them to be flipped TO. Minting those brands is its own piece of work.
 *  3. **A brand can still be widened downstream.** This sees the declaration,
 *     not what a consumer does with the value.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as brands from '../packages/model/src/ids/brands'
import type { AuditContext, AuditSite } from './rearch-audit'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// The vocabulary — read from the model, never restated here
// ---------------------------------------------------------------------------

/**
 * Every brand `packages/model` defines, by its bare name (`Session`, `Issue`,
 * `Machine`, …), derived from the `<Brand>IdField` exports.
 *
 * The FIELD schema is the right thing to key on rather than the validating
 * boundary schema: `brands.ts` ships two per brand and it is the field form that
 * belongs in an entity schema, so a brand without one has nothing for a field to
 * be flipped TO.
 */
export const ID_BRANDS: readonly string[] = Object.keys(brands)
  .filter((k) => k.endsWith('IdField'))
  .map((k) => k.slice(0, -'IdField'.length))
  .sort()

/**
 * Refuse to run on an empty brand vocabulary.
 *
 * A broken import would otherwise make every count fall to zero and the ratchet
 * would print "you improved — lock it in" (`docs/rearch-deletion-audit.md`: "a
 * detector that stops matching is not a deletion"). Exported so a test can watch
 * it REFUSE — an unexercised guard is indistinguishable from an absent one.
 */
export function assertBrandsLoaded(brandNames: readonly string[]): void {
  if (brandNames.length === 0) {
    throw new Error(
      'entity-id-audit: the brand vocabulary loaded EMPTY from packages/model/src/ids/brands. ' +
        'Every count would be zero and the ratchet would read it as a deletion. Fix the import; ' +
        'do not rebaseline.',
    )
  }
}

/**
 * A floor on the TOTAL id-field population — branded, raw, carved out, column
 * and TS member alike.
 *
 * This is the non-trivial count a broken walk cannot reach. The raw count is
 * free to fall to zero (that is the point of the ratchet); the POPULATION is
 * not, because every falling raw site becomes a branded one. Measured at
 * POD-301: 1342. Set well below that so ordinary churn does not trip it, and
 * far above what a scanner that has stopped matching could produce.
 */
export const MIN_ID_FIELD_SITES = 1800

/**
 * The excuse token. Uppercase and word-anchored: `packages/model` already wrote
 * it at eleven fields ("UNBRANDED: a HARNESS-minted `agent_id` …") before this
 * detector read it, so the convention is inherited rather than invented, and
 * lowercase prose about branding cannot trip it.
 */
const UNBRANDED_TOKEN = /\bUNBRANDED\b/

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export type IdFieldForm =
  /** A bare zod string — the debt. */
  | 'zod-string'
  /** A zod schema carrying the brand (`SessionIdField`, `.brand<…>`, `.pipe(…)`). */
  | 'zod-branded'
  /** A drizzle column (`text("session_id")`). Limit 1. */
  | 'db-column'
  /** A hand-written TypeScript `string` member. Limit 1. */
  | 'ts-string'
  /** A branded TS type, a function parameter, a value expression — anything else. */
  | 'other'

export interface EntityIdSite extends AuditSite {
  /** The declared key, verbatim (`targetSessionId`, `session_id`, `id`). */
  readonly key: string
  /** The brand its name denotes (`Session`, `Machine`, …). */
  readonly brand: string
  readonly form: IdFieldForm
  /** The enclosing top-level declaration, when the site is a bare `id`. */
  readonly symbol: string
  /** True when the field's doc comment carries the `UNBRANDED` token. */
  readonly excused: boolean
}

/** `session_id` → `sessionId`, so a snake-cased key is the same concept. */
const toCamel = (key: string): string =>
  key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())

/** Which brand a key's NAME denotes, or null. `<brand>Id` exactly, or any name
 *  ENDING in it — the part an eight-name literal list cannot express. */
export function brandOfKey(key: string, brandNames: readonly string[] = ID_BRANDS): string | null {
  const camel = toCamel(key)
  for (const brand of brandNames) {
    const suffix = `${brand.charAt(0).toUpperCase()}${brand.slice(1)}Id`
    if (camel === `${brand.charAt(0).toLowerCase()}${brand.slice(1)}Id`) return brand
    if (camel.length > suffix.length && camel.endsWith(suffix)) return brand
  }
  return null
}

/**
 * Suffixes that make a declaration a REPRESENTATION OF the brand it starts with,
 * rather than a different entity that merely mentions it.
 *
 * This is the one JUDGEMENT in the detector, so it is stated rather than buried.
 * Without it `brandOfSymbol` is `startsWith`, and `startsWith` says
 * `IssueComment.id` is an `IssueId` — which is false and is the well-typed lie
 * `brands.ts` warns about at `controllerId`. A COMMENT has its own id space;
 * branding it `IssueId` would let a comment id be passed where an issue id is
 * required. POD-423 named that site as a defect and it is not one.
 *
 * Note this list enumerates REPRESENTATION SUFFIXES, not entity names — the
 * thing that made POD-423's grep brittle was a literal list of entities, which
 * {@link ID_BRANDS} replaces with a derived one.
 */
export const REPRESENTATION_SUFFIXES: readonly string[] = [
  '',
  'Wire',
  'Meta',
  'Aggregate',
  'Row',
  'Record',
  'Entity',
  'Snapshot',
  'Summary',
  'SummaryWire',
  'Head',
  'Ref',
  'State',
]

/** Which brand a DECLARATION's name denotes, for the bare-`id` spelling.
 *  `SessionMeta` → Session, `ConversationSummaryWire` → Conversation,
 *  `IssueComment` → null. Longest brand wins, so `AutomationRunWire` is an
 *  AutomationRun and not an Automation. */
export function brandOfSymbol(
  symbol: string,
  brandNames: readonly string[] = ID_BRANDS,
): string | null {
  let best: string | null = null
  for (const brand of brandNames) {
    if (!symbol.startsWith(brand)) continue
    if (!REPRESENTATION_SUFFIXES.includes(symbol.slice(brand.length))) continue
    if (best === null || brand.length > best.length) best = brand
  }
  return best
}

/**
 * Which brand a FILE'S PATH denotes — the THIRD spelling of "an entity id field",
 * added at POD-1212.
 *
 * The two spellings above both read a NAME: the field's own (`sessionId`) or its
 * declaration's (`SessionMeta.id`). A command contract has neither. In
 * `packages/commands/src/issues/contracts.ts` the id of an issue is written
 *
 *     const byId = z.object({ id: z.string() })
 *
 * and every one of the ten commands built from it takes an `IssueId`. The key is
 * `id`, so {@link brandOfKey} is silent; the declaration is `byId`, so
 * {@link brandOfSymbol} is silent. POD-1212 planted `parentId: z.string()` in
 * that file and the detector stayed GREEN — a survivor, and the same class as
 * every "detector covers one syntax form" defect in this run: the concept had a
 * third way of being written and the instrument knew two.
 *
 * The inference is the TENANT, and it is derived from the same brand vocabulary
 * rather than listed: a path segment that singularises to a brand names the
 * entity that directory is about. `commands/src/issues/` → Issue,
 * `modules/conversations/` → Conversation. A tenant with no brand
 * (`mail`, `specs`, `fleet`, `workflows`) yields null and its `id` fields stay
 * unmeasured HERE — correctly, because this item counts fields whose brand
 * EXISTS, and inventing one is POD-318's kind of work, not this key's.
 */
export function brandOfPath(
  file: string,
  brandNames: readonly string[] = ID_BRANDS,
): string | null {
  for (const seg of file.replace(/\.[jt]sx?$/, '').split('/')) {
    const pascal = seg
      .split('-')
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join('')
    // Singular and plural alike; a directory is conventionally plural and a
    // module file conventionally singular, and both name the same tenant.
    for (const cand of [pascal.replace(/ies$/, 'y'), pascal.replace(/s$/, ''), pascal]) {
      const hit = brandNames.find((b) => b.toLowerCase() === cand.toLowerCase())
      if (hit !== undefined) return hit
    }
  }
  return null
}

/**
 * Keys that name the SAME entity the enclosing tenant is about, rather than a
 * different one.
 *
 * `parentId` on an issue is an `IssueId`; this is the self-referential edge of a
 * tree and it is a relationship word, not an entity name, which is why no
 * `<brand>Id` rule can reach it. Enumerated as a CONCEPT (the words a
 * self-reference is written with) rather than as the two lines that happen to
 * exist today.
 */
const SELF_REFERENTIAL_KEYS = /^(?:parent|child|root|ancestor|predecessor|successor)Id$/

/**
 * WHY THERE IS NO STRUCTURAL "POLYMORPHIC ID" RULE HERE, THOUGH IT WAS TRIED.
 *
 * Limit 2 holds that a polymorphic id is out of scope by design. Under the first
 * two spellings that fell out for free (`targetId`/`toId` carry no brand token).
 * Tenant inference does not get it for free: it reads
 * `z.object({ kind: PinKind, id: z.string(), … })` in `commands/src/sessions/`
 * as a `SessionId`, and `PinKind` is `panel | worktree | repo`, so it is none of
 * them.
 *
 * The obvious fix — exclude a bare `id` whose object declares a `kind`/`type`
 * sibling — was implemented at POD-1212 and REVERTED, because it silently
 * excluded three sites that are not polymorphic at all:
 *
 *     startInput      { id, agentKind }                  ← agentKind is an ATTRIBUTE
 *     addSessionInput { id, agentKind }                  ← same
 *     actionInput     { id, kind: 'rebase'|'pr'|'merge' } ← kind is the ACTION
 *
 * In every one of those the `id` is an `IssueId`. What makes `pinSetInput`
 * different is SEMANTIC — its enum members name entity kinds, where these name
 * an attribute or a verb — and that is not legible at the declaration without
 * resolving an imported enum. An exclusion rule that cannot tell them apart
 * fails in the direction this whole issue exists to prevent: quietly not looking.
 *
 * So the polymorphic site is excluded by the `UNBRANDED` marker instead, which is
 * a reasoned, in-source, RATCHETED exclusion rather than a line-number ignore
 * list — the mechanism {@link unbrandedByDecisionFields} exists for.
 */

/**
 * Whether a declaration name is a deliberate NO rather than a silence.
 *
 * {@link brandOfSymbol} returns null for two very different reasons, and tenant
 * inference must only override ONE of them:
 *
 *   - `byId`, `getInput`, `reparentInput` — the name says NOTHING about which
 *     entity it addresses. The directory is the only evidence there is, so
 *     spelling 3 should speak.
 *   - `IssueComment`, `SessionObservationCheckpoint` — the name says this is a
 *     DIFFERENT entity that merely begins with a brand. That is a considered
 *     judgement (see {@link REPRESENTATION_SUFFIXES}) and letting the enclosing
 *     directory outvote it would re-introduce, through the back door, exactly
 *     the `IssueComment.id === IssueId` lie the suffix list exists to prevent.
 *
 * Caught by `entity-id-audit.test.ts` — spelling 3 fired on `IssueComment`
 * inside `commands/src/issues/` before this existed.
 */
export function declaresOtherEntity(
  symbol: string,
  brandNames: readonly string[] = ID_BRANDS,
): boolean {
  if (brandOfSymbol(symbol, brandNames) !== null) return false
  return brandNames.some((b) => symbol.startsWith(b))
}

const DECL_AT_COL_0 = /^export (?:const|type|interface|class) (\w+)/

/**
 * Classify the right-hand side of a field declaration.
 *
 * Anchored on what the expression STARTS with, not on what it contains: a
 * `sessionId: z.object({ … z.string() … })` contains a zod string and is not
 * one. The union/wrapper arm is the exception and is admitted only when the
 * expression opens no nested object.
 */
export function classifyRhs(rhs: string): IdFieldForm {
  const norm = rhs.replace(/\s+/g, '')
  if (/\.brand</.test(norm)) return 'zod-branded'
  if (/\b\w+IdField\b/.test(norm)) return 'zod-branded'
  if (/\.pipe\(/.test(norm) && /\bz\./.test(norm)) return 'zod-branded'
  if (/^z\.string\(/.test(norm)) return 'zod-string'
  // A wrapper (`z.union([z.string(), z.null()])`, `z.nullable(z.string())`) is
  // still a raw string field — but only when it opens no nested object, or the
  // inner shape's own members would be read as this field's type.
  if (/^z\./.test(norm) && /z\.string\(/.test(norm) && !/z\.object\(/.test(norm)) {
    return 'zod-string'
  }
  if (/^z\./.test(norm)) return 'other'
  if (/^(?:text|integer|blob|real|numeric)\(/.test(norm)) return 'db-column'
  if (/^(?:string|\|?string\b)/.test(norm) || /^(?:string\|null|string\|undefined)/.test(norm)) {
    return 'ts-string'
  }
  return 'other'
}

/** Prefix depth of `{` for every index in `text`, computed once per file. */
function braceDepths(text: string): Int32Array {
  const depths = new Int32Array(text.length + 1)
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    depths[i] = depth
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') depth--
  }
  depths[text.length] = depth
  return depths
}

/** The RHS expression: from `start` to the first `,`, `;` or closing bracket at
 *  the same nesting depth. Bounded, so an unbalanced file cannot swallow the
 *  rest of the module. */
function rhsText(text: string, start: number): string {
  let depth = 0
  const limit = Math.min(text.length, start + 600)
  for (let i = start; i < limit; i++) {
    const c = text[i] as string
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      if (depth === 0) return text.slice(start, i)
      depth--
    } else if ((c === ',' || c === ';') && depth === 0) return text.slice(start, i)
  }
  return text.slice(start, limit)
}

/** Line number (1-based) for a byte offset. */
function lineOf(newlineIdx: readonly number[], offset: number): number {
  let lo = 0
  let hi = newlineIdx.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((newlineIdx[mid] as number) < offset) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

/**
 * Whether the field at `line` (1-based, in the RAW source) carries the
 * `UNBRANDED` token — on its own line, or in the comment block immediately
 * above it. Read from the RAW source because the audit context strips comments.
 */
function isExcused(rawLines: readonly string[], line: number): boolean {
  const own = rawLines[line - 1] ?? ''
  if (UNBRANDED_TOKEN.test(own)) return true
  for (let n = line - 2; n >= 0 && n > line - 30; n--) {
    const l = (rawLines[n] ?? '').trim()
    if (l === '') break
    const isComment = l.startsWith('*') || l.startsWith('/*') || l.startsWith('//')
    if (!isComment) break
    if (UNBRANDED_TOKEN.test(l)) return true
  }
  return false
}

const FIELD_POSITION =
  /(^|[{;,(\n])[ \t]*(?:readonly[ \t]+)?(?:'([\w$]+)'|"([\w$]+)"|([\w$]+))\??[ \t]*:[ \t\n]*/g

/**
 * Every field position under `apps/` + `packages/` whose key denotes a branded
 * entity id, with its classified form. Non-test, non-frozen files only.
 *
 * THROWS on an empty brand vocabulary (see {@link assertBrandsLoaded}).
 */
export function entityIdSites(ctx: AuditContext): EntityIdSite[] {
  assertBrandsLoaded(ID_BRANDS)
  const out: EntityIdSite[] = []
  for (const f of ctx.files) {
    if (f.isTest) continue
    // Past migrations are immutable history; generated files are rebuilt from
    // them. Neither may be edited to satisfy an audit.
    if (f.file.includes('/migrations/drizzle/') || f.file.endsWith('.generated.ts')) continue
    // Wire fixtures are captured PAYLOADS, not declarations of a shape.
    if (f.file.endsWith('.fixtures.ts')) continue

    const text = f.stripped
    // Most files declare no entity id at all. Both index builds below are O(file)
    // and were being paid for every file in the tree; they are deferred until a
    // candidate key actually turns up.
    let depths: Int32Array | null = null
    let newlineIdx: number[] | null = null
    const depthAt = (i: number): number => {
      depths ??= braceDepths(text)
      return depths[i] as number
    }
    const lineAt = (i: number): number => {
      if (newlineIdx === null) {
        newlineIdx = []
        for (let k = 0; k < text.length; k++) if (text[k] === '\n') newlineIdx.push(k)
      }
      return lineOf(newlineIdx, i)
    }
    // Comments are the excuse marker's home, so this detector needs the source
    // AS WRITTEN. Falling back to `stripped` means no site reads as excused,
    // which is the fail-CLOSED direction: an unreadable comment cannot excuse.
    const rawLines = (f.raw ?? text).split('\n')

    // The nearest preceding column-0 declaration, for the bare-`id` spelling.
    let decls: { at: number; symbol: string }[] | null = null
    const symbolAt = (offset: number): string => {
      if (decls === null) {
        decls = []
        for (const m of text.matchAll(new RegExp(DECL_AT_COL_0.source, 'gm'))) {
          decls.push({ at: m.index ?? 0, symbol: m[1] as string })
        }
      }
      let sym = ''
      for (const d of decls) {
        if (d.at > offset) break
        sym = d.symbol
      }
      return sym
    }

    FIELD_POSITION.lastIndex = 0
    for (const m of text.matchAll(FIELD_POSITION)) {
      const key = (m[2] ?? m[3] ?? m[4]) as string
      const at = (m.index ?? 0) + m[0].length
      let brand = brandOfKey(key)
      let symbol = ''
      if (brand === null) {
        // Spellings 2 and 3, both at depth 1 only — a nested object's `id`
        // belongs to that inner shape, not to the declaration.
        const selfRef = SELF_REFERENTIAL_KEYS.test(key)
        if ((key !== 'id' && !selfRef) || depthAt(at) !== 1) continue
        // Spelling 2: a bare `id` on a declaration whose NAME denotes a brand.
        symbol = symbolAt(m.index ?? 0)
        brand = key === 'id' ? brandOfSymbol(symbol) : null
        // Spelling 3: the file's TENANT names the entity. Second, so a
        // declaration that names its own brand always wins over the directory —
        // and a declaration that names a DIFFERENT entity vetoes it outright.
        if (brand === null && !declaresOtherEntity(symbol)) brand = brandOfPath(f.file)
        if (brand === null) continue
      }
      const form = classifyRhs(rhsText(text, at))
      // The line of the KEY, not of the separator the match opened on: the
      // separator is often the newline ENDING the previous line, and a site
      // reported one line high points a reader at the wrong field.
      const line = lineAt((m.index ?? 0) + m[0].indexOf(key))
      out.push({
        file: f.file,
        line,
        text: `${key}: ${rhsText(text, at).replace(/\s+/g, ' ').trim().slice(0, 100)}`,
        key,
        brand,
        form,
        symbol,
        excused: isExcused(rawLines, line),
      })
    }
  }
  if (out.length < MIN_ID_FIELD_SITES) {
    throw new Error(
      `entity-id-audit: found only ${out.length} entity-id field positions, below the ` +
        `${MIN_ID_FIELD_SITES} floor. The scanner has stopped matching — every count below ` +
        'would be a false zero. Fix the scan; do not rebaseline.',
    )
  }
  return out
}

const site = (s: EntityIdSite): AuditSite => ({ file: s.file, line: s.line, text: s.text })

/** An id-SHAPED key: the population {@link brandOfKey} is a filter over. */
const ID_SHAPED_KEY = /Id$|^id$|_id$/

/**
 * THE OTHER SCOPE, reported because it disagrees with the counted one.
 *
 * `rearch-audit`'s item counts id fields whose brand EXISTS — that is what its
 * unit says and it is the only scope a ratchet can drive to zero, since a field
 * with no brand has nothing to be flipped TO. But the fanout ledger is explicit
 * that when two defensible scopes disagree you report BOTH rather than picking
 * the kind one, and that "not counted" must never be allowed to read as "not
 * there" (the reason Limit 1 prints db-columns and TS members too).
 *
 * So this is the wider scope: every id-shaped key typed as a bare zod string
 * that NONE of the three spellings can reach, because its name names neither a
 * brand nor a tenant. Measured at POD-1212: **191** sites across ~48 keys — of
 * the 227 that were unreachable before spelling 3, 36 became reachable and were
 * flipped or given a reason.
 *
 * It is deliberately NOT a baseline key, and the split is not flattery:
 *
 *   - MOST of it is not this item's debt. `requestId`, `runId`, `revisionId`,
 *     `stepId`, `transitionId`, `fetchId` and ~40 more name entities that have
 *     no brand in `packages/model` at all. Ratcheting them would demand brands
 *     be minted, which is a modelling decision and its own piece of work.
 *   - A FEW are genuinely this item's debt and simply unreachable by any rule
 *     keyed on names: `duplicateInput.canonicalId` is an `IssueId`;
 *     `causationId` is a `mutationId` under another name. They are listed here
 *     rather than quietly omitted.
 *
 * Reporting-only, via `bun scripts/entity-id-audit.ts --unreachable`.
 */
export function idFieldsWithNoBrandVocabulary(ctx: AuditContext): AuditSite[] {
  const seen = new Set<string>()
  for (const s of sitesOnce(ctx)) seen.add(`${s.file}:${s.line}:${s.key}`)
  const out: AuditSite[] = []
  for (const f of ctx.files) {
    if (f.isTest) continue
    if (f.file.includes('/migrations/drizzle/') || f.file.endsWith('.generated.ts')) continue
    if (f.file.endsWith('.fixtures.ts')) continue
    const text = f.stripped
    const nl: number[] = []
    for (let k = 0; k < text.length; k++) if (text[k] === '\n') nl.push(k)
    FIELD_POSITION.lastIndex = 0
    for (const m of text.matchAll(FIELD_POSITION)) {
      const key = (m[2] ?? m[3] ?? m[4]) as string
      if (!ID_SHAPED_KEY.test(key)) continue
      const at = (m.index ?? 0) + m[0].length
      if (classifyRhs(rhsText(text, at)) !== 'zod-string') continue
      const line = lineOf(nl, (m.index ?? 0) + m[0].indexOf(key))
      // Anything the three spellings already reach is counted elsewhere.
      if (seen.has(`${f.file}:${line}:${key}`)) continue
      out.push({
        file: f.file,
        line,
        text: `${key}: ${rhsText(text, at).replace(/\s+/g, ' ').trim().slice(0, 80)}`,
      })
    }
  }
  return out
}

/** The three checks below share one scan of the tree. Without this the deletion
 *  audit walks every file three times and its own CLI test — which spawns the
 *  real binary — starts timing out on a loaded host. */
const scanCache = new WeakMap<AuditContext, EntityIdSite[]>()
const sitesOnce = (ctx: AuditContext): EntityIdSite[] => {
  const hit = scanCache.get(ctx)
  if (hit !== undefined) return hit
  const sites = entityIdSites(ctx)
  scanCache.set(ctx, sites)
  return sites
}

/**
 * POD-301's item: an entity id field declared as a bare zod string where the
 * brand exists.
 *
 * Machine-id fields are NOT here — they are their own count
 * ({@link machineIdUnbrandedFields}), which is where ADR 1 Amendment 2 D16.2 put
 * them and where POD-318 drove them to zero.
 */
export function rawStringEntityIds(ctx: AuditContext): AuditSite[] {
  return sitesOnce(ctx)
    .filter((s) => s.form === 'zod-string' && s.brand !== 'Machine' && !s.excused)
    .map(site)
}

/**
 * POD-318's item: a machine-id field still declared as a bare `z.string()`.
 *
 * It reached zero when POD-318 retired the sentinels and bound every field to
 * `MachineIdField`. The detector stays because the ratchet is what stops the debt
 * from being re-created: a new machine-id field written as a raw string raises
 * this number and fails the audit.
 */
export function machineIdUnbrandedFields(ctx: AuditContext): AuditSite[] {
  return sitesOnce(ctx)
    .filter((s) => s.brand === 'Machine' && s.form === 'zod-string')
    .map(site)
}

/**
 * The escape hatch, counted. A zod id field excused by an `UNBRANDED` doc
 * comment — harness-native ids, external correlation ids, and the four sites
 * POD-423 checked individually and upheld.
 *
 * Ratcheted so POD-301's count cannot be zeroed by sprinkling comments: a new
 * marker raises THIS number and the audit fails until it is recorded.
 */
export function unbrandedByDecisionFields(ctx: AuditContext): AuditSite[] {
  return sitesOnce(ctx)
    .filter((s) => s.form === 'zod-string' && s.excused)
    .map(site)
}

// ---------------------------------------------------------------------------
// CLI — the reporting surface for the classes the baseline does not ratchet
// ---------------------------------------------------------------------------

/**
 * `bun scripts/entity-id-audit.ts [--sites] [--form <form>]`
 *
 * The ratchet lives in `rearch-audit.ts`; this prints the WHOLE classified
 * population, including the drizzle-column and TS-member classes that are
 * deliberately not in a baseline key (Limit 1). Without a way to see them, "not
 * counted" would read as "not there".
 */
if (import.meta.main) {
  const { loadContext } = await import('./rearch-audit')
  const argv = process.argv.slice(2)
  const only = argv.includes('--form') ? argv[argv.indexOf('--form') + 1] : undefined
  const sites = entityIdSites(loadContext(REPO_ROOT))
  const byForm = new Map<string, number>()
  for (const s of sites) byForm.set(s.form, (byForm.get(s.form) ?? 0) + 1)
  console.log(`entity-id field positions: ${sites.length} (floor ${MIN_ID_FIELD_SITES})`)
  for (const [form, n] of [...byForm].sort((a, b) => b[1] - a[1])) console.log(`  ${form}: ${n}`)
  console.log(
    `  ratcheted: raw=${sites.filter((s) => s.form === 'zod-string' && s.brand !== 'Machine' && !s.excused).length} machine=${sites.filter((s) => s.brand === 'Machine' && s.form === 'zod-string').length} excused=${sites.filter((s) => s.form === 'zod-string' && s.excused).length}`,
  )
  if (argv.includes('--unreachable')) {
    const wider = idFieldsWithNoBrandVocabulary(loadContext(REPO_ROOT))
    const byKey = new Map<string, number>()
    for (const s of wider) {
      const k = s.text.slice(0, s.text.indexOf(':'))
      byKey.set(k, (byKey.get(k) ?? 0) + 1)
    }
    console.log(`\nNOT COUNTED — id-shaped, raw, and unreachable by name: ${wider.length}`)
    console.log('  (mostly names with NO brand in packages/model — nothing to flip TO)')
    for (const [k, n] of [...byKey].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${k}`)
    }
  }
  if (argv.includes('--sites')) {
    for (const s of sites) {
      if (only !== undefined && s.form !== only) continue
      console.log(
        `  ${s.file}:${s.line} [${s.form}/${s.brand}${s.excused ? '/excused' : ''}] ${s.text}`,
      )
    }
  }
}
