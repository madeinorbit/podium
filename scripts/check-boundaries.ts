/**
 * Dependency-boundary lint (Phase 0 guardrail — see ARCHITECTURE.md "Dependency
 * direction" and docs/offline-sync-architecture.md §4).
 *
 * Rules enforced over apps/, packages/ and scripts/ source:
 *
 *  1. No app→app imports. Grandfathered allowance: `apps/web` may import from
 *     `@podium/server` **type-only** (the `AppRouter` type for the tRPC client).
 *  2. `@podium/agent-bridge`, `@podium/pty` and `@podium/harness` may only be
 *     imported by `apps/daemon`, `scripts/`, and their own packages (including
 *     their tests); agent-bridge may also reach pty and harness. Importing any of
 *     them means driving real agent processes / PTYs, which is a host capability.
 *     Servers read transcripts via `@podium/transcript` instead.
 *     See {@link AGENT_HOST_CONSUMERS}.
 *  3. `@podium/protocol` and `@podium/model` are leaf packages — they import
 *     no other workspace package. `@podium/transcript` is a near-leaf: it may
 *     import only `@podium/protocol`. `@podium/runtime` is a near-leaf
 *     runtime-plumbing package: it may import only `@podium/protocol` and
 *     `@podium/model` (e.g. the model's `normalizeOriginUrl`) — never another
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
 *  7. `@podium/model` is the single home for the entity-pure predicates it
 *     exports (issue stage/authz, snooze/defer, worktree/machine identity,
 *     session dedup + priority, git identity): no OTHER `packages/*` source
 *     file may declare a top-level `export function`/`export const` with the
 *     same name — that shape is a redefinition, the exact bug this rule
 *     catches (client-core's viewmodels used to hand-copy several of these).
 *     Re-exporting a model binding (`export { x } from '@podium/model'` or
 *     `export { x }` after `import { x } from '@podium/model'`) is fine and
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
 * 10. The sync kernel's REPLICA ROLE (`packages/sync/src/replica/`) is
 *     direction-locked (POD-369): it imports nothing outside its own directory
 *     — save for the single neutral unit-of-work port `packages/sync/src/span.ts`
 *     (POD-1146), which is neither a merge policy nor an adapter and is the ONE
 *     definition site both kernel roles share — and its comment-stripped
 *     source contains no visibility/authorization or conflict-resolution
 *     evaluation. A replica that can answer "may this principal see X" is a
 *     second authorization surface; a replica that can pick a conflict winner is
 *     arbitrating. Both are forbidden by ADR 1 D1 / ADR 2 Amendment 1 D12.7.
 *
 * Alongside these ten sits the ARCHITECTURE MANIFEST (POD-296,
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
 * Rule 2's targets: the packages that drive real agent PROCESSES, and who may
 * import each. The machine host (apps/daemon) and the build/compose tier
 * (scripts/) may; nothing else may — servers read transcripts through
 * `@podium/transcript` instead.
 *
 * `packages/pty` is the PTY kernel split out of agent-bridge (POD-396). It is
 * listed here for the same reason agent-bridge is: importing it means spawning
 * PTYs, which is a host capability, not a general-purpose one. agent-bridge may
 * reach it (its real-`claude` harness smoke drives a session through it), and
 * POD-397's `packages/harness` is registered the same way.
 */
const AGENT_HOST_CONSUMERS: Record<string, ReadonlySet<string>> = {
  'packages/agent-bridge': new Set(['apps/daemon', 'scripts', 'packages/agent-bridge']),
  'packages/pty': new Set(['apps/daemon', 'scripts', 'packages/pty', 'packages/agent-bridge']),
  'packages/harness': new Set([
    'apps/daemon',
    'scripts',
    'packages/harness',
    'packages/agent-bridge',
  ]),
}

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

// The TRUE leaf is @podium/model (L0): zod-only, zero workspace deps. Since
// POD-300 @podium/protocol is no longer a leaf — it holds only frames and
// imports its entity schemas from model. That single edge is declared in
// RESTRICTED_PACKAGE_DEPS below, so protocol still cannot reach anything else.
const LEAF_PACKAGES = new Set<string>(['packages/model'])

/**
 * Near-leaf packages: may import ONLY the listed workspace packages (plus node
 * builtins/external deps). `@podium/transcript` is pure parsing/paging over
 * protocol types — it must never grow IO/harness dependencies. `@podium/runtime`
 * is node-runtime plumbing (config, sqlite shims, git, connectivity,
 * auth-store, …) — it may reach into the pure leaves (protocol, model) but
 * must never depend on another app or a non-leaf package.
 */
