/**
 * Dependency-boundary lint (Phase 0 guardrail — see ARCHITECTURE.md "Dependency
 * direction" and docs/offline-sync-architecture.md §4).
 *
 * Rules enforced over apps/, packages/ and scripts/ source:
 *
 *  1. No app→app imports. Grandfathered allowance: `apps/web` may import from
 *     `@podium/server` **type-only** (the `AppRouter` type for the tRPC client).
 *  2. `@podium/agent-bridge` may only be imported by `apps/daemon`, `scripts/`,
 *     and its own package (including its tests). Servers read transcripts via
 *     `@podium/transcript` instead.
 *  3. `@podium/protocol` and `@podium/domain` are leaf packages — they import
 *     no other workspace package. `@podium/transcript` is a near-leaf: it may
 *     import only `@podium/protocol`. `@podium/runtime` is a near-leaf
 *     runtime-plumbing package: it may import only `@podium/protocol` and
 *     `@podium/domain` (e.g. domain's `normalizeOriginUrl`) — never another
 *     app or a non-leaf package.
 *  4. `packages/*` never import from `apps/*` (by name or by relative path).
 *  5. `apps/cli` is a normal app under rule 1: it must not import apps/server
 *     or apps/daemon (no allowance). The runnable entry that injects the
 *     in-process host modules is scripts/cli.ts — scripts/ may compose apps.
 *  6. Server role tiers (docs/offline-sync-architecture.md §4, manifest in
 *     apps/server/src/roles.ts): within apps/server/src, core never imports
 *     hub, and NOTHING imports cloud/ (the private module composes only via
 *     the plugins.ts seam). Composition roots (index/server/router.ts) and
 *     test files may import hub — never cloud.
 *  7. `@podium/domain` is the single home for the entity-pure predicates it
 *     exports (issue stage/authz, snooze/defer, worktree/machine identity,
 *     session dedup + priority, git identity): no OTHER `packages/*` source
 *     file may declare a top-level `export function`/`export const` with the
 *     same name — that shape is a redefinition, the exact bug this rule
 *     catches (client-core's viewmodels used to hand-copy several of these).
 *     Re-exporting a domain binding (`export { x } from '@podium/domain'` or
 *     `export { x }` after `import { x } from '@podium/domain'`) is fine and
 *     encouraged; only a NEW declaration under the same name is flagged.
 *  8. `@podium/runtime` browser-safety is enforced two ways instead of being a
 *     purely hand-maintained barrel convention:
 *       (a) `apps/web` (the one literal browser bundle) may import ONLY the
 *           bare `@podium/runtime` specifier — never a subpath
 *           (`@podium/runtime/config`, `/sqlite`, …). Every node-only concern
 *           lives behind an explicit subpath by convention, so this makes
 *           that convention a build failure instead of a docstring.
 *       (b) `packages/runtime/src/index.ts` (the root barrel) may not VALUE-
 *           export (as opposed to type-only) a sibling file that itself
 *           directly imports a Node builtin (`node:*`) — the one-hop check
 *           that would catch e.g. flipping `export type {...} from
 *           './config.js'` to a value `export *`.
 *     What this does NOT do: a full transitive import-graph closure (so a
 *     two-hop leak — the barrel re-exporting a file that re-exports a
 *     node-tainted file — would slip through). That's judged not cleanly
 *     feasible for the payoff here (packages/runtime/src/index.ts is tiny
 *     and reviewed by hand on every change); (a) + (b) cover the actual
 *     historical failure mode (a subpath import creeping into apps/web, or a
 *     barrel re-export widening from type-only to a value). The barrel's own
 *     doc comment still carries the discipline in prose for anyone editing it.
 *  9. Host edge vs agent command relay (ADR 7 D2, the named port rule in
 *     `packages/protocol/src/planes/port-rule.ts`): the daemon's agent-relay
 *     handler and its host-edge handlers (hook ingest, codex/grok hooks,
 *     browser-open) may not import each other — the relay bakes session
 *     identity into its URL path, so crossing the channels re-homes identity.
 *     Composition roots that wire both are fine; a handler reaching across is
 *     not.
 *
 * Alongside these nine sits the ARCHITECTURE MANIFEST (POD-296,
 * scripts/architecture-manifest.ts): tags per workspace and a dependency matrix
 * derived from them. The two families coexist until POD-335 retires each legacy
 * rule against an equivalent manifest constraint.
 *
 * BOTH families are gated by the one phase-mapped allowlist in
 * scripts/boundary-allowlist.ts: a violation listed there (and within its count)
 * WARNS; anything new, over count, or left slack after a fix FAILS. So rule 2's
 * two known server→agent-bridge imports are grandfathered (POD-740) instead of
 * failing every branch, without opening the door to new ones.
 *
 * Run:
 *  - `bun run lint:boundaries` — everything (wired into `bun run lint`, which is
 *    `continue-on-error` in CI while biome's backlog is burned down).
 *  - `bun run lint:architecture` — the manifest alone (`--manifest-only`), the
 *    BLOCKING CI step. Separate precisely because `bun run lint` cannot block.
 *
 * Pure matching logic is exported for the vitest suite in
 * `scripts/check-boundaries.test.ts`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCompositionRoot, ROLE_RANK, serverRoleOf } from '../apps/server/src/roles'
import {
  applyAllowlist,
  checkManifestEdge,
  checkManifestRole,
  clauseIsTypeOnly,
  extractImports,
  findHarnessBranching,
  type ImportRef,
  isTestFile,
  loadHarnessLiterals,
  partitionAllowlist,
  stripComments,
  tagsFor,
  type Violation,
  workspaceOf,
} from './architecture-manifest'
import { BOUNDARY_ALLOWLIST } from './boundary-allowlist'

// The import-scanning primitives and the Violation shape live in
// ./architecture-manifest — both rule families need them, and the dependency
// runs one way (this file -> the manifest). Re-exported here so existing
// consumers and scripts/check-boundaries.test.ts keep importing them from the
// path they always have.
export type { ImportRef, Violation }
export { clauseIsTypeOnly, extractImports, stripComments, workspaceOf }

// ---------------------------------------------------------------------------
// Grandfathered violations. Do NOT add entries — fix the dependency instead.
// ---------------------------------------------------------------------------

/**
 * Empty since Phase 3 extracted transcript parsing into `@podium/transcript`
 * (apps/server now imports that instead of agent-bridge). Kept so the stale-
 * entry warning machinery stays exercised. Do NOT add entries — fix the
 * dependency instead.
 *
 * NOTE: `apps/server/src/model-probe.ts` and `apps/web/src/derive.ts` mention
 * agent-bridge only in comments — a real import appearing there fails the check.
 */
