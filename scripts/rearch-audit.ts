/**
 * Deletion audit — the anti-intermediate-state ratchet for the v3 rewrite
 * (Phase 0 guardrail, POD-297; inventory = the proposal's §6 "what disappears").
 *
 * Every item below is a thing the rewrite DELETES. Each check names it, maps it
 * to the phase issue that owns its removal, and counts the sites that still
 * exist. The counts are committed to `scripts/rearch-audit-baseline.json` and
 * CI compares against them:
 *
 *   - count > baseline  → FAIL. The rewrite may not grow the debt it is deleting.
 *   - count < baseline  → FAIL, "you improved — lock it in with --update-baseline".
 *     A win that isn't recorded can be silently given back by a later PR (the
 *     baseline would still permit the old, higher count). Same discipline as
 *     `bun run migration:manifest --check`: the committed artifact must be exact,
 *     and the fix is one mechanical command. The baseline diff is also the
 *     per-phase before/after evidence the migration ledger (POD-298) wants.
 *   - count === baseline → pass.
 *
 * Phase-close rule: `--phase POD-xxx` exits non-zero while any item mapped to
 * that phase is still > 0. A phase issue may not be closed until it exits 0.
 * See docs/rearch-deletion-audit.md.
 *
 * Run:
 *   bun run audit:rearch                     # ratchet (CI)
 *   bun run audit:rearch --update-baseline   # record current counts
 *   bun run audit:rearch --json
 *   bun run audit:rearch --sites             # print every counted file:line
 *   bun run audit:rearch --phase POD-309     # phase-close gate
 *
 * WHAT A COUNT MEANS: each check declares its own `unit` — deliberately. Some
 * items are a fan-out whose SIZE is the debt (publishComputed call sites, mods()
 * call sites); others are binary (a type exists or it doesn't). A count of 1 on
 * a binary item is not weaker than 103 on a fan-out — both must reach 0.
 *
 * Pure logic is exported for scripts/rearch-audit.test.ts.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changeRowRestatements } from './change-row-audit'
import {
  machineIdUnbrandedFields,
  rawStringEntityIds,
  unbrandedByDecisionFields,
} from './entity-id-audit'
import {
  capabilitySnapshots,
  danglingRegistryEntries,
  instancePartitions,
  perUserSingletons,
  unregisteredRestatements,
} from './representation-audit'

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

export interface AuditSite {
  file: string
  line: number
  text: string
}

export interface SourceFile {
  file: string
  /** Comment-stripped, line-structure preserving (see stripComments). */
  stripped: string
  /** The source AS WRITTEN, comments intact. A detector whose subject is a
   *  marker comment (`entity-id-audit.ts`'s `UNBRANDED` excuse) cannot read
   *  `stripped`, and re-reading the file from disk makes a synthetic context
   *  untestable. Optional so an in-memory context may omit it. */
  raw?: string
  isTest: boolean
}

export interface AuditContext {
  repoRoot: string
  files: readonly SourceFile[]
  /** Repo-relative paths of files directly under a directory (non-recursive). */
  listDir(rel: string): string[]
}

/** Tokens after which a `/` starts a REGEX literal rather than division. */
const REGEX_ALLOWED_AFTER_PUNCT = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '<',
  '>',
  '~',
])
const REGEX_ALLOWED_AFTER_KEYWORD =
  /\b(return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/

/**
 * Strip `//` and block comments, replacing them with spaces so every byte
 * offset — and therefore every line number — is preserved. `check-boundaries.ts`
 * has a `stripComments` too, but it deletes comments outright and collapses the
 * newlines inside block comments; this audit reports `file:line` sites, so it
 * needs the line structure intact.
 *
 * String literals are preserved verbatim: the '__local__' placeholder IS a
 * string literal, so the audit must still see inside quotes.
 *
 * REGEX LITERALS are tracked as their own state. Without that, a quote or
 * backtick inside one (`.replace(/`/g, '')` — real, apps/server/src/steward.ts)
 * flips the scanner into string state and it never recovers, so every comment
 * below it survives as "code" and is counted forever. Four scanned files do
 * this today. Distinguishing a regex from division needs the preceding token:
 * after a value (identifier, `)`, `]`, literal) a `/` is division; after an
 * operator, punctuator, or keyword it opens a regex.
 */
export function stripComments(source: string): string {
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex' | 'class'
  let state: State = 'code'
  let out = ''
  let i = 0
  /** Last non-whitespace char emitted in code state — decides regex vs division. */
  let lastSig = ''
  /** Code emitted so far on this line, for the keyword check. */
  let codeRun = ''
  /** Open `${` interpolations and `{` blocks, so a nested template inside an
   *  interpolation (`` `${x.replace(/'/g, `'\\''`)}` `` — real, tmux.ts:11)
   *  doesn't let the inner backtick close the outer template. */
  const stack: ('tmpl' | 'brace')[] = []
  while (i < source.length) {
    const c = source[i] as string
    const n = source[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') {
        state = 'line'
        out += '  '
        i += 2
        continue
      }
      if (c === '/' && n === '*') {
        state = 'block'
        out += '  '
        i += 2
        continue
      }
      if (c === '{') stack.push('brace')
      else if (c === '}' && stack.length > 0) {
        if (stack.pop() === 'tmpl') {
          state = 'template'
          out += c
          i += 1
          continue
        }
      }
      if (
        c === '/' &&
        (lastSig === '' ||
          REGEX_ALLOWED_AFTER_PUNCT.has(lastSig) ||
          // trimEnd: codeRun keeps the space in `return /re/`, and the keyword
          // pattern is $-anchored.
          REGEX_ALLOWED_AFTER_KEYWORD.test(codeRun.trimEnd()))
      ) {
        state = 'regex'
        out += c
        i += 1
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'single' : c === '"' ? 'double' : 'template'
      }
      if (!/\s/.test(c)) {
        lastSig = c
        codeRun += c
      } else if (c === '\n') codeRun = ''
      else codeRun += c
      out += c
      i += 1
      continue
    }
    if (state === 'regex' || state === 'class') {
      // Escapes are verbatim; `[...]` may contain an unescaped `/`.
      if (c === '\\') {
        out += source.slice(i, i + 2)
        i += 2
        continue
      }
      if (state === 'regex' && c === '[') state = 'class'
      else if (state === 'class' && c === ']') state = 'regex'
      else if (state === 'regex' && c === '/') {
        state = 'code'
        lastSig = '/'
      } else if (c === '\n') {
        // Unterminated: not valid JS. Recover rather than swallow the file.
        state = 'code'
        lastSig = ''
        codeRun = ''
      }
      out += c
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      } else out += ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') {
        state = 'code'
        out += '  '
        i += 2
        continue
      }
      out += c === '\n' ? '\n' : ' '
      i += 1
      continue
    }
    // Inside a string literal.
    if (c === '\\') {
      out += source.slice(i, i + 2)
      i += 2
      continue
    }
    // `${` opens a code interpolation inside a template.
    if (state === 'template' && c === '$' && n === '{') {
      stack.push('tmpl')
      state = 'code'
      lastSig = '{'
      codeRun = ''
      out += '${'
      i += 2
      continue
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code'
      // A closed string is a VALUE, so a following `/` is division, not a regex.
      lastSig = c
      codeRun = ''
    } else if (c === '\n' && state !== 'template') {
      // Unterminated single/double quote: recover at the newline.
      state = 'code'
      lastSig = ''
      codeRun = ''
    }
    out += c
    i += 1
  }
  return out
}

export function isTestFile(file: string): boolean {
  return /\.(test|spec|bun\.test)\.tsx?$/.test(file) || /\/(test|tests|__tests__)\//.test(file)
}

/**
 * Generated or historical files no phase issue can edit: past migrations are
 * immutable history, and generated manifests are rebuilt from them.
 *
 * FROZEN IS `/migrations/drizzle/`, NOT `/migrations/` (POD-1166, found by
 * POD-1162's P4 probe). The timestamped SQL folders under `drizzle/` are the
 * immutable history. `apps/server/src/migrations/` ALSO holds live, editable
 * source — most importantly `schema.ts`, which declares all 57 physical tables —
 * and freezing the whole directory made that file invisible to every detector
 * here. An `instance_id` column planted on the `sessions` table was green across
 * the audit, the model suite, tsgo, the migration suites and store.test.ts, so
 * ADR 1 D5's "multi-user is not multi-tenancy" had no enforcement at the one
 * place a tenant partition would actually be introduced.
 *
 * Note POD-368's registry lists `sessions` at `migrations/schema.ts` as the R3
 * physical table — so the registry knew about a file the audit could not read.
 * That mismatch is the tell: a path-scoped skip whose reason ("history is
 * immutable") does not apply to everything the path matches.
 */
