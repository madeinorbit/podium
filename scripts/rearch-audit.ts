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

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  isTest: boolean
}

export interface AuditContext {
  repoRoot: string
  files: readonly SourceFile[]
  /** Repo-relative paths of files directly under a directory (non-recursive). */
  listDir(rel: string): string[]
}

/**
 * Strip `//` and block comments, replacing them with spaces so every byte
 * offset — and therefore every line number — is preserved. `check-boundaries.ts`
 * has a `stripComments` too, but it deletes comments outright and collapses the
 * newlines inside block comments; this audit reports `file:line` sites, so it
 * needs the line structure intact.
 *
 * String literals are preserved verbatim: the '__local__' placeholder IS a
 * string literal, so the audit must still see inside quotes. Known limitation
 * (shared with check-boundaries): a regex literal containing a quote character
 * can desynchronise the scanner. Only under-reports, and no scanned root has
 * one; the pattern lives in scripts/, which the regex checks don't walk.
 */
export function stripComments(source: string): string {
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let state: State = 'code'
  let out = ''
  let i = 0
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
      if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'single' : c === '"' ? 'double' : 'template'
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
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code'
    } else if (c === '\n' && state !== 'template') {
      // Unterminated single/double quote: recover at the newline.
      state = 'code'
    }
    out += c
    i += 1
  }
  return out
}

export function isTestFile(file: string): boolean {
  return /\.(test|spec|bun\.test)\.tsx?$/.test(file) || /\/(test|tests|__tests__)\//.test(file)
}

/** Generated or historical files no phase issue can edit: past migrations are
 *  immutable history, and generated manifests are rebuilt from them. */
