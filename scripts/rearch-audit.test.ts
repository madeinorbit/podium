import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PER_USER_STATE_KEYS } from '../packages/model/src/aggregates/registry'
import { RETAINED_REPRESENTATIONS } from '../packages/model/src/representations/registry'
import { entityIdSites, MIN_ID_FIELD_SITES } from './entity-id-audit'
import { CHANGE_ROW_KEYS } from './change-row-audit'
import {
  type AuditContext,
  type AuditResult,
  baselineOf,
  CHECKS,
  DAEMON_COMPOSITION_ROOT,
  DAEMON_COMPOSITION_ROOT_MAX_LINES,
  diffBaseline,
  grep,
  grepDistinctLiterals,
  isFrozenFile,
  isTestFile,
  loadContext,
  phaseCloseItems,
  PUBLISH_COMPUTED_CONTROLS,
  PUBLISH_COMPUTED_PATTERN,
  publishComputedControlMisses,
  REGISTERED_RESIDUE,
  runAudit,
  type SourceFile,
  stripComments,
  UPSTREAM_RETIREMENT_CONTROLS,
  UPSTREAM_RETIREMENT_PATTERN,
  upstreamRetirementControlMisses,
} from './rearch-audit'
import {
  entityShapedDeclarations,
  ISSUE_VOCABULARY,
  physicalTableColumns,
  SESSION_VOCABULARY,
} from './representation-audit'

/** A context over in-memory sources, so the rule tests never touch the repo. */
function ctxOf(files: Record<string, string>, dirs: Record<string, string[]> = {}): AuditContext {
  const srcs: SourceFile[] = Object.entries(files).map(([file, source]) => ({
    file,
    stripped: stripComments(source),
    isTest: isTestFile(file),
  }))
  return { repoRoot: '/repo', files: srcs, listDir: (rel) => dirs[rel] ?? [] }
}