const RESTRICTED_PACKAGE_DEPS: Record<string, ReadonlySet<string>> = {
  // L1 wire/frames. Since POD-300 the entity schemas live in L0 @podium/model
  // and protocol imports them; that is its ONLY workspace edge.
  'packages/protocol': new Set(['packages/model']),
  'packages/transcript': new Set(['packages/protocol', 'packages/model']),
  // Pure harness composer adapters (POD-859): prompt-draft extraction + keystroke
  // injection, shared by the web fallback and the daemon engine. Must stay pure —
  // only model's AgentKind enum, never IO or harness packages.
  'packages/composer': new Set(['packages/protocol', 'packages/model']),
  'packages/runtime': new Set(['packages/protocol', 'packages/model']),
  // The issue-client seam (IssueTrpc + the CLI's rendering table) sits between
  // apps/cli and apps/server — it must never import app code or IO packages.
  //
  // `packages/commands` was added by POD-311, and it is the point of that issue
  // rather than a concession to it: the CLI table stopped declaring its own
  // command-name universe and now RENDERS the shared L1 contracts. The direction
  // is still downward — `@podium/commands` is L1 contracts-only, forbidden from
  // importing a service, an app or any IO — so this widens what the seam may read,
  // not what it may reach.
  'packages/issue-client': new Set(['packages/commands', 'packages/protocol', 'packages/model']),
  // The node⇄hub sync layer (issue #196: oplog, upstream dialer/forwarder,
  // transcript mirror) — sqlite/config plumbing comes from @podium/runtime;
  // apps/server injects its store repositories through narrow interfaces
  // instead of this package importing apps/server.
  //
  // `packages/commands` was added by POD-311 for ONE consumer — the upstream
  // forwarder's optimistic-patch characterization, which enumerates the issue
  // command vocabulary and previously read that list from `@podium/protocol`,
  // where it was a hand-maintained array. Folding the array into the contract
  // table moved the import; it did not create a new reach. `@podium/commands` is
  // L1 contracts-only (no service, no IO), so the direction is unchanged.
  //
  // THIS DOES NOT WEAKEN THE ONE RULE THAT MATTERS HERE. What must never see the
  // command vocabulary is the REPLICA ROLE — a replica that can interpret a
  // command is a replica that can arbitrate (ADR 2 Amendment 1 D12.7) — and that
  // is rule 10 below, a separate, stricter check over `packages/sync/src/replica/`
  // which admits nothing outside its own directory but `span.ts`. Rule 10 is what
  // holds the line; this table never did.
  'packages/sync': new Set([
    'packages/commands',
    'packages/protocol',
    'packages/runtime',
    'packages/model',
  ]),
  // Opt-in telemetry [spec:SP-f933]: the schema needs model's AgentKind enum
  // and consent/queue need runtime's config + state dir. It must never reach an
  // app — apps/server constructs the emitter and injects its gauges.
  'packages/telemetry': new Set(['packages/protocol', 'packages/runtime', 'packages/model']),
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

const MODEL_HOME = 'packages/model'

/** Matches a top-level `export function NAME` / `export const NAME =`
 *  declaration. Deliberately does NOT match `export { NAME }` or
 *  `export { NAME } from '...'` — those re-export an existing binding rather
 *  than declaring a new one, which is exactly the pattern a model consumer
 *  (e.g. client-core re-exporting a model predicate under its original name
 *  for backward-compatible call sites) is expected to use. */
const TOP_LEVEL_DECL_RE = /^export (?:function|const)\s+([A-Za-z_$][\w$]*)/gm

/** Names @podium/model exports as a top-level function/const (its entity
 *  predicates and pure logic) — read live from packages/model/src so the set
 *  never drifts from the actual package. Returns an empty set (rule 7 no-op)
 *  if the directory can't be read (e.g. a unit test sandboxing the repo).
 *
 *  RECURSIVE on purpose (POD-299): model organises its sources into
 *  entities/ ids/ identity/ authz/ predicates/ annotations/ user-state/, so a
 *  top-level-only scan would have silently reduced this rule to the two files
 *  that stayed at the root — a dark gate that reads as "no violations". */
export function loadModelExportNames(repoRoot: string): Set<string> {
  const names = new Set<string>()
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || isTestFile(entry.name)) continue
      for (const m of stripComments(readFileSync(full, 'utf8')).matchAll(TOP_LEVEL_DECL_RE)) {
        const name = m[1]
        if (name) names.add(name)
      }
    }
  }
  walk(join(repoRoot, MODEL_HOME, 'src'))
  return names
}

/**
 * Rule 7 — @podium/model is the single home for the predicates it exports.
 * Any packages/* file outside @podium/model itself (and outside tests, which
 * legitimately construct fixture doubles) that DECLARES a top-level
 * function/const under the same name is almost certainly a redefinition.
 */