export function isFrozenFile(file: string): boolean {
  return file.includes('/migrations/') || file.endsWith('.generated.ts')
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
      files.push({
        file,
        stripped: stripComments(readFileSync(abs, 'utf8')),
        isTest: isTestFile(file),
      })
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

const SESSION_SHAPES = [
  'AgentSession',
  'OpencodeSessionRow',
  'ResumableSession',
  'RecentSession',
  'HandoffSession',
  'SessionMeta',
  'SessionCardModel',
  'MountedSession',
  'HandoffManifest',
]

const ISSUE_SHAPES = [
  'IssueWire',
  'IssueSessionSummary',
  'OrphanIssue',
  'IssueRow',
  'IssuePageModel',
  'IssueNavView',
  'HandoffIssue',
]

/** Declaration of one of `names` as an exported interface/type/class. */
function declRe(names: string[]): RegExp {
  return new RegExp(`^export (?:interface|type|class) (?:${names.join('|')})\\b`)
}

export const CHECKS: AuditCheck[] = [
  {
    id: 'publish-computed-fanout',
    title: 'publishComputed snapshot fan-out',
    phase: 'POD-308',
    unit: 'reference to funnel.publishComputed (the legacy snapshot tail)',
    collect: (ctx) => grep(ctx, { roots: ['apps/server/src'], pattern: /\bpublishComputed\b/ }),
  },
  {
    id: 'upstream-sync-forwarder',
    title: 'UpstreamSync / UpstreamForwarder',
    phase: 'POD-309',
    unit: 'class declaration or construction site',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps', 'packages'],
        pattern:
          /^export class (?:UpstreamSync|UpstreamForwarder)\b|new (?:UpstreamSync|UpstreamForwarder)\s*\(/,
      }),
  },
  {
    id: 'session-shapes',
    title: 'Competing session shapes',
    phase: 'POD-302',
    unit: 'declaration of a session shape outside the canonical aggregate',
    collect: (ctx) => grep(ctx, { roots: ['apps', 'packages'], pattern: declRe(SESSION_SHAPES) }),
  },
  {
    id: 'issue-shapes',
    title: 'Competing issue shapes',
    phase: 'POD-302',
    unit: 'declaration of an issue shape outside the canonical aggregate',
    collect: (ctx) => grep(ctx, { roots: ['apps', 'packages'], pattern: declRe(ISSUE_SHAPES) }),
  },
  {
    id: 'change-row-typings',
    title: 'Parallel change-row typings (strict/lenient/unknown)',
    phase: 'POD-302',
    unit: 'exported name in the change-row family (const + its inferred type count once)',
    collect: (ctx) => {
      const sites = grep(ctx, {
        roots: ['packages/protocol/src/messages/sync.ts'],
        pattern:
          /^export (?:const|type) (?:MetadataChange|UnknownMetadataChange|SyncChangesSinceResult)/,
      })
      // `export const X` + `export type X = z.infer<typeof X>` are one shape.
      const seen = new Set<string>()
      return sites.filter((s) => {
        const name = s.text.match(/^export (?:const|type) (\w+)/)?.[1]
        if (!name || seen.has(name)) return false
        seen.add(name)
        return true
      })
    },
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
    title: 'router.ts triple state access (mods() / registry / sessionStore)',
    phase: 'POD-314',
    unit: 'hand-written state reach-through in router.ts',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps/server/src/router.ts'],
        pattern: /\bmods\(|\bsessionStore\b/,
      }),
  },
  {
    id: 'send-turn-duplicate',
    title: 'superagent send / sendTurn duplicate procedure',
    phase: 'POD-313',
    unit: 'REDUNDANT alias: N procedures forwarding to superagent.sendTurn ⇒ N-1 counted (one is the real entry)',
    collect: (ctx) => {
      const sites = grep(ctx, {
        roots: ['apps/server/src/router.ts'],
        pattern: /=>\s*ctx\.superagent\.sendTurn\(/,
      })
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
      for (const f of ctx.files) {
        if (!f.file.startsWith('packages/agent-bridge/src/') || f.isTest) continue
        const lines = f.stripped.split('\n')
        const asyncTwins = new Set<string>()
        for (const line of lines) {
          const m = line.match(/^export async function (\w+)Async\s*\(/)
          if (m?.[1]) asyncTwins.add(m[1])
        }
        for (const [idx, line] of lines.entries()) {
          const m = line.match(/^export function (\w+)\s*\(/)
          if (m?.[1] && asyncTwins.has(m[1]))
            sites.push({ file: f.file, line: idx + 1, text: line.trim() })
        }
      }
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
        const statements = f.stripped
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
        if (statements.length === 0) continue
        if (statements.every((l) => /^export .*\bfrom\s*['"]/.test(l)))
          sites.push({
            file: f.file,
            line: 1,
            text: `${statements.length} re-exports, no other code`,
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
    unit: 'z.enum re-declaring the agent vocabulary outside the canonical protocol/messages/harness.ts (aliases are fine)',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps', 'packages'],
        pattern: /^export const (?:AgentKind|HarnessAgent) = z\.enum\(/,
        skip: (file) => file === 'packages/protocol/src/messages/harness.ts',
      }),
  },
  {
    id: 'capability-tables',
    title: 'Per-harness capability tables',
    phase: 'POD-325',
    unit: 'hand-maintained Record<AgentKind|HarnessAgent, …> table (folds into the manifests)',
    collect: (ctx) =>
      grep(ctx, {
        roots: ['apps', 'packages'],
        pattern: /^export const \w+: Record<(?:AgentKind|HarnessAgent),/,
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

  const ctx = loadContext(repoRoot)
  const results = runAudit(ctx)
  const total = results.reduce((n, r) => n + r.count, 0)

  if (wants('--json')) {
    console.log(JSON.stringify({ total, items: results }, null, 2))
    return
  }

  if (wants('--sites')) {
    for (const r of results) {
      console.log(`${r.count.toString().padStart(4)}  ${r.id} (${r.phase}) — ${r.title}`)
      console.log(`        unit: ${r.unit}`)
      for (const s of r.sites) console.log(`        ${s.file}:${s.line}  ${s.text}`)
    }
    console.log(`\n${results.length} items, ${total} sites`)
    return
  }

  if (wants('--update-baseline')) {
    writeFileSync(join(repoRoot, BASELINE_FILE), formatBaseline(baselineOf(results)))
    console.log(`baseline updated (${results.length} items, ${total} sites) → ${BASELINE_FILE}`)
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