describe('registered residue', () => {
  it('pins every expiring issue residue site to live production code', () => {
    const registeredFiles = [
      ...new Set(REGISTERED_RESIDUE.flatMap((entry) => entry.sites.map((site) => site.file))),
    ]
    const live = ctxOf(
      Object.fromEntries(registeredFiles.map((file) => [file, readFileSync(file, 'utf8')])),
    )
    for (const residue of REGISTERED_RESIDUE) {
      for (const site of residue.sites) {
        const source = live.files.find((file) => file.file === site.file)?.stripped
        expect(source, site.file).toContain(site.needle)

        if (residue.auditItem) {
          const item = CHECKS.find((check) => check.id === residue.auditItem)
          expect(item, `${residue.id} names a missing audit item`).toBeDefined()
          expect(
            item
              ?.collect(live)
              .some((actual) => actual.file === site.file && actual.text.includes(site.needle)),
            `${residue.id} does not declare an exact counted site`,
          ).toBe(true)
        }
      }
    }
  })

  it('an undeclared new residue site still fails the phase gate', () => {
    const expected: AuditResult = {
      id: 'legacy-heals',
      title: 'Legacy heals',
      phase: 'POD-1',
      unit: 'method declaration',
      count: 1,
      sites: [{ file: 'apps/server/src/store.ts', line: 10, text: 'expectedHeal(): void {' }],
    }
    const declared = [
      {
        id: 'expected-heal',
        auditItem: 'legacy-heals',
        owner: 'POD-2',
        expiry: 'when old rows age out',
        note: 'Required for the supported upgrade path.',
        sites: [{ file: 'apps/server/src/store.ts', needle: 'expectedHeal(): void {' }],
      },
    ]

    expect(phaseCloseItems('POD-1', [expected], declared)[0]?.undeclaredSites).toEqual([])

    const withNewSite: AuditResult = {
      ...expected,
      count: 2,
      sites: [
        ...expected.sites,
        { file: 'apps/server/src/store.ts', line: 20, text: 'expectedHeal(): void {' },
      ],
    }
    expect(phaseCloseItems('POD-1', [withNewSite], declared)[0]?.undeclaredSites).toEqual([
      { file: 'apps/server/src/store.ts', line: 20, text: 'expectedHeal(): void {' },
    ])
  })
})

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
    // Verbatim shape of packages/pty/src/tmux.ts:11 (shellQuote).
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

  it('freezes the migration HISTORY and generated files, but not live migration source', () => {
    // Past migrations are immutable history; no phase issue can delete a
    // placeholder out of one, so counting them would pin the audit above zero.
    // That reason applies to the timestamped SQL under drizzle/ — and NOT to the
    // rest of migrations/, which is live editable source.
    expect(isFrozenFile('apps/server/src/migrations/drizzle/20260715135845_baseline/x.sql')).toBe(
      true,
    )
    expect(isFrozenFile('apps/server/src/migrations/drizzle-manifest.generated.ts')).toBe(true)

    // POD-1166: schema.ts declares all 57 physical tables and MUST be audited.
    // Freezing it made an instance_id column on `sessions` invisible to every
    // detector here, so ADR 1 D5 had no enforcement where a tenant partition
    // would actually be introduced. Unfreezing it also revealed three real
    // `__local__` column defaults the placeholder ratchet had never counted.
    expect(isFrozenFile('apps/server/src/migrations/schema.ts')).toBe(false)
    expect(isFrozenFile('apps/server/src/migrations/applier.ts')).toBe(false)

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

  it('skips tests and the frozen migration history, but reads live migration source', () => {
    const ctx = ctxOf({
      'apps/server/src/a.test.ts': `const x = '__local__'`,
      // Frozen: immutable SQL history under drizzle/.
      'apps/server/src/migrations/drizzle/20260715135845_baseline/up.ts': `const w = '__local__'`,
      // NOT frozen since POD-1166: live source that happens to sit in migrations/.
      'apps/server/src/migrations/schema.ts': `const y = '__local__'`,
      'apps/server/src/b.ts': `const z = '__local__'`,
    })
    const sites = grep(ctx, { roots: ['apps'], pattern: /__local__/ })
    // schema.ts is READ; the timestamped history and the test file are skipped.
    expect(sites.map((s) => s.file).sort()).toEqual([
      'apps/server/src/b.ts',
      'apps/server/src/migrations/schema.ts',
    ])
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
      'packages/harness/src/discovery/types.ts': `export type AgentKind = HarnessAgent`,
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
    // POD-383: BOTH homes must miss before it throws — the router (where the
    // procedure was) and the joined table (where the surviving call now lives).
    const broken = ctxOf({ 'apps/server/src/router.ts': 'nothing resembling the anchor' })
    const check = CHECKS.find((c) => c.id === 'send-turn-duplicate')
    expect(() => check?.collect(broken)).toThrow(/neither anchor matched/)
  })

  it('per-user-singletons ERRORS when its control stops matching', () => {
    // The exemption above is only honest if the guard it cites actually fires.
    // Emptying PER_USER_STATE_KEYS is the cheapest way to make this detector
    // report a serene zero — it is a plain array, one deletion away — and from
    // zero that is indistinguishable from the clean tree POD-1229 left.
    const keys = PER_USER_STATE_KEYS as unknown as string[]
    const saved = keys.splice(0, keys.length)
    try {
      const check = CHECKS.find((c) => c.id === 'per-user-singletons')
      expect(() => check?.collect(ctxOf({}))).toThrow(/PER_USER_STATE_KEYS loaded EMPTY/)
    } finally {
      keys.push(...saved)
    }
    // And it says YES again once restored, so the throw above is the guard
    // firing rather than the detector being permanently broken.
    expect(() =>
      CHECKS.find((c) => c.id === 'per-user-singletons')?.collect(ctxOf({})),
    ).not.toThrow()
  })

  it('per-user-singletons still COUNTS the shape POD-1229 deleted', () => {
    // The live zero means "this shape is gone", so the detector has to be shown
    // finding it. This is the observation exactly as it read before POD-1229.
    const ctx = ctxOf({
      'packages/protocol/src/maintenance.ts': [
        'export const IssueAutoArchiveObservation = z.object({',
        '  issueId: z.string().min(1).max(256).pipe(IssueIdField),',
        '  stage: z.string().min(1).max(64),',
        '  closedReason: z.string().nullable(),',
        '  readAt: z.string().datetime(),',
        '  archived: z.literal(false),',
        '  deletedAt: z.null(),',
        '})',
      ].join('\n'),
    })
    const sites = CHECKS.find((c) => c.id === 'per-user-singletons')?.collect(ctx) ?? []
    expect(sites.map((s) => s.text)).toEqual(['IssueAutoArchiveObservation.readAt'])
  })

  it('capability-tables counts a module-private table but not the web icon map', () => {
    const ctx = ctxOf({
      'packages/protocol/src/messages/terminal.ts':
        'export const AGENT_CAPABILITIES: Record<AgentKind, AgentCapabilities> = {}',
      // No `export` — drifts identically, still debt.
      'apps/server/src/private.ts': 'const RESUME: Record<HarnessAgent, string> = {}',
      'packages/harness/src/registry.ts':
        'export const AGENT_MANIFESTS: Record<BuiltinHarnessKind, AgentManifest> = {}',
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
      'packages/pty/src/tmux.ts': [
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

  /**
   * POD-383 moved the surviving call into the joined table when the router
   * became derived. The detector must count an alias in its NEW home too —
   * otherwise re-adding `send:` as a second table key would read as zero, which
   * is the exact shape of failure POD-1180 records.
   */
  it('send-turn-duplicate counts an alias re-added to the joined table', () => {
    const derived = ctxOf({
      'apps/server/src/modules/superagent/registry.ts': [
        `  sendTurn: { contract: C.sendTurn, handler: (s: S, input: I) => s.sendTurn(input) },`,
      ].join('\n'),
    })
    expect(countOf(derived, 'send-turn-duplicate')).toBe(0)

    const aliased = ctxOf({
      'apps/server/src/modules/superagent/registry.ts': [
        `  sendTurn: { contract: C.sendTurn, handler: (s: S, input: I) => s.sendTurn(input) },`,
        `  send: { contract: C.send, handler: (s: S, input: I) => s.sendTurn(input) },`,
      ].join('\n'),
    })
    expect(countOf(aliased, 'send-turn-duplicate')).toBe(1)
  })

  // REDEFINED at POD-305: the item counts hand-restated change-row FIELD LISTS,
  // not exported names. The old assertion here was that a schema and its
  // inferred type counted once — a fact about the NAME-counting detector, which
  // reported the same number whether the field lists below were written out or
  // composed away. See scripts/change-row-audit.test.ts for the detector's own
  // suite, which plants every spelling of a restatement.
  it('change-row-typings counts restated field lists, not exported names', () => {
    const ctx = ctxOf({
      'packages/protocol/src/messages/sync.ts': [
        `export const A = z.object({ seq: z.number(), entity: z.literal('x'), id: z.string(), op: MetadataChangeOp })`,
        `export const B = z.object({ seq: z.number(), entity: z.literal('y'), id: z.string(), op: MetadataChangeOp })`,
      ].join('\n'),
    })
    expect(countOf(ctx, 'change-row-typings')).toBe(2)
  })

  it('change-row-typings does NOT count a construction site', () => {
    // The counterfactual that keeps the ratchet closable: a caller BUILDING a
    // change spec is a use of the shared type, and there are supposed to be many.
    const ctx = ctxOf({
      'apps/server/src/modules/issues/service/crud.ts': `const spec = { entity: 'issue', id: row.id, op: 'upsert', value: wire }`,
    })
    expect(countOf(ctx, 'change-row-typings')).toBe(0)
  })

  it('change-row-typings ERRORS when its control stops matching', () => {
    // POD-1251 drove the live count to zero. The ZERO_BY_DESIGN exemption is
    // only honest if the planted restatement CONTROL still fires — an emptied
    // CHANGE_ROW_KEYS is the cheapest way to make every score fail and turn
    // that control into a serene zero, which from zero is indistinguishable
    // from "the debt is gone".
    const keys = CHANGE_ROW_KEYS as Set<string>
    const saved = [...keys]
    keys.clear()
    try {
      const check = CHECKS.find((c) => c.id === 'change-row-typings')
      expect(() => check?.collect(ctxOf({}))).toThrow(/CHANGE_ROW_KEYS loaded EMPTY/)
    } finally {
      for (const k of saved) keys.add(k)
    }
    // And it says YES again once restored, so the throw above is the guard
    // firing rather than the detector being permanently broken.
    expect(() =>
      CHECKS.find((c) => c.id === 'change-row-typings')?.collect(ctxOf({})),
    ).not.toThrow()
  })

  it('static-systemd-units counts unit files only', () => {
    const ctx = ctxOf({}, { 'scripts/systemd': ['README.md', 'a.service', 'b.timer', 'c.path'] })
    expect(countOf(ctx, 'static-systemd-units')).toBe(3)
  })

  it('composition-root forward refs match `let x!: T`, not a plain lazy local', () => {
    const ctx = ctxOf({
      'apps/server/src/relay.ts': [
        '  let messaging!: MessagingService',
        '  let webDir = process.env.PODIUM_WEB_DIR',
      ].join('\n'),
    })
    expect(countOf(ctx, 'composition-root-forward-refs')).toBe(1)
  })

  it('oversized daemon root refuses line 301 and errors when its anchor disappears', () => {
    const source = (lines: number) =>
      `${Array.from({ length: lines }, (_, i) => `const x${i} = 0`).join('\n')}\n`
    expect(
      countOf(
        ctxOf({ [DAEMON_COMPOSITION_ROOT]: source(DAEMON_COMPOSITION_ROOT_MAX_LINES) }),
        'oversized-daemon-composition-root',
      ),
    ).toBe(0)
    expect(
      countOf(
        ctxOf({ [DAEMON_COMPOSITION_ROOT]: source(DAEMON_COMPOSITION_ROOT_MAX_LINES + 1) }),
        'oversized-daemon-composition-root',
      ),
    ).toBe(1)
    expect(() =>
      CHECKS.find((check) => check.id === 'oversized-daemon-composition-root')?.collect(ctxOf({})),
    ).toThrow(/was not scanned; the zero is unmeasured/)
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

  // BOTH directions of the phase gate, derived from the live audit rather than
  // hardcoded phase ids. The history of this case is the reason:
  //
  // - POD-309 used to be the "still live" subject; it retired its item and
  //   became the clear arm.
  // - POD-308 took over as the live subject; a re-phase emptied it and it
  //   became the clear arm.
  // - POD-1251 took over as the live subject; POD-1251 composed the last
  //   change-row restatement and the exit-1 arm went red with a correct zero
  //   (POD-1417).
  //
  // Hardcoding the next still-live phase would only postpone the same break.
  // Derive both arms from undeclared residue on this tree so the next phase
  // that finishes does not freeze this case red — and a single-direction
  // test still cannot distinguish a working gate from one that always exits 1.
  //
  // Each case launches full-tree audit processes; the full node lane can
  // saturate the 20s default.
  const fullLaneAuditTimeout = 40_000
  const repoRootForPhase = new URL('..', import.meta.url).pathname

  /** First phase with undeclared residue (must gate) and first clear phase. */
  function liveAndClearPhases(): { live: string; clear: string } {
    const results = runAudit(loadContext(repoRootForPhase))
    const phases = [...new Set(results.map((r) => r.phase))].sort()
    let live: string | undefined
    let clear: string | undefined
    for (const phase of phases) {
      const assessed = phaseCloseItems(phase, results)
      if (assessed.length === 0) continue
      const undeclared = assessed.reduce((n, item) => n + item.undeclaredSites.length, 0)
      if (undeclared > 0) live ??= phase
      else clear ??= phase
      if (live && clear) break
    }
    if (!live) {
      throw new Error(
        'phase-close test could not find any phase with undeclared residue — the gate has nothing to say NO about',
      )
    }
    if (!clear) {
      throw new Error(
        'phase-close test could not find any clear phase — both directions of the gate are unmeasured',
      )
    }
    return { live, clear }
  }

  it(
    'gates a phase whose items are still alive, and clears one that reached zero',
    () => {
      const { live, clear } = liveAndClearPhases()
      expect(run(['--phase', live])).toBe(1)
      expect(run(['--phase', clear])).toBe(0)
    },
    fullLaneAuditTimeout,
  )

  it(
    'an output flag cannot disable the gate',
    () => {
      // `--phase X --json` exited 0 with 119 live sites before this was fixed:
      // the format must never decide whether the gate holds. The subject phase
      // is derived (see liveAndClearPhases) so a finished phase cannot freeze
      // this case on a correct zero the way POD-1251 did.
      const { live } = liveAndClearPhases()
      expect(run(['--phase', live, '--json'])).toBe(1)
      expect(run(['--phase', live, '--sites'])).toBe(1)
    },
    fullLaneAuditTimeout,
  )

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

/**
 * THE GUARD BEHIND `upstream-sync-forwarder`'s ZERO_BY_DESIGN EXEMPTION (POD-309).
 *
 * The exemption removes the only assertion that was watching this detector, so the
 * detector has to watch itself — and this suite is what watches THAT. It exists because
 * the guard was written once and then silently reverted by an over-broad `git checkout --`
 * while a hand-run mutant was being cleaned up: the audit still exited 0, the exemption
 * still read as earned, and nothing anywhere went red. A guard whose only evidence is a
 * mutant somebody ran once is a guard with no evidence a week later.
 *
 * EACH CONTROL IS PROVEN LOAD-BEARING SEPARATELY, which is POD-308's finding applied here:
 * two controls that can only ever fail together are one control wearing two names. Each
 * case below breaks ONE branch of the pattern and asserts that EXACTLY the controls
 * covering that branch are reported — so a control that could never fail on its own shows
 * up as a case that cannot be made to fail.
 */
describe('upstream-sync-forwarder: the anchor behind its ZERO_BY_DESIGN exemption', () => {
  const DECL = UPSTREAM_RETIREMENT_CONTROLS.declaration
  const CONS = UPSTREAM_RETIREMENT_CONTROLS.construction

  it('the SHIPPED pattern matches every control — the positive, first', () => {
    // Without this, every "breaking X reports Y" case below is satisfiable by a pattern
    // that matches nothing at all.
    expect(upstreamRetirementControlMisses(UPSTREAM_RETIREMENT_PATTERN.source)).toEqual([])
    expect([...DECL, ...CONS]).toHaveLength(4)
  })

  it('losing the DECLARATION branch reports exactly its two controls', () => {
    const constructionOnly = 'new (?:UpstreamSync|UpstreamForwarder)\\s*\\('
    expect(upstreamRetirementControlMisses(constructionOnly).sort()).toEqual([...DECL].sort())
  })

  it('losing the CONSTRUCTION branch reports exactly its two controls', () => {
    const declarationOnly = '^export class (?:UpstreamSync|UpstreamForwarder)\\b'
    expect(upstreamRetirementControlMisses(declarationOnly).sort()).toEqual([...CONS].sort())
  })

  // Within a branch the two NAMES are independent too — dropping one alternative must
  // report one control, not zero and not both.
  it('losing one NAME inside a branch reports exactly that one control', () => {
    const noForwarderDecl =
      '^export class UpstreamSync\\b|new (?:UpstreamSync|UpstreamForwarder)\\s*\\('
    expect(upstreamRetirementControlMisses(noForwarderDecl)).toEqual([
      'export class UpstreamForwarder {',
    ])
    const noSyncConstruction =
      '^export class (?:UpstreamSync|UpstreamForwarder)\\b|new UpstreamForwarder\\s*\\('
    expect(upstreamRetirementControlMisses(noSyncConstruction)).toEqual([
      'const f = new UpstreamSync({})',
    ])
  })

  it('a pattern that matches nothing reports ALL FOUR, not the first', () => {
    // The throw has to name which half of the regex died, so the function returns every
    // miss. A first-miss-wins implementation passes the two branch cases above and fails
    // exactly here.
    expect(upstreamRetirementControlMisses('zzz-matches-nothing')).toHaveLength(4)
  })

  it('collect THROWS on a context whose roots match no files', () => {
    const check = CHECKS.find((c) => c.id === 'upstream-sync-forwarder')
    expect(check).toBeDefined()
    // The positive first: a context WITH files under the roots must not throw, or this
    // case would pass against a collect that throws unconditionally.
    expect(() => check?.collect(ctxOf({ 'apps/server/src/a.ts': 'const x = 1' }))).not.toThrow()
    expect(() => check?.collect(ctxOf({ 'docs/elsewhere.ts': 'const x = 1' }))).toThrow(
      /scanning nothing/,
    )
  })

  it('collect still FINDS a re-grown forwarder — the anchor did not replace the detector', () => {
    const check = CHECKS.find((c) => c.id === 'upstream-sync-forwarder')
    const sites = check?.collect(
      ctxOf({
        'packages/sync/src/upstream-forwarder.ts': 'export class UpstreamForwarder {}',
        'apps/server/src/server.ts': 'const f = new UpstreamSync({})',
      }),
    )
    expect(sites?.map((s) => s.file).sort()).toEqual([
      'apps/server/src/server.ts',
      'packages/sync/src/upstream-forwarder.ts',
    ])
  })
})

/**
 * THE GUARD BEHIND `publish-computed-fanout`'s ZERO_BY_DESIGN EXEMPTION (POD-1203).
 *
 * Same shape and same reason as the suite above: the exemption removes the only
 * assertion watching this detector, so the detector watches itself and this
 * watches THAT. Each control is proven load-bearing SEPARATELY — two controls
 * that can only fail together are one control wearing two names.
 *
 * The controls are the real deleted lines, copied from the diff that deleted
 * them: a call site (`funnel.publishComputed(spec.snapshot)`) and the
 * composition-root wiring (`fanOutSnapshot: … => sessionsSvc.fanOutSnapshot(…)`).
 * A detector that no longer recognises the code it was written to find is broken,
 * whatever its count says.
 */
describe('publish-computed-fanout: the anchor behind its ZERO_BY_DESIGN exemption', () => {
  it('the SHIPPED pattern matches every control — the positive, first', () => {
    // Without this, every "breaking X reports Y" case below is satisfiable by a
    // pattern that matches nothing at all.
    expect(publishComputedControlMisses(PUBLISH_COMPUTED_PATTERN.source)).toEqual([])
    expect(PUBLISH_COMPUTED_CONTROLS).toHaveLength(2)
  })

  it('losing the publishComputed branch reports exactly its control', () => {
    expect(publishComputedControlMisses('\\bfanOutSnapshot\\b')).toEqual([
      'this.deps.funnel.publishComputed(spec.snapshot)',
    ])
  })

  it('losing the fanOutSnapshot branch reports exactly its control', () => {
    expect(publishComputedControlMisses('\\bpublishComputed\\b')).toEqual([
      'fanOutSnapshot: (snapshot, opts) => sessionsSvc.fanOutSnapshot(snapshot, opts),',
    ])
  })

  it('a pattern that matches nothing reports BOTH, not the first', () => {
    // A first-miss-wins implementation passes both branch cases above and fails
    // exactly here.
    expect(publishComputedControlMisses('zzz-matches-nothing')).toHaveLength(2)
  })

  it('collect THROWS on a context whose roots match no files', () => {
    const check = CHECKS.find((c) => c.id === 'publish-computed-fanout')
    expect(check).toBeDefined()
    // The positive first, or this passes against a collect that always throws.
    expect(() => check?.collect(ctxOf({ 'apps/server/src/a.ts': 'const x = 1' }))).not.toThrow()
    expect(() => check?.collect(ctxOf({ 'docs/elsewhere.ts': 'const x = 1' }))).toThrow(
      /scanning nothing/,
    )
  })

  it('collect still FINDS a re-grown snapshot tail — the anchor did not replace the detector', () => {
    const check = CHECKS.find((c) => c.id === 'publish-computed-fanout')
    const sites = check?.collect(
      ctxOf({
        'apps/server/src/modules/funnel.ts': 'publishComputed(snapshot) {}',
        'apps/server/src/modules/sessions/lifecycle.ts': 'fanOutSnapshot(snapshot) {}',
      }),
    )
    expect(sites?.map((s) => s.file).sort()).toEqual([
      'apps/server/src/modules/funnel.ts',
      'apps/server/src/modules/sessions/lifecycle.ts',
    ])
  })
})

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
      // This issue deleted the last router -> context -> registry reach-through.
      // The synthetic detector test above remains its positive anchor.
      'router-triple-access',
      'capability-snapshots',
      'instance-partitions',
      // POD-398 folded every static row into the canonical per-CLI manifests.
      // The fixture test above remains the detector anchor: it proves both a
      // protocol export and a module-private server table are still counted,
      // while the canonical manifest registry itself is deliberately excluded.
      'capability-tables',
      // POD-383 deleted `superagent.send`, so ONE procedure now forwards to
      // `sendTurn` and N-1 is zero — the item's target state. It is safe to
      // exempt here, and only here, because this detector carries its OWN
      // anchor guard: `collect` THROWS when neither of its two homes matches
      // (asserted above, 'send-turn-duplicate ERRORS when its anchor stops
      // matching'), so detector drift reds loudly instead of reading as a
      // deletion. An item without that guard must not be added to this list.
      'send-turn-duplicate',
      // POD-301 drove it to zero. Exempt here on the SAME condition
      // `send-turn-duplicate` is: this detector carries its own anchor guard —
      // `entityIdSites` THROWS when the population it parses falls below
      // MIN_ID_FIELD_SITES, so a scan that stopped matching reds loudly instead
      // of reading as a deletion. The anchor is asserted directly in
      // 'the entity-id detector still binds to the live tree' below, against
      // the population rather than the subset it reports.
      'raw-string-entity-ids',
      // POD-309 retired UpstreamSync/UpstreamForwarder: 4 → 0, all VANISHED (no file in
      // the repo declares or constructs either, and a destination grep finds no code
      // home). Exempt on the same terms as `send-turn-duplicate` and no looser — its
      // `collect` THROWS when its anchor stops matching. Having no surviving code to
      // anchor on, it anchors on its own scan instead: it throws when its roots match no
      // files, and when its pattern stops matching the four control strings it is
      // supposed to match. Both are asserted below, so an item added to this list
      // without that guard still reds.
      'upstream-sync-forwarder',
      // POD-1203 deleted the snapshot fan-out: 13 → 0, all VANISHED (no file
      // declares or calls either method, and grepping their destinations finds
      // no code home — a legacy client's full lists are folded out of the feed
      // by the expiring v1 adapter, which `bun run audit:serving-path` holds to
      // two allowlisted sites). Exempt on the SAME terms as the two above and no
      // looser: its `collect` THROWS when its roots match no files and when its
      // pattern stops matching the control strings it was written to match, both
      // asserted below.
      'publish-computed-fanout',
      // POD-1229 drove it to zero: both auto-archive observations replaced
      // `readAt` with `readerUserId`, so no representation carries a per-user
      // key as a singleton any more. Exempt on the SAME terms as the three
      // above and no looser — `perUserSingletons` runs its own matcher
      // end-to-end over a CONTROL (the pre-POD-1229 observation, copied from
      // the diff that deleted it) and THROWS when that stops producing exactly
      // one site, so an emptied key list, a widened GENERIC_KEYS, a raised
      // threshold or a broken parser reds loudly instead of reading as a
      // deletion. Asserted in 'per-user-singletons ERRORS when its control
      // stops matching' below.
      'per-user-singletons',
      // POD-324 deleted all four exported sync/async durable-host pairs. The
      // detector now proves its zero against both surviving source roots and a
      // synthetic sync+async control pair, throwing if either anchor disappears.
      'durable-host-sync-async-twins',
      // POD-321 removed the final constructor future reference. The detector is
      // anchored by the planted definite-assignment control test above and scans
      // both production composition roots, so zero here is the delivered state.
      'composition-root-forward-refs',
      // POD-327 reduced daemon.ts from 833 lines to a composition root. The
      // detector throws if that file is no longer scanned, and the planted
      // 300/301-line boundary test above proves both verdicts.
      'oversized-daemon-composition-root',
      // POD-1251 composed the last production change-row restatement: 15 → 0.
      // Exempt on the SAME terms as per-user-singletons and no looser —
      // `changeRowRestatements` runs its own matcher end-to-end over a planted
      // CONTROL (a zod object restating seq/entity/id/op/value) and THROWS when
      // that stops producing exactly one site, so an emptied CHANGE_ROW_KEYS, a
      // raised threshold, a broken DECLARED_OP_VALUE, or a silent block-parser
      // failure reds loudly instead of reading as a deletion. Asserted in
      // 'change-row-typings ERRORS when its control stops matching' above.
      'change-row-typings',
    ])
    for (const r of results) {
      if (ZERO_BY_DESIGN.has(r.id)) continue
      expect(
        r.count,
        `${r.id} matched nothing — detector drift, or genuinely deleted?`,
      ).toBeGreaterThan(0)
    }
  })

  it('the entity-id detector still binds to the live tree', () => {
    // `raw-string-entity-ids` is 0 by design, so its COUNT is the wrong anchor —
    // the same argument POD-368's six items make. Anchor on the population the
    // detector parses instead: a scan that stopped matching cannot produce these
    // numbers, and a zero that means "the regex broke" is this audit's own worst
    // failure mode.
    const sites = entityIdSites(loadContext(repoRoot))
    expect(sites.length).toBeGreaterThan(MIN_ID_FIELD_SITES)
    // The raw class reaching zero must not take the BRANDED class with it: every
    // site POD-301 flipped is still here, counted as branded. If both went quiet
    // together, the walk broke rather than the debt being paid.
    expect(sites.filter((s) => s.form === 'zod-branded').length).toBeGreaterThan(100)
    expect(sites.filter((s) => s.form === 'db-column').length).toBeGreaterThan(20)
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
    // 44 -> 45 when POD-415 registered `LegacyBindingSnapshot`, the one-shot
    // adapter over the daemon's scattered pre-store state. Moving this number is
    // the DELIBERATE ACT the pin exists to force: the entry declares why no
    // canonical legacy record exists to compose and names the real-state-dir
    // migration test that enforces its finite purpose.
    expect(RETAINED_REPRESENTATIONS.length).toBe(45)
  })

  it('the physical-table parser still binds to the live schema', () => {
    // `instance-partitions` is zero-by-design on BOTH its syntax forms, so each
    // one needs its own population anchor: a parser that stopped seeing drizzle
    // tables would report the same zero as a schema with no partition column.
    // These are floors, not pins — adding a table or a column must not red the
    // suite, only losing the ability to see them.
    const cols = physicalTableColumns(loadContext(repoRoot))
    expect(new Set(cols.map((c) => c.table)).size, 'parsed NO physical table').toBeGreaterThan(50)
    expect(cols.length, 'parsed NO table column').toBeGreaterThan(400)
    // And it reads the SQL name, not just the key — `machine_id` under
    // `machineId` is the form a partition column would take.
    expect(cols.some((c) => c.key === 'machineId' && c.column === 'machine_id')).toBe(true)
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