function checkModelRedefinition(
  file: string,
  source: string,
  modelExportNames: ReadonlySet<string>,
): Violation[] {
  if (modelExportNames.size === 0) return []
  if (!file.startsWith('packages/') || file.startsWith(`${MODEL_HOME}/`)) return []
  if (isTestFile(file)) return []
  const violations: Violation[] = []
  for (const m of stripComments(source).matchAll(TOP_LEVEL_DECL_RE)) {
    const name = m[1]
    if (name && modelExportNames.has(name)) {
      violations.push({
        file,
        specifier: name,
        rule: 'model-single-home',
        message: `${file}: redefines '${name}', which @podium/model already exports — import it from '@podium/model' instead (re-exporting the imported binding is fine; declaring a new one under the same name is not)`,
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
/**
 * Every cross-package `@podium/*` import must be a DECLARED dependency of the
 * importing workspace (POD-1131).
 *
 * This closes a hole the other rules could not see. All of them reason about
 * DECLARED edges — layer order, platform tags, leaf purity — so an import whose
 * package.json entry is simply MISSING is invisible to the whole gate: there is no
 * edge to judge. It resolves anyway under Bun's hoisted node_modules, so nothing
 * fails locally, and then a scoped typecheck of some UNRELATED consumer reports
 * TS2307 because no workspace symlink exists. POD-300 produced exactly that:
 * import specifiers moved to `@podium/model`, the dependency lists did not, and
 * `packages/harness` silently imported a package it never declared until an
 * unrelated app's typecheck broke.
 *
 * Reads package.json rather than trusting the import graph, and uses readFileSync
 * over shell grep because one NUL byte makes grep answer "no match".
 */
export function checkDeclaredDeps(repoRoot: string): Violation[] {
  const violations: Violation[] = []
  const manifests = new Map<string, { name?: string; deps: Set<string> }>()
  for (const rootDir of ['apps', 'packages']) {
    const root = join(repoRoot, rootDir)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const ws = `${rootDir}/${entry.name}`
      const pj = join(repoRoot, ws, 'package.json')
      if (!existsSync(pj)) continue
      const parsed = JSON.parse(readFileSync(pj, 'utf8')) as {
        name?: string
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      manifests.set(ws, {
        name: parsed.name,
        deps: new Set([
          ...Object.keys(parsed.dependencies ?? {}),
          ...Object.keys(parsed.devDependencies ?? {}),
        ]),
      })
    }
  }
  const known = new Set([...manifests.values()].map((m) => m.name).filter(Boolean) as string[])
  for (const [ws, { name, deps }] of manifests) {
    const srcDir = join(repoRoot, ws, 'src')
    if (!existsSync(srcDir)) continue
    for (const abs of walk(srcDir)) {
      const file = relative(repoRoot, abs).split(sep).join('/')
      const source = readFileSync(abs, 'utf8')
      for (const ref of extractImports(source)) {
        const spec = ref.specifier
        if (!spec.startsWith('@podium/')) continue
        // Only workspace packages: a published @podium/* dep is a normal dep.
        if (!known.has(spec) || spec === name || deps.has(spec)) continue
        violations.push({
          file,
          specifier: spec,
          rule: 'declared-deps',
          message: `${file}: imports '${spec}' but ${ws}/package.json does not declare it — it resolves via hoisting today and breaks an unrelated workspace's typecheck tomorrow (POD-1131)`,
        })
      }
    }
  }
  return violations
}

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

/**
 * The workspaces that must stay PRINCIPAL-FREE libraries (POD-397 / POD-325 AC).
 * They describe SOFTWARE and drive PROCESSES; they never answer "who is acting,
 * and for whom".
 */
const PRINCIPAL_FREE_WORKSPACES: readonly string[] = [
  'packages/harness',
  'packages/transcript',
  'packages/agent-bridge',
]

/**
 * Identifiers that carry a principal, an authorization decision, or a visibility
 * class. Matched as whole words in a workspace's IMPORT CLAUSES only — this is a
 * "what did you pull in" rule, not a full taint analysis.
 *
 * DELIBERATELY EXCLUDES `HarnessCapabilities`. That is the harness CAPABILITY
 * DESCRIPTOR ("does this CLI support an argv prompt?") and has
 * nothing to do with an authorization capability. The two senses of the word
 * collide exactly here, which is why the exclusion is written down rather than
 * left to whoever next reads a failure.
 */
const PRINCIPAL_IDENTIFIERS: readonly string[] = [
  'UserId',
  'Principal',
  'EnvelopePrincipal',
  'envelopePrincipal',
  'OperatorPrincipal',
  'CurrentUser',
  'OnBehalfOf',
  'Grant',
  'PairingGrant',
  'pairingGrant',
  'VisibilityClass',
  'AuthzContext',
  'IssueAuthz',
  'authorize',
  'requirePermission',
]

const PRINCIPAL_RE = new RegExp(`\\b(${PRINCIPAL_IDENTIFIERS.join('|')})\\b`)

/**
 * Rule: packages/harness, packages/transcript (and the pty half until POD-399
 * deletes it) must not import a principal, user, grant or visibility type.
 *
 * WHY IT IS A LINT rather than a review note: the pressure to break this is
 * ordinary and arrives one call site at a time — someone threads a `currentUser`
 * into a manifest or a discovery call to make something compile, and the harness
 * layer quietly becomes an authorization layer. Per docs/multi-user-readiness.md
 * §3.1.1 the harness/model inventory is OWNED COMPUTE whose scoping is applied at
 * the SERVER PROJECTION BOUNDARY (POD-1079); the daemon side runs as a system
 * principal, which per §3.1.6 S5 may read across owners but never acts as a person
 * and never widens anyone's visibility. If a call site seems to need a principal
 * here, the fix is to push it out to the caller.
 */
export function checkPrincipalFree(file: string, source: string): Violation[] {
  const workspace = PRINCIPAL_FREE_WORKSPACES.find((w) => file.startsWith(`${w}/`))
  if (!workspace) return []
  const violations: Violation[] = []
  const stripped = stripComments(source)
  // Import CLAUSES only: a local variable happening to be called `grant` is not a
  // boundary violation, and this rule should not pretend to know about one.
  const clauses = stripped.matchAll(
    /\b(?:import|export)\s+(?:type\s+)?(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g,
  )
  for (const m of clauses) {
    const clause = m[1] ?? ''
    const specifier = m[2] ?? ''
    const hit = PRINCIPAL_RE.exec(clause)
    if (!hit) continue
    violations.push({
      file,
      specifier,
      rule: 'harness-principal-free',
      message: `${file}: imports '${hit[1]}' from '${specifier}' — ${workspace} must stay a principal-free library (no operator, user id, grant or visibility class). Authorization belongs at the server projection boundary (POD-1079); push the principal out to the caller. See docs/multi-user-readiness.md §3.1.1.`,
    })
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
 *  `modelExportNames` (rule 7) defaults to empty, i.e. a no-op, so existing
 *  call sites (and most tests) that don't pass it are unaffected. */

/**
 * Rule 9 — the sync kernel's REPLICA ROLE is direction-locked (POD-369; ADR 1 D1,
 * ADR 2 Amendment 1 D12.7).
 *
 * The replica applies an ordering somebody else decided. Two things it must never
 * acquire, expressed as one lint because they are the same mistake at two scales:
 *
 *  (a) **No merge policy, no arbitration.** Conflict resolution is the Authority's
 *      job. The replica's imports are therefore restricted to its own directory:
 *      it takes storage and transport as injected PORTS, so any cross-package
 *      import at all is either a merge/domain policy leaking in or a concrete
 *      adapter it is not allowed to know about.
 *  (b) **No visibility or authorization evaluation.** Under private-by-default the
 *      authority computes the slice; the replica applies it. The moment this code
 *      can answer "may this principal see X" it has become a second, untrusted
 *      authorization surface — the thing ADR 3 D7's posture forbids and no
 *      client-side code can be trusted to hold.
 *
 * (b) is checked over comment-stripped source (the manifest's shared
 * `stripComments`) so that DOCUMENTING the prohibition — which that code does at
 * length — does not trip the lint that enforces it.
 */
const REPLICA_ROLE_DIR = 'packages/sync/src/replica/'

/**
 * The ONE module the replica role may reach outside its directory (POD-1146).
 *
 * ADR 2 D10's unit of work must have a single definition site, and it must sit
 * where NEITHER kernel role imports the other: inside `replica/` the outbox would
 * have to import the replica, which is the edge POD-369 and POD-370 deliberately
 * removed. So the span port lives one level up and this rule names it exactly.
 *
 * It is an EXACT PATH and not a prefix, and that is the whole safety of it. A
 * directory exception (`packages/sync/src/ports/`) would let a future file that
 * happens to land beside the span carry a merge policy or a concrete adapter into
 * the replica under the same waiver. This list may only grow by someone editing
 * this constant, which is the review checkpoint the rule exists to force.
 */
const REPLICA_NEUTRAL_PORTS: ReadonlySet<string> = new Set(['packages/sync/src/span.ts'])

/** Evaluation verbs. A call or a declaration either way — both are the same bug. */
const REPLICA_FORBIDDEN_EVAL =
  /\b(canSee|maySee|mayView|isVisibleTo|visibleTo|evaluateVisibility|filterVisible|hasGrant|grantsFor|checkAccess|checkIssueAccess|authorize|resolveCapability|mergePolicy|resolveConflict|arbitrate|lastWriteWins|mergeFields|pickWinner)\s*\(/

/**
 * Rule 11 — the sync KERNEL has zero SQLite/Bun/DOM (POD-305; ADR 2's layered
 * persistence ownership, POD-279 review finding 5).
 *
 * This is POD-305's acceptance criterion as a LINT rather than as a claim,
 * because the import that breaks it will be added by somebody who never read the
 * comment saying not to.
 *
 * The layering it enforces:
 *
 *   KERNEL   `packages/sync/src/**` (everything else)  ports + state machines.
 *   ADAPTER  `packages/sync/src/adapters/**`           the one place a storage
 *                                                      technology is named.
 *
 * SCOPED TO EXACTLY THE THREE TECHNOLOGIES THE CRITERION NAMES, and this is a
 * decision worth stating because the first draft was broader and wrong. Written
 * as "no infrastructure", it also caught `node:fs` in `mirror.ts` (the
 * transcript-lake writer) and `upstream.ts` (the node→hub dialer) — neither of
 * which is a kernel role, both of which legitimately touch files, and one of
 * which POD-309 deletes outright. A rule that needs three exclusions to pass on
 * the day it lands is a rule that will be widened by exclusion afterwards. So it
 * says what the criterion says: SQLite, Bun, DOM. `mirror.ts` and `upstream.ts`
 * pass because reading a file is not any of those three, and no exclusion — and
 * therefore no allowlist entry — is needed for them.
 *
 * TWO PROHIBITIONS, and the second is the one that rots first:
 *
 *  (a) NO SQLITE, BUN OR DOM. A kernel that knows what a database is cannot be
 *      instantiated by the next storage backend without being edited, and one
 *      that knows what a `window` is cannot run on the server.
 *  (b) NO REACHING INTO `adapters/` FROM KERNEL SOURCE. The dependency points
 *      one way: the adapter implements the kernel's ports, the kernel never
 *      names the adapter. Without (b), (a) is bypassed by importing a helper
 *      from the adapter that re-exports the thing.
 *
 * TESTS ARE HELD TO (a) AND EXEMPT FROM (b), deliberately. A kernel test that
 * wires the REAL adapter is proving the port against real technology, which is
 * the most valuable test in the package — but it must take that wiring as a
 * FIXTURE from the layer that owns the technology rather than importing SQLite
 * itself. A test is exactly where a database import first looks harmless, and a
 * kernel test that has one is one refactor away from a kernel MODULE that does.
 *
 * `index.ts` is exempt from (b) and only from (b): a package barrel names every
 * layer by definition — that is what a barrel is — and `@podium/sync`'s public
 * surface legitimately includes the SQLite repository apps/server constructs.
 * What matters is that no kernel MODULE reaches for it, which is what the rule
 * still checks everywhere else.
 */
const SYNC_KERNEL_DIR = 'packages/sync/src/'
const SYNC_ADAPTER_DIR = 'packages/sync/src/adapters/'
const SYNC_PACKAGE_BARREL = 'packages/sync/src/index.ts'

/** SQLite, Bun and DOM — the three the criterion names, and nothing else. */
const KERNEL_FORBIDDEN_SPECIFIER =
  /^(?:bun:|@podium\/runtime\/sqlite$|better-sqlite3|drizzle-orm(?:\/|$))/

/** DOM reached through a global rather than an import — the form no import
 *  check can see, and the one a browser-shaped helper arrives as. */
const KERNEL_FORBIDDEN_DOM =
  /\b(?:window|document|localStorage|sessionStorage|navigator|indexedDB|HTMLElement)\b/

function checkSyncKernelPurity(file: string, source: string): Violation[] {
  if (!file.startsWith(SYNC_KERNEL_DIR)) return []
  if (file.startsWith(SYNC_ADAPTER_DIR)) return []
  const violations: Violation[] = []
  const isTest = file.endsWith('.test.ts')
  for (const ref of extractImports(source)) {
    if (KERNEL_FORBIDDEN_SPECIFIER.test(ref.specifier)) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'sync-kernel-purity',
        message: `${file}: the sync kernel imports '${ref.specifier}' — SQLite, Bun and DOM are the adapter's, not the kernel's. Infrastructure lives in ${SYNC_ADAPTER_DIR}; the kernel takes storage and transactions as injected ports (POD-305, ADR 2 layered persistence ownership).`,
      })
      continue
    }
    if (isTest || file === SYNC_PACKAGE_BARREL) continue
    const resolved = ref.specifier.startsWith('.')
      ? relative('/', resolve('/', dirname(file), ref.specifier))
          .split(sep)
          .join('/')
      : ref.specifier
    if (resolved.startsWith(SYNC_ADAPTER_DIR)) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'sync-kernel-purity',
        message: `${file}: the sync kernel imports the SQLite adapter ('${ref.specifier}'). The dependency points one way — the adapter implements the kernel's ports, never the reverse — and without this the no-SQLite rule is bypassed by re-export. Tests may wire the real adapter; kernel source may not.`,
      })
    }
  }
  // Checked over COMMENT-STRIPPED source, so that DOCUMENTING the prohibition —
  // which this package does at length — does not trip the lint enforcing it.
  // Same treatment rule 9 gives its evaluation verbs, and for the same reason.
  const dom = KERNEL_FORBIDDEN_DOM.exec(stripComments(source))
  if (dom) {
    violations.push({
      file,
      specifier: dom[0],
      rule: 'sync-kernel-purity',
      message: `${file}: '${dom[0]}' is a DOM global. The sync kernel runs on the server and in a worker as well as in a browser; reaching a DOM global makes it instantiable in exactly one of them (POD-305).`,
    })
  }
  return violations
}

function checkReplicaDirection(file: string, source: string): Violation[] {
  if (!file.startsWith(REPLICA_ROLE_DIR)) return []
  const violations: Violation[] = []
  const isTest = file.endsWith('.test.ts')
  for (const ref of extractImports(source)) {
    if (ref.specifier.startsWith('.')) {
      const abs = resolve('/', dirname(file), ref.specifier)
      const rel = relative('/', abs).split(sep).join('/')
      if (rel.startsWith(REPLICA_ROLE_DIR)) continue
      // Extensionless by convention here, so both spellings resolve to the same
      // module and both must be checked against the exact-path allowlist.
      if (REPLICA_NEUTRAL_PORTS.has(rel) || REPLICA_NEUTRAL_PORTS.has(`${rel}.ts`)) continue
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'replica-direction',
        message: `${file}: the Replica role imports '${ref.specifier}' outside ${REPLICA_ROLE_DIR}. It takes storage and transport as injected ports; reaching outside is how a merge policy or a concrete adapter gets in (ADR 1 D1).`,
      })
      continue
    }
    if (isTest && ref.specifier === 'vitest') continue
    violations.push({
      file,
      specifier: ref.specifier,
      rule: 'replica-direction',
      message: `${file}: the Replica role imports '${ref.specifier}'. The replica never arbitrates and never evaluates visibility, so it depends on nothing but its own ports (ADR 1 D1, ADR 2 Amendment 1 D12.7).`,
    })
  }
  const code = stripComments(source)
  const evaluation = REPLICA_FORBIDDEN_EVAL.exec(code)
  if (evaluation) {
    violations.push({
      file,
      specifier: evaluation[1] ?? 'visibility evaluation',
      rule: 'replica-direction',
      message: `${file}: '${evaluation[1]}(' is an arbitration or visibility decision. The Authority computes the slice and resolves conflicts; the Replica applies what it is given (ADR 2 Amendment 1 D12.7).`,
    })
  }
  return violations
}

// ---------------------------------------------------------------------------
// Rule 12 — `sync-browser-reach` (POD-307)
// ---------------------------------------------------------------------------
//
// `packages/sync` is tagged NEUTRAL (see the long note beside its entry in
// scripts/architecture-manifest.ts). Neutral is UNCONSTRAINED by the platform
// rule, so on its own the retag would let apps/web import the bare barrel —
// which value-exports the Authority, the Ledger, `mirror.ts` and the SQLite
// repository. This rule is the half that makes the retag honest, and it lands in
// the same commit as the retag for that reason.
//
// TWO HALVES, because either alone is a gate that cannot say no:
//
//  (a) A browser-safe workspace may reach `@podium/sync` only through a DECLARED
//      browser entrypoint. The bare barrel and every undeclared subpath fail.
//      This is rule 8a's shape (apps/web + @podium/runtime), generalised to every
//      browser-safe workspace because ADR 6 puts a client adapter on mobile too.
//
//  (b) Each declared entrypoint's TRANSITIVE import closure must contain no Node.
//      Rule 8b deliberately stops at one hop; this one does not, and the
//      difference is load-bearing: (a) alone would be satisfied by an entrypoint
//      that re-exports `authority/index`, and a declaration list nobody verifies
//      is exactly the mechanism-present/coverage-absent shape. An entrypoint whose
//      graph cannot be WALKED is reported too — an unresolvable import silently
//      truncates the closure, and a truncated closure is green for the wrong
//      reason.
//
// WHAT (b) DOES NOT COVER, stated rather than left to be discovered: npm
// dependencies are checked only against the short list below. A browser-hostile
// npm package outside it would pass this rule. That is the job of
// `scripts/audit-browser-reach.ts`, which bundles each entrypoint with a real
// browser-target bundler — source text and a running bundler, paired, because
// each is blind where the other sees.
//
// Type-only imports are exempt, matching checkManifestEdge: they are erased at
// build and create no bundle edge.

/**
 * The browser-safe surface of `@podium/sync`: specifier → source entry module.
 *
 * Adding a row here is a DECISION that the module's whole import closure is
 * browser-safe, and (b) then holds you to it. `packages/sync/package.json` must
 * carry the matching `exports` entry — asserted in scripts/check-boundaries.test.ts,
 * because a rule permitting a specifier Node cannot resolve is a rule that
 * permits nothing.
 */
export const SYNC_BROWSER_ENTRYPOINTS: ReadonlyMap<string, string> = new Map([
  ['@podium/sync/replica', 'packages/sync/src/replica/index.ts'],
  ['@podium/sync/outbox', 'packages/sync/src/outbox/index.ts'],
  ['@podium/sync/span', 'packages/sync/src/span.ts'],
  ['@podium/sync/adapters/indexeddb', 'packages/sync/src/adapters/indexeddb/index.ts'],
  ['@podium/sync/adapters/mobile-sqlite', 'packages/sync/src/adapters/mobile-sqlite/index.ts'],
  ['@podium/sync/adapters/legacy-replica', 'packages/sync/src/adapters/legacy-replica/index.ts'],
])

/** npm specifiers (b) knows are node-only. Short and explicit — see the note
 *  above on what this deliberately does not attempt. */
const SYNC_BROWSER_FORBIDDEN_NPM: ReadonlySet<string> = new Set([
  'ws',
  'better-sqlite3',
  'drizzle-orm',
  'fake-indexeddb',
])

/**
 * Rule 12a — a browser-safe workspace may reach @podium/sync only through a
 * declared browser entrypoint.
 */
export function checkSyncBrowserReach(file: string, ref: ImportRef): Violation | null {
  if (ref.typeOnly) return null
  if (isTestFile(file)) return null
  const spec = ref.specifier
  if (spec !== '@podium/sync' && !spec.startsWith('@podium/sync/')) return null
  const from = workspaceOf(file)
  if (tagsFor(from)?.platform !== 'browser-safe') return null
  if (SYNC_BROWSER_ENTRYPOINTS.has(spec)) return null
  const allowed = [...SYNC_BROWSER_ENTRYPOINTS.keys()].sort().join(', ')
  return {
    file,
    specifier: spec,
    rule: 'sync-browser-reach',
    message:
      spec === '@podium/sync'
        ? `${file}: browser-safe ${from} imports the @podium/sync BARREL — it value-exports the Authority, the Ledger and the SQLite repository, so a browser bundle would inline Node code. Import a declared browser entrypoint instead: ${allowed}.`
        : `${file}: browser-safe ${from} imports '${spec}', which is not a declared browser entrypoint of @podium/sync. Declared: ${allowed}. Adding one is a decision — declare it in SYNC_BROWSER_ENTRYPOINTS (scripts/check-boundaries.ts) and its closure is then held to no-Node.`,
  }
}

/** Resolve a relative specifier against a repo-relative importer, trying the
 *  extensionless spellings this repo uses. Returns null when nothing exists —
 *  which (b) reports rather than skips. */
function resolveRelativeModule(repoRoot: string, fromFile: string, spec: string): string | null {
  const base = relative('/', resolve('/', dirname(fromFile), spec))
    .split(sep)
    .join('/')
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (candidate.endsWith('.ts') || candidate.endsWith('.tsx')) {
      if (existsSync(join(repoRoot, candidate))) return candidate
    }
  }
  return null
}

