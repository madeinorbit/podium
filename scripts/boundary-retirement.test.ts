/**
 * THE RETIREMENT EVIDENCE (POD-335).
 *
 * POD-296 introduced the architecture manifest beside eight bespoke boundary
 * rules and said the two families would coexist "until POD-335 retires each
 * legacy rule against an equivalent manifest constraint". This file is the
 * proof obligation that sentence created, and it is deliberately organised as
 * ONE DESCRIBE PER RETIRED RULE rather than by replacement: the question a
 * reviewer has is "did anything get dropped", and the answer has to be
 * addressable rule by rule.
 *
 * EVERY CASE HERE WAS PLANTED AGAINST THE LEGACY RULE FIRST. The bad code in
 * each `it` is ported verbatim from the assertion the retired rule used to make
 * (scripts/check-boundaries.test.ts, before this issue), so what is being shown
 * is not "a manifest rule can fire" but "the manifest rule refuses the same code
 * the legacy rule refused". Where the two differ, the difference is asserted
 * explicitly and explained, because a silent difference is exactly what a
 * retirement is most likely to smuggle in.
 *
 * The ledger with the rule→replacement table is
 * docs/gates/pod-335-boundary-lint-end-state.md.
 */

import { describe, expect, it } from 'vitest'
import {
  checkAuthzSingleHome,
  checkManifestEdge,
  checkManifestRole,
  type ImportRef,
} from './architecture-manifest'
import { checkBrowserReach, checkFeatureSingleHome, checkManifestFile } from './check-boundaries'

const value = (specifier: string): ImportRef => ({ specifier, typeOnly: false })
const typeOnly = (specifier: string): ImportRef => ({ specifier, typeOnly: true })

/** Rules emitted for one file's whole source, the way the runner sees it. */
const rulesFor = (file: string, source: string): string[] =>
  checkManifestFile(file, source).map((v) => v.rule)

// ---------------------------------------------------------------------------
// 1. no-app-to-app  ->  manifest-layer (undeclared same-layer edge)
// ---------------------------------------------------------------------------

