import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyAllowlist, BROWSER_ENTRYPOINTS, partitionAllowlist } from './architecture-manifest'
import { BOUNDARY_ALLOWLIST } from './boundary-allowlist'
import {
  checkBrowserGraphAll,
  checkDeclaredDeps,
  checkFile,
  checkHarnessClassifierBoundary,
  checkHostEdgeSeparationAll,
  checkManifestFile,
  checkPrincipalFree,
  checkSessionBindingFieldAccess,
  checkUiStorageOwnership,
  clauseIsTypeOnly,
  extractImports,
  loadModelExportNames,
} from './check-boundaries'

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
        'apps/web/src/lib/shadow/runner.ts',
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
