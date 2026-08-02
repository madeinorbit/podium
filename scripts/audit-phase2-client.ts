/**
 * THE PHASE-2 CLIENT AUDIT (POD-378), as four detectors that must each report ZERO.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCRIPT AND NOT A REVIEW
 * ---------------------------------------------------------------------------
 *
 * All four items below are properties a future commit can quietly break, and
 * three of them break INVISIBLY — a client-side visibility filter looks like
 * defence, a local copy of a per-user row looks like a cache, and a store read
 * that skips attribution looks like a fast path. A one-off review clears them
 * once and then decays. These run in the test lane, so the day one regresses the
 * lane goes red with the site named.
 *
 * `scripts/audit-phase2-client.test.ts` proves each detector can FIRE, against a
 * synthetic violation of its own item. That is not decoration: this run's
 * recurring defect class is an instrument whose refusing arm nothing has ever
 * produced, and a detector reporting zero is indistinguishable from a detector
 * that cannot count.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH ITEM IS, AND WHY ITS DETECTOR HAS THE SHAPE IT HAS
 * ---------------------------------------------------------------------------
 *
 * 1. THE CLIENT DOES NOT HOLD THE WORLD. ADR 4 D7.3 rejected a server-side IVM
 *    engine because "the client already holds the world"; under scoping the
 *    client holds its SLICE (`docs/multi-user-readiness.md` §3.1 item 4 — keep
 *    D7.3, amend the sentence).
 *
 *    The detector matches the AFFIRMATIVE claim only. A file explaining the
 *    amendment necessarily contains the old words — `engine/overlay.ts` says "A
 *    replica no longer holds the world" — and a detector that counted mentions
 *    would flag the very comments recording the fix, then be "fixed" by deleting
 *    the explanation. So negated forms are excluded by construction, and the test
 *    pins BOTH arms: the affirmative fires, the negated does not.
 *
 * 2. NO CLIENT-SIDE VISIBILITY FILTERING. ADR 1 D1 — the Replica never
 *    arbitrates; scoping is decided entirely by the Authority. A client-side
 *    filter is both a bug (it hides rows the server deliberately sent) and a
 *    false sense of security (it cannot hide what was never delivered), so the
 *    rule is remove, not keep-as-belt-and-braces.
 *
 *    Scoped to filtering over ENTITY COLLECTIONS on a visibility or ownership
 *    concept. Deliberately NOT every `.filter(` with the word "allowed" in it:
 *    `RightRail.tsx` filters which PANELS to render, which is layout, and
 *    `NewPanelMenu.tsx` disables machine rows carrying a server-supplied
 *    `unauthorized` rejection, which is §3.1.4 M5's required affordance rendering
 *    the Authority's answer rather than second-guessing it. A detector that
 *    flagged those would be silenced by an allowlist, and an allowlist is where
 *    a real one hides.
 *
 * 3. NO LOCAL-ONLY HOME FOR ANYTHING POD-1076 MOVED. The list is not this file's
 *    to invent: `PER_USER_STATE_FAMILY` in `packages/model/src/user-state/family.ts`
 *    is the declaration, and `PER_USER_STATE_NON_MEMBERS` names the three facts
 *    that are per-user BY CLASS but were deliberately NOT moved, each with its
 *    reason — sidebar/tab layout (client-local by construction), personal
 *    preference keys (POD-352 owns that surface), the client outbox and replica
 *    cursor (device-local, ADR 1 Am1 §10).
 *
 *    So this detector reads the family at run time rather than restating it. A
 *    hand-copied member list would pass forever after someone added a seventh
 *    member — the wire-gate-blind-to-vocabulary-drift shape.
 *
 * 4. NO UNATTRIBUTED READ OF THE PERSISTED STORE. Per POD-307 this fails CLOSED:
 *    an unattributable store is discarded and re-bootstrapped, never adopted
 *    (`packages/sync/src/adapters/legacy-replica/adoption.ts` is the gate).
 *
 *    The detector is over COMPOSITION ROOTS — the places that construct a client
 *    replica over persisted storage — because that is where the decision either
 *    is or is not made. Checking every read site instead would flag hundreds of
 *    innocent reads and miss the one construction that never asked.
 */

import { type Dirent, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PER_USER_STATE_FAMILY } from '../packages/model/src/user-state/family'