const GRANDFATHERED_AGENT_BRIDGE = new Set<string>([])

/**
 * The one allowed app→app edge: apps/web imports the `AppRouter` *type* from
 * apps/server for its tRPC client. Type-only — erased at build; there is no
 * runtime dependency. Any runtime import of @podium/server from apps/web (or
 * any other app→app import) is a violation.
 */
const APP_TO_APP_TYPE_ONLY_ALLOWED = new Set<string>(['apps/web -> @podium/server'])

// ---------------------------------------------------------------------------
// Workspace map
// ---------------------------------------------------------------------------

const APP_PACKAGES: Record<string, string> = {
  '@podium/cli': 'apps/cli',
  '@podium/daemon': 'apps/daemon',
  '@podium/desktop': 'apps/desktop',
  '@podium/mobile': 'apps/mobile',
  '@podium/server': 'apps/server',
  '@podium/web': 'apps/web',
}

const LEAF_PACKAGES = new Set<string>(['packages/protocol', 'packages/domain'])

/**
 * Near-leaf packages: may import ONLY the listed workspace packages (plus node
 * builtins/external deps). `@podium/transcript` is pure parsing/paging over
 * protocol types — it must never grow IO/harness dependencies. `@podium/runtime`
 * is node-runtime plumbing (config, sqlite shims, git, connectivity,
 * auth-store, …) — it may reach into the pure leaves (protocol, domain) but
 * must never depend on another app or a non-leaf package.
 */
