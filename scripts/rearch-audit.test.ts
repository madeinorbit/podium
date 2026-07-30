import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RETAINED_REPRESENTATIONS } from '../packages/model/src/representations/registry'
import {
  entityShapedDeclarations,
  ISSUE_VOCABULARY,
  SESSION_VOCABULARY,
} from './representation-audit'
import {
  type AuditContext,
  type AuditResult,
  baselineOf,
  CHECKS,
  diffBaseline,
  grep,
  grepDistinctLiterals,
  isFrozenFile,
  isTestFile,
  loadContext,
  runAudit,
  type SourceFile,
  stripComments,
} from './rearch-audit'

/** A context over in-memory sources, so the rule tests never touch the repo. */
function ctxOf(files: Record<string, string>, dirs: Record<string, string[]> = {}): AuditContext {
  const srcs: SourceFile[] = Object.entries(files).map(([file, source]) => ({
    file,
    stripped: stripComments(source),
    isTest: isTestFile(file),
  }))
  return { repoRoot: '/repo', files: srcs, listDir: (rel) => dirs[rel] ?? [] }
}

describe('stripComments', () => {
  it('preserves line numbers across block comments', () => {
    const src = ['const a = 1', '/* one', '   two', '   three */', 'const b = 2'].join('\n')
    const out = stripComments(src)
    expect(out.split('\n')).toHaveLength(5)
    expect(out.split('\n')[4]).toBe('const b = 2')
  })

  it('removes identifiers that only appear in comments', () => {
    // The exact failure this audit must avoid: a doc comment mentioning a
    // deleted symbol would keep its count above zero forever.
    const src = ['// publishComputed is the legacy tail', '/** publishComputed */', 'const x = 1']
    const out = stripComments(src.join('\n'))
    expect(out).not.toContain('publishComputed')
    expect(out).toContain('const x = 1')
  })

  it('keeps string literals intact (the placeholder IS a literal)', () => {
    expect(stripComments(`const p = '__local__'`)).toContain('__local__')
  })

  it('does not treat a URL // as a comment', () => {
    expect(stripComments(`const u = 'https://example.com/x'`)).toContain('example.com/x')
  })

  it('does not strip a comment-looking sequence inside a string', () => {
    expect(stripComments(`const s = "a // b"`)).toBe(`const s = "a // b"`)
    expect(stripComments(`const s = "a /* b */ c"`)).toBe(`const s = "a /* b */ c"`)
  })

  it('handles escaped quotes without desynchronising', () => {
    const src = `const s = 'it\\'s' // gone\nconst t = 1`
    const out = stripComments(src)
    expect(out).toContain(`const s = 'it\\'s'`)
    expect(out).not.toContain('gone')
    expect(out).toContain('const t = 1')
  })

  // A regex literal carrying a quote/backtick used to flip the scanner into
  // string state with no recovery, so EVERY comment below it survived as code
  // and was counted forever. Four real scanned files do this.
  it('does not desync on a regex literal containing a backtick', () => {
    // Verbatim shape of apps/server/src/steward.ts:87.
    const src = ['const t = x.replace(/`/g, "")', '// gone', 'const after = 1'].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('gone')
    expect(out).toContain('const after = 1')
  })

  it('does not desync on a regex literal containing a quote', () => {
    const src = [`const t = s.replace(/'/g, '')`, '// gone', 'const after = 1'].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('gone')
    expect(out).toContain('const after = 1')
  })

  it('does not desync on a nested template inside an interpolation', () => {
    // Verbatim shape of packages/agent-bridge/src/tmux.ts:11 (shellQuote).
    const src = ["const q = `'${s.replace(/'/g, `'\\''`)}'`", '// gone', 'const after = 1'].join(
      '\n',
    )
    const out = stripComments(src)
    expect(out).not.toContain('gone')
    expect(out).toContain('const after = 1')
  })

  it('treats division as division, not as a regex opener', () => {
    const src = ['const r = total / count', '// gone', 'const after = 1'].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('gone')
    expect(out).toContain('const after = 1')
    expect(out).toContain('total / count')
  })

  it('recognises a regex after a return keyword', () => {
    const src = ['function f() { return /a`b/.test(x) }', '// gone', 'const after = 1'].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('gone')
    expect(out).toContain('const after = 1')
  })

  it('handles a / inside a regex character class', () => {
    const src = ['const re = /[/`]/g', '// gone', 'const after = 1'].join('\n')
    const out = stripComments(src)
    expect(out).not.toContain('gone')
    expect(out).toContain('const after = 1')
  })
})

