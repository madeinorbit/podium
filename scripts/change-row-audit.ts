/**
 * THE REDEFINED CHANGE-ROW DETECTOR — POD-305, redefining `change-row-typings`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OLD DETECTOR HAD TO BE REPLACED RATHER THAN RE-BASELINED
 * ---------------------------------------------------------------------------
 *
 * The item used to count EXPORTED NAMES:
 *
 *     /^export (?:const|type) (?:MetadataChange|UnknownMetadataChange|SyncChangesSinceResult)/
 *
 * — seven of them — under the title "Parallel change-row typings
 * (strict/lenient/unknown)". Two independent problems with that, both recorded
 * before this change and neither fixed by a bigger name list:
 *
 * 1. IT MEASURES THE WRONG THING. The POD-279 review's finding 2 is explicit
 *    that change data legitimately exists in distinct lifecycle phases — a
 *    staged spec at commit time, a stored row, a sequenced wire delta — and that
 *    "the deletion-audit target is hand-restated field lists, not the existence
 *    of lifecycle types". A detector keyed on the NAMES of the lifecycle types
 *    can only be zeroed by deleting a type that has a reason to exist.
 * 2. IT WAS BLIND TO THE ACTUAL DEBT. `packages/protocol/src/messages/sync.ts`
 *    restated `seq`/`entity`/`id`/`op`/`value` SIX times (five strict arms plus
 *    the lenient catch-all) and the whole `changesSince` snapshot arm twice, and
 *    the old detector reported the same 7 whether those restatements were there
 *    or not. It also counted `MetadataChangeOp` — an op enum, not a change-row
 *    typing — which `docs/rearch-deletion-audit.md` already flagged as an
 *    over-count "by at least one", left uncorrected because lowering someone
 *    else's count while re-phasing was two changes wearing one justification.
 *    POD-305 owns the item's subject now, so it is corrected here, in the open.
 *
 * WHAT THIS ONE MEASURES: a declaration that WRITES OUT the change-row field
 * list instead of composing `@podium/model`'s change vocabulary. Composition
 * sites survive on purpose — one factory that every arm calls is the target
 * state, not debt, and a detector that punished it would push the code back
 * toward restatement.
 *
 * THE VOCABULARY IS READ FROM THE MODEL AT RUNTIME, never restated here, so a
 * field rename in `packages/model/src/fields/change.ts` cannot silently make
 * this detector stop matching — the same defence `representation-audit.ts`
 * adopted at POD-368 after its hardcoded name lists went stale.
 *
 * AND THE DETECTOR IS UNIT-TESTED AGAINST PLANTED VIOLATIONS
 * (`change-row-audit.test.ts`), because a scanner reporting zero because it is
 * looking in the wrong place is indistinguishable from a clean repo.
 */

import {
  ChangeProvenanceFields,
  ChangeTargetFields,
} from '../packages/model/src/fields/change'
import type { AuditContext, AuditSite } from './rearch-audit'

// ---------------------------------------------------------------------------
// The vocabulary — read from the model
// ---------------------------------------------------------------------------

/**
 * The keys a change row is made of, other than the op itself.
 *
 * Assembled from the model's own field groups plus the four scalar fields that
 * are exported as standalone schemas (a zod scalar has no `.shape` to read, so
 * their NAMES are the one thing this file must state — and the test asserts each
 * one against the model's exports so a rename fails loudly rather than quietly).
 *
 * `id` is included beside `entityId`: the wire spells the target-id key `id`
 * (POD-308 owns reconciling the two), and a detector that only knew the storage
 * spelling would score every wire restatement one key too low.
 */
export const CHANGE_ROW_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(ChangeTargetFields.shape),
  ...Object.keys(ChangeProvenanceFields.shape),
  'id',
  'seq',
  'payload',
  'value',
  'eventTime',
  'revision',
])

/** The key that makes a block a CHANGE row rather than any other record. */
export const CHANGE_OP_KEY = 'op'

/**
 * How many change keys beside `op` make a block a restatement.
 *
 * TWO, not three. A change row is a small shape — `op` plus a target plus a
 * position is the whole thing — so the session/issue detector's threshold of 3
 * would miss the minimal restatement, which is exactly the one a refactor leaves
 * behind. The trade is more sensitivity, and it is paid for by requiring the
 * `op` key: a record with `entity` and `seq` and no `op` is not a change row.
 */
export const CHANGE_ROW_THRESHOLD = 2

// ---------------------------------------------------------------------------
// Block scanning
// ---------------------------------------------------------------------------

