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

/** The attribution gate, by any of its three names. */
const ASKS_WHO_OWNS_IT = /decideLegacyAdoption|migrateLegacyReplica|LegacyIdentityEvidence/

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
    const constructs = lines.some(
      (text) => BUILDS_A_REPLICA.test(text) && !IS_A_DEFINITION.test(text),
    )
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
    const callSites = contents
      .split('\n')
      .filter((text) => BUILDS_A_REPLICA.test(text) && !IS_A_DEFINITION.test(text))
    if (callSites.length === 0) continue
    // The gate, by any of its names. `decideLegacyAdoption` is the decision,
    // `migrateLegacyReplica` is the caller that runs it, and `LegacyIdentityEvidence`
    // is the input it cannot be called without — a root naming ANY of the three
    // has been through the question.
    const attributed = ASKS_WHO_OWNS_IT.test(contents)
    if (attributed) continue
    const line =
      contents
        .split('\n')
        .findIndex((text) => BUILDS_A_REPLICA.test(text) && !IS_A_DEFINITION.test(text)) + 1
    out.push({
      file,
      line,
      text: 'builds a persisted client replica without establishing the store belongs to the current principal',
    })
  }
  return out
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
      id: 'unattributed-store-read',
      title: 'a persisted store adopted without establishing the current principal',
      unit: 'composition root that never asks',
      findings: unattributedStoreRead(repoRoot, discoverCompositionRoots(repoRoot)),
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
  console.log('\nPhase-2 client audit: all four items at zero')
}