const RESTRICTED_PACKAGE_DEPS: Record<string, ReadonlySet<string>> = {
  'packages/transcript': new Set(['packages/protocol']),
  // Pure harness composer adapters (POD-859): prompt-draft extraction + keystroke
  // injection, shared by the web fallback and the daemon engine. Must stay pure —
  // only protocol's AgentKind enum, never IO or harness packages.
  'packages/composer': new Set(['packages/protocol']),
  'packages/runtime': new Set(['packages/protocol', 'packages/domain']),
  // The issue-client seam (IssueTrpc + the shared command table) sits between
  // apps/cli and apps/server — it must never import app code or IO packages.
  'packages/issue-client': new Set(['packages/protocol', 'packages/domain']),
  // The node⇄hub sync layer (issue #196: oplog, upstream dialer/forwarder,
  // transcript mirror) — sqlite/config plumbing comes from @podium/runtime;
  // apps/server injects its store repositories through narrow interfaces
  // instead of this package importing apps/server.
  'packages/sync': new Set(['packages/protocol', 'packages/runtime']),
  // Opt-in telemetry [spec:SP-f933]: the schema needs protocol's AgentKind enum
  // and consent/queue need runtime's config + state dir. It must never reach an
  // app — apps/server constructs the emitter and injects its gauges.
  'packages/telemetry': new Set(['packages/protocol', 'packages/runtime']),
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const SERVER_SRC = 'apps/server/src/'

/** apps/server/src-relative posix path of `file`, or null when outside it. */
function serverSrcRel(file: string): string | null {
  return file.startsWith(SERVER_SRC) ? file.slice(SERVER_SRC.length) : null
}

/**
 * Rule 6 — server role tiers (core → hub → cloud; manifest in
 * apps/server/src/roles.ts): a server-src file may only import files of its
 * own role rank or below. Exemptions per the manifest: composition roots and
 * test files may reach UP into hub (they assemble/inject hub modules) — but
 * `cloud/` is unreachable for everyone: the private cloud module composes in
 * exclusively through the plugins.ts seam, so an OSS import of it is always
 * a violation, exemptions included.
 */
function checkServerRoleTiers(file: string, ref: ImportRef): Violation | null {
  const fromRel = serverSrcRel(file)
  if (fromRel === null || !ref.specifier.startsWith('.')) return null
  const abs = resolve('/', dirname(file), ref.specifier)
  const toRel = serverSrcRel(relative('/', abs).split(sep).join('/'))
  if (toRel === null) return null
  const fromRole = serverRoleOf(fromRel)
  const toRole = serverRoleOf(toRel)
  if (toRole === 'cloud' && fromRole !== 'cloud') {
    return {
      file,
      specifier: ref.specifier,
      rule: 'server-role-tiers',
      message: `${file}: nothing in the OSS tree may import cloud code ('${ref.specifier}') — the private cloud module composes via the plugins.ts seam only`,
    }
  }
  if (ROLE_RANK[toRole] <= ROLE_RANK[fromRole]) return null
  if (isCompositionRoot(fromRel) || isTestFile(file)) return null
  return {
    file,
    specifier: ref.specifier,
    rule: 'server-role-tiers',
    message: `${file}: ${fromRole} must not import ${toRole} code ('${ref.specifier}') — see apps/server/src/roles.ts`,
  }
}

const DOMAIN_HOME = 'packages/domain'

/** Matches a top-level `export function NAME` / `export const NAME =`
 *  declaration. Deliberately does NOT match `export { NAME }` or
 *  `export { NAME } from '...'` — those re-export an existing binding rather
 *  than declaring a new one, which is exactly the pattern a domain consumer
 *  (e.g. client-core re-exporting a domain predicate under its original name
 *  for backward-compatible call sites) is expected to use. */
const TOP_LEVEL_DECL_RE = /^export (?:function|const)\s+([A-Za-z_$][\w$]*)/gm

/** Names @podium/domain exports as a top-level function/const (its entity
 *  predicates and pure logic) — read live from packages/domain/src so the set
 *  never drifts from the actual package. Returns an empty set (rule 7 no-op)
 *  if the directory can't be read (e.g. a unit test sandboxing the repo). */
export function loadDomainExportNames(repoRoot: string): Set<string> {
  const names = new Set<string>()
  let entries: string[]
  try {
    entries = readdirSync(join(repoRoot, DOMAIN_HOME, 'src'))
  } catch {
    return names
  }
  for (const entry of entries) {
    if (!/\.tsx?$/.test(entry) || isTestFile(entry)) continue
    const source = readFileSync(join(repoRoot, DOMAIN_HOME, 'src', entry), 'utf8')
    for (const m of stripComments(source).matchAll(TOP_LEVEL_DECL_RE)) {
      const name = m[1]
      if (name) names.add(name)
    }
  }
  return names
}

/**
 * Rule 7 — @podium/domain is the single home for the predicates it exports.
 * Any packages/* file outside @podium/domain itself (and outside tests, which
 * legitimately construct fixture doubles) that DECLARES a top-level
 * function/const under the same name is almost certainly a redefinition.
 */
function checkDomainRedefinition(
  file: string,
  source: string,
  domainExportNames: ReadonlySet<string>,
): Violation[] {
  if (domainExportNames.size === 0) return []
  if (!file.startsWith('packages/') || file.startsWith(`${DOMAIN_HOME}/`)) return []
  if (isTestFile(file)) return []
  const violations: Violation[] = []
  for (const m of stripComments(source).matchAll(TOP_LEVEL_DECL_RE)) {
    const name = m[1]
    if (name && domainExportNames.has(name)) {
      violations.push({
        file,
        specifier: name,
        rule: 'domain-single-home',
        message: `${file}: redefines '${name}', which @podium/domain already exports — import it from '@podium/domain' instead (re-exporting the imported binding is fine; declaring a new one under the same name is not)`,
      })
    }
  }
  return violations
}

const RUNTIME_HOME = 'packages/runtime'
const RUNTIME_BARREL = `${RUNTIME_HOME}/src/index.ts`

/** True for a Node builtin specifier — the only node-only import shape this
 *  repo's source uses (always `node:fs` style, never a bare `fs`). */
function isNodeBuiltinSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:')
}

