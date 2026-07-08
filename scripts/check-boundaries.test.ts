import { describe, expect, it } from 'vitest'
import { checkFile, clauseIsTypeOnly, extractImports } from './check-boundaries'

describe('extractImports', () => {
  it('extracts value, type-only, side-effect, export-from and dynamic imports', () => {
    const src = [
      `import { a } from '@podium/core'`,
      `import type { AppRouter } from '@podium/server'`,
      `import '@podium/protocol'`,
      `export { b } from '@podium/agent-bridge'`,
      `const m = await import('@podium/terminal-client')`,
      `const n = require('@podium/client-core')`,
    ].join('\n')
    const refs = extractImports(src)
    expect(refs.map((r) => r.specifier)).toEqual([
      '@podium/core',
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
      'apps/server/src/issue-relay-e2e.test.ts',
      `import { issueRelay } from '../../daemon/src/issue-relay'`,
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
      `import { openDatabase } from '@podium/core/sqlite'`,
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
        `import { ISSUE_COMMANDS, makeRelayIssueClient } from '@podium/issue-client'\nimport { loadConfig } from '@podium/core/config'`,
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
      'packages/domain/src/issue-stage.ts',
      `import type { IssueWire } from '@podium/protocol'`,
    )
    expect(d).toHaveLength(1)
    expect(d[0].rule).toBe('leaf-package')
    expect(
      checkFile('apps/server/src/issues.ts', `import { isIssueClosed } from '@podium/domain'`),
    ).toEqual([])
  })

  it('keeps protocol a leaf package', () => {
    const p = checkFile('packages/protocol/src/index.ts', `import { z } from '@podium/core'`)
    expect(p).toHaveLength(1)
    expect(p[0].rule).toBe('leaf-package')
  })

  it('restricts core (runtime plumbing) to the protocol/domain leaves', () => {
    // Allowed: protocol and domain (e.g. domain's normalizeOriginUrl).
    expect(
      checkFile('packages/core/src/settings.ts', `import type { T } from '@podium/protocol'`),
    ).toEqual([])
    expect(
      checkFile('packages/core/src/git.ts', `export { normalizeOriginUrl } from '@podium/domain'`),
    ).toEqual([])
    // Disallowed: any other workspace package.
    const c = checkFile(
      'packages/core/src/settings.ts',
      `import { something } from '@podium/client-core'`,
    )
    expect(c).toHaveLength(1)
    expect(c[0].rule).toBe('restricted-package-deps')
    // Intra-package and external imports are fine.
    expect(
      checkFile('packages/core/src/index.ts', `import { z } from 'zod'\nimport './settings.js'`),
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
      checkFile('apps/server/src/relay.ts', `import { loadConfig } from '@podium/core/config'`),
    ).toEqual([])
  })
})