/**
 * Rule 12b — the transitive closure of every declared browser entrypoint is
 * Node-free. Runs over the declared set rather than per-file (same shape as
 * rules 8b and 9).
 */
export function checkSyncBrowserGraphAll(repoRoot: string): Violation[] {
  const violations: Violation[] = []
  for (const [specifier, entry] of SYNC_BROWSER_ENTRYPOINTS) {
    const seen = new Set<string>()
    const queue: string[] = [entry]
    while (queue.length > 0) {
      const file = queue.shift() as string
      if (seen.has(file)) continue
      seen.add(file)
      let source: string
      try {
        source = readFileSync(join(repoRoot, file), 'utf8')
      } catch {
        violations.push({
          file: entry,
          specifier,
          rule: 'sync-browser-reach',
          message: `${entry}: declared browser entrypoint of '${specifier}' does not exist — a missing entry makes the closure check vacuously green. Create it or remove the row from SYNC_BROWSER_ENTRYPOINTS.`,
        })
        continue
      }
      for (const ref of extractImports(source)) {
        if (ref.typeOnly) continue
        const spec = ref.specifier
        if (spec.startsWith('.')) {
          const target = resolveRelativeModule(repoRoot, file, spec)
          if (target === null) {
            violations.push({
              file,
              specifier: spec,
              rule: 'sync-browser-reach',
              message: `${file}: reachable from browser entrypoint '${specifier}' and imports '${spec}', which resolves to no file here. An unresolvable import TRUNCATES the closure, so the no-Node claim would be green for the wrong reason.`,
            })
            continue
          }
          queue.push(target)
          continue
        }
        const bad =
          spec.startsWith('node:') ||
          spec.startsWith('bun:') ||
          spec.startsWith('@podium/runtime/') ||
          SYNC_BROWSER_FORBIDDEN_NPM.has(spec) ||
          (spec.startsWith('@podium/') &&
            tagsFor(podiumWorkspaceOf(spec))?.platform === 'node-only')
        if (bad) {
          violations.push({
            file,
            specifier: spec,
            rule: 'sync-browser-reach',
            message: `${file}: reachable from browser entrypoint '${specifier}' and imports '${spec}' — a browser bundle would inline Node code. @podium/sync is tagged NEUTRAL on the strength of this closure staying Node-free (POD-307); move the dependency behind a port the composition root injects.`,
          })
        }
      }
    }
  }
  return violations
}