/**
 * Rule 8a — apps/web may import ONLY the bare `@podium/runtime` specifier,
 * never a subpath. See rule 8 in the file doc comment.
 */
function checkWebRuntimeSubpath(file: string, ref: ImportRef): Violation | null {
  if (file !== 'apps/web' && !file.startsWith('apps/web/')) return null
  if (!ref.specifier.startsWith('@podium/runtime/')) return null
  return {
    file,
    specifier: ref.specifier,
    rule: 'runtime-browser-safety',
    message: `${file}: apps/web may not import a @podium/runtime subpath ('${ref.specifier}') — every subpath is node-only by convention; only the browser-safe root barrel ('@podium/runtime') is allowed here`,
  }
}

// ---- Rule 9 — host edge vs agent command relay (ADR 7 D2) -------------------
//
// The NAMED port rule of `packages/protocol/src/planes/port-rule.ts`, enforced
// on the import graph as ADR 7's POD-387 item 4 requires: "agent-relay handler
// must not import host-hook handlers or vice versa". The relay bakes session
// identity into its URL path, so a host callback that reaches for relay code
// (or a relay that reaches for hook code) re-homes identity, confuses authz and
// breaks `PODIUM_NO_RELAY` hermetic tests — the failure [spec:SP-b85a],
// [spec:SP-fccf] and [spec:SP-a43e] each re-derived independently.
//
// Both sets are deliberately narrow: the handler modules themselves, not their
// composition roots. `apps/daemon/src/daemon.ts` wires both and is not a
// violation — assembling two separated channels is what a composition root is
// for.
const AGENT_RELAY_MODULES = new Set<string>(['apps/daemon/src/agent-relay.ts'])

const HOST_EDGE_MODULES = new Set<string>([
  'apps/daemon/src/hook-ingest.ts',
  'apps/daemon/src/codex-hooks.ts',
  'apps/daemon/src/grok-hooks.ts',
  'apps/daemon/src/browser-open.ts',
])