export function isFrozenFile(file: string): boolean {
  return file.includes('/migrations/drizzle/') || file.endsWith('.generated.ts')
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.expo', 'coverage', 'target'])

function* walk(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full)
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

export function loadContext(repoRoot: string, roots = ['apps', 'packages']): AuditContext {
  const files: SourceFile[] = []
  for (const rootDir of roots) {
    for (const abs of walk(join(repoRoot, rootDir))) {
      const file = relative(repoRoot, abs).split(sep).join('/')
      const raw = readFileSync(abs, 'utf8')
      files.push({ file, stripped: stripComments(raw), raw, isTest: isTestFile(file) })
    }
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return {
    repoRoot,
    files,
    listDir(rel) {
      try {
        return readdirSync(join(repoRoot, rel), { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .sort()
      } catch {
        return []
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

interface GrepOptions {
  /** Repo-relative path prefixes to scan. */
  roots: string[]
  pattern: RegExp
  includeTests?: boolean
  includeFrozen?: boolean
  /** Extra per-file veto. */
  skip?: (file: string) => boolean
}

/** Every match of `pattern` in the comment-stripped source under `roots`. */
export function grep(ctx: AuditContext, opts: GrepOptions): AuditSite[] {
  const sites: AuditSite[] = []
  for (const f of ctx.files) {
    if (!opts.roots.some((r) => f.file === r || f.file.startsWith(`${r}/`))) continue
    if (f.isTest && !opts.includeTests) continue
    if (isFrozenFile(f.file) && !opts.includeFrozen) continue
    if (opts.skip?.(f.file)) continue
    const lines = f.stripped.split('\n')
    for (const [idx, line] of lines.entries()) {
      const re = new RegExp(opts.pattern.source, opts.pattern.flags.replace(/[gm]/g, ''))
      if (re.test(line)) sites.push({ file: f.file, line: idx + 1, text: line.trim() })
    }
  }
  return sites
}

/** Distinct string-literal values matching `pattern` under `roots` (one site per
 *  distinct value — its first occurrence). */
export function grepDistinctLiterals(
  ctx: AuditContext,
  opts: GrepOptions & { literal: RegExp },
): AuditSite[] {
  const seen = new Map<string, AuditSite>()
  for (const f of ctx.files) {
    if (!opts.roots.some((r) => f.file === r || f.file.startsWith(`${r}/`))) continue
    if (f.isTest && !opts.includeTests) continue
    if (isFrozenFile(f.file) && !opts.includeFrozen) continue
    if (opts.skip?.(f.file)) continue
    const lines = f.stripped.split('\n')
    for (const [idx, line] of lines.entries()) {
      for (const m of line.matchAll(new RegExp(opts.literal.source, 'g'))) {
        const value = m[1] ?? m[0]
        if (!seen.has(value)) seen.set(value, { file: f.file, line: idx + 1, text: value })
      }
    }
  }
  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

export interface AuditCheck {
  id: string
  title: string
  /** The phase issue that owns deleting this item (POD-xxx). */
  phase: string
  /** What ONE count means. */
  unit: string
  collect(ctx: AuditContext): AuditSite[]
}

/** Declaration of one of `names` as an exported interface/type/class. */
function declRe(names: string[]): RegExp {
  return new RegExp(`^export (?:interface|type|class) (?:${names.join('|')})\\b`)
}

/**
 * THE ANCHOR FOR AN ITEM THAT REACHED ZERO (POD-309), exported so its own test can drive
 * it with a BROKEN pattern instead of mutating the product to find out.
 *
 * `upstream-sync-forwarder` is at 0 and stays there, so from now on its count can only
 * ever mean "nothing found" — which is also what a broken detector reports. It has no
 * surviving code to anchor on (both classes and both construction sites are deleted), so
 * it anchors on the two facts its zero DEPENDS on, neither satisfiable by deletion: the
 * roots still resolve to files, and the pattern still matches text it is supposed to
 * match.
 *
 * ONE CONTROL PER (BRANCH × NAME), AND EACH MEASURED ON ITS OWN. POD-308 found the general
 * form while hardening its own gate: two controls that can only ever fail together are ONE
 * control wearing two names. This pattern has two independent branches — a declaration
 * form and a construction form — and two names inside each, so four controls, and
 * `rearch-audit.test.ts` breaks each branch separately and asserts that EXACTLY the
 * controls covering it are reported. That is why this returns every miss rather than the
 * first: a throw naming one control cannot tell you which half of the regex died.
 *
 * It takes a pattern SOURCE rather than reading the constant, for the reason this function
 * exists at all — a check that can only be exercised by editing the thing it checks is a
 * check nobody exercises. (This guard was written once, silently reverted by an
 * over-broad `git checkout --` while a mutant was being cleaned up, and re-committed only
 * because a later reviewer asked about it. Nothing red. That is the whole argument for
 * putting it under test rather than under a hand-run mutant.)
 */
export const UPSTREAM_RETIREMENT_ROOTS: readonly string[] = ['apps', 'packages']

export const UPSTREAM_RETIREMENT_PATTERN =
  /^export class (?:UpstreamSync|UpstreamForwarder)\b|new (?:UpstreamSync|UpstreamForwarder)\s*\(/

/** The four control strings, grouped by the regex branch each one exercises. */
export const UPSTREAM_RETIREMENT_CONTROLS: Readonly<
  Record<'declaration' | 'construction', readonly string[]>
> = {
  declaration: ['export class UpstreamSync {', 'export class UpstreamForwarder {'],
  construction: ['const f = new UpstreamSync({})', 'upstreamForwarder = new UpstreamForwarder({'],
}

/** Controls `patternSource` FAILS to match. Empty means the anchor is intact. */
export function upstreamRetirementControlMisses(patternSource: string): string[] {
  const re = new RegExp(patternSource)
  return Object.values(UPSTREAM_RETIREMENT_CONTROLS)
    .flat()
    .filter((control) => !re.test(control))
}

/** The roots the snapshot fan-out lived in. Every one of its thirteen sites was
 *  in the server app; a home outside it would be a relocation, not a deletion. */
export const PUBLISH_COMPUTED_ROOTS = ['apps/server/src'] as const

export const PUBLISH_COMPUTED_PATTERN = /\bpublishComputed\b|\bfanOutSnapshot\b/

/** Control strings, one per branch of the pattern. */
export const PUBLISH_COMPUTED_CONTROLS: readonly string[] = [
  'this.deps.funnel.publishComputed(spec.snapshot)',
  'fanOutSnapshot: (snapshot, opts) => sessionsSvc.fanOutSnapshot(snapshot, opts),',
]

/** Controls `patternSource` FAILS to match. Empty means the anchor is intact. */
export function publishComputedControlMisses(patternSource: string): string[] {
  const re = new RegExp(patternSource)
  return PUBLISH_COMPUTED_CONTROLS.filter((control) => !re.test(control))
}

/**
 * REGISTERED RESIDUE — ported from main at the POD-1246 catch-up.
 *
 * A COUNTED check answers "how many sites are left". This answers a different
 * question: which KNOWN-remaining sites are deliberate, who owns them, and what
 * event retires them. Those two are not interchangeable — a residue whose count
 * is legitimately non-zero reads identically to one nobody has looked at, and the
 * distinction is exactly what a catch-up merge loses first.
 *
 * The register is load-bearing only because `rearch-audit.test.ts` pins every
 * `needle` against LIVE production source: an entry whose site has moved or been
 * deleted fails there, so the register cannot quietly describe a tree that no
 * longer exists. That is the difference between this and a comment.
 */
export interface RegisteredResidue {
  id: string
  owner: string
  expiry: string
  note: string
  sites: readonly { file: string; needle: string }[]
}

export const REGISTERED_RESIDUE: readonly RegisteredResidue[] = [
  {
    id: 'issues-forwarder-transition',
    owner: 'POD-827',
    expiry: 'deleted when the hub speaks projections (POD-827)',
    note: 'POD-827 blocks normalized-as-sole-feed on hub-node installs; local clients receive only the session-free transitional issue payload.',
    // RE-POINTED at this tree, not copied from main (POD-1246). Main's register
    // names its own file layout, and three of its four sites are somewhere else
    // here — a needle carried over verbatim would have failed the pin, which is
    // the register working, not the register being wrong.
    //
    // The FOURTH is a deletion, not a move: main lists
    // `packages/sync/src/upstream.ts` (`private readonly issues = new Map<string,
    // IssueWire>()`) as the upstream hub-mirror consumer. POD-309 already landed
    // on this branch — `upstream-sync-forwarder` records both classes and both
    // construction sites as VANISHED, 0 MOVED — so that half of main's residue is
    // retired here and is dropped from the register rather than re-pointed at a
    // file that does not exist. The expiry above narrows to match: only the
    // POD-827 condition is still outstanding.
    sites: [
      {
        // The wire type moved to model at the POD-361 flip; protocol's
        // `messages/issues.ts` now carries only the envelope messages.
        file: 'packages/model/src/entities/issue.ts',
        needle: 'export const IssueWire = IssueWireCore.extend(ISSUE_FLAT_PROVENANCE_SHAPE).extend(',
      },
      {
        // The session-free legacy emit — a named method here rather than main's
        // inline `snapshot:` literal.
        file: 'apps/server/src/modules/issues/publish.ts',
        needle: 'issuesChanged(localIssues: IssueWire[]): PublishSpec {',
      },
      {
        file: 'apps/server/src/modules/issues/instrumentation.ts',
        needle: 'export function countIssueMembershipScan(): void {',
      },
    ],
  },
]

export const CHECKS: AuditCheck[] = [
  {
    /*
     * PORTED FROM MAIN in the catch-up merge. Main's POD-797 deleted the legacy
     * local issue wire; this branch rebuilt that surface independently, so this
     * detector is EXPECTED TO REPORT NON-ZERO here and that number is a real
     * finding rather than merge noise. Kept because a detector this branch lacks
     * is a guard this branch lacks.
     */
    id: 'issues-legacy-local-wire',
    title: 'Legacy local issue membership wire path',
    phase: 'POD-797',
    unit: 'production site that embeds or scans sessions for an issue payload, gates normalized issue emission, or retains a POD-722/723 issue shim',
    collect: (ctx) => [
      ...grep(ctx, {
        roots: ['packages/protocol/src/messages/issues.ts'],
        pattern:
          /IssueSessionSummary|sessions:\s*z[.]array[(]SessionMeta[)]|sessionSummary:\s*IssueSessionSummary|unread:\s*z[.]boolean/,
      }),
      ...grep(ctx, {
        roots: ['apps/server/src'],
        skip: (file) => file === 'apps/server/src/modules/issues/instrumentation.ts',
        pattern:
          /issueRelevantSessionProjection|lastIssueSessionProjection|legacyIssueWireNeeded|issuesNormalizedWire|toWireMemo|wireCache|bumpIssueInputs|memberSessionFingerprint|countIssueMembershipScan[(]|issues-normalized-wire/,
      }),
    ],
  },
  {
    id: 'publish-computed-fanout',
    title: 'publishComputed snapshot fan-out',
    phase: 'POD-308',
    unit: 'reference to funnel.publishComputed / fanOutSnapshot (the legacy snapshot tail)',
    collect: (ctx) => {
      // REACHED ZERO at POD-1203: `publishComputed`, `fanOutSnapshot` and all
      // thirteen call sites are gone, and grepping their destinations finds no
      // code home — VANISHED, not MOVED. The serving path they were half of is
      // `gateway/feed-serving.ts`, which produces no message of its own: a
      // legacy client's full lists are folded out of the feed by the expiring v1
      // adapter, and `bun run audit:serving-path` holds that to two allowlisted
      // sites.
      //
      // A ZEROED DETECTOR IS THE DANGEROUS KIND, because from here its count can
      // only mean "nothing found" — which is what a BROKEN detector reports too.
      // `send-turn-duplicate` set the rule and `upstream-sync-forwarder`
      // followed it: an item may sit in the audit test's ZERO_BY_DESIGN list
      // only if its `collect` THROWS when its anchor stops matching. With no
      // surviving code to anchor on, this anchors on its own scan — the roots
      // must match files, and the pattern must still match the control strings
      // it was written to match.
      const missing = publishComputedControlMisses(PUBLISH_COMPUTED_PATTERN.source)
      if (missing.length > 0)
        throw new Error(
          `publish-computed-fanout: the pattern no longer matches ${missing.length} of its ` +
            `control strings (${missing.map((c) => JSON.stringify(c)).join(', ')}). The ` +
            'detector is broken; fix it rather than recording a phantom zero.',
        )
      const scanned = ctx.files.filter((f) =>
        PUBLISH_COMPUTED_ROOTS.some((r) => f.file === r || f.file.startsWith(`${r}/`)),
      )
      if (scanned.length === 0)
        throw new Error(
          `publish-computed-fanout: the roots ${PUBLISH_COMPUTED_ROOTS.join(', ')} matched no ` +
            'files. The detector is scanning nothing; its zero is a phantom, not the cutover ' +
            'holding.',
        )
      return grep(ctx, {
        roots: [...PUBLISH_COMPUTED_ROOTS],
        pattern: PUBLISH_COMPUTED_PATTERN,
      })
    },
  },
  {
    /**
     * The CONCRETE N-1 wire adapter (POD-308) — a scheduled deletion, tracked
     * here for the reason POD-1077's placeholder is: temporary code that keeps
     * everything working survives by default, because nothing ever forces the
     * conversation about removing it.
     *
     * This item is EXPECTED to be non-zero for one rollout window and must reach
     * 0 by Phase 7. `scripts/audit-wire-adapters.ts` owns the condition (the
     * support floor reaching 2) and the allowlist; this counts the sites, so the
     * ratchet shows the cost of the window growing if anyone adds a dependency
     * on it.
     */
    /*
     * RE-PHASED POD-308 -> POD-337 by the POD-279 coordinator, with the reason
     * recorded here because a re-phase is the move that can launder debt.
     *
     * POD-310's Phase 2 exit gate found a CONTRADICTION IN THE PLAN, not a
     * defect in the tree: POD-308's job was to BIRTH this adapter, its expiry
     * is declared as DATA (expiresWhenMinSupportedReaches: 2, deleteByPhase
     * Phase 7) and that condition has not arrived because MIN_SUPPORTED_VERSION
     * is still 1 — yet the item was mapped to a Phase-2 issue graded by a rule
     * saying its phase may not close while the count is non-zero. So a closed,
     * correct child could never pass its own phase-close gate, and the only ways
     * out were to falsify the gate or to leave Phase 2 permanently unclosable.
     *
     * POD-310 did NOT re-phase it to let itself close, escalating instead — an
     * exit gate that edits this mapping to pass is a detector that cannot say NO
     * one level up. This edit is the coordinator's answer, not the gate's, which
     * is the same separation POD-423 established for per-user-singletons.
     *
     * POD-337 is the right owner: it is where the expiry condition is actually
     * evaluated, and it CANNOT close while this is non-zero — so the
     * anti-laundering property is preserved rather than spent. Check with
     * `bun scripts/rearch-audit.ts --phase POD-337`.
     */
    id: 'legacy-wire-v1-adapter',
    title: 'Concrete pre-cutover (wire v1) translation adapter',
    phase: 'POD-337',
    unit: 'declaration or reference to the expiring LegacyWireV1Adapter',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps', 'packages'],
        pattern: /\bLegacyWireV1Adapter\b|\bLEGACY_WIRE_V1_EXPIRY\b/,
      }),
  },
  {
    id: 'upstream-sync-forwarder',
    title: 'UpstreamSync / UpstreamForwarder',
    phase: 'POD-309',
    unit: 'class declaration or construction site',
    collect: (ctx) => {
      // REACHED ZERO at POD-309: both classes and both construction sites are gone, and a
      // repo-wide grep for their destinations finds no code home — 4 VANISHED, 0 MOVED.
      //
      // A zeroed detector is the dangerous kind, because from here its count can only mean
      // "nothing found", and "nothing found" is what a BROKEN detector reports too.
      // `send-turn-duplicate` set the rule this follows: an item may sit in the audit
      // test's ZERO_BY_DESIGN list only if its `collect` THROWS when its anchor stops
      // matching. See {@link upstreamRetirementControlMisses} for what this one anchors on
      // and why, since it has no surviving code to anchor to.
      const missing = upstreamRetirementControlMisses(UPSTREAM_RETIREMENT_PATTERN.source)
      if (missing.length > 0)
        throw new Error(
          `upstream-sync-forwarder: the pattern no longer matches ${missing.length} of its ` +
            `control strings (${missing.map((c) => JSON.stringify(c)).join(', ')}). The ` +
            'detector is broken; fix it rather than recording a phantom zero.',
        )
      const scanned = ctx.files.filter((f) =>
        UPSTREAM_RETIREMENT_ROOTS.some((r) => f.file === r || f.file.startsWith(`${r}/`)),
      )
      if (scanned.length === 0)
        throw new Error(
          `upstream-sync-forwarder: the roots ${UPSTREAM_RETIREMENT_ROOTS.join(', ')} matched ` +
            'no files. The detector is scanning nothing; its zero is a phantom, not the ' +
            'retirement holding.',
        )
      return grep(ctx, { roots: UPSTREAM_RETIREMENT_ROOTS, pattern: UPSTREAM_RETIREMENT_PATTERN })
    },
  },
  // REDEFINED at POD-368. The old detectors were `^export (interface|type|class)
  // X` over hardcoded lists of nine and seven NAMES, which POD-367 measured at
  // 4 of 17 issue representations — with `packages/model`'s own canonical
  // declarations counted as debt and the repo's largest restatement invisible
  // because its name was not on the list. The lists were deliberately NOT
  // extended: a longer literal list reproduces the defect and leaves the
  // criterion zeroable by RENAMING an identifier. These key on the entity
  // VOCABULARY, read at runtime out of the model, so a rename changes nothing.
  // See `scripts/representation-audit.ts` for what they can and cannot measure.
  {
    id: 'session-shapes',
    title: 'Hand-restated session field lists, unaccounted for in the model registry',
    phase: 'POD-302',
    unit: 'a declaration restating ≥3 session vocabulary keys that is neither registered in packages/model nor excluded with a reason',
    collect: (ctx) => unregisteredRestatements(ctx, 'session'),
  },
  {
    id: 'issue-shapes',
    title: 'Hand-restated issue field lists, unaccounted for in the model registry',
    phase: 'POD-302',
    unit: 'a declaration restating ≥3 issue vocabulary keys that is neither registered in packages/model nor excluded with a reason',
    collect: (ctx) => unregisteredRestatements(ctx, 'issue'),
  },
  {
    // The other direction of the loop. Without it the registry can rot into a
    // list of retired names while every other check reports green — the same
    // shape as a detector that stops matching.
    id: 'representation-registry-rot',
    title: 'Registry entries whose declaration is gone',
    phase: 'POD-302',
    unit: 'a registered representation whose site is missing or no longer declares the symbol',
    collect: (ctx) => danglingRegistryEntries(ctx.repoRoot),
  },
  {
    // A RATCHET, not a regression guard: seven rode the tree when this was
    // written. They are INHERITED — 1.4 added none and blessed none (POD-367
    // §3.5) — and each one left behind is later a table migration PLUS a wire
    // change PLUS a replica migration. Originally mapped to POD-1076, which
    // owned the (userId, entityId) re-key, and deliberately NOT to POD-302,
    // because POD-302 must not be able to close by laundering it.
    //
    // RE-PHASED POD-1076 -> POD-1229 by the POD-279 coordinator, with the
    // reason recorded here because a re-phase is exactly the move that can
    // launder debt:
    //
    // POD-1076 shipped its mechanical extraction and closed with TWO sites
    // surviving — IssueAutoArchiveObservation.readAt and
    // SessionAutoArchiveObservation.readAt. Those two are not residue of an
    // incomplete re-key. They are OUT OF SCOPE for a mechanical re-key by
    // construction, and both the source and the issue tracker said so BEFORE
    // this gate existed: maintenance.ts's own docblock names POD-1136, and
    // POD-1136's brief says "this is a policy call, not a mechanical re-key,
    // which is why it is not part of POD-1076's mechanical extraction". The
    // steward is a SYSTEM principal (ADR 9 D8 S5) with no human behind it, so
    // "archive it because it was read" cannot be re-keyed — someone has to
    // DECIDE read-by-whom.
    //
    // POD-423's Phase 1 exit gate found the conflict and refused to re-phase
    // it itself, which was right: an exit gate that edits this mapping in
    // order to let itself close is a detector that cannot say NO, one level
    // up, and is indistinguishable from a clean pass downstream. It escalated
    // instead. This edit is the coordinator's answer, not the gate's.
    //
    // The anti-laundering property is PRESERVED, not spent: POD-1229 is an
    // open, scheduled issue that owns the policy call and cannot close while
    // these sites exist. It points at POD-1136 (still `proposed`; a
    // coordinator cannot promote one) as its provenance. Check with
    // `bun scripts/rearch-audit.ts --phase POD-1229`.
    //
    // SETTLED AT POD-1229, and the detector was NOT touched to get there. Both
    // observations now carry `readerUserId` and no `readAt` at all: the policy
    // call was "the viewer the shared `archived` flag speaks for", and naming
    // that viewer on the wire is what removes the singleton — the value being
    // gated on is the authority's own and it re-derives it. See
    // `docs/agents/pod-1229-auto-archive-reader-decision.md`.
    //
    // Read the zero with its LIMIT: this item is name-matched over declarations
    // that clear ENTITY_SHAPE_THRESHOLD, so a shape can fall out of the
    // population by shedding unrelated keys rather than by shedding per-user
    // state. Both sites were checked against exactly that — re-adding `readAt`
    // to either observation makes the detector report it again — but the limit
    // is general and the next zero deserves the same check.
    id: 'per-user-singletons',
    title: 'Per-user state surviving as a singleton field on a representation',
    phase: 'POD-1229',
    unit: 'one per-user key on one session/issue representation',
    collect: (ctx) => perUserSingletons(ctx),
  },
  {
    // Expected ZERO and kept as a regression guard, because it will look like a
    // harmless denormalization to whoever adds it (ADR 9 D5 A1). `owner`,
    // `actor` and `onBehalfOf` are deliberately NOT matched: attribution must
    // survive export, and forbidding it would forbid what the matrix requires.
    id: 'capability-snapshots',
    title: 'Serialized effective-capability snapshot on a representation',
    phase: 'POD-302',
    unit: 'one authority-shaped key on one session/issue representation',
    collect: (ctx) => capabilitySnapshots(ctx),
  },
  {
    // ADR 1 D5 stands, Amendment 2 fences it: multi-user lives INSIDE one
    // instance and the dimension it adds is OWNER, not tenant. Zero, as a
    // guard — "multi-user" and "multi-tenant" are the two words this programme
    // most needs kept apart.
    // POD-1168 widened it from "a key on a representation" to "or a column on a
    // physical table": a drizzle table is a call expression, so its columns were
    // never enumerated and POD-1162's P4 plant of `instance_id` on `sessions`
    // was green everywhere. One concept, two syntax forms, one pattern.
    id: 'instance-partitions',
    title: 'Instance/tenant partition on a representation or a physical table',
    phase: 'POD-302',
    unit: 'one instance_id/tenant_id-shaped key or table column',
    collect: (ctx) => instancePartitions(ctx),
  },
  {
    id: 'change-row-typings',
    title: 'Hand-restated change-row field lists',
    // REDEFINED at POD-305, and this is a redefinition rather than a
    // re-baselining — the code did not change in the commit that moved this
    // number, the DETECTOR's definition did. Recorded in
    // docs/rearch-deletion-audit.md with the before/after measurement.
    //
    // The old detector counted EXPORTED NAMES in
    // `packages/protocol/src/messages/sync.ts`:
    //
    //   /^export (?:const|type) (?:MetadataChange|UnknownMetadataChange|SyncChangesSinceResult)/
    //
    // Two things were wrong with it, and neither is fixed by a longer name list.
    //
    // 1. IT MEASURED THE WRONG THING. The POD-279 review's finding 2 is explicit
    //    that change data legitimately exists in distinct lifecycle phases — a
    //    staged spec at commit time, a stored row, a sequenced wire delta — and
    //    that "the deletion-audit target is hand-restated field lists, not the
    //    existence of lifecycle types". Keyed on the NAMES of those types, the
    //    item could only be zeroed by deleting a type that has a reason to exist.
    // 2. IT WAS BLIND TO THE DEBT IT NAMED. `messages/sync.ts` restated
    //    seq/entity/id/op/value six times over and the changesSince snapshot arm
    //    twice, and this item reported the same 7 either way. The over-count
    //    `docs/rearch-deletion-audit.md` already flagged — `MetadataChangeOp`,
    //    an op enum rather than a change-row typing — is corrected by the
    //    redefinition rather than left as a known-wrong number, because POD-305
    //    owns the item's subject now and correcting it silently was the thing
    //    the earlier note declined to do.
    //
    // The phase stays POD-308: the wire cutover is what collapses the strict /
    // lenient duality for good. What POD-305 changes is that the item now
    // measures restatement, so composing a field list registers as the deletion
    // it is. See `scripts/change-row-audit.ts` for the two spellings it covers
    // and `change-row-audit.test.ts` for the planted violation of each.
    phase: 'POD-1251',
    // RE-PHASED POD-308 -> POD-1251 by the POD-279 coordinator. POD-310's Phase 2
    // exit gate found this mapped to a CLOSED issue, so 12 sites of real debt had
    // no owner and POD-308 could not pass its own phase-close rule. POD-1251 owns
    // composing them and cannot close while the count is non-zero, so the
    // anti-laundering property is preserved rather than spent. NOTE the count is
    // NOT a regression against main: main runs a different detector under this key
    // (exported names in one file, no change-row-audit.ts at all) — one instrument
    // over both trees gives integration 12, MAIN 22.
    unit: "a declaration writing out the change-row field list (an `op` key beside ≥2 other change-vocabulary keys) instead of composing the model's change field schemas",
    collect: (ctx) => changeRowRestatements(ctx),
  },
  {
    id: 'local-placeholders',
    title: "'__local__' machine placeholder",
    phase: 'POD-318',
    unit: "occurrence of the '__local__' placeholder in live code",
    collect: (ctx) => grep(ctx, { roots: ['apps', 'packages'], pattern: /__local__/ }),
  },
  {
    id: 'adoption-backfill-heals',
    title: 'Adoption / backfill heal methods',
    phase: 'POD-318',
    unit: 'heal method declaration',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps/server/src'],
        pattern:
          /^\s*(?:async\s+)?(?:adoptLocalRows|backfillRepoIds|backfillNullRepoIds|healLocalOrigins|backfillPrefixes|backfillMachine)\s*\(/,
      }),
  },
  {
    id: 'router-triple-access',
    title: 'tRPC transport triple state access (mods() / registry / sessionStore)',
    phase: 'POD-314',
    unit: 'hand-written state reach-through in a file that BUILDS tRPC procedures',
    // SCOPE WIDENED AT POD-314, AND THIS IS A REDEFINITION RATHER THAN A
    // RE-BASELINING — the POD-305 pattern. No product code changed in the commit
    // that moved this number; the DETECTOR's scope did, and the count rose
    // because debt became measurable (POD-301's words, 25/186 -> 28/237).
    //
    // WHY IT HAD TO MOVE. The old root was `apps/server/src/router.ts` alone,
    // which is exactly the blindness POD-1180 was filed for: an extraction into
    // `modules/**/trpc.ts` read as a win with nothing removed. Three issues
    // measured it and each declined to widen, because widening changes
    // EVERYONE's number and had to be done once, across all the derived routers,
    // by whoever could measure the whole thing — POD-382 found 5 of its 7
    // "removals" were moves, POD-384 moved seven sites into
    // modules/fleet/handlers.ts, POD-386 one into modules/specs/trpc.ts.
    //
    // MEASURED, both scopes, so the one NOT chosen is on the record too:
    //   router.ts alone (the old scope)      6
    //   + modules/**/trpc.ts (this scope)   20
    //   all of apps/server/src/modules      37
    // (all three measured BY THIS INSTRUMENT, which strips comments first — a
    // raw grep reports one more for the middle figure, and the instrument's
    // number is the one that governs.)
    //
    // THIS SCOPE IS THE FILES THAT BUILD PROCEDURES, chosen on what the item
    // MEANS rather than on what it counts: its subject is A TRANSPORT REACHING
    // PAST THE SEAM. The third boundary measures something different — reach-
    // through by anything a transport DERIVES — and folding it in here would
    // change the referent while keeping the name, which is the same defect as a
    // restatement passing a golden fixture. The 20 -> 37 gap is a finding in its
    // own right and belongs to POD-1180's successor: it says the derived arms
    // reach past the seam MORE than the transports ever did, which is the
    // opposite of what the cutovers were meant to buy.
    collect: (ctx) =>
      grep(ctx, {
        // Both homes, the POD-383 precedent recorded on `send-turn-duplicate`
        // below: a detector that follows code to its new address and forgets the
        // old one reads a RELAPSE as a pass.
        roots: ['apps/server/src/router.ts', 'apps/server/src/modules'],
        // Only the files that BUILD procedures. Expressed as the existing `skip`
        // veto rather than a new option: `router.ts` is named directly and every
        // other scanned file must be a family's `trpc.ts`.
        skip: (file) => file !== 'apps/server/src/router.ts' && !file.endsWith('/trpc.ts'),
        // `mods(ctx)` is only sugar: trpc.ts returns `ctx.modules ??
        // ctx.registry.modules`. Keying on the helper NAME alone would miss the
        // same reach-through spelled longhand — and would read a codemod that
        // inlines the helper as 100+ deletions.
        pattern: /\bmods\(|\bsessionStore\b|\bctx\.registry\.modules\b|\bctx\.modules\b/,
      }),
  },
  {
    id: 'send-turn-duplicate',
    title: 'superagent send / sendTurn duplicate procedure',
    phase: 'POD-313',
    unit: 'REDUNDANT alias: N procedures forwarding to superagent.sendTurn ⇒ N-1 counted (one is the real entry)',
    collect: (ctx) => {
      // THE ANCHOR FOLLOWED THE CODE (POD-383), and this comment says which of
      // the two things happened, because POD-1180 exists for the case where they
      // are confused. The DUPLICATE PROCEDURE genuinely VANISHED: `superagent.send`
      // is deleted, not relocated, and no file in the repo declares it. The CALL
      // ONTO THE SERVICE merely MOVED: `ctx.superagent.sendTurn(input)` in
      // router.ts became `s.sendTurn(input)` in the joined table at
      // modules/superagent/registry.ts, because the router is now derived from
      // the contract table. A detector still scanning only router.ts would have
      // read the move as a win — and its own guard below would have thrown, which
      // is the guard working.
      //
      // So BOTH homes are scanned. Adding a second `sendTurn:`-shaped alias is
      // counted wherever it is written: by hand in the router, or as a second key
      // in the table (`send: { contract: …, handler: (s) => s.sendTurn(…) }`),
      // which is the only place an alias could now come back. No `=>` in either
      // anchor: it rides on formatting, and biome wraps the arrow onto its own
      // line as soon as the arg list grows.
      const sites = [
        ...grep(ctx, {
          roots: ['apps/server/src/router.ts'],
          pattern: /ctx\.superagent\.sendTurn\(/,
        }),
        ...grep(ctx, {
          roots: ['apps/server/src/modules/superagent/registry.ts'],
          pattern: /\bs\.sendTurn\(/,
        }),
      ]
      // A bare `sites.slice(1)` turns detector FAILURE into "0 = deleted, phase
      // clear to close": if the anchor ever stops matching, [].slice(1) is []
      // and POD-313 reads as done with both procedures intact. Zero matches
      // means the anchor moved, not that the duplicate went away.
      if (sites.length === 0)
        throw new Error(
          'send-turn-duplicate: neither anchor matched — `ctx.superagent.sendTurn(` in ' +
            'apps/server/src/router.ts nor `s.sendTurn(` in ' +
            'apps/server/src/modules/superagent/registry.ts. The detector is broken (or the ' +
            'turn command moved again). Fix the check; do not record a phantom zero.',
        )
      return sites.slice(1)
    },
  },
  {
    id: 'durable-host-sync-async-twins',
    title: 'Sync/async abduco+tmux twins',
    phase: 'POD-324',
    unit: 'blocking function that has an async twin (X + XAsync)',
    collect: (ctx) => {
      const sites: AuditSite[] = []
      const twinLines = (lines: string[]): Array<{ line: number; text: string }> => {
        const asyncTwins = new Set<string>()
        for (const line of lines) {
          const m = line.match(/^export async function (\w+)Async\s*\(/)
          if (m?.[1]) asyncTwins.add(m[1])
        }
        const twins: Array<{ line: number; text: string }> = []
        for (const [idx, line] of lines.entries()) {
          const m = line.match(/^export function (\w+)\s*\(/)
          if (m?.[1] && asyncTwins.has(m[1])) twins.push({ line: idx + 1, text: line.trim() })
        }
        return twins
      }
      const control = twinLines([
        'export function durableHostControl() {}',
        'export async function durableHostControlAsync() {}',
      ])
      if (control.length !== 1)
        throw new Error(
          'durable-host-sync-async-twins: matcher no longer recognizes its sync/async control pair',
        )
      let durableHostFiles = 0
      for (const f of ctx.files) {
        // POD-396 moved the durable hosts (abduco.ts, tmux.ts) out of
        // agent-bridge into packages/pty. Both roots are listed rather than one
        // swapped for the other: a single hardcoded root turns a package MOVE
        // into "0 sites = twins deleted, POD-324 clear to close" — the phantom
        // zero this audit exists to prevent. POD-397 adds packages/harness here
        // if any durable-host twin ever lands there.
        const inDurableHostHome =
          f.file.startsWith('packages/pty/src/') || f.file.startsWith('packages/agent-bridge/src/')
        if (!inDurableHostHome || f.isTest) continue
        durableHostFiles++
        for (const twin of twinLines(f.stripped.split('\n'))) {
          sites.push({ file: f.file, line: twin.line, text: twin.text })
        }
      }
      if (durableHostFiles === 0)
        throw new Error(
          'durable-host-sync-async-twins: neither durable-host source root matched files; the zero is unmeasured',
        )
      return sites
    },
  },
  {
    id: 'reexport-shims',
    title: 'App-level re-export shims',
    phase: 'POD-333',
    unit: 'file whose every statement is a re-export (package barrels excluded)',
    collect: (ctx) => {
      const sites: AuditSite[] = []
      for (const f of ctx.files) {
        if (f.isTest || isFrozenFile(f.file)) continue
        // Barrels under `packages/*/src/**` are a legitimate public API surface,
        // not debt: `protocol/src/messages/index.ts` re-exports the domain split
        // precisely so `@podium/protocol`'s import path stays stable. Only
        // APP-level all-re-export files are shims (a moved module's tombstone).
        if (/^packages\/[^/]+\/src\/(?:.*\/)?index\.ts$/.test(f.file)) continue
        // STATEMENT-based, not line-based. A wrapped `export {\n a,\n} from 'x'`
        // has no single line carrying both `export` and `from`, so a per-line
        // test drops the file entirely — and since biome (lineWidth 100) wraps a
        // re-export as soon as one name is added, the count would FALL and the
        // ratchet would cheerfully record a deletion that never happened.
        const code = f.stripped
        const REEXPORT =
          /export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[\s\S]*?\})\s+from\s*['"][^'"]+['"]\s*;?/g
        const count = code.match(REEXPORT)?.length ?? 0
        if (count === 0) continue
        if (code.replace(REEXPORT, '').trim().length === 0)
          sites.push({
            file: f.file,
            line: 1,
            text: `${count} re-exports, no other code`,
          })
      }
      return sites
    },
  },
  {
    id: 'cli-launch-plan-debt',
    title: 'CLI launch-plan config-migration debt',
    phase: 'POD-333',
    unit: 'LaunchPlan variant that exists only to repair/migrate unversioned config',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps/cli/src/cli.ts'],
        pattern: /\|\s*\{\s*kind:\s*'repair-config'/,
      }),
  },
  {
    id: 'agent-kind-enums',
    title: 'Duplicate agent-kind enums',
    phase: 'POD-303',
    unit: 'z.enum re-declaring the agent vocabulary outside the canonical model/entities/agent.ts (aliases are fine)',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps', 'packages'],
        pattern: /^export const (?:AgentKind|HarnessAgent) = z\.enum\(/,
        skip: (file) => file === 'packages/model/src/entities/agent.ts',
      }),
  },
  {
    id: 'capability-tables',
    title: 'Per-harness capability tables',
    phase: 'POD-325',
    unit:
      'hand-maintained per-harness Record<AgentKind|HarnessAgent, …> table in the ' +
      'protocol/runtime/agent-bridge/server tree (folds into the harness manifests)',
    collect: (ctx) =>
      grep(ctx, {
        // Scoped to where per-harness CAPABILITY data lives. apps/web's
        // KIND_ICON (WorkerLabel.tsx:77) is the same Record<AgentKind, …> shape
        // and drifts the same way, but it is a UI icon map, not a capability
        // POD-325 folds into a harness manifest — counting it would block this
        // phase on unrelated web work. Deliberately out of scope, not an oversight.
        // SPANS BOTH HOMES of the harness code. POD-397 split agent-bridge, moving
        // the manifest registry to packages/harness; this list keeps BOTH so the
        // move cannot silently zero the count. A path-prefix scope that follows
        // code to exactly one new home reads a relocation as a deletion, and the
        // ratchet banks it as progress — see docs/rearch-deletion-audit.md, "a
        // detector that stops matching is not a deletion".
        roots: [
          'packages/protocol',
          'packages/runtime',
          'packages/agent-bridge',
          'packages/harness',
          'apps/server',
          'apps/daemon',
        ],
        // No `export` requirement: a module-private table drifts identically.
        // BuiltinHarnessKind is included because POD-397 renamed the registry's key
        // type (Record<HarnessAgent, HarnessAdapter> -> Record<BuiltinHarnessKind,
        // AgentManifest>). Without it the rename alone would drop the site while the
        // table sat there untouched — the same phantom zero as the path move, by a
        // second independent route.
        pattern:
          /^\s*(?:export )?const \w+: (?:Readonly<)?Record<\s*(?:AgentKind|HarnessAgent|BuiltinHarnessKind)\s*,/,
      }),
  },
  {
    id: 'state-dir-defs',
    title: 'stateDir() redefinitions',
    phase: 'POD-333',
    unit: 'stateDir() declared outside packages/runtime/src/config.ts (regression guard: already 0)',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps', 'packages'],
        pattern: /^export (?:function|const) stateDir\b/,
        skip: (file) => file === 'packages/runtime/src/config.ts',
      }),
  },
  {
    id: 'panel-mode-duality',
    title: 'panelMode storage duality',
    phase: 'POD-329',
    unit: 'panelMode storage-key literal outside the engine persistence module',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps', 'packages'],
        pattern: /'podium\.panelMode(?:Default)?'/,
        skip: (file) => file === 'packages/client-core/src/engine/persistence.ts',
      }),
  },
  {
    /**
     * THE TWO DIRTY-SCOPING SHIMS (POD-722/POD-723), COUNTED AT LAST.
     *
     * These were named as deletion-audit items when POD-736 was written and were
     * never actually registered — so "delete the shims at the cutover" was an
     * instruction with no instrument behind it, and an item nobody counts is an
     * item nobody has to reach zero on. Registering them is the point even
     * though POD-736 MEASURED that they must not be deleted yet (18x switch
     * regression at 588 sessions / 800 issues — see
     * docs/agents/pod-736-harness-evidence.md): the difference between a comment
     * saying "interim" and a scheduled deletion is exactly a gate counting the
     * sites, and this run has paid for that distinction more than once.
     *
     * THE EXPIRY CONDITION, NAMED SO IT CAN ARRIVE: both shims exist to suppress
     * the O(issues x sessions) `allWire()` rebuild that a SESSION-driven publish
     * triggers. They become deletable when the issue projection stops being
     * rebuilt from a session list at all — i.e. when IssueWire stops embedding
     * SessionMeta[] and a session change reaches issue clients as its own change
     * row. That is a representation change (ADR 4), not a timing one, and it is
     * what POD-337 must see at zero.
     *
     * Anchored on the STATE each shim keeps rather than on its comment marker: a
     * comment can be deleted while the mechanism stays, which is the shape of a
     * detector that reports a win for a rename.
     */
    id: 'issue-wire-dirty-scoping-shims',
    title: 'Interim dirty-scoping shims on the issue wire rebuild (POD-722/723)',
    phase: 'POD-337',
    unit: 'piece of dirty-set state kept solely to skip the session-driven issue rebuild',
    collect: (ctx) => [
      ...grep(ctx, {
        roots: ['apps/server/src/modules/sessions/service.ts'],
        pattern: /private (?:last)?[iI]ssueProjectionGeneration\b/,
      }),
      ...grep(ctx, {
        roots: ['apps/server/src/modules/issues/service/core.ts'],
        pattern: /private (?:readonly )?(?:wireCache|issueInputsGen)\b/,
      }),
    ],
  },
  {
    id: 'mobile-client-value',
    title: 'MobileClientValue bespoke mobile surface',
    phase: 'POD-332',
    unit: 'declaration of the bespoke mobile client value type',
    collect: (ctx) =>
      grep(ctx, { roots: ['apps/mobile'], pattern: /^export interface MobileClientValue\b/ }),
  },
  {
    id: 'superagent-shadow-types',
    title: 'Mobile superagent shadow types',
    phase: 'POD-332',
    unit: 'mobile-local re-declaration of a server superagent row',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps/mobile/src/client/trpc.ts'],
        pattern: /^export interface Superagent\w+\b/,
      }),
  },
  {
    id: 'web-storage-keys',
    title: 'Stray localStorage keys',
    phase: 'POD-329',
    unit: "distinct 'podium.*' storage-key literal in apps/web (no central keys module)",
    collect: (ctx) =>
      grepDistinctLiterals(ctx, {
        roots: ['apps/web/src'],
        pattern: /'podium\.[\w.]*'/,
        literal: /'(podium\.[\w.]*)'/,
      }),
  },
  {
    id: 'static-systemd-units',
    title: 'Static systemd unit family',
    phase: 'POD-334',
    unit: 'checked-in unit file duplicating the rendered units (scripts/render-systemd.ts)',
    collect: (ctx) =>
      ctx
        .listDir('scripts/systemd')
        .filter((n) => /\.(service|timer|path|socket)$/.test(n))
        .map((n) => ({ file: `scripts/systemd/${n}`, line: 1, text: n })),
  },
  {
    id: 'composition-root-forward-refs',
    title: 'let-thunk forward refs in the composition root',
    phase: 'POD-321',
    unit: 'definite-assignment forward ref (`let x!: T`) broken by a thunk',
    collect: (ctx) => grep(ctx, { roots: ['apps/server/src/server.ts'], pattern: /^\s*let \w+!:/ }),
  },
  // ADDED at POD-301. POD-363's AC and POD-301's fourth AC both name a
  // "raw-string entity ids" item that reached zero; there was NO SUCH KEY and no
  // detector, so the zero being reported was the POD-361-EDGE-CAST marker count
  // — a different, genuinely-zero thing. POD-423 held Phase 1 open for exactly
  // this and its formulation is the one adopted here: an audit item named in an
  // acceptance criterion but absent from the baseline is not a passing check, it
  // is an unmeasured claim.
  //
  // Adding these three keys is a RATCHET EXTENSION, not a rebaseline: they
  // measure debt that was always present and never counted, so the item total
  // rises on the commit that introduces them and may only fall afterwards. See
  // `scripts/entity-id-audit.ts` for what the detector can and cannot see, and
  // `entity-id-audit.test.ts` for the planted violation of every spelling.
  {
    id: 'raw-string-entity-ids',
    title: 'Entity id declared as a bare zod string while its brand exists',
    phase: 'POD-301',
    unit: 'one zod field whose key names a branded entity id and whose schema is an unbranded string',
    collect: (ctx) => rawStringEntityIds(ctx),
  },
  {
    // SPLIT OUT DELIBERATELY, and mapped to POD-318 rather than POD-301: ADR 1
    // Amendment 2 D16.2 is normative that `MachineId` must NOT be adopted at any
    // field until `local` / `__local__` are retired, because branding a sentinel
    // LAUNDERS it instead of flagging it. D16.2 asks for "a narrower, VISIBLE
    // debt" — a carve-out nobody counts is not visible — so these are counted
    // here instead of being silently excluded from the item above. POD-301 must
    // not be able to close by laundering them, and POD-318 must not be able to
    // close while any remain.
    id: 'machine-id-unbranded-fields',
    title: 'Machine-id field still an unbranded string (the D16.2 carve-out)',
    phase: 'POD-318',
    unit: 'one machine-id zod field, in either spelling — bare z.string() or the machineIdBlockedOnPOD318 marker',
    collect: (ctx) => machineIdUnbrandedFields(ctx),
  },
  {
    // The escape hatch, counted so it cannot be used quietly. Without this key
    // the item above is zeroable by writing the word UNBRANDED above every
    // field. With it, an excuse RAISES a committed number and the audit fails
    // until someone records the reason — the same discipline the deletion audit
    // applies to itself.
    id: 'unbranded-by-decision-ids',
    title: 'Entity id fields excused from branding by an UNBRANDED doc comment',
    phase: 'POD-301',
    unit: 'one zod id field carrying the UNBRANDED excuse marker',
    collect: (ctx) => unbrandedByDecisionFields(ctx),
  },
]

// ---------------------------------------------------------------------------
// Run + ratchet
// ---------------------------------------------------------------------------

export interface AuditResult {
  id: string
  title: string
  phase: string
  unit: string
  count: number
  sites: AuditSite[]
}

export function runAudit(ctx: AuditContext, checks: readonly AuditCheck[] = CHECKS): AuditResult[] {
  return checks.map((c) => {
    const sites = c.collect(ctx)
    return { id: c.id, title: c.title, phase: c.phase, unit: c.unit, count: sites.length, sites }
  })
}

export type Baseline = Record<string, number>

export interface Delta {
  id: string
  baseline: number | undefined
  count: number
}

/** Items whose count moved, plus items missing from / stale in the baseline. */
export function diffBaseline(
  results: readonly AuditResult[],
  baseline: Baseline,
): { regressions: Delta[]; improvements: Delta[]; unknown: string[]; stale: string[] } {
  const regressions: Delta[] = []
  const improvements: Delta[] = []
  const unknown: string[] = []
  for (const r of results) {
    const b = baseline[r.id]
    if (b === undefined) {
      unknown.push(r.id)
      continue
    }
    if (r.count > b) regressions.push({ id: r.id, baseline: b, count: r.count })
    else if (r.count < b) improvements.push({ id: r.id, baseline: b, count: r.count })
  }
  const ids = new Set(results.map((r) => r.id))
  const stale = Object.keys(baseline).filter((k) => !ids.has(k))
  return { regressions, improvements, unknown, stale }
}

export function baselineOf(results: readonly AuditResult[]): Baseline {
  const out: Baseline = {}
  for (const r of results) out[r.id] = r.count
  return out
}

const BASELINE_FILE = 'scripts/rearch-audit-baseline.json'

function formatBaseline(baseline: Baseline): string {
  const body = Object.keys(baseline)
    .sort()
    .map((k) => `    ${JSON.stringify(k)}: ${baseline[k]}`)
    .join(',\n')
  return `{
  "$schema": "Deletion audit baseline — see scripts/rearch-audit.ts and docs/rearch-deletion-audit.md.",
  "$note": "Counts of v3-inventory items still present. Regenerate with: bun run audit:rearch --update-baseline. These may only go DOWN; every item must reach 0 before its phase issue closes.",
  "counts": {
${body}
  }
}
`
}

function readBaseline(repoRoot: string): Baseline {
  const raw = readFileSync(join(repoRoot, BASELINE_FILE), 'utf8')
  const parsed = JSON.parse(raw) as { counts?: Baseline }
  if (!parsed.counts || typeof parsed.counts !== 'object')
    throw new Error(`${BASELINE_FILE}: missing "counts" object`)
  return parsed.counts
}

function printSites(r: AuditResult): void {
  for (const s of r.sites) console.error(`      ${s.file}:${s.line}  ${s.text}`)
}

const KNOWN_FLAGS = new Set(['--update-baseline', '--json', '--sites', '--phase'])

/**
 * THE MEASUREMENT HARNESS — EXPLICITLY NOT DEBT [POD-736].
 *
 * ---------------------------------------------------------------------------
 * WHY A DELETION AUDIT NEEDS A KEEP LIST AT ALL
 * ---------------------------------------------------------------------------
 *
 * Everything else in this file counts things that must reach zero. These files
 * must reach zero NEVER, and they are unusually easy to sweep up: the
 * switch-latency harness was BUILT to instrument the `publishComputed` pipeline
 * that POD-308/POD-1203 deleted, so a sweep aimed at "code belonging to the
 * deleted pipeline" catches it by every reasonable heuristic. It is also the only
 * quantitative source POD-310's rehearsal and POD-337's release gate have.
 *
 * A COMMENT SAYING "KEEP THIS" IS NOT A WHITELIST. This run's standing lesson is
 * that a declaration nothing reads is indistinguishable from an enforced one, so
 * this list is READ: {@link assertHarnessPresent} fails the audit if any entry
 * has gone missing. Deleting the harness therefore reddens the gate that the
 * deletion was supposedly satisfying, which is the only arrangement that makes
 * the protection real.
 *
 * Note what it does NOT do: it does not assert the files still WORK. That is
 * `apps/server/src/modules/perf/harness-live.test.ts`, which drives the real
 * composition and fails when the harness stops observing the serving path. A
 * present-but-dark harness is the failure mode this list cannot see, and saying
 * so here is what stops someone reading this as more protection than it is.
 */
const MEASUREMENT_HARNESS: readonly string[] = [
  // The wire contract, including PHASE_MIGRATION — the retired names' map.
  'packages/protocol/src/perf.ts',
  // The ring, the per-principal partitions and the slice-size dimension.
  'apps/server/src/modules/perf/registry.ts',
  // The one derivation of the partition key, so every site moves together.
  'apps/server/src/modules/perf/principal.ts',
  // perf.report / perf.reset / perf.snapshot — the operator-facing surface.
  'apps/server/src/modules/perf/commands.ts',
  'apps/server/src/modules/perf/queries.ts',
  // The gate that proves the harness observes the LIVE path, not a remainder.
  'apps/server/src/modules/perf/harness-live.test.ts',
  // The A/B bench POD-310 and POD-337 consume, and its client-side counterpart.
  'scripts/switch-latency-ab.ts',
  'scripts/switch-bench-serve.ts',
  'tests/e2e/switch-bench.ts',
  // The client half of the trace contract.
  'packages/client-core/src/perf/switch-trace.ts',
]

/** Fails the audit when a whitelisted harness file has been deleted. */
function assertHarnessPresent(repoRoot: string): void {
  const missing = MEASUREMENT_HARNESS.filter((rel) => !existsSync(join(repoRoot, rel)))
  if (missing.length === 0) return
  console.error(
    'Deletion audit: the switch-latency measurement harness is MISSING files. These are\n' +
      'whitelisted as permanent instrumentation, not as debt — POD-310\u2019s rehearsal and\n' +
      'POD-337\u2019s release gate have no other quantitative source for switch latency. If a\n' +
      'file genuinely moved, update MEASUREMENT_HARNESS in scripts/rearch-audit.ts in the\n' +
      'same commit; if it was deleted with the pipeline it used to instrument, that is the\n' +
      'exact mistake POD-736 exists to prevent.\n',
  )
  for (const rel of missing) console.error(`  missing: ${rel}`)
  process.exit(2)
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const argv = process.argv.slice(2)
  const wants = (flag: string) => argv.includes(flag)
  const phaseIdx = argv.indexOf('--phase')
  const phaseArg = phaseIdx === -1 ? undefined : argv[phaseIdx + 1]

  // Fail closed on anything unrecognised: a typo'd `--updatebaseline` silently
  // running the ratchet instead (exit 0, nothing updated) is the worst outcome
  // this tool can produce — it looks like it worked.
  const unknownFlags = argv.filter(
    (a, i) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !(phaseIdx !== -1 && i === phaseIdx + 1),
  )
  if (unknownFlags.length > 0) {
    console.error(`Unknown flag(s): ${unknownFlags.join(', ')}`)
    console.error(`Known: ${[...KNOWN_FLAGS].sort().join(', ')}`)
    process.exit(2)
  }

  // `--phase` is a GATE, so it must decide the exit code before any mode that
  // returns early. Otherwise `--phase POD-314 --json` exits 0 with 119 live
  // sites, and any automation reading machine output from the gate always
  // passes — the exact "looks like it worked" failure the unknown-flag check
  // above exists to prevent.
  if (wants('--phase') && wants('--update-baseline')) {
    console.error('--phase is a read-only gate; it cannot be combined with --update-baseline.')
    process.exit(2)
  }
  // Validate the phase argument BEFORE the repo walk: bad args should fail in
  // milliseconds, not after 2.3s of scanning.
  if (wants('--phase') && (!phaseArg || !/^POD-\d+$/.test(phaseArg))) {
    console.error('usage: --phase POD-309')
    process.exit(2)
  }

  assertHarnessPresent(repoRoot)
  const ctx = loadContext(repoRoot)
  const results = runAudit(ctx)
  const total = results.reduce((n, r) => n + r.count, 0)

  // ACTIONS BEFORE REPORTS. `--json` is a format, not a mode: when it ran first
  // and returned, `--json --update-baseline` exited 0 having written NOTHING —
  // an output flag silently swallowing the write, and it looked like it worked.
  // Same family as an output flag disabling the --phase gate.
  if (wants('--update-baseline')) {
    const next = baselineOf(results)
    writeFileSync(join(repoRoot, BASELINE_FILE), formatBaseline(next))
    if (wants('--json')) console.log(JSON.stringify({ total, items: results }, null, 2))
    else
      console.log(`baseline updated (${results.length} items, ${total} sites) → ${BASELINE_FILE}`)
    return
  }

  if (wants('--json') && !wants('--phase')) {
    console.log(JSON.stringify({ total, items: results }, null, 2))
    return
  }

  if (wants('--sites') && !wants('--phase')) {
    for (const r of results) {
      console.log(`${r.count.toString().padStart(4)}  ${r.id} (${r.phase}) — ${r.title}`)
      console.log(`        unit: ${r.unit}`)
      for (const s of r.sites) console.log(`        ${s.file}:${s.line}  ${s.text}`)
    }
    console.log(`\n${results.length} items, ${total} sites`)
    return
  }

  // Phase-close gate.
  if (wants('--phase')) {
    if (!phaseArg || !/^POD-\d+$/.test(phaseArg)) {
      console.error('usage: --phase POD-309')
      process.exit(2)
    }
    const mine = results.filter((r) => r.phase === phaseArg)
    if (mine.length === 0) {
      console.error(`No deletion-audit items are mapped to ${phaseArg}.`)
      console.error(
        'Phases with items: ' + [...new Set(results.map((r) => r.phase))].sort().join(', '),
      )
      process.exit(2)
    }
    const left = mine.filter((r) => r.count > 0)
    // `--phase --json` still gates; the JSON is the report, the exit code is the
    // verdict. Never let an output format decide whether a gate holds.
    if (wants('--json'))
      console.log(
        JSON.stringify({ phase: phaseArg, clearToClose: left.length === 0, items: mine }, null, 2),
      )
    if (left.length > 0) {
      console.error(`${phaseArg} may NOT be closed — ${left.length} of its items still exist:\n`)
      for (const r of left) {
        console.error(`  ${r.count.toString().padStart(3)}  ${r.id} — ${r.title}`)
        printSites(r)
      }
      console.error('\nPhase-close rule: docs/rearch-deletion-audit.md')
      process.exit(1)
    }
    console.log(
      `${phaseArg}: all ${mine.length} deletion-audit items are at zero — clear to close.`,
    )
    return
  }

  // Ratchet.
  let baseline: Baseline
  try {
    baseline = readBaseline(repoRoot)
  } catch (err) {
    console.error(`Cannot read ${BASELINE_FILE}: ${(err as Error).message}`)
    console.error('Create it with: bun run audit:rearch --update-baseline')
    process.exit(2)
  }
  const { regressions, improvements, unknown, stale } = diffBaseline(results, baseline)

  if (regressions.length > 0) {
    console.error(`Deletion audit: ${regressions.length} item(s) GREW. The rewrite may not add to`)
    console.error('the debt it is deleting — route the new code through the replacement seam.\n')
    for (const d of regressions) {
      const r = results.find((x) => x.id === d.id) as AuditResult
      console.error(`  ${r.id} (${r.phase}) — ${r.title}`)
      console.error(`      baseline ${d.baseline} → now ${d.count}   [${r.unit}]`)
      printSites(r)
      console.error('')
    }
  }
  if (unknown.length > 0)
    console.error(
      `Deletion audit: ${unknown.length} item(s) missing from the baseline: ${unknown.join(', ')}`,
    )
  if (stale.length > 0)
    console.error(
      `Deletion audit: baseline has ${stale.length} unknown item(s): ${stale.join(', ')}`,
    )
  if (improvements.length > 0) {
    console.error(
      'Deletion audit: counts went DOWN — nice. Lock the win in so it cannot be given back:\n',
    )
    for (const d of improvements) console.error(`  ${d.id}: ${d.baseline} → ${d.count}`)
    console.error(`\n  bun run audit:rearch --update-baseline   (then commit ${BASELINE_FILE})`)
  }
  if (regressions.length + improvements.length + unknown.length + stale.length > 0) process.exit(1)

  console.log(
    `deletion audit OK — ${results.length} items, ${total} sites remaining (baseline exact)`,
  )
}

if (import.meta.main) main()