/** `@podium/foo` / `@podium/foo/bar` → the workspace path the manifest tags. */
function podiumWorkspaceOf(specifier: string): string {
  const name = specifier.slice('@podium/'.length).split('/')[0] ?? ''
  return tagsFor(`packages/${name}`) !== null ? `packages/${name}` : `apps/${name}`
}

const SESSION_BINDING_CONSUMER =
  /^(?:apps\/daemon\/src\/session-observers\.ts|apps\/daemon\/src\/control\/[^/]+\.ts)$/
const SESSION_BINDING_DELEGATION_ACCESS =
  /(?:\.\s*(onBehalfOf|actor|scope)\b|\b(onBehalfOf|actor|scope)\s*:)/g

export function checkSessionBindingFieldAccess(file: string, source: string): Violation[] {
  if (!SESSION_BINDING_CONSUMER.test(file) || file.endsWith('.test.ts')) return []
  const violations: Violation[] = []
  for (const match of stripComments(source).matchAll(SESSION_BINDING_DELEGATION_ACCESS)) {
    const field = match[1] ?? match[2]
    if (!field) continue
    violations.push({
      file,
      specifier: field,
      rule: 'session-binding-field-access',
      message: `${file}: reads or writes SessionBinding delegation field '${field}' directly. Observers and control handlers consume SessionBinding; alias and delegation field names stay in the binding module and manifests (POD-416).`,
    })
  }
  return violations
}

