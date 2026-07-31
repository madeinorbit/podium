import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyAllowlist, partitionAllowlist } from './architecture-manifest'
import { BOUNDARY_ALLOWLIST } from './boundary-allowlist'
import {
  checkDeclaredDeps,
  checkFile,
  checkHostEdgeSeparationAll,
  checkManifestFile,
  checkPrincipalFree,
  checkRuntimeBarrelPurity,
  checkSessionBindingFieldAccess,
  checkSyncBrowserGraphAll,
  clauseIsTypeOnly,
  extractImports,
  loadModelExportNames,
  SYNC_BROWSER_ENTRYPOINTS,
} from './check-boundaries'

describe('extractImports', () => {
  it('extracts value, type-only, side-effect, export-from and dynamic imports', () => {
    const src = [
      `import { a } from '@podium/runtime'`,
      `import type { AppRouter } from '@podium/server'`,
      `import '@podium/protocol'`,
      `export { b } from '@podium/agent-bridge'`,
      `const m = await import('@podium/terminal-client')`,
      `const n = require('@podium/client-core')`,
    ].join('\n')
    const refs = extractImports(src)
    expect(refs.map((r) => r.specifier)).toEqual([
      '@podium/runtime',
      '@podium/server',
      '@podium/protocol',
      '@podium/agent-bridge',
      '@podium/terminal-client',
      '@podium/client-core',
    ])
    expect(refs.map((r) => r.typeOnly)).toEqual([false, true, false, false, false, false])
  })

  it('handles multiline import clauses', () => {
    const src = `import {\n  fileChainSource,\n  fileIdFor,\n} from '@podium/agent-bridge'`
    expect(extractImports(src)).toEqual([{ specifier: '@podium/agent-bridge', typeOnly: false }])
  })

  it('ignores specifiers that only appear in comments', () => {
    // Mirrors apps/server/src/model-probe.ts and apps/web/src/derive.ts, which
    // mention agent-bridge in prose only.
    const src = [
      `// Kept in apps/server (rather than @podium/agent-bridge) so ...`,
      `/* see '@podium/agent-bridge' agentLaunchCommand */`,
      `import { z } from 'zod'`,
    ].join('\n')
    expect(extractImports(src)).toEqual([{ specifier: 'zod', typeOnly: false }])
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

  it('allows the grandfathered type-only web→server AppRouter import', () => {
    const v = checkFile('apps/web/src/trpc.ts', `import type { AppRouter } from '@podium/server'`)
    expect(v).toEqual([])
  })

  it('rejects a runtime web→server import', () => {
    const v = checkFile('apps/web/src/trpc.ts', `import { appRouter } from '@podium/server'`)
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('no-app-to-app')
    expect(v[0].message).toContain('type-only')
  })

  it('rejects any other app→app import, even type-only', () => {
    const v = checkFile('apps/server/src/x.ts', `import type { Y } from '@podium/daemon'`)
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('no-app-to-app')
  })

  it('rejects relative imports that cross into another app (non-test files)', () => {
    const v = checkFile('apps/server/src/x.ts', `import { repoOp } from '../../daemon/src/repo-op'`)
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('no-app-to-app')
  })

  it('exempts e2e test files from the app→app rule', () => {
    const v = checkFile(
      'apps/server/src/agent-relay-e2e.test.ts',
      `import { agentRelay } from '../../daemon/src/agent-relay'`,
    )
    expect(v).toEqual([])
  })

  it('allows agent-bridge imports from daemon, scripts and its own tests', () => {
    for (const file of [
      'apps/daemon/src/daemon.ts',
      'scripts/daemon.ts',
      'packages/agent-bridge/test/pty-behavior/abduco.bun.test.ts',
    ]) {
      expect(checkFile(file, `import { x } from '@podium/agent-bridge'`)).toEqual([])
    }
  })

  it('rejects agent-bridge importers in apps/server (Phase 3 removed the grandfathers)', () => {
    for (const file of [
      'apps/server/src/relay.ts',
      'apps/server/src/transcript-indexer.ts',
      'apps/server/src/modules/conversations/service.ts',
    ]) {
      const v = checkFile(file, `import { fileChainSource } from '@podium/agent-bridge'`)
      expect(v).toHaveLength(1)
      expect(v[0].rule).toBe('agent-bridge-consumers')
    }
  })

  // Ported from main (POD-808) during the POD-1246 catch-up: integration had
  // near-leaf coverage for transcript but none for the protocol/model pair, which
  // is the edge ADR 8 actually turns on. Kept because a rule with no test is a
  // rule that can be narrowed silently.
  it('keeps protocol near-leaf: model only, nothing else [POD-808]', () => {
    // The one allowed workspace edge: L1 frames compose the L0 vocabulary.
    expect(
      checkFile('packages/protocol/src/index.ts', `import { Revision } from '@podium/model'`),
    ).toEqual([])
    // Everything else stays refused — the leaf property that actually matters.
    const p = checkFile('packages/protocol/src/index.ts', `import { z } from '@podium/runtime'`)
    expect(p).toHaveLength(1)
    expect(p[0].rule).toBe('restricted-package-deps')
  })

  it('keeps model a true leaf [POD-808]', () => {
    const m = checkFile('packages/model/src/index.ts', `import { x } from '@podium/protocol'`)
    expect(m).toHaveLength(1)
    expect(m[0].rule).toBe('leaf-package')
  })

  it('allows @podium/transcript from apps and packages, and keeps it near-leaf', () => {
    expect(
      checkFile(
        'apps/server/src/transcript-indexer.ts',
        `import { claudeRecordToItems } from '@podium/transcript'`,
      ),
    ).toEqual([])
    expect(
      checkFile(
        'packages/transcript/src/source.ts',
        `import type { TranscriptItem } from '@podium/protocol'`,
      ),
    ).toEqual([])
    const core = checkFile(
      'packages/transcript/src/source.ts',
      `import { openDatabase } from '@podium/runtime/sqlite'`,
    )
    expect(core).toHaveLength(1)
    expect(core[0].rule).toBe('restricted-package-deps')
    const bridge = checkFile(
      'packages/transcript/src/file-chain.ts',
      `import { locateClaudeSessionFile } from '@podium/agent-bridge'`,
    )
    expect(bridge.map((v) => v.rule)).toContain('restricted-package-deps')
  })

  it('rejects new agent-bridge importers (not grandfathered)', () => {
    const v = checkFile(
      'apps/server/src/model-probe.ts',
      `import { agentLaunchCommand } from '@podium/agent-bridge'`,
    )
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('agent-bridge-consumers')
    const web = checkFile('apps/web/src/derive.ts', `import { x } from '@podium/agent-bridge'`)
    expect(web).toHaveLength(1)
    expect(web[0].rule).toBe('agent-bridge-consumers')
  })

  it('rejects subpath imports of agent-bridge too', () => {
    const v = checkFile('apps/web/src/x.ts', `import { y } from '@podium/agent-bridge/pty'`)
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('agent-bridge-consumers')
  })

  it('forbids apps/cli from importing server or daemon code (the CLI boundary)', () => {
    for (const spec of ['@podium/server', '@podium/daemon', '../../server/src/server']) {
      const v = checkFile('apps/cli/src/cli.ts', `import { x } from '${spec}'`)
      expect(v, spec).toHaveLength(1)
      expect(v[0].rule).toBe('no-app-to-app')
    }
    expect(
      checkFile(
        'apps/cli/src/issue-cli.ts',
        `import { ISSUE_COMMANDS, makeRelayIssueClient } from '@podium/issue-client'\nimport { loadConfig } from '@podium/runtime/config'`,
      ),
    ).toEqual([])
  })

  it('keeps the issue-client seam free of app/IO deps', () => {
    const v = checkFile(
      'packages/issue-client/src/commands.ts',
      `import { x } from '@podium/agent-bridge'`,
    )
    expect(v.map((f) => f.rule)).toContain('restricted-package-deps')
    expect(
      checkFile(
        'packages/issue-client/src/commands.ts',
        `import type { IssueStage } from '@podium/protocol'`,
      ),
    ).toEqual([])
  })

  it('keeps domain a leaf package', () => {
    const d = checkFile(
      'packages/model/src/issue-stage.ts',
      `import type { IssueWire } from '@podium/protocol'`,
    )
    expect(d).toHaveLength(1)
    expect(d[0].rule).toBe('leaf-package')
    expect(
      checkFile('apps/server/src/issues.ts', `import { isIssueClosed } from '@podium/model'`),
    ).toEqual([])
  })

  it('keeps @podium/model the true leaf', () => {
    const m = checkFile('packages/model/src/index.ts', `import { z } from '@podium/runtime'`)
    expect(m).toHaveLength(1)
    expect(m[0].rule).toBe('leaf-package')
  })

  it('lets protocol import model and nothing else (POD-300)', () => {
    // Protocol stopped being a leaf when its entity schemas moved to L0 model:
    // it holds only frames now and imports those schemas. That ONE edge is
    // allowed; every other workspace import is still a violation.
    expect(
      checkFile(
        'packages/protocol/src/messages/issues.ts',
        `import { IssueWire } from '@podium/model'`,
      ),
    ).toEqual([])
    const p = checkFile('packages/protocol/src/index.ts', `import { z } from '@podium/runtime'`)
    expect(p).toHaveLength(1)
    expect(p[0].rule).toBe('restricted-package-deps')
  })

  it('restricts @podium/runtime to the protocol/domain leaves', () => {
    // Allowed: protocol and domain (e.g. domain's normalizeOriginUrl).
    expect(
      checkFile('packages/runtime/src/settings.ts', `import type { T } from '@podium/protocol'`),
    ).toEqual([])
    expect(
      checkFile(
        'packages/runtime/src/git.ts',
        `export { normalizeOriginUrl } from '@podium/model'`,
      ),
    ).toEqual([])
    // Disallowed: any other workspace package.
    const c = checkFile(
      'packages/runtime/src/settings.ts',
      `import { something } from '@podium/client-core'`,
    )
    expect(c).toHaveLength(1)
    expect(c[0].rule).toBe('restricted-package-deps')
    // Intra-package and external imports are fine.
    expect(
      checkFile('packages/runtime/src/index.ts', `import { z } from 'zod'\nimport './settings.js'`),
    ).toEqual([])
  })

  it('rejects packages importing from apps, by name or relative path', () => {
    const byName = checkFile(
      'packages/client-core/src/x.ts',
      `import type { AppRouter } from '@podium/server'`,
    )
    expect(byName).toHaveLength(1)
    expect(byName[0].rule).toBe('packages-no-apps')
    const relativePath = checkFile(
      'packages/client-core/src/x.ts',
      `import { store } from '../../../apps/server/src/store'`,
    )
    expect(relativePath).toHaveLength(1)
    expect(relativePath[0].rule).toBe('packages-no-apps')
  })

  it('permits normal app→package and package→package edges', () => {
    expect(
      checkFile(
        'apps/web/src/store.tsx',
        `import { groupSessions } from '@podium/client-core/focus'\nimport type { SessionMeta } from '@podium/protocol'`,
      ),
    ).toEqual([])
    expect(
      checkFile(
        'packages/client-core/src/transport.ts',
        `import { WIRE_VERSION } from '@podium/protocol'`,
      ),
    ).toEqual([])
  })
})

describe('server role tiers (core → hub → cloud, apps/server/src/roles.ts)', () => {
  it('flags core importing hub', () => {
    const v = checkFile(
      'apps/server/src/relay.ts',
      `import { PairingManager } from './hub/pairing'`,
    )
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('server-role-tiers')
    // Nested core files too (the resolver walks ../).
    const nested = checkFile(
      'apps/server/src/modules/machines/service.ts',
      `import { PairingManager } from '../../hub/pairing'`,
    )
    expect(nested).toHaveLength(1)
    expect(nested[0].rule).toBe('server-role-tiers')
  })

  it('allows hub importing core, and core importing core', () => {
    expect(
      checkFile(
        'apps/server/src/hub/pairing.ts',
        `import { sha256 } from '../modules/machines/service'`,
      ),
    ).toEqual([])
    expect(
      checkFile('apps/server/src/relay.ts', `import { EventBus } from './modules/bus'`),
    ).toEqual([])
  })

  it('exempts composition roots and test files for hub — they assemble/inject', () => {
    expect(
      checkFile('apps/server/src/server.ts', `import { PairingManager } from './hub/pairing'`),
    ).toEqual([])
    expect(
      checkFile(
        'apps/server/src/router.ts',
        `import { buildJoinCommand } from './hub/machines-join'`,
      ),
    ).toEqual([])
    expect(
      checkFile('apps/server/src/relay.test.ts', `import { PairingManager } from './hub/pairing'`),
    ).toEqual([])
  })

  it('bans cloud/ imports for EVERYONE — core, hub, composition roots, tests', () => {
    for (const file of [
      'apps/server/src/relay.ts',
      'apps/server/src/hub/pairing.ts',
      'apps/server/src/server.ts',
      'apps/server/src/relay.test.ts',
    ]) {
      const spec = file.includes('/hub/') ? '../cloud/billing' : './cloud/billing'
      const v = checkFile(file, `import { bill } from '${spec}'`)
      expect(v).toHaveLength(1)
      expect(v[0].rule).toBe('server-role-tiers')
      expect(v[0].message).toContain('plugins.ts seam')
    }
  })

  it('ignores files outside apps/server/src and non-relative specifiers', () => {
    expect(checkFile('apps/web/src/hub/x.ts', `import { y } from './thing'`)).toEqual([])
    expect(
      checkFile('apps/server/src/relay.ts', `import { loadConfig } from '@podium/runtime/config'`),
    ).toEqual([])
  })
})

describe('rule 7 — @podium/model single-home for its predicates', () => {
  const domainNames = new Set(['isSnoozed', 'worktreeForCwd'])

  it('flags a packages/* file that REDECLARES a domain-exported name', () => {
    const v = checkFile(
      'packages/client-core/src/viewmodels/derive.ts',
      `export function isSnoozed(s, now) { return false }`,
      domainNames,
    )
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('model-single-home')
    expect(v[0].message).toContain('isSnoozed')

    const c = checkFile(
      'packages/client-core/src/viewmodels/derive.ts',
      `export const worktreeForCwd = (cwd, paths) => null`,
      domainNames,
    )
    expect(c).toHaveLength(1)
    expect(c[0].rule).toBe('model-single-home')
  })

  it('allows re-exporting the imported binding under the same name', () => {
    expect(
      checkFile(
        'packages/client-core/src/viewmodels/derive.ts',
        `import { isSnoozed } from '@podium/model'\nexport { isSnoozed }`,
        domainNames,
      ),
    ).toEqual([])
    expect(
      checkFile(
        'packages/client-core/src/viewmodels/derive.ts',
        `export { isSnoozed } from '@podium/model'`,
        domainNames,
      ),
    ).toEqual([])
  })

  it('is a no-op with an empty domain-names set (existing checkFile callers unaffected)', () => {
    expect(
      checkFile(
        'packages/client-core/src/viewmodels/derive.ts',
        `export function isSnoozed(s, now) { return false }`,
      ),
    ).toEqual([])
  })

  it('exempts @podium/model itself and test files', () => {
    expect(
      checkFile(
        'packages/model/src/snooze.ts',
        `export function isSnoozed(row, now) { return false }`,
        domainNames,
      ),
    ).toEqual([])
    expect(
      checkFile(
        'packages/client-core/src/viewmodels/derive.test.ts',
        `export function isSnoozed(s, now) { return false }`,
        domainNames,
      ),
    ).toEqual([])
  })

  it('never flags apps/* — the rule patrols the package layer only', () => {
    expect(
      checkFile(
        'apps/web/src/derive.ts',
        `export function isSnoozed(s, now) { return false }`,
        domainNames,
      ),
    ).toEqual([])
  })

  it('loadModelExportNames reads the real @podium/model source', () => {
    const repoRoot = new URL('..', import.meta.url).pathname
    const names = loadModelExportNames(repoRoot)
    expect(names.has('isSnoozed')).toBe(true)
    expect(names.has('worktreeForCwd')).toBe(true)
    expect(names.has('isIssueClosed')).toBe(true)
  })
})

describe('rule 8 — @podium/runtime browser-safety', () => {
  it('rejects apps/web importing any @podium/runtime subpath', () => {
    const v = checkFile('apps/web/src/x.ts', `import { z } from '@podium/runtime/config'`)
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('runtime-browser-safety')
    expect(v[0].message).toContain('subpath')
  })

  it('allows apps/web bare-importing @podium/runtime', () => {
    expect(
      checkFile('apps/web/src/x.ts', `import { normalizeOriginUrl } from '@podium/runtime'`),
    ).toEqual([])
  })

  it('lets every other workspace use @podium/runtime subpaths freely', () => {
    expect(
      checkFile('apps/server/src/x.ts', `import { loadConfig } from '@podium/runtime/config'`),
    ).toEqual([])
    expect(
      checkFile('apps/daemon/src/x.ts', `import { openDatabase } from '@podium/runtime/sqlite'`),
    ).toEqual([])
  })

  it('checkRuntimeBarrelPurity passes clean against the real repo (git/settings are node-free)', () => {
    const repoRoot = new URL('..', import.meta.url).pathname
    expect(checkRuntimeBarrelPurity(repoRoot)).toEqual([])
  })

  it('checkRuntimeBarrelPurity is a no-op when the barrel file cannot be read', () => {
    expect(checkRuntimeBarrelPurity('/nonexistent/repo/root')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// harness-principal-free (POD-397) — packages/harness must stay a library about
// SOFTWARE, never about who is allowed to use it.
// ---------------------------------------------------------------------------

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

  it('does NOT flag AgentCapabilities — that is the harness capability descriptor', () => {
    // The two senses of "capability" collide exactly here. A rule that flagged
    // this would be uselessly noisy AND would teach the next contributor that the
    // harness capability table is an authorization concept, which it is not.
    expect(
      checkPrincipalFree(HARNESS, `import type { AgentCapabilities } from '@podium/protocol'`),
    ).toEqual([])
    expect(
      checkPrincipalFree(HARNESS, `import { AGENT_CAPABILITIES } from '@podium/protocol'`),
    ).toEqual([])
  })

  it('only looks at import clauses, not at local names', () => {
    expect(checkPrincipalFree(HARNESS, `const grantedScopes = 1`)).toEqual([])
    expect(checkPrincipalFree(HARNESS, `function authorize() {}`)).toEqual([])
  })

  it('applies only to the principal-free workspaces', () => {
    expect(
      checkPrincipalFree('apps/server/src/x.ts', `import type { UserId } from '@podium/protocol'`),
    ).toEqual([])
    // The pty half is guarded too, until POD-399 deletes it.
    expect(
      checkPrincipalFree(
        'packages/agent-bridge/src/session.ts',
        `import type { UserId } from '@podium/protocol'`,
      ),
    ).toHaveLength(1)
  })

  it('passes clean against the REAL packages/harness tree', () => {
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
    const files = walk('packages/harness/src')
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
    expect(violations[0].rule).toBe('host-edge-separation')
    expect(violations[0].message).toContain('must not import')
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

describe('rule 12a — browser-safe workspaces reach @podium/sync only through a declared entrypoint', () => {
  it('refuses the BARE BARREL from a browser-safe workspace', () => {
    // The barrel value-exports the Authority, the Ledger, mirror.ts and the
    // SQLite repository. This is the exact edge the node-only tag used to refuse.
    const v = checkManifestFile(
      'apps/web/src/boot.ts',
      `import { createIndexedDbReplicaStore } from '@podium/sync'`,
    )
    expect(v.map((x) => x.rule)).toEqual(['sync-browser-reach'])
    expect(v[0]?.message).toContain('BARREL')
  })

  it('refuses an UNDECLARED subpath', () => {
    const v = checkManifestFile(
      'apps/mobile/src/boot.ts',
      `import { Authority } from '@podium/sync/authority/index'`,
    )
    expect(v.map((x) => x.rule)).toEqual(['sync-browser-reach'])
  })

  it('ALLOWS every declared entrypoint — the control', () => {
    // Without this the suite would pass against a rule that refuses everything,
    // which would "prove" browser-safety by making the adapters unreachable
    // again — the state POD-307 exists to end.
    for (const specifier of SYNC_BROWSER_ENTRYPOINTS.keys()) {
      const v = checkManifestFile('apps/web/src/boot.ts', `import { X } from '${specifier}'`)
      expect(v.map((x) => x.rule)).not.toContain('sync-browser-reach')
    }
  })

  it('does not fire for a node-only workspace — apps/server may use the barrel', () => {
    const v = checkManifestFile(
      'apps/server/src/boot.ts',
      `import { Authority } from '@podium/sync'`,
    )
    expect(v.map((x) => x.rule)).not.toContain('sync-browser-reach')
  })

  it('exempts type-only imports, matching checkManifestEdge (erased at build)', () => {
    const v = checkManifestFile(
      'apps/web/src/boot.ts',
      `import type { Authority } from '@podium/sync'`,
    )
    expect(v.map((x) => x.rule)).not.toContain('sync-browser-reach')
  })

  it('every declared entrypoint is resolvable — packages/sync/package.json exports it', () => {
    // A rule that permits a specifier Node cannot resolve permits nothing. This
    // is the check that would have caught declaring an entrypoint and forgetting
    // the exports map, which fails at RUNTIME in the client and nowhere in CI.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/sync/package.json'), 'utf8')) as {
      exports: Record<string, { import?: string }>
    }
    for (const [specifier, entry] of SYNC_BROWSER_ENTRYPOINTS) {
      const subpath = `.${specifier.slice('@podium/sync'.length)}`
      expect(pkg.exports[subpath], `${specifier} missing from packages/sync exports`).toBeDefined()
      expect(pkg.exports[subpath]?.import).toBe(`./${entry.slice('packages/sync/'.length)}`)
    }
  })
})

describe("rule 12b — a declared entrypoint's TRANSITIVE closure is Node-free", () => {
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
    [...SYNC_BROWSER_ENTRYPOINTS.values()].map((entry) => [entry, `export const x = 1\n`]),
  )

  it('says YES on a clean closure — the control', () => {
    expect(checkSyncBrowserGraphAll(plant(CLEAN))).toEqual([])
  })

  it('says YES on the REAL repo — the control that matters', () => {
    // The synthetic control above proves the walker can return empty; this one
    // proves the actual entrypoints are actually clean today. Both are needed:
    // the first can pass against a broken walker, the second can pass against a
    // walker that reads nothing.
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    expect(checkSyncBrowserGraphAll(repoRoot)).toEqual([])
  })

  it('refuses a Node builtin ONE hop from the entrypoint', () => {
    const root = plant({
      ...CLEAN,
      'packages/sync/src/replica/index.ts': `export * from './leaf'\n`,
      'packages/sync/src/replica/leaf.ts': `import { readFileSync } from 'node:fs'\nexport const x = readFileSync\n`,
    })
    const v = checkSyncBrowserGraphAll(root)
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
    const v = checkSyncBrowserGraphAll(root)
    expect(v.map((x) => x.specifier)).toEqual(['bun:sqlite'])
  })

  it('refuses a node-only WORKSPACE package reached from the closure', () => {
    const root = plant({
      ...CLEAN,
      'packages/sync/src/replica/index.ts': `import { openDatabase } from '@podium/runtime/sqlite'\nexport const x = openDatabase\n`,
    })
    expect(checkSyncBrowserGraphAll(root).map((x) => x.specifier)).toEqual([
      '@podium/runtime/sqlite',
    ])
  })

  it('refuses an UNRESOLVABLE import — a truncated closure is green for the wrong reason', () => {
    const root = plant({ ...CLEAN, 'packages/sync/src/span.ts': `export * from './gone'\n` })
    const v = checkSyncBrowserGraphAll(root)
    expect(v.map((x) => x.specifier)).toEqual(['./gone'])
    expect(v[0]?.message).toContain('TRUNCATES')
  })

  it('refuses a MISSING entrypoint — an absent file makes the closure vacuously green', () => {
    const { 'packages/sync/src/span.ts': _dropped, ...withoutSpan } = CLEAN
    const v = checkSyncBrowserGraphAll(plant(withoutSpan))
    expect(v.map((x) => x.specifier)).toEqual(['@podium/sync/span'])
  })

  it('does not fire on a type-only Node import (erased at build)', () => {
    const root = plant({
      ...CLEAN,
      'packages/sync/src/replica/index.ts': `import type { Stats } from 'node:fs'\nexport type X = Stats\n`,
    })
    expect(checkSyncBrowserGraphAll(root)).toEqual([])
  })
})