const hostEdgeSideOf = (file: string): 'agent-relay' | 'host' | null =>
  AGENT_RELAY_MODULES.has(file) ? 'agent-relay' : HOST_EDGE_MODULES.has(file) ? 'host' : null

/**
 * Runs over the two module sets rather than per-file like most rules (same
 * shape as rule 8b): the sets are small and named, and reading them directly
 * keeps the rule's subject obvious to anyone who edits it.
 */
export function checkHostEdgeSeparationAll(repoRoot: string): Violation[] {
  const violations: Violation[] = []
  for (const file of [...AGENT_RELAY_MODULES, ...HOST_EDGE_MODULES]) {
    let source: string
    try {
      source = readFileSync(join(repoRoot, file), 'utf8')
    } catch {
      // A renamed module is a stale rule entry, not a violation; the ratchet
      // catches drift the other way (a new cross-import) which is what matters.
      continue
    }
    for (const ref of extractImports(source)) {
      const violation = hostEdgeCrossImport(repoRoot, file, ref)
      if (violation) violations.push(violation)
    }
  }
  return violations
}

function hostEdgeCrossImport(repoRoot: string, file: string, ref: ImportRef): Violation | null {
  const from = hostEdgeSideOf(file)
  if (from === null || !ref.specifier.startsWith('.')) return null
  const targetAbs = resolveTsSibling(repoRoot, file, ref.specifier)
  if (!targetAbs) return null
  const target = relative(repoRoot, targetAbs).split(sep).join('/')
  const to = hostEdgeSideOf(target)
  if (to === null || to === from) return null
  return {
    file,
    specifier: ref.specifier,
    rule: 'host-edge-separation',
    message: `${file}: the ${from} channel must not import the ${to} channel ('${ref.specifier}' → ${target}) — ADR 7 D2 keeps host↔server traffic separate from the agent command relay ([spec:SP-b85a], [spec:SP-fccf], [spec:SP-a43e]); give the host feature its own typed frames instead`,
  }
}

/** Resolve a relative specifier from `fromFile` (repo-relative posix path,
 *  './config.js' style) to the .ts source file it actually names on disk. */
