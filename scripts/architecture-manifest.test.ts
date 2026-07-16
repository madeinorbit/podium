import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type AllowlistEntry,
  applyAllowlist,
  checkManifestEdge,
  checkManifestRole,
  duplicateFeatureOwners,
  findHarnessBranching,
  type ImportRef,
  loadHarnessLiterals,
  MANIFEST,
  SAME_LAYER_ALLOWED,
  stripComments,
  tagsFor,
  type WorkspaceTags,
} from './architecture-manifest'
import { BOUNDARY_ALLOWLIST } from './boundary-allowlist'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const value = (specifier: string): ImportRef => ({ specifier, typeOnly: false })
const typeOnly = (specifier: string): ImportRef => ({ specifier, typeOnly: true })

// ---------------------------------------------------------------------------
// The manifest itself
// ---------------------------------------------------------------------------

describe('MANIFEST coverage', () => {
  it('tags every app and package that exists on disk', () => {
    const onDisk: string[] = []
    for (const root of ['apps', 'packages']) {
      for (const entry of readdirSync(join(REPO_ROOT, root), { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) onDisk.push(`${root}/${entry.name}`)
      }
    }
    // A new package that nobody tagged would silently sit outside the matrix —
    // the drift this manifest exists to prevent.
    expect(onDisk.filter((w) => tagsFor(w) === null)).toEqual([])
  })

  it('tags the scripts build tier', () => {
    expect(tagsFor('scripts')?.layer).toBe(5)
  })

  it('owns every feature exactly once', () => {
    expect(duplicateFeatureOwners()).toEqual([])
  })

  it('gives every workspace at least one feature', () => {
    const featureless = Object.entries(MANIFEST)
      .filter(([, tags]) => tags.features.length === 0)
      .map(([w]) => w)
    expect(featureless).toEqual([])
  })

  it('declares same-layer edges only between tagged workspaces on the SAME layer', () => {
    for (const edge of SAME_LAYER_ALLOWED) {
      const [from = '', to = ''] = edge.split(' -> ')
      const fromTags = tagsFor(from)
      const toTags = tagsFor(to)
      expect(fromTags, `${edge}: '${from}' is not in MANIFEST`).not.toBeNull()
      expect(toTags, `${edge}: '${to}' is not in MANIFEST`).not.toBeNull()
      // A "same-layer allowance" for a downward edge is dead weight — it would
      // be legal anyway, and it hides the fact that the layers disagree.
      expect(fromTags?.layer, `${edge} is not actually a same-layer edge`).toBe(toTags?.layer)
    }
  })

  it('detects a feature claimed by two workspaces', () => {
    const clashing: Record<string, WorkspaceTags> = {
      'packages/a': { layer: 0, platform: 'neutral', features: ['shared'] },
      'packages/b': { layer: 1, platform: 'neutral', features: ['shared', 'own'] },
    }
    expect(duplicateFeatureOwners(clashing)).toEqual(['shared'])
  })
})

// ---------------------------------------------------------------------------
// Ledger drift guard — same shape and rationale as
// packages/telemetry/src/docs-drift.test.ts [spec:SP-f933].
// ---------------------------------------------------------------------------

describe('migration-ledger drift', () => {
  // The ledger's tag table is a PROMISE: "when a phase adds, renames or splits a
  // package, it updates this table and the manifest in the same commit". Phases
  // 1/5/6 rename or split half these packages, so a hand-maintained table is one
  // that rots on the first split. Checks NAMES and TAG VALUES, never prose — the
  // section should stay readable and human-written.
  const LEDGER = readFileSync(join(REPO_ROOT, 'docs/rearchitecture-v3.md'), 'utf8')
  const LAYER_LABEL: Record<number, string> = {
    0: 'L0 model',
    1: 'L1 wire',
    2: 'L2 kernel',
    3: 'L3 feature',
    4: 'L4 app',
    5: 'L5 compose',
  }
  const rowFor = (workspace: string) =>
    LEDGER.split('\n').find((line) => line.startsWith(`| \`${workspace}\` |`))

  it.each(Object.keys(MANIFEST))('records %s with its real tags', (workspace) => {
    const tags = MANIFEST[workspace]
    const row = rowFor(workspace)
    expect(row, `no ledger row for '${workspace}' — add it to the POD-296 tag table`).toBeDefined()
    expect(row).toContain(LAYER_LABEL[tags?.layer ?? -1])
    expect(row).toContain(tags?.platform)
    for (const feature of tags?.features ?? []) expect(row).toContain(feature)
  })

  it('records every declared same-layer edge', () => {
    for (const edge of SAME_LAYER_ALLOWED) {
      const [from = '', to = ''] = edge.split(' -> ')
      const short = `${from.replace('packages/', '')} → ${to.replace('packages/', '')}`
      expect(LEDGER, `same-layer edge '${short}' is not in the ledger`).toContain(short)
    }
  })

  it('lists no workspace the manifest does not tag', () => {
    const listed = [...LEDGER.matchAll(/^\| `((?:apps|packages)\/[a-z-]+|scripts)` \|/gm)].map(
      (m) => m[1] ?? '',
    )
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.filter((w) => tagsFor(w) === null)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Layer axiom
// ---------------------------------------------------------------------------

describe('checkManifestEdge — layer axiom', () => {
  it('allows a downward import', () => {
    // client-core (L3) -> domain (L0)
    expect(
      checkManifestEdge(
        'packages/client-core/src/x.ts',
        'packages/client-core',
        'packages/domain',
        value('@podium/domain'),
      ),
    ).toEqual([])
  })

  it('flags an upward import', () => {
    // transcript (L2, node-only) -> server (L4, node-only): isolates the layer
    // rule, since both sides are node-only and platform has nothing to say.
    const v = checkManifestEdge(
      'packages/transcript/src/x.ts',
      'packages/transcript',
      'apps/server',
      value('@podium/server'),
    )
    expect(v.map((x) => x.rule)).toEqual(['manifest-layer'])
    expect(v[0]?.message).toContain('imports UP')
  })

  it('flags an UNDECLARED same-layer import', () => {
    // transcript (L2) -> sync (L2), not in SAME_LAYER_ALLOWED
    const v = checkManifestEdge(
      'packages/transcript/src/x.ts',
      'packages/transcript',
      'packages/sync',
      value('@podium/sync'),
    )
    expect(v.map((x) => x.rule)).toEqual(['manifest-layer'])
    expect(v[0]?.message).toContain('undeclared same-layer import')
  })

  it('allows a DECLARED same-layer import', () => {
    // sync (L2) -> runtime (L2), declared.
    expect(
      checkManifestEdge(
        'packages/sync/src/x.ts',
        'packages/sync',
        'packages/runtime',
        value('@podium/runtime'),
      ),
    ).toEqual([])
  })

  it('exempts type-only imports (erased at build, no runtime edge)', () => {
    // The real grandfathered edge: web -> server, same layer, type-only.
    expect(
      checkManifestEdge('apps/web/src/x.ts', 'apps/web', 'apps/server', typeOnly('@podium/server')),
    ).toEqual([])
    // ... and a type-only UPWARD edge is erased too.
    expect(
      checkManifestEdge(
        'packages/domain/src/x.ts',
        'packages/domain',
        'apps/server',
        typeOnly('@podium/server'),
      ),
    ).toEqual([])
  })

  it('ignores edges touching an untagged workspace', () => {
    expect(
      checkManifestEdge(
        'packages/ghost/src/x.ts',
        'packages/ghost',
        'packages/domain',
        value('@podium/domain'),
      ),
    ).toEqual([])
  })
})

describe('checkManifestEdge — test-file exemptions', () => {
  // Mirrors the split the legacy rules already make: rule 1 (app->app, a
  // same-layer edge) exempts tests; rule 4 (packages->apps, upward) exempts none.
  it('exempts a test file from the same-layer rule (e2e composes peer apps)', () => {
    expect(
      checkManifestEdge(
        'apps/server/src/agent-relay-e2e.test.ts',
        'apps/server',
        'apps/daemon',
        value('../../daemon/src/agent-relay'),
      ),
    ).toEqual([])
  })

  it('does NOT exempt a test file from the upward rule', () => {
    const v = checkManifestEdge(
      'packages/domain/src/x.test.ts',
      'packages/domain',
      'apps/server',
      value('@podium/server'),
    )
    expect(v.map((x) => x.rule)).toEqual(['manifest-layer'])
    expect(v[0]?.message).toContain('imports UP')
  })

  it('exempts a test file from the platform rule (never bundled)', () => {
    expect(
      checkManifestEdge(
        'apps/web/src/x.test.ts',
        'apps/web',
        'packages/transcript',
        value('@podium/transcript'),
      ),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

describe('checkManifestEdge — platform', () => {
  it('flags browser-safe -> node-only', () => {
    const v = checkManifestEdge(
      'apps/web/src/x.ts',
      'apps/web',
      'packages/transcript',
      value('@podium/transcript'),
    )
    expect(v.map((x) => x.rule)).toContain('manifest-platform')
  })

  it('allows browser-safe -> neutral', () => {
    // web (browser-safe, L4) -> runtime (neutral, L2)
    expect(
      checkManifestEdge(
        'apps/web/src/x.ts',
        'apps/web',
        'packages/runtime',
        value('@podium/runtime'),
      ),
    ).toEqual([])
  })

  it('allows browser-safe -> browser-safe', () => {
    expect(
      checkManifestEdge(
        'apps/web/src/x.ts',
        'apps/web',
        'packages/client-core',
        value('@podium/client-core'),
      ),
    ).toEqual([])
  })

  it('allows node-only -> node-only', () => {
    // daemon (node-only, L4) -> transcript (node-only, L2)
    expect(
      checkManifestEdge(
        'apps/daemon/src/x.ts',
        'apps/daemon',
        'packages/transcript',
        value('@podium/transcript'),
      ),
    ).toEqual([])
  })

  it('reports layer AND platform when one edge breaks both', () => {
    // The real apps/desktop -> scripts edge: browser-safe L4 -> node-only L5.
    const v = checkManifestEdge(
      'apps/desktop/scripts/stage-sidecar.ts',
      'apps/desktop',
      'scripts',
      value('../../../scripts/build-bun.js'),
    )
    expect(v.map((x) => x.rule).sort()).toEqual(['manifest-layer', 'manifest-platform'])
  })
})

// ---------------------------------------------------------------------------
// Role tiers (delegated to apps/server/src/roles.ts)
// ---------------------------------------------------------------------------

describe('checkManifestRole', () => {
  it('flags core -> hub', () => {
    const v = checkManifestRole('apps/server/src/sessions.ts', value('./hub/pairing'))
    expect(v?.rule).toBe('manifest-role')
    expect(v?.message).toContain('core must not import hub')
  })

  it('allows hub -> core (downward)', () => {
    expect(checkManifestRole('apps/server/src/hub/pairing.ts', value('../store'))).toBeNull()
  })

  it('exempts composition roots reaching into hub', () => {
    expect(checkManifestRole('apps/server/src/router.ts', value('./hub/pairing'))).toBeNull()
  })

  it('exempts test files reaching into hub', () => {
    expect(checkManifestRole('apps/server/src/sessions.test.ts', value('./hub/pairing'))).toBeNull()
  })

  it('forbids cloud imports for EVERYONE, composition roots included', () => {
    expect(checkManifestRole('apps/server/src/router.ts', value('./cloud/billing'))?.rule).toBe(
      'manifest-role',
    )
    expect(
      checkManifestRole('apps/server/src/sessions.test.ts', value('./cloud/billing'))?.rule,
    ).toBe('manifest-role')
  })

  it('ignores workspaces that are not role-tiered', () => {
    expect(checkManifestRole('apps/web/src/x.ts', value('./hub/pairing'))).toBeNull()
  })

  it('ignores non-relative specifiers', () => {
    expect(checkManifestRole('apps/server/src/sessions.ts', value('@podium/protocol'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Harness axiom
// ---------------------------------------------------------------------------

describe('loadHarnessLiterals', () => {
  it('reads the LIVE protocol enum, not a hardcoded copy', () => {
    // If this fails, HarnessAgent moved or changed shape and the harness rule
    // has silently gone quiet — loadHarnessLiterals fails open by design, so
    // THIS test is the guard, not the function.
    expect(loadHarnessLiterals(REPO_ROOT)).toEqual([
      'claude-code',
      'codex',
      'grok',
      'opencode',
      'cursor',
    ])
  })

  it('returns [] when the enum is unreadable (rule no-ops rather than crashes)', () => {
    expect(loadHarnessLiterals('/nonexistent-repo-root')).toEqual([])
  })
})

describe('findHarnessBranching', () => {
  const LITERALS = ['claude-code', 'codex', 'grok', 'opencode', 'cursor']
  const find = (file: string, src: string) => findHarnessBranching(file, src, LITERALS)

  it('flags an equality comparison on harness identity', () => {
    const v = find('apps/web/src/x.ts', `if (session.agentKind === 'codex') { doCodexThing() }`)
    expect(v.map((x) => x.rule)).toEqual(['harness-branching'])
  })

  it('flags an inequality comparison', () => {
    expect(find('apps/web/src/x.ts', `if (msg.agentKind !== 'claude-code') return`)).toHaveLength(1)
  })

  it('flags a mirrored comparison (literal on the left)', () => {
    expect(find('apps/web/src/x.ts', `if ('codex' === b.harnessAgent) return`)).toHaveLength(1)
  })

  it('flags a case under a harness switch', () => {
    const src = `switch (agentKind) {\n  case 'claude-code':\n    return 'Claude'\n  case 'codex':\n    return 'Codex'\n}`
    expect(find('apps/web/src/x.ts', src)).toHaveLength(2)
  })

  it('reports the ORIGINAL source line, not the comment-stripped one', () => {
    // Regression: stripComments used to DELETE block comments, so every line
    // after one shifted and the reported line pointed at an innocent neighbour.
    const src = [
      'const a = 1',
      '/*',
      ' * a block comment',
      ' */',
      `if (kind === 'codex') go()`,
    ].join('\n')
    expect(find('apps/web/src/x.ts', src)[0]?.message).toContain('apps/web/src/x.ts:5:')
  })

  // --- what the corrected axiom explicitly PERMITS -------------------------

  it('does NOT flag an identifier flowing (passed, stored, typed, serialized)', () => {
    const src = [
      `import type { HarnessAgent } from '@podium/protocol'`,
      `const agent: HarnessAgent = settings.agentKind`,
      `spawn({ agent, model })`,
      `JSON.stringify({ agentKind: session.agentKind })`,
    ].join('\n')
    expect(find('apps/web/src/x.ts', src)).toEqual([])
  })

  it('does NOT flag a Record lookup keyed by harness (the blessed icon map)', () => {
    const src = `const Icon = KIND_ICON[kind]\nconst label = LABELS[agentKind]`
    expect(find('apps/web/src/x.ts', src)).toEqual([])
  })

  it('does NOT flag branching INSIDE the adapter home', () => {
    expect(
      find('packages/agent-bridge/src/adapters.ts', `if (kind === 'codex') return codexAdapter`),
    ).toEqual([])
  })

  it('does NOT flag test files', () => {
    expect(find('apps/web/src/x.test.ts', `expect(s.agentKind === 'codex').toBe(true)`)).toEqual([])
  })

  it('does NOT flag branching in a comment', () => {
    expect(
      find('apps/web/src/x.ts', `// when agentKind === 'codex' we used to branch here`),
    ).toEqual([])
  })

  // --- the 'cursor' false-positive guard ----------------------------------

  it("does NOT flag a non-harness 'cursor' comparison", () => {
    const src = [
      `if (style.cursor === 'pointer') return`,
      `if (page.cursor === 'cursor') next()`,
    ].join('\n')
    expect(find('apps/web/src/x.ts', src)).toEqual([])
  })

  it("still flags a REAL harness 'cursor'", () => {
    expect(
      find('apps/web/src/x.ts', `if (spec.agent === 'cursor') return cursorDriver`),
    ).toHaveLength(1)
  })

  it('does NOT flag a case under a non-harness switch', () => {
    const src = `switch (style.cursor) {\n  case 'grok':\n    return 1\n}`
    expect(find('apps/web/src/x.ts', src)).toEqual([])
  })

  // --- the codex/codex collision: ApiProvider is NOT HarnessAgent ------------
  // settings.ts declares ApiProvider = ['openrouter','anthropic','openai','codex'],
  // a different enum that shares the literal 'codex'. Resolving exactly this
  // collision is what the context guard is for.

  it("does NOT flag an ApiProvider 'codex' comparison", () => {
    expect(
      find('apps/server/src/llm.ts', `if (backend.provider === 'codex') return codexClient()`),
    ).toEqual([])
  })

  it("does NOT flag an ApiProvider 'codex' switch (providerLabel)", () => {
    const src = `switch (p) {\n  case 'openrouter':\n    return 'OpenRouter'\n  case 'codex':\n    return 'Codex (ChatGPT)'\n}`
    expect(find('apps/web/src/x.tsx', src)).toEqual([])
  })

  it('still flags a real HarnessAgent codex branch in the same file', () => {
    // The distinction is the identity being read, not the literal: this is a
    // HarnessAgent, the two above are ApiProviders.
    expect(
      find('packages/runtime/src/settings.ts', `if (b.harnessAgent !== 'codex') return b`),
    ).toHaveLength(1)
    expect(
      find(
        'packages/runtime/src/settings.ts',
        `if (harness === 'codex' && role === 'background') {`,
      ),
    ).toHaveLength(1)
  })

  it('no-ops when the literal set is empty', () => {
    expect(findHarnessBranching('apps/web/src/x.ts', `if (k === 'codex') go()`, [])).toEqual([])
  })
})

describe('stripComments', () => {
  it('preserves line count and column offsets', () => {
    const src = 'const a = 1 // trailing\n/* block\n   spanning */\nconst b = 2'
    const out = stripComments(src)
    expect(out.split('\n')).toHaveLength(src.split('\n').length)
    expect(out.length).toBe(src.length)
    expect(out).toContain('const a = 1')
    expect(out).toContain('const b = 2')
    expect(out).not.toContain('trailing')
    expect(out).not.toContain('spanning')
  })

  it('does not mistake a URL for a line comment', () => {
    expect(stripComments(`const u = 'https://example.com/x'`)).toContain('https://example.com/x')
  })
})

// ---------------------------------------------------------------------------
// Ratchet
// ---------------------------------------------------------------------------

describe('applyAllowlist', () => {
  const v = (rule: string, file: string, specifier = 'x') => ({
    rule,
    file,
    specifier,
    message: `${file}: ${rule}`,
  })
  const entry = (rule: string, file: string, count: number): AllowlistEntry => ({
    rule,
    file,
    count,
    phase: 'POD-292',
    note: 'test',
  })

  it('warns for an allowlisted violation within its count', () => {
    const r = applyAllowlist(
      [v('harness-branching', 'a.ts')],
      [entry('harness-branching', 'a.ts', 1)],
    )
    expect(r.errors).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.stale).toEqual([])
  })

  it('ERRORS for a violation that is not allowlisted at all', () => {
    const r = applyAllowlist([v('harness-branching', 'new.ts')], [])
    expect(r.errors).toHaveLength(1)
    expect(r.warnings).toEqual([])
  })

  it('ERRORS only for the EXCESS when a file exceeds its count', () => {
    // The ratchet: an allowlisted file is frozen at today's size, not blessed.
    const r = applyAllowlist(
      [
        v('harness-branching', 'a.ts'),
        v('harness-branching', 'a.ts'),
        v('harness-branching', 'a.ts'),
      ],
      [entry('harness-branching', 'a.ts', 2)],
    )
    expect(r.warnings).toHaveLength(2)
    expect(r.errors).toHaveLength(1)
  })

  it('ERRORS for a DIFFERENT rule in an already-dirty file', () => {
    // Counts are per (rule, file) — an allowlisted harness branch does not
    // buy the file a free layer violation.
    const r = applyAllowlist(
      [v('harness-branching', 'a.ts'), v('manifest-layer', 'a.ts')],
      [entry('harness-branching', 'a.ts', 1)],
    )
    expect(r.warnings).toHaveLength(1)
    expect(r.errors.map((e) => e.rule)).toEqual(['manifest-layer'])
  })

  it('reports a stale entry whose count is now too high', () => {
    const r = applyAllowlist(
      [v('harness-branching', 'a.ts')],
      [entry('harness-branching', 'a.ts', 3)],
    )
    expect(r.errors).toEqual([])
    expect(r.stale).toHaveLength(1)
    expect(r.stale[0]).toContain('allows 3 but only 1 remain')
  })

  it('reports a dead entry with zero remaining violations', () => {
    const r = applyAllowlist([], [entry('harness-branching', 'gone.ts', 2)])
    expect(r.stale).toHaveLength(1)
    expect(r.stale[0]).toContain('is dead')
  })

  it('is clean for an empty repo and an empty allowlist (the POD-335 end state)', () => {
    expect(applyAllowlist([], [])).toEqual({ warnings: [], errors: [], stale: [] })
  })

  it('errors on every violation when an entry declares count 0', () => {
    const r = applyAllowlist(
      [v('harness-branching', 'a.ts')],
      [entry('harness-branching', 'a.ts', 0)],
    )
    expect(r.warnings).toEqual([])
    expect(r.errors).toHaveLength(1)
  })
})

describe('BOUNDARY_ALLOWLIST integrity', () => {
  // applyAllowlist keys by (rule, file), so a second entry for the same key
  // silently WINS and could quietly raise a count past the first. Cheap to
  // forbid outright; the ratchet is only as honest as this list.
  it('has no duplicate (rule, file) entry', () => {
    const keys = BOUNDARY_ALLOWLIST.map((e) => `${e.rule} ${e.file}`)
    expect(keys).toEqual([...new Set(keys)])
  })

  it('gives every entry a positive count, a phase and a note', () => {
    for (const e of BOUNDARY_ALLOWLIST) {
      expect(e.count, `${e.rule} ${e.file}`).toBeGreaterThan(0)
      // AC: every entry maps to the phase that removes it — an unmapped entry
      // is debt with no owner, which is how allowlists become permanent.
      expect(e.phase, `${e.rule} ${e.file} has no phase`).toMatch(/^POD-\d+$/)
      expect(e.note.length, `${e.rule} ${e.file} has no note`).toBeGreaterThan(0)
    }
  })
})