/** One brace-delimited block and the keys declared directly inside it. */
export interface KeyBlock {
  /** 1-indexed line the block opened on. */
  line: number
  keys: ReadonlySet<string>
  /** The source text following `op:` in this block, if it has one. Decides
   *  DECLARATION versus CONSTRUCTION — see {@link isDeclaredFieldList}. */
  opValue?: string
}

/**
 * DECLARATION versus CONSTRUCTION — the line that keeps this item actionable.
 *
 * A first cut of this detector counted every block with an `op` key beside two
 * other change keys and reported 76 sites. Reading them showed the flaw at once:
 * most were `{ entity: 'automation', id: automation.id, op: 'upsert', value: w }`
 * — a caller BUILDING a change spec. That is a USE of the shared type, and there
 * are supposed to be many; counting them would have made the ratchet unclosable
 * and would have punished exactly the callers the composition exists to serve.
 *
 * The debt is a DECLARATION: a place that writes the field list beside TYPES or
 * SCHEMAS, creating a second definition of what a change row is. So the block is
 * counted only when its `op` member is declared as a type/schema rather than
 * assigned a value:
 *
 *   COUNTED     op: MetadataChangeOp          (a zod schema reference)
 *               op: z.enum([...])             (a zod schema)
 *               op: 'upsert' | 'remove'       (a TS union type)
 *               op: string                    (a TS type)
 *               op: text().notNull()          (a drizzle column — POD-1168's form)
 *   NOT COUNTED op: 'upsert'                  (a value)
 *               op: row.op                    (a value)
 *               op: row.op as 'upsert' | 'remove'   (a value, cast)
 *
 * The cast case is why the test is anchored at the START of the value rather than
 * searching it for a `|`: `row.op as 'upsert' | 'remove'` contains a union and is
 * still a construction.
 */
const DECLARED_OP_VALUE = new RegExp(
  [
    '^z\\.', // a zod schema: z.enum([...]), z.string(), …
    '^(?:text|integer|real|blob|numeric)\\s*\\(', // a drizzle column
    "^'[^']*'\\s*\\|", // a TS union of string literals
    '^(?:string|unknown|any)\\b', // a bare TS type
    '^[A-Z][\\w.]*\\s*(?:$|[,;}\\n])', // a schema/type IDENTIFIER, uncalled
  ].join('|'),
)

export function isDeclaredFieldList(opValue: string | undefined): boolean {
  if (opValue === undefined) return false
  return DECLARED_OP_VALUE.test(opValue.trim())
}

const KEY_AT_DEPTH = /^[A-Za-z_$][\w$]*$/

/**
 * Every `{ … }` block in `source`, with the keys declared at ITS OWN depth.
 *
 * Char-level rather than line-level because the shapes this has to see are
 * written both ways — `z.object({ seq: …, entity: … })` on one line and an
 * `interface` over eight — and a line-based counter attributes a nested block's
 * keys to its parent, which would score `geometry: z.object({cols, rows})` as
 * two extra keys on the enclosing shape.
 *
 * String literals are skipped so a brace inside one cannot unbalance the depth.
 * The input is already comment-stripped by the audit context.
 */
export function keyBlocks(source: string): KeyBlock[] {
  const blocks: KeyBlock[] = []
  const stack: { line: number; keys: Set<string>; opValue?: string }[] = []
  let line = 1
  let pendingWord = ''
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string
    if (ch === '\n') {
      line += 1
      pendingWord = ''
      continue
    }
    // Skip over a string/template literal wholesale — its contents are data.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i += 1
      while (i < source.length) {
        const c = source[i] as string
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '\n') line += 1
        if (c === quote) break
        i += 1
      }
      pendingWord = ''
      continue
    }
    if (ch === '{') {
      stack.push({ line, keys: new Set() })
      pendingWord = ''
      continue
    }
    if (ch === '}') {
      const frame = stack.pop()
      if (frame) {
        blocks.push(
          frame.opValue === undefined
            ? { line: frame.line, keys: frame.keys }
            : { line: frame.line, keys: frame.keys, opValue: frame.opValue },
        )
      }
      pendingWord = ''
      continue
    }
    if (ch === ':') {
      const frame = stack[stack.length - 1]
      if (frame && KEY_AT_DEPTH.test(pendingWord)) {
        frame.keys.add(pendingWord)
        // Capture the member's declared text so DECLARATION can be told from
        // CONSTRUCTION. Bounded at the line end: a member spanning lines is a
        // schema expression, and its first line already answers the question.
        if (pendingWord === CHANGE_OP_KEY) {
          const rest = source.slice(i + 1)
          frame.opValue = (rest.split('\n')[0] ?? '').trim()
        }
      }
      pendingWord = ''
      continue
    }
    if (/[\w$]/.test(ch)) {
      pendingWord += ch
      continue
    }
    // `?` before the colon marks an optional member; keep the word alive for it.
    if (ch !== '?') pendingWord = ''
  }
  return blocks
}