function resolveTsSibling(repoRoot: string, fromFile: string, specifier: string): string | null {
  const abs = resolve('/', dirname(join(repoRoot, fromFile)), specifier).replace(/\.js$/, '')
  for (const candidate of [`${abs}.ts`, `${abs}.tsx`, join(abs, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Rule 8b — the @podium/runtime root barrel may not VALUE-export a sibling
 * file that itself directly imports a Node builtin. One-hop check (not a full
 * transitive closure — see rule 8 in the file doc comment for why). Runs once
 * against the one file it targets, not per-file like the rest of checkFile's
 * rules, so it's a standalone function `runCheck` calls directly.
 */
export function checkRuntimeBarrelPurity(repoRoot: string): Violation[] {
  const abs = join(repoRoot, RUNTIME_BARREL)
  let source: string
  try {
    source = readFileSync(abs, 'utf8')
  } catch {
    return []
  }
  const violations: Violation[] = []
  for (const ref of extractImports(source)) {
    if (ref.typeOnly || !ref.specifier.startsWith('.')) continue
    const targetAbs = resolveTsSibling(repoRoot, RUNTIME_BARREL, ref.specifier)
    if (!targetAbs) continue
    const targetSource = readFileSync(targetAbs, 'utf8')
    const targetRel = relative(repoRoot, targetAbs).split(sep).join('/')
    const nodeImport = extractImports(targetSource).find(
      (r) => isNodeBuiltinSpecifier(r.specifier) && !r.typeOnly,
    )
    if (nodeImport) {
      violations.push({
        file: RUNTIME_BARREL,
        specifier: ref.specifier,
        rule: 'runtime-browser-safety',
        message: `${RUNTIME_BARREL}: value-exports '${ref.specifier}' (${targetRel}), which directly imports Node builtin '${nodeImport.specifier}' — apps/web's bundle would inline it. Re-export only its types (export type {...}) or move it behind its own subpath.`,
      })
    }
  }
  return violations
}

/** Workspace a specifier points at, or null for external/std imports. */
function targetWorkspace(file: string, specifier: string): string | null {
  if (specifier.startsWith('@podium/')) {
    const name = specifier.split('/').slice(0, 2).join('/')
    if (name in APP_PACKAGES) return APP_PACKAGES[name]
    return `packages/${name.slice('@podium/'.length)}`
  }
  if (specifier.startsWith('.')) {
    const abs = resolve('/', dirname(file), specifier)
    const rel = relative('/', abs).split(sep).join('/')
    return workspaceOf(rel)
  }
  return null
}

/** Check one file's imports against all boundary rules. Pure — used by tests.
 *  `domainExportNames` (rule 7) defaults to empty, i.e. a no-op, so existing
 *  call sites (and most tests) that don't pass it are unaffected. */
export function checkFile(
  file: string,
  source: string,
  domainExportNames: ReadonlySet<string> = new Set(),
): Violation[] {
  const violations: Violation[] = [...checkDomainRedefinition(file, source, domainExportNames)]
  const from = workspaceOf(file)
  for (const ref of extractImports(source)) {
    // Rule 6 first: role tiers are same-workspace edges (apps/server internal),
    // which the cross-workspace rules below deliberately skip.
    const roleViolation = checkServerRoleTiers(file, ref)
    if (roleViolation) {
      violations.push(roleViolation)
      continue
    }
    // Rule 8a: apps/web may only bare-import @podium/runtime, never a subpath.
    const webRuntimeViolation = checkWebRuntimeSubpath(file, ref)
    if (webRuntimeViolation) {
      violations.push(webRuntimeViolation)
      continue
    }
    const to = targetWorkspace(file, ref.specifier)
    if (to === null || to === from) continue

    // Rule 4: packages never import from apps.
    if (from.startsWith('packages/') && to.startsWith('apps/')) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'packages-no-apps',
        message: `${file}: packages must never import from apps (imports '${ref.specifier}')`,
      })
      continue
    }

    // Rule 3: protocol and core are leaf packages.
    if (LEAF_PACKAGES.has(from) && (to.startsWith('packages/') || to.startsWith('apps/'))) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'leaf-package',
        message: `${file}: ${from} is a leaf package and must not import workspace package '${ref.specifier}'`,
      })
      continue
    }

    // Rule 3b: near-leaf packages with an explicit allowed-deps list.
    const restricted = RESTRICTED_PACKAGE_DEPS[from]
    if (
      restricted &&
      (to.startsWith('packages/') || to.startsWith('apps/')) &&
      !restricted.has(to)
    ) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'restricted-package-deps',
        message: `${file}: ${from} may only import ${[...restricted].join(', ')} among workspace packages (imports '${ref.specifier}')`,
      })
      continue
    }

    // Rule 1: no app→app imports (grandfathered: web→server type-only).
    // Test files are exempt: e2e tests legitimately compose several apps
    // (e.g. apps/server/src/agent-relay-e2e.test.ts drives daemon code) and
    // are never shipped, so they don't create a runtime dependency edge.
    if (from.startsWith('apps/') && to.startsWith('apps/') && !isTestFile(file)) {
      const edge = `${from} -> @podium/${to.slice('apps/'.length)}`
      if (APP_TO_APP_TYPE_ONLY_ALLOWED.has(edge) && ref.typeOnly) continue
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'no-app-to-app',
        message: APP_TO_APP_TYPE_ONLY_ALLOWED.has(edge)
          ? `${file}: runtime import of '${ref.specifier}' — only type-only imports of @podium/server are allowed from apps/web`
          : `${file}: app→app import of '${ref.specifier}' is forbidden`,
      })
      continue
    }

    // Rule 2: agent-bridge importers are restricted.
    if (to === 'packages/agent-bridge') {
      const allowed =
        from === 'apps/daemon' || from === 'scripts' || from === 'packages/agent-bridge'
      if (allowed) continue
      if (GRANDFATHERED_AGENT_BRIDGE.has(file)) continue
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'agent-bridge-consumers',
        message: `${file}: '@podium/agent-bridge' may only be imported by apps/daemon, scripts/, or its own tests (Phase 3 extracts @podium/transcript for the grandfathered server cases)`,
      })
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// Architecture manifest (POD-296) — the tag-derived matrix, run alongside the
// legacy rules above. See scripts/architecture-manifest.ts for the tags and why
// the two rule families coexist (POD-335 retires the legacy eight, each only
// once an equivalent manifest constraint exists).
// ---------------------------------------------------------------------------

