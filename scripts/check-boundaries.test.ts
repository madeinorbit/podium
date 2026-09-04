import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyAllowlist, BROWSER_ENTRYPOINTS, partitionAllowlist } from './architecture-manifest'
import { BOUNDARY_ALLOWLIST } from './boundary-allowlist'
import {
  checkBrowserGraphAll,
  checkCacheTableAnnouncement,
  checkConsoleOwnership,
  checkDeclaredDeps,
  checkDrizzleImportHome,
  checkDrizzleTransaction,
  checkFile,
  checkFlipUndeleted,
  checkHarnessClassifierBoundary,
  checkHostEdgeSeparationAll,
  checkManifestFile,
  checkPlaneLeakAll,
  checkPrincipalFree,
  checkRepositoryDbCapture,
  checkSessionBindingFieldAccess,
  checkSqlRawLiteral,
  checkStoreBoundaryLedger,
  checkStoreRawHandles,
  checkUiStorageOwnership,
  clauseIsTypeOnly,
  extractImports,
  FLIP_UNDELETED,
  type FlipUndeletedEntry,
  loadModelExportNames,
  STAGE_A_UNCONVERTED,
  type Violation,
} from './check-boundaries'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Every violation the STORE BOUNDARY family reports on the real tree, computed
 * once. Each rule's "quiet on the REAL repository" control reads from this: a
 * rule that is red on the tree it ships with is a rule somebody switches off,
 * so the control is as load-bearing as the fixtures that prove it can fire.
 */
let realRepoCache: Violation[] | undefined
function realRepoViolations(): Violation[] {
  if (realRepoCache) return realRepoCache
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name.startsWith('.')) return []
      if (e.isDirectory()) {
        return ['node_modules', 'dist', 'build', 'coverage', 'target', '.expo'].includes(e.name)
          ? []
          : walk(join(dir, e.name))
      }
      return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [join(dir, e.name)] : []
    })
  const out: Violation[] = []
  for (const rootDir of ['apps', 'packages']) {
    for (const abs of walk(join(REPO_ROOT, rootDir))) {
      const file = relative(REPO_ROOT, abs).split(sep).join('/')
      const source = readFileSync(abs, 'utf8')
      out.push(
        ...checkStoreRawHandles(file, source),
        ...checkRepositoryDbCapture(file, source),
        ...checkDrizzleTransaction(file, source),
        ...checkDrizzleImportHome(file, source),
        ...checkSqlRawLiteral(file, source),
        ...checkCacheTableAnnouncement(file, source),
      )
    }
  }
  realRepoCache = out
  return out
}

describe('console-ownership (POD-1905)', () => {
  it('flags a raw console call in server product code', () => {
    const vs = checkConsoleOwnership(
      'apps/server/src/modules/thing.ts',
      "export const f = () => { console.log('hi') }",
    )
    expect(vs.map((v) => v.rule)).toEqual(['console-ownership'])
    expect(vs[0]?.specifier).toBe('console.log')
  })

  it('covers every method, `table` and a globalThis-qualified call included', () => {
    // `console.table` is named in the plan as the one that must be decided
    // explicitly; `globalThis.console` is the form a leading-boundary guard
    // would have missed.
    expect(
      checkConsoleOwnership('packages/client-core/src/x.ts', 'console.table(rows)').map(
        (v) => v.specifier,
      ),
    ).toEqual(['console.table'])
    expect(
      checkConsoleOwnership('packages/harness/src/x.ts', 'globalThis.console.warn(m)'),
    ).toHaveLength(1)
  })

  it('exempts CLI output, the logger package, and the named feature files', () => {
    for (const file of [
      'apps/cli/src/cli.ts',
      'packages/logger/src/sinks.ts',
      'packages/client-core/src/logging/forward-sink.ts',
      'packages/client-core/src/logging/crash.ts',
      'packages/client-core/src/perf/switch-trace.ts',
      'packages/terminal-client/src/terminal-diagnostics.ts',
      'packages/pty/src/abduco-bin.ts',
      'apps/web/src/perf/large-state.frontend-perf.tsx',
    ]) {
      expect(checkConsoleOwnership(file, "console.warn('x')")).toEqual([])
    }
  })

  it('carves tests out BY DIRECTORY, not by a *.test.ts glob', () => {
    // The POD-1906 finding: these are test infrastructure that is not named
    // `.test.ts`, and a glob-shaped carve-out would have swept them.
    for (const file of [
      'apps/server/src/test-support/capture-logs.ts',
      'apps/daemon/test/fixtures/build-report-compiled.ts',
      'apps/web/src/lib/__tests__/helper.ts',
      'apps/server/src/store.test.ts',
    ]) {
      expect(checkConsoleOwnership(file, "console.log('x')")).toEqual([])
    }
  })

  it('leaves build tooling alone — scripts/ and apps/<x>/scripts/**', () => {
    expect(checkConsoleOwnership('scripts/audit-thing.ts', "console.log('x')")).toEqual([])
    expect(checkConsoleOwnership('apps/mobile/scripts/patch.ts', "console.log('x')")).toEqual([])
  })

  it('does not fire on a comment naming the prohibition, or on a bare reference', () => {
    // Two mutants that must stay silent. The first is this rule documenting
    // itself; the second is restore.ts's injected stdout default, which is a
    // reference rather than a call.
    expect(
      checkConsoleOwnership('apps/server/src/x.ts', '// never write console.log() here\n'),
    ).toEqual([])
    expect(
      checkConsoleOwnership(
        'apps/server/src/migrations/restore.ts',
        'export function m(out: (s: string) => void = console.log): number { return 0 }',
      ),
    ).toEqual([])
  })
})

describe('ui-storage-ownership (POD-329)', () => {
  it('flags a feature-surface localStorage method call', () => {
    const vs = checkUiStorageOwnership(
      'apps/web/src/features/terminal/EchoHud.tsx',
      "export const on = () => localStorage.getItem('podium.echoHud') === '1'",
    )
    expect(vs.map((v) => v.rule)).toEqual(['ui-storage-ownership'])
    expect(vs[0]?.file).toBe('apps/web/src/features/terminal/EchoHud.tsx')
  })

  it('flags AsyncStorage method access outside the replica adapter', () => {
    const vs = checkUiStorageOwnership(
      'apps/mobile/src/screens/leak.ts',
      "import AsyncStorage from '@react-native-async-storage/async-storage'\nvoid AsyncStorage.setItem('k', 'v')",
    )
    expect(vs.map((v) => v.rule)).toEqual(['ui-storage-ownership'])
  })

  it('allows the ui-state module and replica adapter', () => {
    expect(
      checkUiStorageOwnership(
        'packages/client-core/src/ui-state.ts',
        'globalThis.localStorage?.setItem(key, value)',
      ),
    ).toEqual([])
    expect(
      checkUiStorageOwnership(
        'packages/client-core/src/replica/async-storage.ts',
        'await AsyncStorage.getItem(k)',
      ),
    ).toEqual([])
  })

  it('does not fire on comments that merely name localStorage', () => {
    // Mutant that must stay silent: documentation of the prohibition.
    expect(
      checkUiStorageOwnership(
        'apps/web/src/features/x.ts',
        '/** Never call localStorage.getItem from here — use ui-state. */\nexport const x = 1',
      ),
    ).toEqual([])
  })

  it('does not fire on bare localStorage identifiers without a method call', () => {
    // Mutant that must stay silent: passing the storage object into the adapter.
    expect(
      checkUiStorageOwnership(
        'apps/web/src/features/replica-note.ts',
        'const s = window.localStorage\nvoid s',
      ),
    ).toEqual([])
  })

  it('is wired through checkFile so lint:boundaries cannot skip it', () => {
    const vs = checkFile(
      'apps/web/src/features/rogue.ts',
      "const v = localStorage.getItem('podium.view')",
    )
    expect(vs.some((v) => v.rule === 'ui-storage-ownership')).toBe(true)
  })
})

describe('harness classifier manifest boundary', () => {
  it('keeps the engine inside harness and Claude rules inside their manifest', () => {
    expect(
      checkHarnessClassifierBoundary(
        'apps/daemon/src/leak.ts',
        [
          'im',
          `port { createTranscriptClassifier } from '../../../packages/harness/src/agent-state/transcript-classifier'`,
        ].join(''),
      ).map((v) => v.rule),
    ).toEqual(['harness-classifier-boundary'])
    expect(
      checkHarnessClassifierBoundary(
        'packages/harness/src/agent-state/leak.ts',
        [
          'im',
          `port { claudeTranscriptClassifierRules } from '../manifests/claude-code-classifier'`,
        ].join(''),
      ).map((v) => v.rule),
    ).toEqual(['harness-classifier-boundary'])
    expect(
      checkHarnessClassifierBoundary(
        'packages/harness/src/manifests/claude-code.ts',
        ['im', `port { claudeTranscriptClassifierRules } from './claude-code-classifier.js'`].join(
          '',
        ),
      ),
    ).toEqual([])
  })
})