/** Does this block DECLARE a change-row field list? */
export function isChangeRowRestatement(block: KeyBlock): boolean {
  return isDeclaredFieldList(block.opValue) && scores(block.keys)
}

function scores(keys: Iterable<string>): boolean {
  const set = keys instanceof Set ? keys : new Set(keys)
  if (!set.has(CHANGE_OP_KEY)) return false
  let matched = 0
  for (const key of set) {
    if (key !== CHANGE_OP_KEY && CHANGE_ROW_KEYS.has(key)) matched += 1
  }
  return matched >= CHANGE_ROW_THRESHOLD
}

// ---------------------------------------------------------------------------
// The SECOND syntax form: a field list written as string literals
// ---------------------------------------------------------------------------

/**
 * `Pick<ChangeRow, 'seq' | 'entity' | 'op'>` and its friends.
 *
 * This form exists because POD-1168 caught the sibling detector covering exactly
 * one spelling of its concept: `instancePartitions` iterated entity-shaped
 * DECLARATIONS and tested their KEYS, so a physical column declared through a
 * call expression — `sqliteTable("sessions", { instanceId: text("instance_id") })`
 * — was never enumerated, and its probe kept passing while the concept went
 * unmeasured.
 *
 * So the concept here is "a change-row field list, written out", and it has two
 * spellings, not one:
 *
 *   1. KEY POSITIONS — an object literal, a `z.object`, an `interface` body, a
 *      `type` alias body, or a drizzle `sqliteTable` column map. All of these put
 *      the field names in key position and are found by {@link keyBlocks}; a
 *      drizzle table needs no special case precisely because its columns ARE keys.
 *   2. STRING LITERALS in a type operator — `Pick`, `Omit`, `Extract`, a
 *      `keyof`-driven union, or a plain `as const` array of field names. The
 *      block scanner skips string literals wholesale (it must, or a brace inside
 *      one unbalances the depth), so this form would otherwise be invisible.
 *
 * Both are counted, and `change-row-audit.test.ts` plants one of EACH and
 * requires it to fire.
 */
const TYPE_OPERATOR_FIELD_LIST =
  /\b(?:Pick|Omit|Extract|Exclude)\s*<[^<>]*?,\s*((?:\s*'[^']+'\s*\|?)+)\s*>/g

const AS_CONST_FIELD_LIST = /\[\s*((?:'[^']+'\s*,?\s*)+)\]\s*as\s+const/g

/** Field-name string lists in `source`, with the line each was found on. */
export function literalFieldLists(source: string): { line: number; keys: Set<string> }[] {
  const found: { line: number; keys: Set<string> }[] = []
  for (const re of [TYPE_OPERATOR_FIELD_LIST, AS_CONST_FIELD_LIST]) {
    for (const match of source.matchAll(new RegExp(re.source, 'g'))) {
      const body = match[1] ?? ''
      const keys = new Set([...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string))
      const line = source.slice(0, match.index ?? 0).split('\n').length
      found.push({ line, keys })
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// The audit item's collector
// ---------------------------------------------------------------------------

/**
 * Every hand-restated change-row field list under `apps` and `packages`.
 *
 * Scanned repo-wide rather than over the protocol file alone, deliberately: the
 * old item was scoped to `messages/sync.ts`, so a restatement copied into the
 * server or the kernel was free. A field list restated anywhere is the same debt.
 */
export function changeRowRestatements(ctx: AuditContext): AuditSite[] {
  const sites: AuditSite[] = []
  for (const f of ctx.files) {
    if (!(f.file.startsWith('apps/') || f.file.startsWith('packages/'))) continue
    if (f.isTest) continue
    const lines = f.stripped.split('\n')
    const at = (line: number): AuditSite => ({
      file: f.file,
      line,
      text: (lines[line - 1] ?? '').trim(),
    })
    for (const block of keyBlocks(f.stripped)) {
      if (isChangeRowRestatement(block)) sites.push(at(block.line))
    }
    for (const literal of literalFieldLists(f.stripped)) {
      if (scores(literal.keys)) sites.push(at(literal.line))
    }
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}