/** Check one file against the MANIFEST rules (layer, platform, role, harness). */
export function checkManifestFile(
  file: string,
  source: string,
  harnessLiterals: readonly string[] = [],
): Violation[] {
  const violations: Violation[] = [...findHarnessBranching(file, source, harnessLiterals)]
  const from = workspaceOf(file)
  for (const ref of extractImports(source)) {
    // Role tiers are same-workspace edges, which the cross-workspace matrix skips.
    const roleViolation = checkManifestRole(file, ref)
    if (roleViolation) {
      violations.push(roleViolation)
      continue
    }
    const to = targetWorkspace(file, ref.specifier)
    if (to === null || to === from) continue
    violations.push(...checkManifestEdge(file, from, to, ref))
  }
  return violations
}

/**
 * Every workspace carrying source must be tagged — otherwise a new package
 * silently sits outside the matrix, which is exactly the drift the manifest
 * exists to prevent.
 */
function checkManifestCoverage(workspaces: ReadonlySet<string>): Violation[] {
  return [...workspaces]
    .filter((w) => tagsFor(w) === null)
    .sort()
    .map((w) => ({
      file: w,
      specifier: w,
      rule: 'manifest-untagged',
      message: `${w}: workspace has source but no entry in MANIFEST — tag it (layer/platform/features) in scripts/architecture-manifest.ts`,
    }))
}

// ---------------------------------------------------------------------------
// Walker + main
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.expo', 'coverage', 'target'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
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

export function runCheck(repoRoot: string): {
  violations: Violation[]
  staleGrandfathers: string[]
  manifest: Violation[]
} {
  const violations: Violation[] = []
  const manifest: Violation[] = []
  const agentBridgeImporters = new Set<string>()
  const workspaces = new Set<string>()
  const domainExportNames = loadDomainExportNames(repoRoot)
  const harnessLiterals = loadHarnessLiterals(repoRoot)
  for (const rootDir of ['apps', 'packages', 'scripts']) {
    for (const abs of walk(join(repoRoot, rootDir))) {
      const file = relative(repoRoot, abs).split(sep).join('/')
      const source = readFileSync(abs, 'utf8')
      workspaces.add(workspaceOf(file))
      violations.push(...checkFile(file, source, domainExportNames))
      manifest.push(...checkManifestFile(file, source, harnessLiterals))
      if (extractImports(source).some((r) => r.specifier.startsWith('@podium/agent-bridge')))
        agentBridgeImporters.add(file)
    }
  }
  violations.push(...checkRuntimeBarrelPurity(repoRoot))
  violations.push(...checkHostEdgeSeparationAll(repoRoot))
  manifest.push(...checkManifestCoverage(workspaces))
  const staleGrandfathers = [...GRANDFATHERED_AGENT_BRIDGE].filter(
    (f) => !agentBridgeImporters.has(f),
  )
  return { violations, staleGrandfathers, manifest }
}