describe('extractImports', () => {
  it('extracts value, type-only, side-effect, export-from and dynamic imports', () => {
    const src = [
      `import { a } from '@podium/runtime'`,
      `import type { AppRouter } from '@podium/server'`,
      `import '@podium/protocol'`,
      `export { b } from '@podium/harness'`,
      `const m = await import('@podium/terminal-client')`,
      `const n = require('@podium/client-core')`,
    ].join('\n')
    const refs = extractImports(src)
    expect(refs.map((r) => r.specifier)).toEqual([
      '@podium/runtime',
      '@podium/server',
      '@podium/protocol',
      '@podium/harness',
      '@podium/terminal-client',
      '@podium/client-core',
    ])
    expect(refs.map((r) => r.typeOnly)).toEqual([false, true, false, false, false, false])
  })

  it('handles multiline import clauses', () => {
    const src = `import {\n  fileChainSource,\n  fileIdFor,\n} from '@podium/harness'`
    expect(extractImports(src)).toEqual([{ specifier: '@podium/harness', typeOnly: false }])
  })

  it('ignores specifiers that only appear in comments', () => {
    // Mirrors the shape of apps/web/src/derive.ts and any server file that
    // mentions harness in prose only.
    const src = [
      `// Kept in apps/server (rather than @podium/harness) so ...`,
      `/* see '@podium/harness' agentLaunchCommand */`,
      `import { z } from 'zod'`,
    ].join('\n')
    expect(extractImports(src)).toEqual([{ specifier: 'zod', typeOnly: false }])
  })

  it('does not let the word "import" inside a string swallow the next import (POD-755)', () => {
    // The side-effect alternative used to fire on this string's `import`, then run
    // from its closing quote to the OPENING quote of the real statement below —
    // returning one junk specifier and losing '@podium/transcript' entirely.
    const src = [`const help = 'usage: import'`, `import { parse } from '@podium/transcript'`].join(
      '\n',
    )
    expect(extractImports(src)).toEqual([{ specifier: '@podium/transcript', typeOnly: false }])
  })

  it('still finds side-effect imports that are indented or follow a brace/semicolon', () => {
    const src = [`  import './indented'`, `import 'a';import 'b'`, `{ import './in-block' }`].join(
      '\n',
    )
    expect(extractImports(src).map((r) => r.specifier)).toEqual([
      './indented',
      'a',
      'b',
      './in-block',
    ])
  })
})

describe('clauseIsTypeOnly', () => {
  it('detects import type clauses', () => {
    expect(clauseIsTypeOnly('type { AppRouter }')).toBe(true)
    expect(clauseIsTypeOnly('type Foo')).toBe(true)
    expect(clauseIsTypeOnly('{ type A, type B }')).toBe(true)
  })
  it('rejects value or mixed clauses', () => {
    expect(clauseIsTypeOnly('{ AppRouter }')).toBe(false)
    expect(clauseIsTypeOnly('{ type A, b }')).toBe(false)
    expect(clauseIsTypeOnly('Foo')).toBe(false)
    expect(clauseIsTypeOnly('* as ns')).toBe(false)
  })
})

describe('checkFile rules', () => {
  it('keeps SessionBinding delegation fields out of observers and control handlers', () => {
    for (const fieldAccess of [
      'binding.onBehalfOf',
      'binding.actor',
      'binding.scope',
      'const binding = { onBehalfOf: user }',
      'const binding = { actor: agent }',
      'const binding = { scope: requested }',
    ]) {
      expect(
        checkSessionBindingFieldAccess('apps/daemon/src/session-observers.ts', fieldAccess).map(
          (violation) => violation.rule,
        ),
      ).toEqual(['session-binding-field-access'])
    }
  })

  it('allows the SessionBinding API name and prose mentioning delegation fields', () => {
    const source = `// actor, onBehalfOf and scope stay opaque\nctx.sessionBinding.transition(input)`
    expect(checkSessionBindingFieldAccess('apps/daemon/src/control/session.ts', source)).toEqual([])
  })
})

describe('checkPrincipalFree', () => {
  const HARNESS = 'packages/harness/src/manifest.ts'

  it('flags a principal type imported into packages/harness', () => {
    const v = checkPrincipalFree(HARNESS, `import type { UserId } from '@podium/protocol'`)
    expect(v).toHaveLength(1)
    expect(v[0]?.rule).toBe('harness-principal-free')
    expect(v[0]?.message).toContain('UserId')
  })

  it('flags a value-imported authorization helper too, not just types', () => {
    expect(
      checkPrincipalFree(HARNESS, `import { envelopePrincipal } from '@podium/protocol'`),
    ).toHaveLength(1)
  })

  it('does NOT flag HarnessCapabilities — that is the software capability descriptor', () => {
    // The two senses of "capability" collide exactly here. A rule that flagged
    // this would be uselessly noisy AND would teach the next contributor that the
    // harness capability descriptor is an authorization concept, which it is not.
    expect(
      checkPrincipalFree(HARNESS, `import type { HarnessCapabilities } from './manifest.js'`),
    ).toEqual([])
  })

  it('only looks at import clauses, not at local names', () => {
    expect(checkPrincipalFree(HARNESS, `const grantedScopes = 1`)).toEqual([])
    expect(checkPrincipalFree(HARNESS, `function authorize() {}`)).toEqual([])
  })

  it('applies only to the principal-free workspaces', () => {
    expect(
      checkPrincipalFree(
        'packages/transcript/src/slice.ts',
        `import type { UserId } from '@podium/model'`,
      ),
    ).toHaveLength(1)
    expect(
      checkPrincipalFree('apps/server/src/x.ts', `import type { UserId } from '@podium/protocol'`),
    ).toEqual([])
    // The pty kernel is guarded too; it is a permanent principal-free seam.
    expect(
      checkPrincipalFree(
        'packages/pty/src/session.ts',
        `import type { UserId } from '@podium/protocol'`,
      ),
    ).toHaveLength(1)
  })

  it('passes clean against the REAL harness, pty and transcript trees', () => {
    // The claim the acceptance criterion actually makes. Walks the shipped source
    // rather than a fixture, so reintroducing a principal import fails here.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const walk = (dir: string): string[] =>
      readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(`${dir}/${e.name}`)
          : e.name.endsWith('.ts') || e.name.endsWith('.tsx')
            ? [`${dir}/${e.name}`]
            : [],
      )
    const files = [
      ...walk('packages/harness/src'),
      ...walk('packages/pty/src'),
      ...walk('packages/transcript/src'),
    ]
    expect(files.length).toBeGreaterThan(50)
    const violations = files.flatMap((f) =>
      checkPrincipalFree(f, readFileSync(join(repoRoot, f), 'utf8')),
    )
    expect(violations).toEqual([])
  })
})

describe('rule 9 — host edge vs agent command relay (ADR 7 D2)', () => {
  it('passes clean against the real repo: neither channel imports the other', () => {
    const repoRoot = new URL('..', import.meta.url).pathname
    expect(checkHostEdgeSeparationAll(repoRoot)).toEqual([])
  })

  it('flags a host-hook handler that reaches for the agent relay', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-boundaries-'))
    mkdirSync(join(root, 'apps/daemon/src'), { recursive: true })
    writeFileSync(join(root, 'apps/daemon/src/agent-relay.ts'), 'export const relay = 1\n')
    writeFileSync(
      join(root, 'apps/daemon/src/hook-ingest.ts'),
      "import { relay } from './agent-relay.js'\nexport const use = relay\n",
    )
    const violations = checkHostEdgeSeparationAll(root)
    expect(violations).toHaveLength(1)
    const [violation] = violations
    if (violation === undefined) throw new Error('expected exactly one violation')
    expect(violation.rule).toBe('host-edge-separation')
    expect(violation.message).toContain('must not import')
  })

  it('flags the crossing in the other direction too', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-boundaries-'))
    mkdirSync(join(root, 'apps/daemon/src'), { recursive: true })
    writeFileSync(join(root, 'apps/daemon/src/browser-open.ts'), 'export const open = 1\n')
    writeFileSync(
      join(root, 'apps/daemon/src/agent-relay.ts'),
      "import { open } from './browser-open.js'\nexport const use = open\n",
    )
    expect(checkHostEdgeSeparationAll(root).map((v) => v.rule)).toEqual(['host-edge-separation'])
  })

  it('a violation FAILS the gate: it is not allowlisted, so it lands in errors', () => {
    // Mechanism presence is not coverage. The two tests above prove the rule
    // fires; this one proves a firing rule stops the build rather than being
    // warned away by the ratchet, which is the other half of "enforced".
    const violation = {
      file: 'apps/daemon/src/hook-ingest.ts',
      specifier: './agent-relay.js',
      rule: 'host-edge-separation',
      message: 'synthetic',
    }
    const [, legacy] = partitionAllowlist(BOUNDARY_ALLOWLIST)
    const { warnings, errors } = applyAllowlist([violation], legacy)
    expect(errors).toEqual([violation])
    expect(warnings).toEqual([])
  })

  it('leaves same-side imports and unrelated siblings alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-boundaries-'))
    mkdirSync(join(root, 'apps/daemon/src'), { recursive: true })
    writeFileSync(join(root, 'apps/daemon/src/codex-hooks.ts'), 'export const c = 1\n')
    writeFileSync(join(root, 'apps/daemon/src/util.ts'), 'export const u = 1\n')
    writeFileSync(
      join(root, 'apps/daemon/src/hook-ingest.ts'),
      "import { c } from './codex-hooks.js'\nimport { u } from './util.js'\nexport const use = [c, u]\n",
    )
    expect(checkHostEdgeSeparationAll(root)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// declared-deps (POD-1131) — a cross-package import must be a DECLARED dep.
// The other rules all reason about declared edges, so a MISSING dependency is
// invisible to them: there is no edge to judge. It resolves via hoisting and
// then breaks an unrelated workspace's typecheck.
// ---------------------------------------------------------------------------

describe('checkDeclaredDeps', () => {
  const mk = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'podium-deps-'))
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true })
      writeFileSync(join(root, rel), body)
    }
    return root
  }

  it('flags an import of a workspace package the importer does not declare', () => {
    const root = mk({
      'packages/a/package.json': JSON.stringify({ name: '@podium/a', dependencies: {} }),
      'packages/a/src/x.ts': "import { thing } from '@podium/b'\nexport const y = thing\n",
      'packages/b/package.json': JSON.stringify({ name: '@podium/b' }),
      'packages/b/src/i.ts': 'export const thing = 1\n',
    })
    const v = checkDeclaredDeps(root)
    expect(v).toHaveLength(1)
    expect(v[0]?.rule).toBe('declared-deps')
    expect(v[0]?.specifier).toBe('@podium/b')
  })

  it('is silent once the dependency is declared', () => {
    const root = mk({
      'packages/a/package.json': JSON.stringify({
        name: '@podium/a',
        dependencies: { '@podium/b': 'workspace:*' },
      }),
      'packages/a/src/x.ts': "import { thing } from '@podium/b'\nexport const y = thing\n",
      'packages/b/package.json': JSON.stringify({ name: '@podium/b' }),
      'packages/b/src/i.ts': 'export const thing = 1\n',
    })
    expect(checkDeclaredDeps(root)).toEqual([])
  })

  it('accepts a devDependency, and ignores self-imports and non-workspace scopes', () => {
    const root = mk({
      'packages/a/package.json': JSON.stringify({
        name: '@podium/a',
        devDependencies: { '@podium/b': 'workspace:*' },
      }),
      'packages/a/src/x.ts':
        "import { t } from '@podium/b'\nimport { s } from '@podium/a'\nimport z from '@podium/not-a-workspace'\nexport const y = [t, s, z]\n",
      'packages/b/package.json': JSON.stringify({ name: '@podium/b' }),
      'packages/b/src/i.ts': 'export const t = 1\n',
    })
    expect(checkDeclaredDeps(root)).toEqual([])
  })
})