describe('RETIRED no-app-to-app -> manifest-layer', () => {
  it('refuses a RUNTIME web->server import', () => {
    // Two arms fire — the edge is both an undeclared same-layer one and outside
    // any declared surface — so this asserts the LAYER refusal specifically.
    expect(
      rulesFor('apps/web/src/trpc.ts', `import { appRouter } from '@podium/server'`),
    ).toContain('manifest-layer')
  })

  it('allows the one sanctioned TYPE-ONLY web->server edge', () => {
    expect(
      rulesFor('apps/web/src/trpc.ts', `import type { AppRouter } from '@podium/server'`),
    ).toEqual([])
  })

  it('refuses any OTHER app->app edge, even type-only — legacy rule 1 did too', () => {
    // The distinction that would have been easiest to lose: the manifest exempts
    // type-only from the PLATFORM rule, and a blanket exemption would have made
    // every app->app type import legal. It does not.
    expect(rulesFor('apps/server/src/x.ts', `import type { Y } from '@podium/daemon'`)).toEqual([
      'manifest-layer',
    ])
  })

  it('refuses a RELATIVE import that crosses into another app', () => {
    expect(
      rulesFor('apps/server/src/x.ts', `import { repoOp } from '../../daemon/src/repo-op'`),
    ).toEqual(['manifest-layer'])
  })

  it('exempts an e2e test that composes two apps — as legacy rule 1 did', () => {
    expect(
      rulesFor(
        'apps/server/src/agent-relay-e2e.test.ts',
        `import { agentRelay } from '../../daemon/src/agent-relay'`,
      ),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. cli-no-apps  ->  manifest-layer
// ---------------------------------------------------------------------------

describe('RETIRED cli-no-apps -> manifest-layer', () => {
  it.each(['@podium/server', '@podium/daemon', '../../server/src/server'])(
    'refuses apps/cli importing %s',
    (spec) => {
      expect(rulesFor('apps/cli/src/cli.ts', `import { x } from '${spec}'`)).toEqual([
        'manifest-layer',
      ])
    },
  )

  it('still allows the CLI its own seam and runtime config', () => {
    expect(
      rulesFor(
        'apps/cli/src/issue-cli.ts',
        `import { ISSUE_COMMANDS } from '@podium/issue-client'\nimport { loadConfig } from '@podium/runtime/config'`,
      ),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. packages-no-apps  ->  manifest-layer (upward)
// ---------------------------------------------------------------------------

describe('RETIRED packages-no-apps -> manifest-layer', () => {
  it('refuses a package importing an app BY NAME', () => {
    expect(
      rulesFor('packages/client-core/src/x.ts', `import type { AppRouter } from '@podium/server'`),
    ).toEqual(['manifest-layer'])
  })

  it('refuses a package importing an app BY RELATIVE PATH', () => {
    expect(
      rulesFor(
        'packages/client-core/src/x.ts',
        `import { store } from '../../../apps/server/src/store'`,
      ),
    ).toContain('manifest-layer')
  })

  it('exempts nothing — not even a package test — exactly as legacy rule 4 did', () => {
    expect(
      rulesFor('packages/model/src/x.test.ts', `import { s } from '@podium/server'`).length,
    ).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4 + 5. leaf-package / restricted-package-deps  ->  manifest-deps
// ---------------------------------------------------------------------------

describe('RETIRED leaf-package + restricted-package-deps -> manifest-deps', () => {
  it('keeps @podium/model a TRUE leaf (deps: [])', () => {
    expect(
      rulesFor('packages/model/src/index.ts', `import { x } from '@podium/protocol'`),
    ).toContain('manifest-deps')
    expect(rulesFor('packages/model/src/index.ts', `import { z } from '@podium/runtime'`)).toContain(
      'manifest-deps',
    )
  })

  it('keeps protocol near-leaf: model only [POD-808]', () => {
    expect(
      rulesFor('packages/protocol/src/index.ts', `import { Revision } from '@podium/model'`),
    ).toEqual([])
    expect(
      rulesFor('packages/protocol/src/index.ts', `import { z } from '@podium/runtime'`),
    ).toContain('manifest-deps')
  })

  it('keeps transcript near-leaf, and reachable from apps', () => {
    expect(
      rulesFor(
        'apps/server/src/modules/memory/transcript-indexer.ts',
        `import { claudeRecordToItems } from '@podium/transcript'`,
      ),
    ).toEqual([])
    expect(
      rulesFor(
        'packages/transcript/src/source.ts',
        `import { openDatabase } from '@podium/runtime/sqlite'`,
      ),
    ).toContain('manifest-deps')
  })

  it('restricts @podium/runtime to the two leaves — the edge a layer ordinal CANNOT express', () => {
    // The reason `deps` exists at all. runtime is L2 and commands is L1, so the
    // layer axiom says "down, fine"; the closed set is what still refuses it,
    // which is what legacy rule 3b did.
    expect(
      rulesFor('packages/runtime/src/settings.ts', `import type { T } from '@podium/protocol'`),
    ).toEqual([])
    expect(
      rulesFor('packages/runtime/src/settings.ts', `import { c } from '@podium/commands'`),
    ).toEqual(['manifest-deps'])
    expect(
      rulesFor('packages/runtime/src/settings.ts', `import { s } from '@podium/client-core'`),
    ).toContain('manifest-deps')
  })

  it('keeps the issue-client seam free of IO packages', () => {
    expect(
      rulesFor('packages/issue-client/src/commands.ts', `import { x } from '@podium/harness'`).length,
    ).toBeGreaterThan(0)
    expect(
      rulesFor(
        'packages/issue-client/src/commands.ts',
        `import type { IssueStage } from '@podium/protocol'`,
      ),
    ).toEqual([])
  })

  it('leaves normal app->package and package->package edges alone', () => {
    expect(
      rulesFor(
        'apps/web/src/store.tsx',
        `import { groupSessions } from '@podium/client-core/focus'\nimport type { SessionMeta } from '@podium/protocol'`,
      ),
    ).toEqual([])
    expect(
      rulesFor(
        'packages/client-core/src/transport.ts',
        `import { WIRE_VERSION } from '@podium/protocol'`,
      ),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 6. agent-host-consumers  ->  manifest-consumers (+ manifest-open-entrypoint)
// ---------------------------------------------------------------------------

describe('RETIRED agent-host-consumers -> manifest-consumers', () => {
  it.each(['apps/daemon/src/daemon.ts', 'scripts/daemon.ts'])(
    'allows the host capability to %s',
    (file) => {
      expect(rulesFor(file, `import { x } from '@podium/harness'`)).toEqual([])
    },
  )

  it("allows the restricted package's OWN tests", () => {
    expect(
      rulesFor('packages/harness/test/pty-behavior/abduco.bun.test.ts', `import { x } from '@podium/harness'`),
    ).toEqual([])
  })

  it('refuses a test OUTSIDE the restricted workspace — a test may not take the capability its source may not', () => {
    expect(
      rulesFor('apps/server/src/x.test.ts', `import { launch } from '@podium/harness'`),
    ).toEqual(['manifest-consumers'])
  })

  it.each([
    'apps/server/src/relay.ts',
    'apps/server/src/model-catalog.ts',
    'apps/web/src/derive.ts',
  ])('refuses the barrel from %s', (file) => {
    // apps/web adds `manifest-platform` on top (browser-safe -> node-only), which
    // is a second true statement about the same edge, so this asserts the
    // capability refusal specifically.
    expect(rulesFor(file, `import { agentLaunchCommand } from '@podium/harness'`)).toContain(
      'manifest-consumers',
    )
  })

  it('refuses an UNDECLARED subpath too', () => {
    expect(rulesFor('apps/web/src/x.ts', `import { y } from '@podium/harness/pty'`)).toContain(
      'manifest-consumers',
    )
  })

  it('admits the DECLARED open entrypoint, and only it', () => {
    // The precision the whole-package ban could not express, and the reason the
    // four apps/server allowlist entries could finally be paid.
    expect(
      rulesFor(
        'apps/server/src/harness-manifest.ts',
        `export { harnessDisplayName } from '@podium/harness/metadata'`,
      ),
    ).toEqual([])
  })

  it('refuses @podium/pty from a server file — it declares NO open surface', () => {
    expect(rulesFor('apps/server/src/x.ts', `import { spawnPty } from '@podium/pty'`)).toEqual([
      'manifest-consumers',
    ])
  })
})

// ---------------------------------------------------------------------------
// 7. server-role-tiers  ->  manifest-role
// ---------------------------------------------------------------------------

describe('RETIRED server-role-tiers -> manifest-role', () => {
  it('refuses core importing hub', () => {
    const v = checkManifestRole('apps/server/src/sessions.ts', value('./hub/pairing'))
    expect(v?.rule).toBe('manifest-role')
    expect(v?.message).toContain('roles.ts')
  })

  it('refuses cloud for EVERYONE, composition roots included', () => {
    for (const [file, spec] of [
      ['apps/server/src/index.ts', './cloud/billing'],
      ['apps/server/src/hub/pairing.ts', '../cloud/billing'],
    ] as const) {
      const v = checkManifestRole(file, value(spec))
      expect(v?.rule, file).toBe('manifest-role')
      expect(v?.message, file).toContain('plugins.ts seam')
    }
  })

  it('allows a composition root to reach hub', () => {
    expect(checkManifestRole('apps/server/src/index.ts', value('./hub/pairing'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 8. model-single-home  ->  feature-single-home
// ---------------------------------------------------------------------------

describe('RETIRED model-single-home -> feature-single-home', () => {
  const owned = new Set(['isIssueClosed', 'normalizeOriginUrl'])

  it('refuses a package REDECLARING an owned name', () => {
    const v = checkFeatureSingleHome(
      'packages/client-core/src/viewmodels.ts',
      `export function isIssueClosed(i: I) { return false }`,
      owned,
    )
    expect(v.map((x) => x.rule)).toEqual(['feature-single-home'])
    expect(v[0]?.message).toContain('ownership is exclusive')
  })

  it('refuses an APP redeclaring one — legacy rule 7 only ever looked at packages/', () => {
    // The one widening this retirement makes, asserted so it cannot quietly
    // regress to the narrower scope.
    expect(
      checkFeatureSingleHome(
        'apps/server/src/repo-id.ts',
        `export function normalizeOriginUrl(u: string) { return u }`,
        owned,
      ).map((x) => x.rule),
    ).toEqual(['feature-single-home'])
  })

  it('allows RE-EXPORTING the home binding, in both spellings', () => {
    expect(
      checkFeatureSingleHome(
        'packages/client-core/src/index.ts',
        `export { isIssueClosed } from '@podium/model'`,
        owned,
      ),
    ).toEqual([])
    expect(
      checkFeatureSingleHome(
        'packages/client-core/src/index.ts',
        `import { isIssueClosed } from '@podium/model'\nexport { isIssueClosed }`,
        owned,
      ),
    ).toEqual([])
  })

  it('never accuses the home itself', () => {
    expect(
      checkFeatureSingleHome(
        'packages/model/src/predicates/issue-stage.ts',
        `export function isIssueClosed(i: I) { return false }`,
        owned,
      ),
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 9. runtime-browser-safety (8a + 8b)  ->  manifest-browser-reach
// ---------------------------------------------------------------------------

describe('RETIRED runtime-browser-safety -> manifest-browser-reach', () => {
  it('refuses a @podium/runtime SUBPATH from apps/web — legacy rule 8a, verbatim', () => {
    const v = checkBrowserReach('apps/web/src/x.ts', value('@podium/runtime/config'))
    expect(v?.rule).toBe('manifest-browser-reach')
    expect(v?.message).toContain('@podium/runtime')
  })

  it('allows the declared bare barrel', () => {
    expect(checkBrowserReach('apps/web/src/x.ts', value('@podium/runtime'))).toBeNull()
  })

  it('generalises past apps/web — every browser-safe workspace is held to it', () => {
    // Rule 8a named ONE app. ADR 6 puts a client adapter on mobile too, and
    // packages/client-core is browser-safe as well.
    for (const file of ['apps/mobile/src/x.ts', 'packages/client-core/src/x.ts']) {
      expect(checkBrowserReach(file, value('@podium/runtime/sqlite')), file).not.toBeNull()
    }
  })

  it('says nothing to a NODE-ONLY consumer — the rule is about bundles', () => {
    expect(checkBrowserReach('apps/server/src/x.ts', value('@podium/runtime/sqlite'))).toBeNull()
  })

  it('exempts a type-only import, which reaches no bundle', () => {
    expect(checkBrowserReach('apps/web/src/x.ts', typeOnly('@podium/runtime/config'))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// NEW GUARDRAIL, no legacy predecessor: authz-single-home.
// ---------------------------------------------------------------------------

describe('NEW authz-single-home — identity/authz/visibility have one home', () => {
  it('refuses a SECOND visibility-class table', () => {
    const v = checkAuthzSingleHome(
      'apps/server/src/modules/memory/visibility.ts',
      `export const DOC_VISIBILITY = {
         session: 'personal',
         issue: 'personal',
         setting: 'deployment-substrate',
       } as const`,
    )
    expect(v.map((x) => x.rule)).toEqual(['authz-single-home'])
    expect(v[0]?.message).toContain("ADR 1's ownership matrix")
  })

  it('refuses a visibility DECISION declared without consulting a home', () => {
    const v = checkAuthzSingleHome(
      'apps/server/src/modules/sessions/queries.ts',
      `export function mayReadSession(u: string, row: Row): boolean {
         return row.owner === u || row.grants.includes(u)
       }`,
    )
    expect(v.map((x) => x.rule)).toEqual(['authz-single-home'])
    expect(v[0]?.specifier).toBe('mayReadSession')
  })

  it('refuses a parallel GRANT check in a machines module (§3.1.4 M6)', () => {
    // The readiness doc's other named case: machine access must be grants on the
    // same principal model, "rather than as a separate fleet ACL".
    const v = checkAuthzSingleHome(
      'apps/server/src/hub/fleet-acl.ts',
      `export function hasGrant(u: string, m: Machine): boolean {
         return m.allowedUsers.includes(u)
       }`,
    )
    expect(v.map((x) => x.rule)).toEqual(['authz-single-home'])
  })

  it('allows a module that DELEGATES to the home', () => {
    expect(
      checkAuthzSingleHome(
        'apps/server/src/issue-authz.ts',
        `import { authorize, type Capability } from '@podium/model'
         export function checkAccess(cap: Capability): boolean {
           return authorize(cap, 'read') === 'allow'
         }`,
      ),
    ).toEqual([])
  })

  it('allows declaring a PORT with a decision verb', () => {
    // The shape the repo is full of, and the one a naive name rule flags hardest:
    // packages/protocol's plane contract and packages/commands' workflows port
    // both DECLARE these verbs so the one implementation can be injected.
    expect(
      checkAuthzSingleHome(
        'packages/protocol/src/planes/principal.ts',
        `export interface VisibilityResolver {
           canSee(principal: Principal, entity: { kind: string; id: string }): boolean
         }`,
      ),
    ).toEqual([])
  })

  it('allows CALLING a decision — asking the authority is the point', () => {
    expect(
      checkAuthzSingleHome(
        'packages/commands/src/mail/ceiling.ts',
        `export function resolve(ref: string, deps: D) {
           return deps.ceiling.canSee({ kind: 'session', id: ref }) ? ref : null
         }`,
      ),
    ).toEqual([])
  })

  it('allows a `visibility:` DECLARATION against the matrix — §3.1.1 rule 2 being obeyed', () => {
    expect(
      checkAuthzSingleHome(
        'packages/commands/src/fleet/contracts.ts',
        `export const PAIR = { visibility: 'owned-compute', policy: { resource: 'machine' } }
         export const UNPAIR = { visibility: 'owned-compute', policy: { resource: 'machine' } }`,
      ),
    ).toEqual([])
  })

  it('never accuses the homes themselves', () => {
    for (const file of [
      'packages/model/src/authz/issue-authz.ts',
      'packages/model/src/identity/grant.ts',
      'packages/model/src/annotations/matrix.ts',
      'packages/sync/src/feed/visibility.ts',
    ]) {
      expect(
        checkAuthzSingleHome(
          file,
          `export function evaluateVisibility(p: P, e: E): boolean { return true }`,
        ),
        file,
      ).toEqual([])
    }
  })
})

// ---------------------------------------------------------------------------
// The build-tier decision that emptied the last two allowlist entries.
// ---------------------------------------------------------------------------

describe('apps/*/scripts is BUILD TIER', () => {
  it('lets a per-app build script share the build tier', () => {
    expect(
      rulesFor(
        'apps/desktop/scripts/stage-sidecar.ts',
        `import { buildBun } from '../../../scripts/build-bun.js'`,
      ),
    ).toEqual([])
  })

  it('does NOT extend to app source — the narrowness is the safety', () => {
    expect(
      rulesFor(
        'apps/desktop/src/scripts/thing.ts',
        `import { x } from '../../../../scripts/build-bun.js'`,
      ).length,
    ).toBeGreaterThan(0)
  })

  it('does not let an app hide product code under a scripts/ folder one level deeper', () => {
    expect(
      checkManifestEdge(
        'apps/web/src/features/scripts/x.ts',
        'apps/web',
        'scripts',
        value('../../../../scripts/build-bun.js'),
      ).map((v) => v.rule),
    ).toContain('manifest-layer')
  })
})