describe('isTestFile / isFrozenFile', () => {
  it('classifies test files', () => {
    expect(isTestFile('apps/web/src/app/ui-state.test.ts')).toBe(true)
    expect(isTestFile('apps/server/test/store.bun.test.ts')).toBe(true)
    expect(isTestFile('apps/server/src/store.ts')).toBe(false)
  })

  it('freezes migrations and generated files', () => {
    // Past migrations are immutable history; no phase issue can delete a
    // placeholder out of one, so counting them would pin the audit above zero.
    expect(isFrozenFile('apps/server/src/migrations/schema.ts')).toBe(true)
    expect(isFrozenFile('apps/server/src/migrations/drizzle-manifest.generated.ts')).toBe(true)
    expect(isFrozenFile('apps/server/src/store.ts')).toBe(false)
  })
})

describe('grep', () => {
  it('reports accurate file:line after comment stripping', () => {
    const ctx = ctxOf({
      'apps/server/src/a.ts': ['/* pad', '   pad */', 'funnel.publishComputed(x)'].join('\n'),
    })
    expect(grep(ctx, { roots: ['apps/server/src'], pattern: /\bpublishComputed\b/ })).toEqual([
      { file: 'apps/server/src/a.ts', line: 3, text: 'funnel.publishComputed(x)' },
    ])
  })

  it('skips tests and frozen files by default', () => {
    const ctx = ctxOf({
      'apps/server/src/a.test.ts': `const x = '__local__'`,
      'apps/server/src/migrations/schema.ts': `const y = '__local__'`,
      'apps/server/src/b.ts': `const z = '__local__'`,
    })
    const sites = grep(ctx, { roots: ['apps'], pattern: /__local__/ })
    expect(sites.map((s) => s.file)).toEqual(['apps/server/src/b.ts'])
  })

  it('honours a root that names a single file', () => {
    const ctx = ctxOf({
      'apps/server/src/router.ts': 'mods(ctx)',
      'apps/server/src/other.ts': 'mods(ctx)',
    })
    const sites = grep(ctx, { roots: ['apps/server/src/router.ts'], pattern: /\bmods\(/ })
    expect(sites.map((s) => s.file)).toEqual(['apps/server/src/router.ts'])
  })

  it('counts one site per matching line, not per occurrence', () => {
    const ctx = ctxOf({ 'apps/a.ts': 'mods(ctx); mods(ctx)' })
    expect(grep(ctx, { roots: ['apps'], pattern: /\bmods\(/ })).toHaveLength(1)
  })
})

describe('grepDistinctLiterals', () => {
  it('dedupes by literal value across files', () => {
    const ctx = ctxOf({
      'apps/web/src/a.ts': `const a = 'podium.view'`,
      'apps/web/src/b.ts': `const b = 'podium.view'\nconst c = 'podium.theme.mode'`,
    })
    const sites = grepDistinctLiterals(ctx, {
      roots: ['apps/web/src'],
      pattern: /'podium\.[\w.]*'/,
      literal: /'(podium\.[\w.]*)'/,
    })
    expect(sites.map((s) => s.text)).toEqual(['podium.view', 'podium.theme.mode'])
  })
})

// ---------------------------------------------------------------------------
// Inventory rules — each pinned by the shape it must and must not match.
// ---------------------------------------------------------------------------

function countOf(ctx: AuditContext, id: string): number {
  const check = CHECKS.find((c) => c.id === id)
  if (!check) throw new Error(`no such check: ${id}`)
  return check.collect(ctx).length
}

describe('inventory checks', () => {
  it('every check maps to a phase issue and declares its unit', () => {
    for (const c of CHECKS) {
      expect(c.phase, c.id).toMatch(/^POD-\d+$/)
      expect(c.unit.length, c.id).toBeGreaterThan(0)
      expect(c.title.length, c.id).toBeGreaterThan(0)
    }
  })

  it('check ids are unique', () => {
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length)
  })

  it('agent-kind-enums counts redeclarations but not the canonical one or an alias', () => {
    const ctx = ctxOf({
      // Canonical home — never counted.
      'packages/model/src/entities/agent.ts': `export const HarnessAgent = z.enum(['codex'])`,
      // A true redeclaration (the drift risk).
      'packages/runtime/src/settings.ts': `export const HarnessAgent = z.enum(['codex'])`,
      // An alias re-using the canonical enum is the GOOD pattern, not debt.
      'packages/agent-bridge/src/discovery/types.ts': `export type AgentKind = HarnessAgent`,
    })
    const sites = CHECKS.find((c) => c.id === 'agent-kind-enums')?.collect(ctx) ?? []
    expect(sites.map((s) => s.file)).toEqual(['packages/runtime/src/settings.ts'])
  })

  it('reexport-shims flags app tombstones but never a package barrel', () => {
    const ctx = ctxOf({
      'apps/web/src/lib/home.ts': `export { home } from '@podium/client-core'`,
      'packages/protocol/src/messages/index.ts': `export * from './approvals'`,
      'packages/protocol/src/index.ts': `export * from './messages'`,
      // Not a shim: has real code alongside the re-export.
      'apps/web/src/lib/real.ts': `export { a } from './a'\nexport const b = 1`,
    })
    const sites = CHECKS.find((c) => c.id === 'reexport-shims')?.collect(ctx) ?? []
    expect(sites.map((s) => s.file)).toEqual(['apps/web/src/lib/home.ts'])
  })

  // A per-LINE predicate missed these: no single line carries both `export` and
  // `from`. Biome (lineWidth 100) wraps a re-export as soon as a name is added,
  // so the count would DROP and the ratchet would record a phantom deletion.
  it('reexport-shims sees a wrapped multi-line re-export', () => {
    const ctx = ctxOf({
      'apps/web/src/app/optimistic-spawn.ts': [
        '/** Re-export shim (arch-v2 P3). */',
        'export {',
        '  mergeOptimistic,',
        '  type OptimisticSpawnArgs,',
        "} from '@podium/client-core/viewmodels'",
      ].join('\n'),
    })
    const sites = CHECKS.find((c) => c.id === 'reexport-shims')?.collect(ctx) ?? []
    expect(sites.map((s) => s.file)).toEqual(['apps/web/src/app/optimistic-spawn.ts'])
  })

  it('reexport-shims count does not move when a re-export is reformatted', () => {
    const oneLine = ctxOf({ 'apps/a.ts': `export { a, b } from './x'` })
    const wrapped = ctxOf({ 'apps/a.ts': `export {\n  a,\n  b,\n} from './x'` })
    const check = CHECKS.find((c) => c.id === 'reexport-shims')
    expect(check?.collect(oneLine).length).toBe(check?.collect(wrapped).length)
  })

  it('router-triple-access counts the longhand reach-through, not just mods()', () => {
    // mods(ctx) IS `ctx.modules ?? ctx.registry.modules` (trpc.ts:41), so keying
    // on the helper name alone would read an inlining codemod as ~119 deletions.
    const ctx = ctxOf({
      'apps/server/src/router.ts': [
        'mods(ctx).sessions.list()',
        'ctx.registry.modules.rpc.scanRepos([])',
        'const s = sessionStore',
      ].join('\n'),
    })
    expect(countOf(ctx, 'router-triple-access')).toBe(3)
  })

  it('send-turn-duplicate ERRORS when its anchor stops matching', () => {
    // `[].slice(1)` is `[]` — a broken detector would otherwise report 0 and
    // `--phase POD-313` would print "clear to close" with both procedures live.
    const broken = ctxOf({ 'apps/server/src/router.ts': 'nothing resembling the anchor' })
    const check = CHECKS.find((c) => c.id === 'send-turn-duplicate')
    expect(() => check?.collect(broken)).toThrow(/matched nothing/)
  })

  it('capability-tables counts a module-private table but not the web icon map', () => {
    const ctx = ctxOf({
      'packages/protocol/src/messages/terminal.ts':
        'export const AGENT_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {}',
      // No `export` — drifts identically, still debt.
      'apps/server/src/private.ts': 'const RESUME: Record<HarnessAgent, string> = {}',
      // Same shape, different concern: a UI icon map is not a harness capability.
      'apps/web/src/lib/WorkerLabel.tsx': 'const KIND_ICON: Record<AgentKind, IconComponent> = {}',
    })
    const sites = CHECKS.find((c) => c.id === 'capability-tables')?.collect(ctx) ?? []
    expect(sites.map((s) => s.file).sort()).toEqual([
      'apps/server/src/private.ts',
      'packages/protocol/src/messages/terminal.ts',
    ])
  })

  it('sync/async twins match only a blocking fn that HAS an async twin', () => {
    const ctx = ctxOf({
      'packages/agent-bridge/src/tmux.ts': [
        'export function tmuxHasSession(l) {}',
        'export async function tmuxHasSessionAsync(l) {}',
        // No twin — a lone sync function is not this item.
        'export function onlySync(l) {}',
        // Node-builtin-style name without a twin must not false-positive.
        'export function readFileSync(l) {}',
      ].join('\n'),
    })
    const sites = CHECKS.find((c) => c.id === 'durable-host-sync-async-twins')?.collect(ctx) ?? []
    expect(sites.map((s) => s.text)).toEqual(['export function tmuxHasSession(l) {}'])
  })

  it('send-turn-duplicate counts the redundant alias, not the real entry', () => {
    const one = ctxOf({
      'apps/server/src/router.ts': `sendTurn: t.procedure.mutation(({ ctx, input }) => ctx.superagent.sendTurn(input)),`,
    })
    expect(countOf(one, 'send-turn-duplicate')).toBe(0)

    const two = ctxOf({
      'apps/server/src/router.ts': [
        `sendTurn: t.procedure.mutation(({ ctx, input }) => ctx.superagent.sendTurn(input)),`,
        `send: t.procedure.mutation(({ ctx, input }) => ctx.superagent.sendTurn(input)),`,
      ].join('\n'),
    })
    expect(countOf(two, 'send-turn-duplicate')).toBe(1)
  })

  it('change-row-typings counts a schema + its inferred type once', () => {
    const ctx = ctxOf({
      'packages/protocol/src/messages/sync.ts': [
        `export const MetadataChange = z.discriminatedUnion('entity', [])`,
        `export type MetadataChange = z.infer<typeof MetadataChange>`,
        `export const UnknownMetadataChange = z.object({})`,
      ].join('\n'),
    })
    expect(countOf(ctx, 'change-row-typings')).toBe(2)
  })

  it('static-systemd-units counts unit files only', () => {
    const ctx = ctxOf({}, { 'scripts/systemd': ['README.md', 'a.service', 'b.timer', 'c.path'] })
    expect(countOf(ctx, 'static-systemd-units')).toBe(3)
  })

  it('composition-root forward refs match `let x!: T`, not a plain lazy local', () => {
    const ctx = ctxOf({
      'apps/server/src/server.ts': [
        '  let messaging!: MessagingService',
        '  let webDir = process.env.PODIUM_WEB_DIR',
      ].join('\n'),
    })
    expect(countOf(ctx, 'composition-root-forward-refs')).toBe(1)
  })

  it('state-dir-defs ignores the canonical home', () => {
    const ctx = ctxOf({
      'packages/runtime/src/config.ts': 'export function stateDir(): string {}',
    })
    expect(countOf(ctx, 'state-dir-defs')).toBe(0)
    const drifted = ctxOf({
      'packages/runtime/src/config.ts': 'export function stateDir(): string {}',
      'apps/server/src/paths.ts': 'export function stateDir(): string {}',
    })
    expect(countOf(drifted, 'state-dir-defs')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Ratchet
// ---------------------------------------------------------------------------

function resultsOf(counts: Record<string, number>): AuditResult[] {
  return Object.entries(counts).map(([id, count]) => ({
    id,
    title: id,
    phase: 'POD-1',
    unit: 'x',
    count,
    sites: [],
  }))
}

describe('diffBaseline', () => {
  it('passes when counts match exactly', () => {
    const d = diffBaseline(resultsOf({ a: 3 }), { a: 3 })
    expect(d).toEqual({ regressions: [], improvements: [], unknown: [], stale: [] })
  })

  it('flags a growth as a regression', () => {
    const d = diffBaseline(resultsOf({ a: 4 }), { a: 3 })
    expect(d.regressions).toEqual([{ id: 'a', baseline: 3, count: 4 }])
    expect(d.improvements).toEqual([])
  })

  it('flags a decrease as an improvement to be locked in', () => {
    const d = diffBaseline(resultsOf({ a: 2 }), { a: 3 })
    expect(d.improvements).toEqual([{ id: 'a', baseline: 3, count: 2 }])
    expect(d.regressions).toEqual([])
  })

  it('reports a new check missing from the baseline', () => {
    expect(diffBaseline(resultsOf({ a: 1, b: 2 }), { a: 1 }).unknown).toEqual(['b'])
  })

  it('reports a baseline entry whose check is gone', () => {
    expect(diffBaseline(resultsOf({ a: 1 }), { a: 1, gone: 0 }).stale).toEqual(['gone'])
  })

  it('baselineOf round-trips through diffBaseline cleanly', () => {
    const results = resultsOf({ a: 3, b: 0 })
    const d = diffBaseline(results, baselineOf(results))
    expect(d.regressions).toHaveLength(0)
    expect(d.improvements).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The CLI contract. The phase-close rule (docs/rearch-deletion-audit.md, and
// the migration ledger's §3.2) is an EXIT CODE, so the argument handling is the
// load-bearing part — and it was previously covered only by code-reading. This
// repo has shipped a fail-OPEN gate twice (`git rev-parse` echoes unknown flags
// and exits 0, which defeated POD-657 and POD-665 independently), so these
// assert the codes against the real binary rather than trusting main().
// ---------------------------------------------------------------------------

describe('CLI exit codes', () => {
  const script = new URL('./rearch-audit.ts', import.meta.url).pathname

  /** Run the audit for real; returns its exit code (never throws on non-zero). */
  function run(args: string[]): number {
    const r = spawnSync('bun', [script, ...args], { encoding: 'utf8' })
    if (r.error) throw r.error
    return r.status ?? -1
  }

  it('exits 0 when the tree matches the committed baseline', () => {
    expect(run([])).toBe(0)
  })

  it('fails CLOSED on an unknown flag rather than silently running the ratchet', () => {
    // A typo'd `--updatebaseline` that quietly exits 0 having updated nothing is
    // the worst outcome this tool can produce: it looks like it worked.
    expect(run(['--updatebaseline'])).toBe(2)
    expect(run(['--phasee', 'POD-309'])).toBe(2)
    expect(run(['--json', '--bogus'])).toBe(2)
  })

  it('fails CLOSED on a malformed or missing phase argument', () => {
    expect(run(['--phase'])).toBe(2)
    expect(run(['--phase', 'notaphase'])).toBe(2)
    expect(run(['--phase', '297'])).toBe(2)
  })

  it('fails CLOSED on a well-formed phase that maps to no items', () => {
    // Must never read as "clear to close" just because nothing matched.
    expect(run(['--phase', 'POD-999'])).toBe(2)
  })

  it('refuses --phase together with --update-baseline', () => {
    expect(run(['--phase', 'POD-309', '--update-baseline'])).toBe(2)
  })

  it('gates a phase whose items are still alive', () => {
    expect(run(['--phase', 'POD-309'])).toBe(1)
  })

  it('an output flag cannot disable the gate', () => {
    // `--phase X --json` exited 0 with 119 live sites before this was fixed:
    // the format must never decide whether the gate holds.
    expect(run(['--phase', 'POD-314', '--json'])).toBe(1)
    expect(run(['--phase', 'POD-314', '--sites'])).toBe(1)
  })

  it('an output flag cannot swallow the baseline write', () => {
    // `--json --update-baseline` used to exit 0 having written NOTHING: --json
    // returned first. Actions must run before reports.
    const file = new URL('./rearch-audit-baseline.json', import.meta.url).pathname
    const original = readFileSync(file, 'utf8')
    try {
      writeFileSync(file, original.replace(/"publish-computed-fanout": \d+/, '"x-planted": 99'))
      expect(run(['--json', '--update-baseline'])).toBe(0)
      expect(readFileSync(file, 'utf8')).not.toContain('x-planted')
      expect(readFileSync(file, 'utf8')).toContain('publish-computed-fanout')
    } finally {
      writeFileSync(file, original)
    }
  })
})

// ---------------------------------------------------------------------------
// Live repo: the audit must actually bind to this codebase.
// ---------------------------------------------------------------------------

describe('against the live repo', () => {
  const repoRoot = new URL('..', import.meta.url).pathname
  const results = runAudit(loadContext(repoRoot))

  it('every check still binds to a real anchor', () => {
    // A check that silently stops matching (a rename, a moved file) would read
    // as "deleted!" and let the phase close on a false zero. Items that are
    // legitimately at zero are listed here as deliberate regression guards.
    // agent-kind-enums reached zero at POD-300: @podium/model's
    // entities/agent.ts is now the single declaration of AgentKind AND
    // HarnessAgent, and packages/runtime re-exports it rather than keeping its
    // own identical z.enum copy. The detector stays as a regression guard.
    // POD-368's six items are all legitimately at zero, and for them a count is
    // the WRONG anchor: the whole point of the redefinition is that a zero means
    // "every restatement is accounted for", which is a state this repo has now
    // reached. Their anchor is asserted separately below, against the population
    // the detector parses rather than against the subset it reports — so a
    // detector that stopped matching still reds.
    const ZERO_BY_DESIGN = new Set([
      'state-dir-defs',
      'agent-kind-enums',
      'session-shapes',
      'issue-shapes',
      'representation-registry-rot',
      'capability-snapshots',
      'instance-partitions',
    ])
    for (const r of results) {
      if (ZERO_BY_DESIGN.has(r.id)) continue
      expect(
        r.count,
        `${r.id} matched nothing — detector drift, or genuinely deleted?`,
      ).toBeGreaterThan(0)
    }
  })

  it('the redefined vocabulary detector still binds to the live tree', () => {
    // The anchor for the six zero-by-design items above. `session-shapes` and
    // `issue-shapes` report only the UNACCOUNTED-FOR subset, so their zero is a
    // success — but a broken parser or an empty vocabulary would produce the same
    // zero. This asserts the population, which cannot be zero while the repo has
    // any entity-shaped declaration at all.
    const declarations = entityShapedDeclarations(loadContext(repoRoot))
    expect(declarations.length, 'the detector parsed NO entity-shaped declaration').toBeGreaterThan(
      20,
    )
    expect(SESSION_VOCABULARY.size, 'session vocabulary loaded empty').toBeGreaterThan(30)
    expect(ISSUE_VOCABULARY.size, 'issue vocabulary loaded empty').toBeGreaterThan(30)
    // And the registry it is checked against is non-empty, so
    // `representation-registry-rot`'s zero means "nothing rotted", not "nothing
    // to check".
    expect(RETAINED_REPRESENTATIONS.length).toBe(43)
  })

  it('reports real files for every site', () => {
    for (const r of results) {
      for (const s of r.sites) {
        expect(s.line, `${r.id} ${s.file}`).toBeGreaterThan(0)
        expect(s.file.length, r.id).toBeGreaterThan(0)
      }
    }
  })

  it('maps every item to a phase issue in the rewrite plan', () => {
    const phases = new Set(results.map((r) => r.phase))
    for (const p of phases) expect(p).toMatch(/^POD-\d+$/)
  })
})