export function checkFile(
  file: string,
  source: string,
  modelExportNames: ReadonlySet<string> = new Set(),
): Violation[] {
  const violations: Violation[] = [
    ...checkModelRedefinition(file, source, modelExportNames),
    ...checkReplicaDirection(file, source),
    ...checkSyncKernelPurity(file, source),
    ...checkSessionBindingFieldAccess(file, source),
  ]
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

    // Rule 2: agent-host importers are restricted — the machine host and the
    // build tier may drive agent processes; nothing else may.
    const hostAllowed = AGENT_HOST_CONSUMERS[to]
    if (hostAllowed) {
      if (hostAllowed.has(from)) continue
      if (GRANDFATHERED_AGENT_BRIDGE.has(file)) continue
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'agent-bridge-consumers',
        message: `${file}: '${ref.specifier}' may only be imported by ${[...hostAllowed].sort().join(', ')}, or its own tests (Phase 3 extracts @podium/transcript for the grandfathered server cases)`,
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
    // Rule 12a — the guard that replaces what packages/sync's node-only tag used
    // to give the platform rule for free.
    const syncReach = checkSyncBrowserReach(file, ref)
    if (syncReach) {
      violations.push(syncReach)
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
  const modelExportNames = loadModelExportNames(repoRoot)
  const harnessLiterals = loadHarnessLiterals(repoRoot)
  for (const rootDir of ['apps', 'packages', 'scripts']) {
    for (const abs of walk(join(repoRoot, rootDir))) {
      const file = relative(repoRoot, abs).split(sep).join('/')
      const source = readFileSync(abs, 'utf8')
      workspaces.add(workspaceOf(file))
      violations.push(...checkFile(file, source, modelExportNames))
      violations.push(...checkPrincipalFree(file, source))
      manifest.push(...checkManifestFile(file, source, harnessLiterals))
      if (extractImports(source).some((r) => r.specifier.startsWith('@podium/agent-bridge')))
        agentBridgeImporters.add(file)
    }
  }
  violations.push(...checkRuntimeBarrelPurity(repoRoot))
  violations.push(...checkDeclaredDeps(repoRoot))
  violations.push(...checkHostEdgeSeparationAll(repoRoot))
  manifest.push(...checkManifestCoverage(workspaces))
  manifest.push(...checkSyncBrowserGraphAll(repoRoot))
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