describe('rule 9 — the Replica role is direction-locked (POD-369)', () => {
  const REPLICA = 'packages/sync/src/replica/replica.ts'

  it('allows sibling imports inside the replica directory', () => {
    expect(
      checkFile(REPLICA, `import type { Cursor } from './types'\nimport { x } from './ports'`),
    ).toEqual([])
  })

  it('rejects a merge-policy or concrete-adapter import, however it is spelled', () => {
    for (const specifier of [
      '@podium/domain',
      '../merge-policy',
      '../../../domain/src/issue-authz',
      '@podium/protocol',
      'idb',
    ]) {
      const v = checkFile(REPLICA, `import { x } from '${specifier}'`)
      // Some of these also trip rule 3b (restricted package deps); rule 9 must
      // fire on ALL of them, including the ones no other rule would catch.
      expect(
        v.map((e) => e.rule),
        specifier,
      ).toContain('replica-direction')
    }
  })

  it('allows the ONE neutral unit-of-work port, in either spelling (POD-1146)', () => {
    expect(checkFile(REPLICA, `import type { SyncSpan } from '../span'`)).toEqual([])
    expect(checkFile(REPLICA, `import { SyncCommitConflict } from '../span.ts'`)).toEqual([])
    // The exception is granted to the replica role, not to the file name: the
    // same specifier from a sibling role must still be an ordinary import.
    expect(
      checkFile('packages/sync/src/replica/ports.ts', `import type { SyncSpan } from '../span'`),
    ).toEqual([])
  })

  it('is an EXACT path, so a neighbour of the span port is still rejected', () => {
    // The counterfactual the previous test cannot supply: if the waiver were a
    // directory prefix (or a basename match), each of these would pass too — and a
    // merge policy or a concrete adapter would ride in beside the span.
    for (const specifier of ['../spans', '../span-extra', '../replica-span', '../ports/span']) {
      expect(
        checkFile(REPLICA, `import type { X } from '${specifier}'`).map((e) => e.rule),
        specifier,
      ).toContain('replica-direction')
    }
  })

  it('rejects visibility, authorization and conflict EVALUATION in replica source', () => {
    for (const snippet of [
      'const ok = canSee(principal, row)',
      'function isVisibleTo(p: unknown) { return true }',
      'if (hasGrant(user, entity)) apply()',
      'const winner = resolveConflict(a, b)',
      'const merged = lastWriteWins(a, b)',
    ]) {
      const v = checkFile(REPLICA, snippet)
      expect(
        v.map((e) => e.rule),
        snippet,
      ).toEqual(['replica-direction'])
    }
  })

  it('does NOT flag prose that documents the prohibition', () => {
    const source = [
      '/** The replica must never ask canSee(principal, row) — the Authority decides. */',
      '// no arbitrate() here, and no resolveConflict() either',
      "import type { Cursor } from './types'",
    ].join('\n')
    expect(checkFile(REPLICA, source)).toEqual([])
  })

  it('lets the replica tests import vitest, and nothing else from outside', () => {
    const test = 'packages/sync/src/replica/replica.test.ts'
    expect(checkFile(test, `import { describe } from 'vitest'`)).toEqual([])
    expect(
      checkFile(test, `import { authorize } from '@podium/domain'`).map((e) => e.rule),
    ).toContain('replica-direction')
  })

  it('leaves every other workspace alone', () => {
    expect(
      checkFile('packages/sync/src/ledger.ts', `import { z } from '@podium/protocol'`),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Rule 11 — the sync kernel has zero SQLite/Bun/DOM (POD-305)
// ---------------------------------------------------------------------------

describe('rule 11: sync kernel purity', () => {
  // The instrument must say YES before its NO means anything. Each prohibited
  // form is planted and required to fire; each permitted one is planted too,
  // because a rule that fires on everything is as useless as one that fires on
  // nothing — and the permitted cases are what stop the next person "fixing" a
  // false positive by widening the rule.

  it('fires on a SQLite import in kernel source', () => {
    const v = checkFile(
      'packages/sync/src/authority/authority.ts',
      `import { transaction } from '@podium/runtime/sqlite'`,
    )
    expect(v.map((x) => x.rule)).toContain('sync-kernel-purity')
  })

  it('fires on a bun: import in kernel source', () => {
    const v = checkFile('packages/sync/src/ledger.ts', `import { Database } from 'bun:sqlite'`)
    expect(v.map((x) => x.rule)).toContain('sync-kernel-purity')
  })

  it('fires on drizzle-orm in kernel source', () => {
    const v = checkFile('packages/sync/src/ledger.ts', `import { sql } from 'drizzle-orm'`)
    expect(v.map((x) => x.rule)).toContain('sync-kernel-purity')
  })

  it('fires on a DOM GLOBAL, which no import check can see', () => {
    const v = checkFile(
      'packages/sync/src/replica/memory-store.ts',
      `export const save = (k: string) => localStorage.setItem(k, '1')`,
    )
    expect(v.map((x) => x.rule)).toContain('sync-kernel-purity')
  })

  it('fires on kernel SOURCE importing the adapter', () => {
    // Without this, the no-SQLite rule is bypassed by importing an adapter
    // helper that re-exports the thing.
    const v = checkFile(
      'packages/sync/src/ledger.ts',
      `import { SyncRepository } from './adapters/sqlite/sync-repository'`,
    )
    expect(v.map((x) => x.rule)).toContain('sync-kernel-purity')
  })

  it('does NOT fire on a kernel TEST wiring the real adapter', () => {
    // The most valuable test in the package is one that proves the port against
    // real technology. It takes the wiring as a fixture, which is allowed.
    const v = checkFile(
      'packages/sync/src/ledger.test.ts',
      `import { createTestTransact } from './adapters/sqlite/test-support'`,
    )
    expect(v.map((x) => x.rule)).not.toContain('sync-kernel-purity')
  })

  it('DOES fire on a kernel test importing SQLite directly', () => {
    // The counterfactual for the case above: tests are exempt from the
    // adapter-import rule and NOT from the technology rule. A test is exactly
    // where a database import first looks harmless.
    const v = checkFile(
      'packages/sync/src/ledger.test.ts',
      `import { transaction } from '@podium/runtime/sqlite'`,
    )
    expect(v.map((x) => x.rule)).toContain('sync-kernel-purity')
  })

  it('does not fire inside the adapter itself', () => {
    const v = checkFile(
      'packages/sync/src/adapters/sqlite/sync-repository.ts',
      `import { transaction } from '@podium/runtime/sqlite'`,
    )
    expect(v.map((x) => x.rule)).not.toContain('sync-kernel-purity')
  })

  it('does not fire on the package barrel re-exporting the adapter', () => {
    const v = checkFile(
      'packages/sync/src/index.ts',
      `export * from './adapters/sqlite/sync-repository'`,
    )
    expect(v.map((x) => x.rule)).not.toContain('sync-kernel-purity')
  })

  it('does not fire on node:fs — the criterion is SQLite/Bun/DOM, not "no I/O"', () => {
    // mirror.ts and upstream.ts legitimately touch files and are not kernel
    // roles. A broader rule needed three exclusions to pass on the day it
    // landed, and a rule that starts with exclusions gets widened by exclusion.
    const v = checkFile('packages/sync/src/mirror.ts', `import { mkdirSync } from 'node:fs'`)
    expect(v.map((x) => x.rule)).not.toContain('sync-kernel-purity')
  })

  it('does not fire on a COMMENT documenting the prohibition', () => {
    // This package documents the rule at length. A lint that tripped on its own
    // documentation would be removed within a week.
    const v = checkFile(
      'packages/sync/src/authority/ports.ts',
      `/** Never reach localStorage or a bun:sqlite handle from here. */\nexport type X = string`,
    )
    expect(v.map((x) => x.rule)).not.toContain('sync-kernel-purity')
  })

  it('does not fire outside packages/sync', () => {
    const v = checkFile(
      'apps/server/src/store.ts',
      `import { openDatabase } from '@podium/runtime/sqlite'`,
    )
    expect(v.map((x) => x.rule)).not.toContain('sync-kernel-purity')
  })
})

// ---------------------------------------------------------------------------
// Rule 12 — sync-browser-reach (POD-307)
// ---------------------------------------------------------------------------
//
// The rule this suite guards is the one that makes `packages/sync`'s NEUTRAL tag
// honest, so every case here is written to the standard the tag rests on: each
// refusing arm is paired with the control proving the same instrument can say
// YES. A gate that only ever refuses, or only ever passes, is evidence of
// nothing.

describe('manifest-browser-reach (a) — browser-safe workspaces reach a NEUTRAL workspace only through a declared entrypoint', () => {
  it('refuses the BARE BARREL from a browser-safe workspace', () => {
    // The barrel value-exports the Authority, the Ledger, mirror.ts and the
    // SQLite repository. This is the exact edge the node-only tag used to refuse.
    const v = checkManifestFile(
      'apps/web/src/boot.ts',
      `import { createIndexedDbReplicaStore } from '@podium/sync'`,
    )
    expect(v.map((x) => x.rule)).toEqual(['manifest-browser-reach'])
    expect(v[0]?.message).toContain('BARREL')
  })

  it('refuses an UNDECLARED subpath', () => {
    const v = checkManifestFile(
      'apps/mobile/src/boot.ts',
      `import { Authority } from '@podium/sync/authority/index'`,
    )
    expect(v.map((x) => x.rule)).toEqual(['manifest-browser-reach'])
  })

  it('ALLOWS every declared entrypoint — the control', () => {
    // Without this the suite would pass against a rule that refuses everything,
    // which would "prove" browser-safety by making the adapters unreachable
    // again — the state POD-307 exists to end.
    for (const specifier of BROWSER_ENTRYPOINTS.keys()) {
      const v = checkManifestFile('apps/web/src/boot.ts', `import { X } from '${specifier}'`)
      expect(v.map((x) => x.rule)).not.toContain('manifest-browser-reach')
    }
  })

  it('does not fire for a node-only workspace — apps/server may use the barrel', () => {
    const v = checkManifestFile(
      'apps/server/src/boot.ts',
      `import { Authority } from '@podium/sync'`,
    )
    expect(v.map((x) => x.rule)).not.toContain('manifest-browser-reach')
  })

  it('exempts type-only imports, matching checkManifestEdge (erased at build)', () => {
    const v = checkManifestFile(
      'apps/web/src/boot.ts',
      `import type { Authority } from '@podium/sync'`,
    )
    expect(v.map((x) => x.rule)).not.toContain('manifest-browser-reach')
  })

  it('EVERY declared entrypoint is resolvable — its package.json exports it', () => {
    // A rule that permits a specifier Node cannot resolve permits nothing. This
    // is the check that would have caught declaring an entrypoint and forgetting
    // the exports map, which fails at RUNTIME in the client and nowhere in CI.
    //
    // Generalised past @podium/sync with the rule itself (POD-335): every NEUTRAL
    // workspace's declared surface is checked against its own package.json, so
    // adding a browser entrypoint to a workspace this test has never heard of is
    // covered on the day it lands.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    for (const [specifier, entry] of BROWSER_ENTRYPOINTS) {
      const workspace = entry.slice(0, entry.indexOf('/src/'))
      const pkg = JSON.parse(readFileSync(join(repoRoot, workspace, 'package.json'), 'utf8')) as {
        name: string
        exports: Record<string, string | Record<string, string>>
      }
      const subpath = specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`
      const declared = pkg.exports[subpath]
      expect(declared, `${specifier} missing from ${workspace} exports`).toBeDefined()
      // The exports map has two shapes in this repo — a bare path, or a
      // conditions object where `@podium/source` (in-repo) and `import` (built)
      // may point at different files. Any of them naming the module this rule
      // WALKED is what makes the declaration resolvable; asserting one spelling
      // would fail on workspaces that use the other.
      const targets = typeof declared === 'string' ? [declared] : Object.values(declared ?? {})
      expect(targets, specifier).toContain(`./${entry.slice(`${workspace}/`.length)}`)
    }
  })
})

describe("manifest-browser-reach (b) — a declared entrypoint's TRANSITIVE closure is Node-free", () => {
  /** A synthetic repo containing only the files a case needs, so the refusing
   *  arm is produced by the fixture rather than waited for. */
  function plant(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'sync-reach-'))
    for (const [rel, source] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, source)
    }
    return root
  }

  /** Every declared entrypoint present and trivially clean — the baseline each
   *  case mutates ONE file of. */
  const CLEAN: Record<string, string> = Object.fromEntries(
    [...BROWSER_ENTRYPOINTS.values()].map((entry) => [entry, `export const x = 1\n`]),
  )

  it('says YES on a clean closure — the control', () => {
    expect(checkBrowserGraphAll(plant(CLEAN))).toEqual([])
  })

  it('says YES on the REAL repo — the control that matters', () => {
    // The synthetic control above proves the walker can return empty; this one
    // proves the actual entrypoints are actually clean today. Both are needed:
    // the first can pass against a broken walker, the second can pass against a
    // walker that reads nothing.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    expect(checkBrowserGraphAll(repoRoot)).toEqual([])
  })

  it('refuses a Node builtin ONE hop from the entrypoint', () => {
    const root = plant({
      ...CLEAN,
      'packages/sync/src/replica/index.ts': `export * from './leaf'\n`,
      'packages/sync/src/replica/leaf.ts': `import { readFileSync } from 'node:fs'\nexport const x = readFileSync\n`,
    })
    const v = checkBrowserGraphAll(root)
    expect(v.map((x) => x.specifier)).toEqual(['node:fs'])
  })

  it('refuses a Node builtin THREE hops away — the case a one-hop check cannot see', () => {
    // Rule 8b stops at one hop by design. This rule does not, and that is the
    // whole reason `neutral` is safe here: the tainted module is not named by the
    // entrypoint, nor by anything the entrypoint names.
    const root = plant({
      ...CLEAN,
      'packages/sync/src/replica/index.ts': `export * from './a'\n`,
      'packages/sync/src/replica/a.ts': `export * from './b'\n`,
      'packages/sync/src/replica/b.ts': `export * from './c'\n`,
      'packages/sync/src/replica/c.ts': `import { Database } from 'bun:sqlite'\nexport const x = Database\n`,
    })
    const v = checkBrowserGraphAll(root)
    expect(v.map((x) => x.specifier)).toEqual(['bun:sqlite'])
  })

  it('refuses a node-only WORKSPACE package reached from the closure', () => {
    const root = plant({
      ...CLEAN,
      'packages/sync/src/replica/index.ts': `import { openDatabase } from '@podium/runtime/sqlite'\nexport const x = openDatabase\n`,
    })
    expect(checkBrowserGraphAll(root).map((x) => x.specifier)).toEqual(['@podium/runtime/sqlite'])
  })

  it('refuses an UNRESOLVABLE import — a truncated closure is green for the wrong reason', () => {
    const root = plant({ ...CLEAN, 'packages/sync/src/span.ts': `export * from './gone'\n` })
    const v = checkBrowserGraphAll(root)
    expect(v.map((x) => x.specifier)).toEqual(['./gone'])
    expect(v[0]?.message).toContain('TRUNCATES')
  })

  it('refuses a MISSING entrypoint — an absent file makes the closure vacuously green', () => {
    const { 'packages/sync/src/span.ts': _dropped, ...withoutSpan } = CLEAN
    const v = checkBrowserGraphAll(plant(withoutSpan))
    expect(v.map((x) => x.specifier)).toEqual(['@podium/sync/span'])
  })

  it('does not fire on a type-only Node import (erased at build)', () => {
    const root = plant({
      ...CLEAN,
      'packages/sync/src/replica/index.ts': `import type { Stats } from 'node:fs'\nexport type X = Stats\n`,
    })
    expect(checkBrowserGraphAll(root)).toEqual([])
  })
})

describe('manifest-plane-leak — the browser barrel does not reach the daemon plane (POD-2470)', () => {
  /** A miniature of packages/protocol: a barrel, a domain module it re-exports,
   *  and a daemon entry that owns one module of its own. */
  function plant(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'plane-leak-'))
    for (const [rel, source] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, source)
    }
    return root
  }

  const CLEAN: Record<string, string> = {
    'packages/protocol/src/index.ts': `export * from './messages'\n`,
    'packages/protocol/src/messages/index.ts': `export * from './sync'\n`,
    'packages/protocol/src/messages/sync.ts': `export const Sync = 1\n`,
    'packages/protocol/src/daemon.ts': `export * from './messages/runtime'\n`,
    'packages/protocol/src/messages/runtime.ts': `export const RuntimeEvent = 1\n`,
  }

  it('says YES on a clean split — the control', () => {
    expect(checkPlaneLeakAll(plant(CLEAN))).toEqual([])
  })

  it('says YES on the REAL repo — the control that matters', () => {
    // The synthetic control can pass against a walker that reads nothing; this
    // one proves the actual protocol barrel is actually clean today.
    expect(checkPlaneLeakAll(fileURLToPath(new URL('..', import.meta.url)))).toEqual([])
  })

  it('refuses the ALIASED re-export — the line that defeated the name-level guard', () => {
    // Verbatim the regression a reviewer used to walk through the first
    // attempt at this guard, which compared export NAMES: the daemon-plane
    // value reaches the browser under a name no namespace check was watching
    // for. The edge is identical, so the edge check does not care.
    const root = plant({
      ...CLEAN,
      'packages/protocol/src/messages/index.ts': `export * from './sync'\nexport { RuntimeEvent as BrowserRuntimeEvent } from './runtime'\n`,
    })
    const v = checkPlaneLeakAll(root)
    expect(v.map((x) => x.rule)).toEqual(['manifest-plane-leak'])
    expect(v[0]?.specifier).toBe('packages/protocol/src/messages/runtime.ts')
  })

  it('refuses the leak TWO HOPS down — the shape a barrel-only scan cannot see', () => {
    // The original POD-2470 leak: `sync.ts` parsed one interaction schema out of
    // the daemon-plane module, so nothing the barrel names is the culprit.
    const root = plant({
      ...CLEAN,
      'packages/protocol/src/messages/sync.ts': `import { RuntimeEvent } from './runtime'\nexport const Sync = RuntimeEvent\n`,
    })
    const v = checkPlaneLeakAll(root)
    expect(v.map((x) => x.specifier)).toEqual(['packages/protocol/src/messages/runtime.ts'])
    // The chain, not just the endpoint — the endpoint alone does not tell you
    // which import to go and change.
    expect(v[0]?.message).toContain(
      'packages/protocol/src/index.ts -> packages/protocol/src/messages/index.ts -> ' +
        'packages/protocol/src/messages/sync.ts -> packages/protocol/src/messages/runtime.ts',
    )
  })

  it('protects a NEW daemon-plane module with no edit to this rule', () => {
    // The property that makes this survive the next contract: the forbidden set
    // is read from daemon.ts at check time. POD-1761 W1 added a whole new family
    // and every hand-listed assertion stayed green because none knew to grow.
    const root = plant({
      ...CLEAN,
      'packages/protocol/src/daemon.ts': `export * from './messages/runtime'\nexport * from './messages/shipping'\n`,
      'packages/protocol/src/messages/shipping.ts': `export const ShipEffect = 1\n`,
      'packages/protocol/src/messages/sync.ts': `import { ShipEffect } from './shipping'\nexport const Sync = ShipEffect\n`,
    })
    expect(checkPlaneLeakAll(root).map((x) => x.specifier)).toEqual([
      'packages/protocol/src/messages/shipping.ts',
    ])
  })

  it('refuses the barrel reaching its OWN package by specifier — the route around the walk', () => {
    // The rename defeat's natural successor: don't name './runtime' at all,
    // name '@podium/protocol/daemon'. That is a bare specifier, so a walk that
    // follows relative imports never sees where it lands.
    const root = plant({
      ...CLEAN,
      'packages/protocol/src/messages/index.ts': `export * from './sync'\nexport * from '@podium/protocol/daemon'\n`,
    })
    const v = checkPlaneLeakAll(root)
    expect(v.map((x) => x.specifier)).toEqual(['@podium/protocol/daemon'])
  })

  it('still allows the barrel to import a DIFFERENT workspace', () => {
    // The rule above is about self-reference, not about npm or sibling packages
    // — @podium/model is where the branded ids live and the barrel needs them.
    const root = plant({
      ...CLEAN,
      'packages/protocol/src/messages/sync.ts': `import { SessionIdField } from '@podium/model'\nexport const Sync = SessionIdField\n`,
    })
    expect(checkPlaneLeakAll(root)).toEqual([])
  })

  it('does not fire on a type-only edge (erased at build, no bundle cost)', () => {
    const root = plant({
      ...CLEAN,
      'packages/protocol/src/messages/index.ts': `export * from './sync'\nexport type { RuntimeEvent } from './runtime'\n`,
    })
    expect(checkPlaneLeakAll(root)).toEqual([])
  })

  it('refuses an UNRESOLVABLE import — a truncated closure is green for the wrong reason', () => {
    const root = plant({
      ...CLEAN,
      'packages/protocol/src/messages/sync.ts': `export * from './gone'\n`,
    })
    const v = checkPlaneLeakAll(root)
    expect(v.map((x) => x.specifier)).toEqual(['./gone'])
    expect(v[0]?.message).toContain('TRUNCATES')
  })

  it('refuses a MISSING barrel — an absent entry makes the closure vacuously green', () => {
    const { 'packages/protocol/src/index.ts': _dropped, ...withoutBarrel } = CLEAN
    const v = checkPlaneLeakAll(plant(withoutBarrel))
    expect(v.map((x) => x.rule)).toEqual(['manifest-plane-leak'])
    expect(v[0]?.message).toContain('vacuously green')
  })

  it('refuses an EMPTY forbidden set — a guard that cannot fail is not a guard', () => {
    // If daemon.ts stops owning modules of its own, every leak becomes
    // undetectable and the suite above still reports success. That state has to
    // be a decision someone makes, not one this rule absorbs silently.
    const root = plant({
      ...CLEAN,
      'packages/protocol/src/daemon.ts': `export const nothing = 1\n`,
    })
    const v = checkPlaneLeakAll(root)
    expect(v.map((x) => x.rule)).toEqual(['manifest-plane-leak'])
    expect(v[0]?.message).toContain('EMPTY')
  })
})

// ---------------------------------------------------------------------------
// The STORE BOUNDARY family (POD-3252, epic POD-3221)
//
// Every rule gets a case that FAILS and a case that PASSES, because either one
// alone is worthless: a rule with only failing fixtures might refuse everything,
// and a rule with only passing ones might refuse nothing. Where a rule draws a
// line, both edges are pinned — the last thing included and the first thing
// excluded — since widening is the direction a rule silently loses.
// ---------------------------------------------------------------------------

describe('store-raw-handle (POD-3252 rule 13)', () => {
  // A repository under the store boundary that is NOT on the Stage A ledger, so
  // the rule applies to it in full. Chosen as a path that does not exist rather
  // than a real file, so these cases cannot be broken by a conversion landing.
  const REPO = 'apps/server/src/store/widgets.ts'

  it('flags an import of the raw SQLite handle', () => {
    const vs = checkStoreRawHandles(
      REPO,
      `import type { SqlDatabase } from '@podium/runtime/sqlite'\n`,
    )
    expect(vs.map((v) => v.rule)).toEqual(['store-raw-handle'])
    expect(vs[0]?.specifier).toBe('@podium/runtime/sqlite')
  })

  it('flags a TYPE-ONLY import too — naming the handle is the point', () => {
    // `import type` is erased at build, so a rule that skipped it would let a
    // repository keep `SqlDatabase` in its own signature. That field IS what
    // Stage A's exit gate deletes; erasure is not the criterion.
    expect(
      checkStoreRawHandles(REPO, `import type { SqlDatabase } from '@podium/runtime/sqlite'\n`),
    ).toHaveLength(1)
    expect(
      checkStoreRawHandles(REPO, `import { transaction } from '@podium/runtime/sqlite'\n`),
    ).toHaveLength(1)
  })

  it('flags a prepared statement', () => {
    const vs = checkStoreRawHandles(REPO, `export const f = (db: D) => db.prepare('SELECT 1')\n`)
    expect(vs.map((v) => v.specifier)).toEqual(['.prepare('])
  })

  it('flags a WHOLE raw statement on each of drizzle’s four raw-execution methods', () => {
    for (const method of ['all', 'get', 'run', 'values']) {
      const vs = checkStoreRawHandles(REPO, `const r = db.${method}(sql\`SELECT 1\`)\n`)
      expect(vs.map((v) => v.specifier)).toEqual([`.${method}(sql\`…\`)`])
    }
  })

  it('does NOT flag a `sql` FRAGMENT inside a builder query — the line the rule draws', () => {
    // Spec §6 rule 1: fragments inside builder queries are fine ANYWHERE; only
    // a whole statement handed to a raw-execution method is banned. Getting
    // this edge wrong would ban the epic's own idiom.
    expect(
      checkStoreRawHandles(
        REPO,
        `const r = db.select().from(t).where(sql\`\${t.id} = 1\`).all()\n`,
      ),
    ).toEqual([])
  })

  it('allows only a marked whole UPDATE with the builder-missing SQLite conflict clause', () => {
    for (const algorithm of ['ROLLBACK', 'ABORT', 'FAIL', 'IGNORE', 'REPLACE']) {
      const source = [
        'const result = db.run(',
        '  // UPDATE-CONFLICT STATEMENT POD-3406',
        `  sql\`UPDATE OR ${algorithm} widgets SET value = \${value} WHERE id = \${id}\`,`,
        ')',
      ].join('\n')
      expect(checkStoreRawHandles(REPO, source)).toEqual([])
    }

    const unmarked = `const result = db.run(sql\`UPDATE OR IGNORE widgets SET value = \${value}\`)\n`
    expect(checkStoreRawHandles(REPO, unmarked)).toHaveLength(1)

    for (const statement of [
      'UPDATE widgets SET value = 1',
      'SELECT * FROM widgets',
      'DELETE FROM widgets',
    ]) {
      const falselyMarked = [
        'const result = db.run(',
        '  // UPDATE-CONFLICT STATEMENT POD-3406',
        `  sql\`${statement}\`,`,
        ')',
      ].join('\n')
      expect(checkStoreRawHandles(REPO, falselyMarked)).toHaveLength(1)
    }
  })

  it("allows rule 31b's INSERT OR REPLACE only on the auth path, with the token AND the shape", () => {
    // THREE CONDITIONS, EACH PINNED SEPARATELY. The exception was canaried once
    // by hand at merge time (POD-3403), which proves the checker was right that
    // day and guards nothing afterwards: a later edit that drops the path test or
    // widens the SQL matcher keeps the suite green. OR REPLACE DELETES the
    // conflicting row and fires ON DELETE CASCADE, so the path pin is the part
    // that stops a second destructive site from adopting it by typing the token.
    const AUTH = 'apps/server/src/store/auth.ts'
    const statement = 'INSERT OR REPLACE INTO client_sessions (token_hash) VALUES (${tokenHash})'
    const marked = (sql: string) =>
      ['this.db.run(', '  // REPLACE-STATEMENT POD-3403', `  sql\`${sql}\`,`, ')'].join('\n')

    expect(checkStoreRawHandles(AUTH, marked(statement))).toEqual([])

    // 1. the token, absent
    expect(
      checkStoreRawHandles(AUTH, `this.db.run(sql\`${statement}\`)\n`),
    ).toHaveLength(1)

    // 2. the shape — every other conflict algorithm, and a bare INSERT
    for (const other of [
      'INSERT OR IGNORE INTO client_sessions (token_hash) VALUES (${tokenHash})',
      'INSERT OR ABORT INTO client_sessions (token_hash) VALUES (${tokenHash})',
      'INSERT INTO client_sessions (token_hash) VALUES (${tokenHash})',
      'UPDATE client_sessions SET token_hash = ${tokenHash}',
    ]) {
      expect(checkStoreRawHandles(AUTH, marked(other))).toHaveLength(1)
    }

    // 3. the path — the SAME token and the SAME statement in another repository
    expect(checkStoreRawHandles(REPO, marked(statement))).toHaveLength(1)
  })

  it('flags PRAGMA, sqlite_master and ATTACH inside a `sql` BODY, not just in an import line', () => {
    const constructs = [
      'PRAGMA table_info(sessions)',
      'SELECT * FROM sqlite_master',
      "ATTACH DATABASE 'other.db' AS other",
    ]
    for (const construct of constructs) {
      const vs = checkStoreRawHandles(REPO, `const q = sql\`${construct}\`\n`)
      expect(vs.map((v) => v.rule)).toEqual(['store-raw-handle'])
    }
  })

  it('checks the `sql` body even on an UNCONVERTED file', () => {
    // The ledger excuses a file's RAW HANDLES, never its statements: an
    // unconverted repository that starts writing `sql` templates is exactly
    // where a PRAGMA would arrive looking like progress.
    const ledgered = STAGE_A_UNCONVERTED[0]
    expect(ledgered).toBeDefined()
    expect(
      checkStoreRawHandles(
        ledgered as string,
        `import { transaction } from '@podium/runtime/sqlite'\n`,
      ),
    ).toEqual([])
    expect(
      checkStoreRawHandles(ledgered as string, `const q = sql\`PRAGMA foreign_keys = ON\`\n`),
    ).toHaveLength(1)
  })

  it('does NOT flag the constructs the one-dialect decision keeps', () => {
    // Spec §2.7 / §7.5: both bun:sqlite and Turso accept these, so none of them
    // is a portability problem. A rule that banned them would be enforcing a
    // decision nobody made — and the per-site "an OR REPLACE conversion must
    // name every column" check stays a REVIEWER rule, because it is a property
    // of the column list against the schema.
    const kept = [
      `const q = sql\`SELECT rowid FROM t ORDER BY rowid\`\n`,
      `const q = sql\`INSERT OR REPLACE INTO t (a, b) VALUES (1, 2)\`\n`,
      `const q = sql\`INSERT OR IGNORE INTO t (a) VALUES (1)\`\n`,
      `const q = sql\`SELECT * FROM t WHERE name GLOB 'a*'\`\n`,
      `const q = sql\`INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING RETURNING a\`\n`,
      `const q = sql\`SELECT json_extract(payload, '$.x') FROM t\`\n`,
      `export const id = res.lastInsertRowid\n`,
    ]
    for (const source of kept) expect(checkStoreRawHandles(REPO, source)).toEqual([])
  })

  it('exempts the SearchIndex port, the driver seam and test files — and nothing near them', () => {
    const raw = `import { openDatabase } from '@podium/runtime/sqlite'\nconst s = db.prepare('SELECT 1')\n`
    for (const exempt of [
      'apps/server/src/store/conversations/index.ts',
      'apps/server/src/store/conversations/transcript-index.ts',
      'apps/server/src/store/executor/driver.ts',
      'apps/server/src/store/executor/bun-driver.ts',
      'apps/server/src/store/executor/harness.ts',
      'apps/server/src/store/widgets.test.ts',
      'apps/server/src/store/test-support/seed.ts',
    ]) {
      expect(checkStoreRawHandles(exempt, raw)).toEqual([])
    }
    // The first thing EXCLUDED from each exemption, which is the edge that
    // matters: `conversations/` also holds ordinary repositories (mirror.ts,
    // registry.ts) and `executor/` holds modules that are not the driver, so a
    // `conversations/**` or `executor/**` glob would have carried them along.
    // Named as paths that do not exist, so a conversion landing on a real
    // sibling cannot quietly turn this assertion into a ledger check.
    for (const held of [
      'apps/server/src/store/conversations/widgets.ts',
      'apps/server/src/store/executor/widgets.ts',
    ]) {
      expect(checkStoreRawHandles(held, raw)).toHaveLength(2)
    }
  })

  it('covers the operations store and the sync SQLite adapter, and stops there', () => {
    const raw = `const s = db.prepare('SELECT 1')\n`
    expect(checkStoreRawHandles('apps/server/src/modules/operations/widgets.ts', raw)).toEqual([])
    expect(checkStoreRawHandles('packages/sync/src/adapters/indexeddb/store.ts', raw)).toEqual([])
    // …but a NEW file in the sync SQLite adapter is covered with no edit here.
    expect(checkStoreRawHandles('packages/sync/src/adapters/sqlite/widgets.ts', raw)).toHaveLength(
      1,
    )
  })

  it('honours the one site allowlist, and only on the marked LINE', () => {
    const source = `const a = db.prepare('SELECT 1') // DECISION POD-4242\nconst b = db.prepare('SELECT 2')\n`
    const vs = checkStoreRawHandles(REPO, source)
    expect(vs).toHaveLength(1)
    expect(vs[0]?.message).toContain(`${REPO}:2`)
  })
})

describe('repository-db-capture (POD-3221 B1)', () => {
  const REPO = 'apps/server/src/store/widgets.ts'

  it('defeat: flags a real capture at the this.db line and is wired through checkFile', () => {
    const source = [
      'class WidgetsRepository {',
      '  async insert(row: Row) {',
      '    const db = this.db',
      '    await something()',
      '    db.insert(widgets).values(row).run()',
      '  }',
      '}',
    ].join('\n')
    const violations = checkRepositoryDbCapture(REPO, source)
    expect(violations.map((violation) => violation.rule)).toEqual(['repository-db-capture'])
    expect(violations[0]?.specifier).toBe('db')
    expect(violations[0]?.message).toContain(`${REPO}:3`)
    expect(
      checkFile(REPO, source).some((violation) => violation.rule === 'repository-db-capture'),
    ).toBe(true)
  })

  it('does not mistake a multi-line query result or a comment for a capture', () => {
    const source = [
      '// Never write: const db = this.db',
      'const row = this.db',
      '  .select()',
      '  .from(widgets)',
      '  .where(eq(widgets.id, id))',
      '  .get()',
    ].join('\n')
    expect(checkRepositoryDbCapture(REPO, source)).toEqual([])
  })

  it('is quiet on the real repository', () => {
    expect(realRepoViolations().filter((v) => v.rule === 'repository-db-capture')).toEqual([])
  })
})

describe('store-transaction-port (POD-3252 rule 14)', () => {
  const DRIZZLE_IMPORT = `import { eq } from 'drizzle-orm'\n`

  it('flags drizzle’s own transaction, on the db and on a tx', () => {
    for (const receiver of ['db', 'tx']) {
      const vs = checkDrizzleTransaction(
        'apps/server/src/store/widgets.ts',
        `await ${receiver}.transaction(async (t) => t)\n`,
      )
      expect(vs.map((v) => v.rule)).toEqual(['store-transaction-port'])
    }
  })

  it('flags it OUTSIDE the store too, wherever a drizzle handle can reach', () => {
    const vs = checkDrizzleTransaction(
      'apps/server/src/modules/issues/service.ts',
      `${DRIZZLE_IMPORT}await database.transaction(async (t) => t)\n`,
    )
    expect(vs).toHaveLength(1)
  })

  it('does NOT flag IndexedDB’s transaction — the browser API of the same name', () => {
    // The discriminator is whether a drizzle handle can be in scope at all,
    // which rule 15 makes decidable from the import list. indexeddb/store.ts is
    // excluded because it cannot hold one, not because its path was recognised.
    expect(
      checkDrizzleTransaction(
        'packages/sync/src/adapters/indexeddb/store.ts',
        `const tx = db.transaction([...ALL_STORES], 'readwrite')\n`,
      ),
    ).toEqual([])
  })

  it('does NOT flag the store’s own port, nor the runtime’s free function', () => {
    expect(
      checkDrizzleTransaction(
        'apps/server/src/store/widgets.ts',
        `await this.transact(async () => 1)\n`,
      ),
    ).toEqual([])
    expect(
      checkDrizzleTransaction(
        'apps/server/src/store/widgets.ts',
        `transaction(this.db, () => 1)\n`,
      ),
    ).toEqual([])
  })

  it('does NOT flag a DRIVER, which is the port’s implementation (spec §6 rule 22)', () => {
    // POD-3342: the rule was flagging the one site that must make the call.
    for (const driver of [
      'apps/server/src/store/executor/bun-driver.ts',
      'apps/server/src/store/spike/turso-append/libsql-driver.ts',
      'apps/server/src/store/spike/turso-append/run-proofs.ts',
    ]) {
      expect(
        checkDrizzleTransaction(driver, `${DRIZZLE_IMPORT}await client.transaction('write')\n`),
      ).toEqual([])
    }
  })

  it('STILL flags the scheduler and the executor beside the driver it exempts', () => {
    // The other edge of the same class, and the reason the exemption is a NAMED
    // LIST rather than a directory: `store/executor/` also holds the scheduler
    // and the executor, neither of which may ever open a raw transaction. A
    // directory exemption would blind the rule to the two files it most needs to
    // watch, so a widening to one has to fail here.
    for (const neighbour of [
      'apps/server/src/store/executor/scheduler.ts',
      'apps/server/src/store/executor/executor.ts',
      'apps/server/src/store/spike/turso-append/sync-append.ts',
    ]) {
      const vs = checkDrizzleTransaction(
        neighbour,
        `${DRIZZLE_IMPORT}await client.transaction('write')\n`,
      )
      expect(vs.map((v) => v.rule)).toEqual(['store-transaction-port'])
    }
  })

  it('is quiet on the REAL repository — the control', () => {
    // A rule this broad is only usable if it is silent on the tree it ships
    // with; a red baseline is how a guard gets switched off.
    expect(realRepoViolations().filter((v) => v.rule === 'store-transaction-port')).toEqual([])
  })
})

describe('drizzle-import-home (POD-3252 rule 15)', () => {
  it('flags drizzle imported outside persistence, by any subpath', () => {
    for (const specifier of ['drizzle-orm', 'drizzle-orm/sqlite-core']) {
      const vs = checkDrizzleImportHome(
        'apps/server/src/modules/issues/service.ts',
        `import { eq } from '${specifier}'\n`,
      )
      expect(vs.map((v) => v.rule)).toEqual(['drizzle-import-home'])
      expect(vs[0]?.specifier).toBe(specifier)
    }
  })

  it('allows the four homes, and holds everything else', () => {
    const source = `import { eq } from 'drizzle-orm'\n`
    for (const home of [
      'apps/server/src/store/widgets.ts',
      'apps/server/src/store/conversations/mirror.ts',
      'apps/server/src/modules/operations/store.ts',
      'apps/server/src/migrations/schema.ts',
      'packages/sync/src/adapters/sqlite/schema.ts',
    ]) {
      expect(checkDrizzleImportHome(home, source)).toEqual([])
    }
    // The first thing excluded from each: a SIBLING of the operations store,
    // and the sync adapter's non-SQLite neighbour.
    for (const held of [
      'apps/server/src/modules/operations/service.ts',
      'packages/sync/src/adapters/indexeddb/store.ts',
      'apps/web/src/features/issues/list.tsx',
    ]) {
      expect(checkDrizzleImportHome(held, source)).toHaveLength(1)
    }
  })

  it('does NOT flag a package whose name merely starts the same way', () => {
    expect(
      checkDrizzleImportHome('apps/web/src/x.ts', `import x from 'drizzle-orm-extras'\n`),
    ).toEqual([])
  })

  it('is quiet on the REAL repository — the control', () => {
    expect(realRepoViolations().filter((v) => v.rule === 'drizzle-import-home')).toEqual([])
  })
})

describe('sql-raw-literal (POD-3252 rule 16)', () => {
  const FILE = 'apps/server/src/store/widgets.ts'

  it('flags sql.raw of anything that is not written down as a literal', () => {
    for (const argument of ['column', 'toColumn(x)', '`${table}`', "'a' + b"]) {
      const vs = checkSqlRawLiteral(FILE, `const f = sql.raw(${argument})\n`)
      expect(vs.map((v) => v.rule)).toEqual(['sql-raw-literal'])
    }
  })

  it('allows a literal written in the file — including a template with no hole', () => {
    for (const argument of ["'created_at'", '"created_at"', '`created_at`']) {
      expect(checkSqlRawLiteral(FILE, `const f = sql.raw(${argument})\n`)).toEqual([])
    }
  })

  it('exempts the SearchIndex port, where a dynamic identifier is the job', () => {
    expect(
      checkSqlRawLiteral(
        'apps/server/src/store/conversations/index.ts',
        `const f = sql.raw(column)\n`,
      ),
    ).toEqual([])
  })

  it('is quiet on the REAL repository — the control', () => {
    expect(realRepoViolations().filter((v) => v.rule === 'sql-raw-literal')).toEqual([])
  })
})

describe('store-boundary-ledger (POD-3252, Stage A’s completeness proof)', () => {
  function plantLedger(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'store-ledger-'))
    for (const [rel, source] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, source)
    }
    return root
  }

  it('says YES on the real repository — every listed file is really unconverted', () => {
    // The control that makes the count trustworthy. If this ever fails, the
    // ledger has drifted above the truth and Stage A's progress measure is
    // reporting more work left than exists.
    expect(checkStoreBoundaryLedger(REPO_ROOT)).toEqual([])
  })

  it('refuses SLACK — a listed file that has been converted', () => {
    // The property that keeps the ledger monotone. Without it the agent that
    // converts a repository can leave its line behind and the list stops
    // measuring anything. Every OTHER entry is planted still-unconverted, so
    // the one violation reported is attributable to the one file that changed.
    const converted = STAGE_A_UNCONVERTED[0]
    expect(converted).toBeDefined()
    const unconverted = `import type { SqlDatabase } from '@podium/runtime/sqlite'\n`
    const root = plantLedger(
      Object.fromEntries(
        STAGE_A_UNCONVERTED.map((f) => [
          f,
          f === converted ? `export const clean = 1\n` : unconverted,
        ]),
      ),
    )
    const v = checkStoreBoundaryLedger(root)
    expect(v.map((x) => x.file)).toEqual([converted])
    expect(v[0]?.rule).toBe('store-boundary-ledger')
    expect(v[0]?.message).toContain('CONVERTED')
  })

  it('refuses a STALE entry — a listed file that no longer exists', () => {
    const v = checkStoreBoundaryLedger(plantLedger({}))
    expect(v.length).toBe(STAGE_A_UNCONVERTED.length)
    expect(v.every((x) => x.message.includes('does not exist'))).toBe(true)
  })

  it('every entry is inside the store boundary — an entry outside exempts nothing', () => {
    for (const entry of STAGE_A_UNCONVERTED) {
      expect(
        entry.startsWith('apps/server/src/store/') ||
          entry.startsWith('packages/sync/src/adapters/sqlite/') ||
          entry === 'apps/server/src/modules/operations/store.ts',
      ).toBe(true)
    }
  })

  it('names the executor legacy field’s module, so the ledger and the exit gate empty together', () => {
    // Stage A's exit gate is two clauses — "lint family green" AND "the
    // executor's legacy field deleted" (method §5). `executor.ts` is on the
    // ledger precisely because its `readonly legacy: SqlDatabase | undefined`
    // is that field, so the second clause cannot be met while the first is not.
    expect(STAGE_A_UNCONVERTED).toContain('apps/server/src/store/executor/executor.ts')
  })
})

describe('flip-undeleted (POD-3221 B1 exit gate)', () => {
  function plantFile(file: string, source: string): string {
    const root = mkdtempSync(join(tmpdir(), 'flip-undeleted-'))
    const abs = join(root, file)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, source)
    return root
  }

  it('finds every listed transitional construct on the real tree', () => {
    expect(checkFlipUndeleted(REPO_ROOT)).toEqual([])
    expect(FLIP_UNDELETED.map(({ file, construct, issue }) => [file, construct, issue])).toEqual([
      ['packages/runtime/src/sqlite/transaction.ts', 'the `podium_sp_` savepoints', 'POD-3267'],
      ['packages/runtime/src/sqlite/transaction.ts', 'the `depths` WeakMap', 'POD-3267'],
      ['apps/server/src/store/executor/synchronous-span.ts', '`runSynchronousSpan`', 'POD-3327'],
      [
        'apps/server/src/store/executor/legacy-handle-probe.ts',
        'the whole legacy-handle probe file',
        'POD-3326',
      ],
      [
        'apps/server/src/store/executor/executor.ts',
        'the `StoreExecutor.legacy` readonly field',
        'POD-3267',
      ],
    ])
  })

  it('defeat: fires naming a listed construct deleted from a scratch copy', () => {
    const entry = FLIP_UNDELETED.find(({ construct }) => construct === 'the `depths` WeakMap')
    expect(entry?.target.kind).toBe('code')
    if (entry?.target.kind !== 'code') throw new Error('missing depths ledger entry')
    const source = readFileSync(join(REPO_ROOT, entry.file), 'utf8')
    const deleted = source.replace(entry.target.pattern, 'const removedDepths = new Map<')
    expect(deleted).not.toBe(source)
    const root = plantFile(
      entry.file,
      `${deleted}\n// const depths = new WeakMap<SqlTransactionScope, number>()\n`,
    )
    try {
      const violations = checkFlipUndeleted(root, [entry])
      expect(violations.map((violation) => violation.rule)).toEqual(['flip-undeleted'])
      expect(violations[0]?.file).toBe(entry.file)
      expect(violations[0]?.message).toContain(entry.construct)
      expect(violations[0]?.message).toContain(entry.issue)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('defeat: fires for a bogus entry naming a construct that never existed', () => {
    const bogus: FlipUndeletedEntry = {
      file: 'packages/runtime/src/sqlite/transaction.ts',
      construct: '`neverExistedFlipBridge`',
      issue: 'POD-3263',
      target: { kind: 'code', pattern: /\bneverExistedFlipBridge\b/ },
    }
    const violations = checkFlipUndeleted(REPO_ROOT, [...FLIP_UNDELETED, bogus])
    expect(violations).toHaveLength(1)
    expect(violations[0]?.specifier).toBe(bogus.construct)
    expect(violations[0]?.message).toContain(bogus.issue)
  })
})

describe('store-boundary family vs the write-announcement seam (POD-3247)', () => {
  const SEAM = 'apps/server/src/store/table-writes.ts'

  it('leaves the seam alone — it is clean, and NOT on the ledger', () => {
    // POD-3247's `TableWrites` has no production caller ON PURPOSE: POD-3246
    // retired the one writer it was built for, the shape survives the writer,
    // and the conversion waves are what will call it. Nothing in this family
    // asks whether a seam is called — but pinning it by path means a future
    // widening that starts flagging it fails here instead of getting the
    // mechanism deleted.
    const source = readFileSync(join(REPO_ROOT, SEAM), 'utf8')
    expect(checkStoreRawHandles(SEAM, source)).toEqual([])
    expect(checkDrizzleTransaction(SEAM, source)).toEqual([])
    expect(checkDrizzleImportHome(SEAM, source)).toEqual([])
    expect(checkSqlRawLiteral(SEAM, source)).toEqual([])
    expect(STAGE_A_UNCONVERTED).not.toContain(SEAM)
  })

  it('is clean DESPITE naming sqlite_master and prepare in its prose', () => {
    // The seam's docstring explains the bug it replaces: "the boot upgrades
    // build SQL from `sqlite_master` on the raw handle" and "a `prepare`
    // wrapper that dropped the cache". A grep would flag both. Documenting the
    // prohibition must not trip the lint enforcing it — the same treatment
    // checkSyncKernelPurity gives its DOM globals, and this file is the live
    // case that would catch a regression in it.
    const source = readFileSync(join(REPO_ROOT, SEAM), 'utf8')
    expect(source).toContain('sqlite_master')
    expect(source).toContain('prepare')
    expect(checkStoreRawHandles(SEAM, source)).toEqual([])
    // …and the same two constructs in CODE are still refused.
    expect(
      checkStoreRawHandles(SEAM, `const q = sql\`SELECT name FROM sqlite_master\`\n`),
    ).toHaveLength(1)
    expect(checkStoreRawHandles(SEAM, `const s = db.prepare('SELECT 1')\n`)).toHaveLength(1)
  })
})

describe('cache-table-announcement — the seam is real, the guarantee was not (POD-3362)', () => {
  /**
   * A file OUTSIDE the store boundary, so the fixtures below prove this rule's
   * scope is "anything under apps/ or packages/" rather than a store rule that
   * happens to be quiet elsewhere. The failure it exists for is a writer nobody
   * expected, and the place nobody expects one is outside the store directory.
   */
  const OUTSIDER = 'apps/server/src/modules/repos/backfill.ts'

  const write = (sql: string): string => `await client.run(\`${sql}\`)\n`
  const announce = (table: string): string => `store.tableWrites.wrote('${table}')\n`

  it('is quiet on the real repository', () => {
    // The control. This rule's correct count on this tree is ZERO — POD-3246
    // retired the last outside writer of `repos` — so every other assertion in
    // this block is about a fixture, and this is the only one that says the rule
    // ships green. Without it, a rule that fired on half the tree would still
    // pass every fixture below.
    expect(realRepoViolations().filter((v) => v.rule === 'cache-table-announcement')).toEqual([])
  })

  describe('a writer that FORGETS, in each spelling the rule claims to catch', () => {
    // THE MUTATION, AS FIXTURES. A guard whose only evidence is the control
    // above has proven that it ran. Each case here is the POD-3292 finding
    // written as source: a write to a cache-owning table with no announcement,
    // after which `listRepos()` serves the pre-write rows for the life of the
    // process. The reviewer's model was a no-op callback; this is the same
    // mutation moved one step earlier, to the caller that never made the call.
    it.each([
      ['INSERT', write("INSERT INTO repos (path) VALUES ('/a')")],
      ['INSERT OR IGNORE', write("INSERT OR IGNORE INTO repos (path) VALUES ('/a')")],
      ['UPDATE', write("UPDATE repos SET path = '/b' WHERE path = '/a'")],
      ['UPDATE OR IGNORE', write("UPDATE OR IGNORE repos SET path = '/b'")],
      ['DELETE', write("DELETE FROM repos WHERE path = '/a'")],
      ['REPLACE', write("REPLACE INTO repos (path) VALUES ('/a')")],
      // The spelling this epic is CONVERTING TO. A rule that read only SQL text
      // would go quiet at exactly the wave that introduces the risk.
      ['drizzle builder', 'await db.update(repos).set({ path: "/b" })\n'],
      ['drizzle builder, namespaced', 'await db.delete(schema.repos)\n'],
      ['drizzle insert', 'await db.insert(repos).values({ path: "/a" })\n'],
    ])('refuses a %s that never announces', (_spelling, source) => {
      const violations = checkCacheTableAnnouncement(OUTSIDER, source)
      expect(violations).toHaveLength(1)
      expect(violations[0]?.specifier).toBe('repos')
      expect(violations[0]?.message).toContain('never announces it')
    })

    it('catches the second table too, by its own schema symbol', () => {
      const violations = checkCacheTableAnnouncement(
        OUTSIDER,
        'await db.update(repoPrefixes).set({ prefix: "p" })\n',
      )
      expect(violations).toHaveLength(1)
      expect(violations[0]?.specifier).toBe('repo_prefixes')
    })

    it('reports each cache-owning table separately when a writer touches both', () => {
      const violations = checkCacheTableAnnouncement(
        OUTSIDER,
        write('DELETE FROM repos WHERE 1') + write('DELETE FROM repo_prefixes WHERE 1'),
      )
      expect(violations.map((v) => v.specifier).sort()).toEqual(['repo_prefixes', 'repos'])
    })
  })

  describe('ordering — announcing is not the same as announcing AFTER', () => {
    // The other half of the same window, and the direction that is easy to get
    // backwards. INSIDE `ReposRepository` the invalidation goes BEFORE the write
    // (`store-repos-registry-cache-writers.test.ts` enforces that, and refuses a
    // cached read in between). OUTSIDE it the announcement goes AFTER, because
    // an announcement raised first leaves the write itself inside the window: a
    // read taken between the drop and the write re-holds rows the write is about
    // to make wrong. Same window, read from the two sides.
    it('accepts a write followed by its announcement', () => {
      expect(
        checkCacheTableAnnouncement(
          OUTSIDER,
          write('DELETE FROM repos WHERE 1') + announce('repos'),
        ),
      ).toEqual([])
    })

    it('refuses a write whose only announcement comes first', () => {
      const violations = checkCacheTableAnnouncement(
        OUTSIDER,
        announce('repos') + write('DELETE FROM repos WHERE 1'),
      )
      expect(violations).toHaveLength(1)
      expect(violations[0]?.message).toContain('comes BEFORE that write')
    })

    it('reads the LAST write, so an announcement between two writes is not enough', () => {
      // The loop-shaped mistake: announce after the first write, add a second
      // write later, and a rule that accepted "some announcement after some
      // write" would stay green.
      expect(
        checkCacheTableAnnouncement(
          OUTSIDER,
          write('DELETE FROM repos WHERE 1') +
            announce('repos') +
            write("INSERT INTO repos (path) VALUES ('/a')"),
        ),
      ).toHaveLength(1)
    })

    it('requires the announcement to name THIS table', () => {
      // The counterfactual for the whole rule: if any announcement satisfied any
      // write, `wrote('sessions')` would clear a `repos` write and the rule would
      // be about nothing. `store/repos-read-cost.test.ts` asserts the runtime
      // half of exactly this.
      expect(
        checkCacheTableAnnouncement(
          OUTSIDER,
          write('DELETE FROM repos WHERE 1') + announce('sessions'),
        ),
      ).toHaveLength(1)
    })
  })

  describe('scope — who is exempt, and why each one is', () => {
    it('exempts the owner, which is guarded harder and in the other direction', () => {
      // `store/repos.ts` writes both tables constantly and announces neither: it
      // calls `invalidateRegistry()` BEFORE each write instead, which is its own
      // source scan's rule. Flagging it here would demand the opposite of what
      // that scan demands, and one of the two would get switched off.
      const owner = 'apps/server/src/store/repos.ts'
      expect(
        checkCacheTableAnnouncement(owner, readFileSync(join(REPO_ROOT, owner), 'utf8')),
      ).toEqual([])
    })

    it('exempts the migrations, which run before the cache holds a read', () => {
      expect(
        checkCacheTableAnnouncement(
          'apps/server/src/migrations/heal-repos.ts',
          write('UPDATE repos SET machine_id = ?'),
        ),
      ).toEqual([])
    })

    it('exempts tests, and everything outside apps/ and packages/', () => {
      const source = write('DELETE FROM repos WHERE 1')
      expect(checkCacheTableAnnouncement('apps/server/src/store/repos.test.ts', source)).toEqual([])
      expect(checkCacheTableAnnouncement('scripts/seed-repos.ts', source)).toEqual([])
    })

    it('honours the one allowlist token, on the write line', () => {
      expect(
        checkCacheTableAnnouncement(
          OUTSIDER,
          "await client.run('DELETE FROM repos WHERE 1') // DECISION POD-3362\n",
        ),
      ).toEqual([])
    })
  })

  describe('what a bare name match would have cost', () => {
    it('does not fire on a READ of a cache-owning table', () => {
      // A read is the ordinary case and must stay silent, or the rule becomes
      // noise and stops being read.
      expect(
        checkCacheTableAnnouncement(OUTSIDER, write('SELECT path FROM repos ORDER BY rowid')),
      ).toEqual([])
    })

    it('does not fire on the table name in prose or in documentation strings', () => {
      // `packages/model/src/annotations/matrix.ts` really does hold
      // "Repo / prefix (`repos`, `repo_prefixes`)" in a string literal, and
      // `stripComments` does not strip strings. Requiring the VERB in front of
      // the name is what keeps that file out, and it is the live case.
      expect(
        checkCacheTableAnnouncement(
          'packages/model/src/annotations/matrix.ts',
          "const title = 'Repo / prefix (`repos`, `repo_prefixes`)'\n// deletes from repos\n",
        ),
      ).toEqual([])
    })

    it('does not fire on a table whose name merely STARTS with a listed one', () => {
      // `repos` is a prefix of `repos_archive`; the word boundary is what stops
      // this rule demanding an announcement for a table with no cache over it.
      expect(
        checkCacheTableAnnouncement(OUTSIDER, write('DELETE FROM repos_archive WHERE 1')),
      ).toEqual([])
    })
  })
})