function main(): void {
  // `--manifest-only` runs the ARCHITECTURE MANIFEST alone and takes its exit
  // code from the ratchet only (new/over-count manifest violations), ignoring
  // the legacy rules entirely. That is what makes the ratchet blockable in CI
  // today: `bun run lint` is `continue-on-error: true` because it is already red
  // — ~249 biome errors (podium #30) plus the agent-bridge-consumers failures
  // (POD-740) — so a ratchet wired only into `bun run lint` would report a NEW
  // violation and CI would sail straight past it. This mode is green as of the
  // committed allowlist, so `lint:architecture` blocks on its own while the
  // legacy rules stay non-blocking until their reds are burned down.
  const manifestOnly = process.argv.includes('--manifest-only')
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const start = performance.now()
  const { violations, staleGrandfathers, manifest } = runCheck(repoRoot)
  // ONE allowlist, but the two rule families must be applied to their OWN
  // violations: applyAllowlist calls any entry with no matching violation stale,
  // so a shared pass would have each family declaring the other's entries dead.
  const [manifestAllowed, legacyAllowed] = partitionAllowlist(BOUNDARY_ALLOWLIST)
  const { warnings, errors, stale } = applyAllowlist(manifest, manifestAllowed)
  // The legacy rules run through the SAME ratchet (POD-740): their two known
  // violations are grandfathered in the one phase-mapped allowlist, so
  // lint:boundaries is green while a NEW legacy violation still fails. Before
  // this, any legacy violation failed outright — which is why the check had been
  // red on every branch since accounts.ts/relay.ts grew those imports, and a
  // guardrail everyone has learned to ignore is not a guardrail.
  const legacy = applyAllowlist(violations, legacyAllowed)
  const ms = Math.round(performance.now() - start)
  if (!manifestOnly) {
    for (const f of staleGrandfathers) {
      console.warn(
        `warning: grandfathered agent-bridge entry '${f}' no longer imports it — remove it from GRANDFATHERED_AGENT_BRIDGE in scripts/check-boundaries.ts`,
      )
    }
  }

  // Architecture manifest — WARN mode (POD-296). Allowlisted violations are
  // known debt, each mapped to the phase that removes it; they report but do
  // not fail. Anything NEW (or over an entry's count) is an error: that is the
  // ratchet. POD-335 flips this to error level with an empty allowlist.
  // Stale entries FAIL: a count left above reality leaves slots that can be
  // silently refilled while CI stays green, which would make the ratchet hold
  // only at its loosest historical setting. See applyAllowlist.
  if (stale.length > 0) {
    console.error(`\nStale allowlist entries (${stale.length}) — the ratchet only goes down:\n`)
    for (const s of stale) console.error(`  ${s}`)
  }
  if (warnings.length > 0) {
    console.warn(
      `\narchitecture manifest — ${warnings.length} allowlisted violation(s) (warn, see scripts/boundary-allowlist.ts):`,
    )
    for (const v of warnings) console.warn(`  [${v.rule}] ${v.message}`)
  }
  if (errors.length > 0) {
    console.error(`\nNEW architecture-manifest violations (${errors.length}):\n`)
    for (const v of errors) console.error(`  [${v.rule}] ${v.message}`)
    console.error(
      '\nThese are not in scripts/boundary-allowlist.ts (or exceed the declared count).',
    )
    console.error('Fix the dependency — the allowlist is a ratchet, it only goes down.')
  }

  if (!manifestOnly) {
    if (legacy.warnings.length > 0) {
      console.warn(
        `\nlegacy dependency rules — ${legacy.warnings.length} allowlisted violation(s) (warn, see scripts/boundary-allowlist.ts):`,
      )
      for (const v of legacy.warnings) console.warn(`  [${v.rule}] ${v.message}`)
    }
    for (const s of legacy.stale) console.error(`  ${s}`)
    if (legacy.errors.length > 0) {
      console.error(`\nDependency-boundary violations (${legacy.errors.length}):\n`)
      for (const v of legacy.errors) console.error(`  [${v.rule}] ${v.message}`)
      console.error('\nSee ARCHITECTURE.md "Dependency direction" for the rules.')
    }
  }

  const legacyFailed = !manifestOnly && (legacy.errors.length > 0 || legacy.stale.length > 0)
  if (errors.length > 0 || stale.length > 0 || legacyFailed) process.exit(1)
  const allowlisted = warnings.length + (manifestOnly ? 0 : legacy.warnings.length)
  console.log(
    manifestOnly
      ? `architecture manifest OK (${ms}ms) — ${warnings.length} allowlisted, 0 new`
      : `boundaries OK (${ms}ms) — ${allowlisted} allowlisted, 0 new`,
  )
}

if (import.meta.main) main()