/** The repo root, from this file's own location — never `cwd`, which makes the
 *  audit report a different answer depending on where it was invoked. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface AuditFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

export interface AuditItem {
  readonly id: string
  readonly title: string
  /** What one finding means, in the words the fix needs. */
  readonly unit: string
  readonly findings: readonly AuditFinding[]
}

/** The client surface this audit governs. */
export const CLIENT_ROOTS = ['apps/web/src', 'apps/mobile/src', 'packages/client-core/src'] as const

/**
 * How a composition root is RECOGNISED. Not a list — see {@link discoverCompositionRoots}.
 *
 * `createReplica` is the legacy adapter, `createKernelReplica` the facade, and
 * `<X>SyncStore.open` any kernel store. A root is any product file that calls one.
 */
const BUILDS_A_REPLICA = /\bcreateReplica\s*\(|\bcreateKernelReplica\s*\(|SyncStore\.open\s*\(/

/**
 * A DEFINITION of one of those functions, which is not a call to it.
 *
 * `export function createReplica(init: ReplicaInit = {}): Replica {` matches
 * {@link BUILDS_A_REPLICA} perfectly, so the first discovery pass reported
 * `replica.ts` and `facade.ts` — the files that DECLARE the constructors — as roots
 * that had failed to attribute a store. Mention-is-not-a-call: the fix is to require
 * call shape, never to name those two files and skip them, because naming them would
 * also skip a real call that later appears in either.
 */
const IS_A_DEFINITION = /\b(export\s+)?(async\s+)?function\s+(createReplica|createKernelReplica)\b/

/**
 * The gate IN CALL POSITION, not by mention (POD-1239).
 *
 * This was `/decideLegacyAdoption|migrateLegacyReplica|LegacyIdentityEvidence/`
 * tested against whole file contents, and the names of a gate are exactly the words
 * a comment ABOUT the gate contains. So a root carrying
 *
 *     // TODO: call migrateLegacyReplica here before we read anything
 *
 * graded as attributed — a declaration with no consumer, certified by the prose
 * describing the consumer it does not have.
 *
 * It is the same mention-is-not-a-call shape this file already fixed on the OTHER
 * side of the same function, and the asymmetry is what made it worse: call shape was
 * required to be graded a ROOT, but a bare mention was enough to be graded CLEAN.
 * The lenient half is the one that decides whether a security property is REPORTED
 * AS HELD.
 *
 * `LegacyIdentityEvidence` is deliberately dropped. It is a TYPE; a type mention is
 * not an act, and an unused `import type` is precisely the shape that would pass. A
 * root that genuinely attributes necessarily CALLS one of the two functions.
 *
 * THE GATE MUST BE NAMED AT THE ROOT — a judgement POD-1239 left open, decided here.
 * If a client wraps the gate in a helper and the root calls the helper, this reports
 * the root unattributed. That is a false positive and it is the direction to fail in:
 * over-reporting costs an investigation, under-reporting reports a fail-closed
 * security decision as enforced when nothing enforces it (§3.1.1 rule 1 —
 * forgetting must fail toward privacy). Resolving one import hop was the
 * alternative and it invites "why not two", plus a resolver that needs its own
 * probe.
 *
 * POD-1220, as the author of the repo's first real `migrateLegacyReplica` call,
 * reached the same answer independently and gave a better reason than the grader's:
 * "the question a reader arrives with is 'does this client attribute its store
 * before adopting it?', which is asked OF the file that composes the store. A helper
 * is better factoring for almost anything else and worse for this: it moves the
 * answer one hop from where it is looked for, and one hop is enough for the next
 * person to assume it does not happen."
 *
 * THEIR CAVEAT MATTERS MORE THAN THEIR AGREEMENT, and it is a limit on this rule
 * rather than a cheer for it: "I would not extend that to a general rule. 'Inline it
 * so the audit can see it' is a bad principle applied broadly — it shapes code
 * around a detector. What justifies it here is that the root IS the right home for
 * the call, and the detector happens to agree. WHEN THOSE TWO COME APART, FIX THE
 * DETECTOR."
 *
 * So: if the helper pattern ever becomes the right factoring, widen this to name the
 * helper — never add an allowlist, which is where a genuine finding would hide, and
 * never contort a composition root to keep this regex happy.
 */
const CALLS_THE_GATE = /\b(?:decideLegacyAdoption|migrateLegacyReplica)\s*\(/

/**
 * A construction that provably persists NOTHING (POD-1252).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, WHICH IS NOT "TWO FILES WERE INCONVENIENT"
 * ---------------------------------------------------------------------------
 *
 * The item is "a PERSISTED store adopted without establishing the current
 * principal". The detector could only see the CONSTRUCTION, so it reported two
 * roots that construct a replica over a private in-memory Map: the shadow
 * comparison harness (`shadow/runner.ts`, whose second replica must not touch the
 * user's collections at all — that is its whole design) and the fixture capture
 * (`legacy-snapshot.ts`, which drives the real writer over a Map to record what it
 * wrote). Neither can adopt anyone's rows, because there are no rows to adopt: the
 * store dies with the function.
 *
 * The alternatives were both worse than fixing the detector. Calling the gate in
 * those two roots would be the thing this file's own header forbids — "never
 * contort a composition root to keep this regex happy" — and would leave the tree
 * with two `decideLegacyAdoption` calls that decide nothing, which is how a reader
 * learns that the call is ceremony. An allowlist of the two names is where a real
 * finding would later hide. POD-1220's caveat is the governing sentence and it is
 * about exactly this moment: "what justifies it here is that the root IS the right
 * home for the call, and the detector happens to agree. WHEN THOSE TWO COME APART,
 * FIX THE DETECTOR."
 *
 * ---------------------------------------------------------------------------
 * IT FAILS CLOSED, WHICH IS THE ONLY REASON IT IS SAFE
 * ---------------------------------------------------------------------------
 *
 * Exemption requires a POSITIVE declaration: the construction's `storage` must
 * resolve, in the same file, to `memoryStorage()` — the shipped ephemeral seam,
 * whose contract says nothing survives. Everything else is a finding, including
 * every store this audit has never heard of. The inverse rule — "exempt unless the
 * storage looks durable" — was the first draft and it is the unknown-input-fails-
 * open shape: a root over a store named neither `localStorage` nor `persisted`
 * would have graded clean by never being recognised.
 *
 * Resolution is one hop and deliberately no more: `storage: memoryStorage()`
 * inline, or `const s = memoryStorage()` in the same file passed as `storage: s`
 * or `{ storage }` shorthand. An import hop is not followed, for the reason this
 * file already gives about the gate: it invites "why not two", and it needs a
 * resolver that needs its own probe.
 *
 * The anti-spoof case is pinned in the probe suite: a root that builds over
 * `window.localStorage` is STILL a finding when the same file happens to call
 * `memoryStorage()` somewhere else, because the check is against the storage of
 * THAT construction, not against the file's vocabulary.
 */
/** {@link BUILDS_A_REPLICA} with offsets, so a call can be located in the file
 *  rather than only in a line — the argument list spans lines. */
const BUILDS_A_REPLICA_GLOBAL = new RegExp(BUILDS_A_REPLICA.source, 'g')

/** Where each construction call starts, definitions excluded. */
function constructionOffsets(source: string): number[] {
  const out: number[] = []
  for (const match of source.matchAll(BUILDS_A_REPLICA_GLOBAL)) {
    const index = match.index ?? 0
    // The definition exclusion is a LINE property (`export function createReplica(`),
    // so it is asked of the line the match sits on.
    const lineStart = source.lastIndexOf('\n', index) + 1
    const lineEnd = source.indexOf('\n', index)
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    if (IS_A_DEFINITION.test(line)) continue
    out.push(index)
  }
  return out
}

const DECLARES_EPHEMERAL = /\bstorage\s*:\s*memoryStorage\s*\(/
const BINDS_EPHEMERAL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*memoryStorage\s*\(/g
const STORAGE_IS_NAME = /\bstorage\s*:\s*([A-Za-z_$][\w$]*)\s*[,}\n]/
const STORAGE_SHORTHAND = /[{,]\s*storage\s*[,}]/

/**
 * The argument text of the construction call starting at `from`, by balancing
 * parens rather than by stopping at the first `)`.
 *
 * The naive version stops inside `enumerateKeys: () => storage.keys()`, which is
 * where the two exempt roots put the very thing being looked for — the same
 * first-closing-paren mistake `CLIENT_VISIBILITY_FILTER` records above, and it
 * would have failed in the direction that reports MORE rather than less, so it
 * would have looked like the detector working.
 */
function callArguments(source: string, from: number): string {
  const open = source.indexOf('(', from)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return source.slice(open + 1)
}

/** True when this construction's store is the shipped ephemeral seam. */
function buildsEphemeralReplica(source: string, callIndex: number): boolean {
  const args = callArguments(source, callIndex)
  if (DECLARES_EPHEMERAL.test(args)) return true
  const bound = new Set<string>()
  for (const match of source.matchAll(BINDS_EPHEMERAL)) bound.add(match[1] as string)
  if (bound.size === 0) return false
  if (STORAGE_SHORTHAND.test(args) && bound.has('storage')) return true
  const named = STORAGE_IS_NAME.exec(args)
  return named !== null && bound.has(named[1] as string)
}

/**
 * Source with comments and string literals blanked.
 *
 * BOTH halves of this detector read it, because the mistake runs both ways: a
 * MENTION of the gate in a comment must not grade a root clean, and a COMMENTED-OUT
 * `createReplica(` must not promote an innocent file INTO the population. The second
 * direction fell out of POD-1239's probe rather than being looked for.
 *
 * Blanking only ever REMOVES text, so it cannot invent a finding — a real call is
 * never inside a comment or a string literal.
 */
function withoutCommentsOrStrings(source: string): string {
  return (
    source
      // NEWLINES PRESERVED, and this was wrong in the first draft. Collapsing a block
      // comment to a single space renumbers every line after it, so the findings
      // pointed at real files and fictional lines — `desktopReplica.ts:135` became
      // `:98`. A report whose line numbers are confidently wrong is worse than one
      // with none: it sends the reader to an innocent line and costs them the trust
      // they need to act on the next finding.
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  )
}

/**
 * Files that build a replica and are NOT product composition roots.
 *
 * Tests construct replicas constantly, and a benchmark harness builds one over a
 * memory store to measure rendering. Neither adopts a user's persisted store, so
 * neither owes the attribution question. This is the detector's one judgement, so it
 * is a pattern with a stated reason rather than a list of names — a list is what goes
 * stale, which is the defect this function replaced.
 */
const NOT_A_PRODUCT_ROOT = /\.(test|spec)\.tsx?$|(^|\/)perf\//

/**
 * Find every composition root, rather than being told where they are.
 *
 * THE FIRST VERSION WAS A HARDCODED LIST OF TWO AND IT WENT STALE IMMEDIATELY.
 * POD-1223/1228 merged two new production roots — `apps/web/src/lib/kernelReplica.ts`
 * and `apps/web/src/lib/shadow/runner.ts` — and the audit went on reporting the same
 * two findings, so a reader would have concluded the new roots were fine when the
 * detector had never looked at them.
 *
 * That is this run's dominant defect class wearing a different hat: not a gate that
 * cannot refuse, but a gate pointed at the wrong wall. A list of sites is a standing
 * bet that nobody adds a site, and the entire premise of this item is that the next
 * client will. The probe suite's original guard — `COMPOSITION_ROOTS.length > 0` —
 * passes happily while the list is two names out of four, which is exactly why it did
 * not catch this and a discovery pass does.
 */
export function discoverCompositionRoots(
  repoRoot: string,
  roots: readonly string[] = CLIENT_ROOTS,
): string[] {
  const byFile = new Map<string, string[]>()
  for (const line of readClientLines(repoRoot, roots)) {
    const existing = byFile.get(line.file)
    if (existing === undefined) byFile.set(line.file, [line.text])
    else existing.push(line.text)
  }
  const found: string[] = []
  for (const [file, lines] of byFile) {
    if (NOT_A_PRODUCT_ROOT.test(file)) continue
    // Blanked WHOLE-FILE, not per raw line: a block comment spans lines, so a
    // line-at-a-time blank cannot see that it is inside one.
    const source = withoutCommentsOrStrings(lines.join('\n'))
    const constructs = source
      .split('\n')
      .some((text) => BUILDS_A_REPLICA.test(text) && !IS_A_DEFINITION.test(text))
    if (constructs) found.push(file)
  }
  return found.sort()
}

export interface SourceLine {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** Every line of every source file under `roots`, with its origin. */
export function readClientLines(repoRoot: string, roots: readonly string[]): SourceLine[] {
  const out: SourceLine[] = []
  for (const root of roots) {
    for (const file of listSources(join(repoRoot, root), root)) {
      let contents: string
      try {
        contents = readFileSync(join(repoRoot, file), 'utf8')
      } catch {
        continue
      }
      contents.split('\n').forEach((text, index) => {
        out.push({ file, line: index + 1, text })
      })
    }
  }
  return out
}

function listSources(absolute: string, relative: string): string[] {
  // Iteratively, and directories are pushed only when `isDirectory()` says so —
  // a walk that followed symlinks could leave the tree, and the audit must not
  // grade files outside the roots it names.
  const out: string[] = []
  const stack: { abs: string; rel: string }[] = [{ abs: absolute, rel: relative }]
  while (stack.length > 0) {
    const next = stack.pop()
    if (next === undefined) break
    let entries: Dirent[]
    try {
      entries = readdirSync(next.abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const abs = join(next.abs, entry.name)
      const rel = `${next.rel}/${entry.name}`
      if (entry.isDirectory()) {
        stack.push({ abs, rel })
        continue
      }
      if (/\.tsx?$/.test(entry.name)) out.push(rel)
    }
  }
  return out.sort()
}

/**
 * Item 1 — an AFFIRMATIVE claim that the client holds the world.
 *
 * The negative lookbehind set is the load-bearing half and is enumerated rather
 * than approximated: "no longer", "never", "does not", "cannot", "not". Without
 * it the amended comments in `engine/overlay.ts` and `replica/feed/mode.ts` are
 * findings, and the natural "fix" is to delete the sentence recording why the
 * amendment happened.
 */
const HOLDS_THE_WORLD =
  /\b(?<!no longer )(?<!never )(?<!does not )(?<!cannot )(?<!not )(holds?|has) the (whole )?world\b/i

export function worldAssumption(lines: readonly SourceLine[]): AuditFinding[] {
  return lines
    .filter((line) => {
      if (!HOLDS_THE_WORLD.test(line.text)) return false
      // Belt for the lookbehinds' one blind spot: a negation earlier in the same
      // sentence but on the previous clause ("the replica does not, and never
      // did, hold the world"). Cheap, and it only ever REMOVES findings, so it
      // cannot mask a regression it would otherwise have caught — the affirmative
      // form has no negation to find.
      return !/\b(no longer|never|not|cannot|slice)\b/i.test(line.text)
    })
    .map(({ file, line, text }) => ({ file, line, text: text.trim() }))
}

/**
 * Item 2 — a client-side filter over entities keyed on visibility or ownership.
 *
 * Two forms, because one concept has two spellings and a detector that knows only
 * the first is a detector that certifies the second: a `.filter(...)` chained off
 * a row source, and a standalone predicate named for the concept. Both must name
 * a VISIBILITY concept — `visible`, `canSee`, `owner`, `shared`, `private`,
 * `grant`, `authorized`, `permitted` — over an ENTITY word, so layout filtering
 * (which panel, which tab) is out of scope by construction rather than by
 * allowlist.
 */
const VISIBILITY_WORD = String.raw`visib|canSee|owner|shared|private|grant|authoriz|permitt`
const ENTITY_WORD = String.raw`session|issue|conversation|automation|entit|row`
const CLIENT_VISIBILITY_FILTER = new RegExp(
  // `.*?` and NOT `[^)]*`: the first draft stopped at the first `)`, which in
  // `rows.filter((s) => s.ownerId === me)` is the arrow's own parameter list —
  // so the detector matched nothing and reported a clean codebase. Caught by its
  // own probe, which is the entire reason the probe exists.
  String.raw`(${ENTITY_WORD})\w*\s*\.\s*filter\(.*?(${VISIBILITY_WORD})`,
  'i',
)

export function clientVisibilityFilter(lines: readonly SourceLine[]): AuditFinding[] {
  return lines
    .filter((line) => CLIENT_VISIBILITY_FILTER.test(line.text))
    .map(({ file, line, text }) => ({ file, line, text: text.trim() }))
}

/**
 * Item 3 — a local-only home for a member POD-1076 MOVED.
 *
 * The member names come from the family itself. Only MOVED members are graded:
 * `PER_USER_STATE_NON_MEMBERS` records three facts that are per-user by class and
 * were deliberately left client-local WITH a reason, and flagging those would be
 * grading this issue against a decision another issue made and documented.
 */
export function perUserStateLocalHome(lines: readonly SourceLine[]): AuditFinding[] {
  // `readAt` → /read[_.]?at/i etc. A persisted KEY is what a local home looks
  // like, so the match is against string literals, not against field reads: the
  // client legitimately reads `readAt` off a wire row it did not persist.
  const members = PER_USER_STATE_FAMILY.flatMap((member) =>
    Object.keys(member.schema.shape).filter((field) => field !== 'userId' && !/Id$/.test(field)),
  )
  const unique = [...new Set(members)]
  if (unique.length === 0) {
    throw new Error(
      'per-user-state family reported no gradeable members — the detector would pass vacuously',
    )
  }
  const pattern = new RegExp(String.raw`['"\`][\w.:-]*(${unique.join('|')})[\w.:-]*['"\`]`, 'i')
  return lines
    .filter((line) => {
      // A persisted local home is a KEY handed to a storage seam. Reading the
      // field off a row is not one, and grading it would make every renderer of
      // an unread badge a finding.
      if (!/\b(ui|uiState|storage|AsyncStorage)\b/.test(line.text)) return false
      return pattern.test(line.text)
    })
    .map(({ file, line, text }) => ({ file, line, text: text.trim() }))
}

/**
 * Item 4 — a composition root that builds a persisted client replica without
 * establishing the store belongs to the CURRENT principal.
 *
 * Graded per FILE rather than per line: the question is whether the decision was
 * made anywhere in the root, and a line-level detector would report the same hole
 * once per construction call.
 */
export function unattributedStoreRead(repoRoot: string, roots: readonly string[]): AuditFinding[] {
  const out: AuditFinding[] = []
  for (const file of roots) {
    let contents: string
    try {
      contents = readFileSync(join(repoRoot, file), 'utf8')
    } catch {
      // A root that has been deleted is not a finding — the TanStack removal
      // deletes one of them. A root that has been RENAMED and left ungraded is,
      // which is why `COMPOSITION_ROOTS` is asserted non-empty by the test.
      continue
    }
    const source = withoutCommentsOrStrings(contents)
    // Per CALL rather than per file, because the exemption is a property of one
    // construction's storage: a file holding an ephemeral replica beside a
    // persisted one owes the question for the persisted one, and a file-level
    // check would let the ephemeral half answer for both.
    const persisted = constructionOffsets(source).filter(
      (offset) => !buildsEphemeralReplica(source, offset),
    )
    if (persisted.length === 0) continue
    // The gate, by any of its names. `decideLegacyAdoption` is the decision,
    // `migrateLegacyReplica` is the caller that runs it, and `LegacyIdentityEvidence`
    // is the input it cannot be called without — a root naming ANY of the three
    // has been through the question.
    const attributed = CALLS_THE_GATE.test(source)
    if (attributed) continue
    // Reported against the BLANKED source. Blanking preserves newlines exactly (see
    // `withoutCommentsOrStrings`), so this number still points at the real line —
    // and it is the first PERSISTED construction's line, not the first construction
    // of any kind, so a reader sent here finds the call the finding is about.
    const line = source.slice(0, persisted[0]).split('\n').length
    out.push({
      file,
      line,
      text: 'builds a persisted client replica without establishing the store belongs to the current principal',
    })
  }
  return out
}

/**
 * Item 5 — a construction of the client's principal-scoped machinery OUTSIDE the
 * one place that owns the principal (POD-404).
 *
 * The acceptance clause is "no residual path constructs transport, replica or
 * outbox outside the provider". That is a claim about CALL SITES, so it is
 * checked as one: there is exactly one chain — `react/provider.tsx` builds a
 * `ClientRuntime` per principal, and the runtime builds the hub and the outbox
 * for itself. A second site anywhere is a second principal boundary that nobody
 * tears down on sign-out.
 *
 * WHY BY SYMBOL AND NOT BY "does this file import the engine".
 * An import is not a construction, and the failure this item exists to catch is
 * a file that quietly opens a socket or a queue of its own — not one that reads
 * a type. Conversely a MENTION is not a call (the lesson item 4 already learned
 * the hard way), so each pattern below requires call shape, and the DEFINITION
 * of each factory is excluded explicitly: `wiring.ts` declares `createEngineHub`
 * and `createEngineOutbox`, and declaring them is not calling them.
 *
 * The REPLICA half of the clause is item 4's job and stays there: a replica is
 * legitimately built at a platform composition root (client-core cannot know the
 * device's storage), so the property that matters for it is that the root asks
 * whose store it is — which is what item 4 measures.
 */
interface ConstructionRule {
  /** The construction, in CALL position. */
  readonly call: RegExp
  /** Its declaration, which is not a call to it. */
  readonly definition: RegExp
  /**
   * The files allowed to make this call.
   *
   * Two entries for the runtime rule, not a widening: `runtime.ts` DECLARES the
   * class, so the `new ClientRuntime` inside `createClientRuntime` is that
   * factory's own body rather than a second construction site. The property this
   * rule protects is that no OTHER file reaches either symbol.
   */
  readonly homes: readonly string[]
  readonly what: string
}

const CONSTRUCTION_RULES: readonly ConstructionRule[] = [
  {
    call: /\b(?:createClientRuntime\s*\(|new\s+ClientRuntime\s*\()/,
    definition: /\b(?:export\s+)?(?:function\s+createClientRuntime|class\s+ClientRuntime)\b/,
    homes: [
      'packages/client-core/src/react/provider.tsx',
      'packages/client-core/src/engine/runtime.ts',
    ],
    what: 'constructs a client runtime outside the provider that owns the principal',
  },
  {
    call: /\bcreateEngineHub\s*\(/,
    definition: /\b(?:export\s+)?function\s+createEngineHub\b/,
    homes: ['packages/client-core/src/engine/runtime.ts'],
    what: 'constructs the socket transport outside the principal-scoped runtime',
  },
  {
    call: /\bcreateEngineOutbox\s*\(/,
    definition: /\b(?:export\s+)?function\s+createEngineOutbox\b/,
    homes: ['packages/client-core/src/engine/runtime.ts'],
    what: 'constructs the outbox outside the principal-scoped runtime',
  },
]

export function constructionOutsideProvider(lines: readonly SourceLine[]): AuditFinding[] {
  const out: AuditFinding[] = []
  for (const line of lines) {
    for (const rule of CONSTRUCTION_RULES) {
      if (rule.homes.includes(line.file)) continue
      if (rule.definition.test(line.text)) continue
      if (!rule.call.test(line.text)) continue
      out.push({ file: line.file, line: line.line, text: rule.what })
    }
  }
  return out
}

/**
 * Item 6 — identity read from something other than the authenticated transport
 * (ADR 3 D7, the client half — POD-404).
 *
 * "Payload identity is inert" has a client twin: the value that selects WHOSE
 * slice and WHOSE storage namespace this client opens may only come from an
 * authenticated server answer. Every other source is controlled by somebody
 * other than the server — the address bar, whatever the last person on the
 * device left behind, a wire frame, a text field.
 *
 * THE CONCEPT HAS THREE SPELLINGS AND A DETECTOR THAT KNOWS ONE CERTIFIES THE
 * OTHER TWO, so all three are enumerated:
 *
 *   1. a STORAGE read whose key names an identity ("podium.last-user");
 *   2. a URL read naming an identity (`searchParams.get('userId')`);
 *   3. a principal ASSIGNED from a payload/frame/input.
 *
 * WHAT IS DELIBERATELY NOT A FINDING, and why each is safe:
 *
 *   - The THEME. It is a pre-auth storage read by design (ThemeProvider wraps
 *     StoreProvider) and carries no identity, no cursor and no authored work, so
 *     it cannot leak one person's data to another. Form 1 keys on identity words
 *     and the theme is not one, so this needs no exemption — it is out of scope
 *     by construction, which is the only kind of exemption worth having.
 *   - `inspectPrincipalNamespaces`. The offline fallback in
 *     `use-kernel-replica.ts` reads namespace MARKERS, accepts an answer only
 *     when exactly one principal has ever been retained on the device, and fails
 *     closed on ambiguity. It enumerates keys rather than reading an
 *     identity-named key, so form 1 does not see it — again by construction.
 */
const IDENTITY_WORD = String.raw`user|principal|account|identity|signed-?in|whoami`
const IDENTITY_FROM_STORAGE = new RegExp(
  // `getItem` only. Deleting a key derives nothing — `kernelReplica.ts` retires
  // the old raw identity ledger with `removeItem`, which is the FIX for this
  // item's failure mode, and a detector that flagged it would be arguing for the
  // ledger's return.
  String.raw`\.getItem\(\s*(['"\`])[^'"\`]*(?:${IDENTITY_WORD})[^'"\`]*\1`,
  'i',
)
const IDENTITY_FROM_URL = new RegExp(
  String.raw`(?:searchParams|urlParams|queryParams)\s*\.\s*get\(\s*(['"\`])\s*(?:${IDENTITY_WORD})\w*\s*\1`,
  'i',
)
const IDENTITY_FROM_PAYLOAD =
  /\b(?:principal|userId|actor)\s*[:=]\s*[\w.]*\b(?:payload|body|frame|wire|input|message|params)\b/i

export function identityFromNonTransportSource(lines: readonly SourceLine[]): AuditFinding[] {
  return lines
    .filter(
      (line) =>
        IDENTITY_FROM_STORAGE.test(line.text) ||
        IDENTITY_FROM_URL.test(line.text) ||
        IDENTITY_FROM_PAYLOAD.test(line.text),
    )
    .map(({ file, line, text }) => ({
      file,
      line,
      text: `derives an identity from something other than the authenticated transport: ${text.trim()}`,
    }))
}

export function runPhase2ClientAudit(repoRoot: string): AuditItem[] {
  const lines = readClientLines(repoRoot, CLIENT_ROOTS)
  // The audit grades PRODUCT code. A test may legitimately construct the very
  // shape the item forbids in order to prove the detector fires — which is what
  // `audit-phase2-client.test.ts` does, and grading it would make the audit
  // impossible to certify.
  const product = lines.filter((line) => !/\.(test|spec)\.tsx?$/.test(line.file))
  return [
    {
      id: 'world-assumption',
      title: 'client code that assumes it holds the WORLD rather than its slice',
      unit: 'affirmative claim that the client holds the world',
      findings: worldAssumption(product),
    },
    {
      id: 'client-visibility-filter',
      title: 'client-side visibility filtering (ADR 1 D1 — the Replica never arbitrates)',
      unit: 'entity filter keyed on a visibility or ownership concept',
      findings: clientVisibilityFilter(product),
    },
    {
      id: 'per-user-state-local-home',
      title: 'a local-only home for a per-user-state member POD-1076 moved',
      unit: 'persisted client key naming a moved member',
      findings: perUserStateLocalHome(product),
    },
    {
      /**
       * A FINDING IN SHARED CODE IS REPORTED CORRECTLY AND IS STILL UNFIXABLE IN
       * PLACE. Named here because it is a property of this item's findings that
       * the detector cannot see, and the reader who hits it next will otherwise
       * lose time looking for a fix that cannot exist where the finding points.
       *
       * This item reported `packages/client-core/src/engine/engine.ts:297` —
       * accurately: `client-core/src` is a client root and the line really did
       * construct a replica. But client-core is PLATFORM-NEUTRAL, and attribution
       * needs the CURRENT PRINCIPAL, which shared code has no way to know. So the
       * file could not host its own fix. A platform agent picking that finding up
       * would have found nothing to do there — quieter than an uncounted site,
       * and it lasts just as long.
       *
       * POD-1239's resolution is the general one: MOVE THE CONSTRUCTION to a
       * platform file where the principal is reachable (here
       * apps/web/src/lib/webReplica.ts), then fix it there. The count does not
       * move — it is a swap, not an addition — which is the tell that the work
       * was relocation rather than remediation, and is exactly what should
       * happen.
       */
      id: 'unattributed-store-read',
      title: 'a persisted store adopted without establishing the current principal',
      unit: 'composition root that never asks',
      findings: unattributedStoreRead(repoRoot, discoverCompositionRoots(repoRoot)),
    },
    {
      id: 'construction-outside-provider',
      title: 'transport or outbox constructed outside the provider’s principal-scoped path',
      unit: 'construction site that no principal change tears down',
      findings: constructionOutsideProvider(product),
    },
    {
      id: 'identity-from-non-transport-source',
      title: 'identity read from the URL, storage, a payload or a client-supplied name',
      unit: 'identity derived from something the server did not authenticate',
      findings: identityFromNonTransportSource(product),
    },
  ]
}

if (import.meta.main) {
  const items = runPhase2ClientAudit(REPO_ROOT)
  let total = 0
  for (const item of items) {
    total += item.findings.length
    const mark = item.findings.length === 0 ? 'ZERO' : `${item.findings.length}`
    console.log(`${mark.padStart(4)}  ${item.id} — ${item.title}`)
    for (const finding of item.findings) {
      console.log(`        ${finding.file}:${finding.line}  ${finding.text}`)
    }
  }
  if (total > 0) {
    console.error(`\nPhase-2 client audit: ${total} item(s) NOT at zero`)
    process.exit(1)
  }
  console.log(`\nPhase-2 client audit: all ${items.length} items at zero`)
}
