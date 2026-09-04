/**
 * Dependency-boundary lint (Phase 0 guardrail — see ARCHITECTURE.md "Dependency
 * direction" and docs/offline-sync-architecture.md §4).
 *
 * Rules enforced over apps/, packages/ and scripts/ source:
 *
 *  1. No app→app imports. Grandfathered allowance: `apps/web` may import from
 *     `@podium/server` **type-only** (the `AppRouter` type for the tRPC client).
 *  2. `@podium/harness`, `@podium/pty` and `@podium/harness` may only be
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
 * 11. CONSOLE OWNERSHIP (POD-1905): product source under `apps/` and
 *     `packages/` logs through `@podium/logger`, not `console.*`. Exempt are
 *     the places where console output IS the product — CLI stdout, the logger
 *     package itself, perf harnesses, the logging module's own degrade notices
 *     — plus tests (by DIRECTORY, not by glob) and the build tier. The full
 *     reasoning, and what the rule deliberately cannot see, sits with
 *     {@link checkConsoleOwnership}.
 *
 * 13. The STORE BOUNDARY family (POD-3252, epic POD-3221): four rules over the
 *     repositories — no raw SQLite handle (`@podium/runtime/sqlite`,
 *     `.prepare(`, a whole raw statement on `db.all/get/run/values`), no
 *     `PRAGMA`/`sqlite_master`/`ATTACH` inside a `sql` body, no drizzle
 *     transaction outside the store's `transact` port, drizzle imported only
 *     from persistence, and no `sql.raw` of a non-literal. Before the drizzle
 *     conversion they are Stage A's COMPLETENESS PROOF, gated by the shrinking
 *     {@link STAGE_A_UNCONVERTED} ledger; after it they are the permanent guard
 *     that keeps the hosted server able to run on Turso. Full reasoning, the
 *     exemptions and what is deliberately NOT banned:
 *     docs/gates/pod-3252-store-boundary-lint.md.
 *
 * Alongside these (and rule 12, `sync-browser-reach`, documented at its own
 * definition) sits the ARCHITECTURE MANIFEST (POD-296,
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
 *  - `bun run lint:boundaries` — everything, and the BLOCKING CI step. It is
 *    also wired into `bun run lint`, which is `continue-on-error` while
 *    biome's backlog is burned down; that bundle is not what gates.
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
  applyManifestPolicy,
  BROWSER_ENTRYPOINTS,
  browserEntrypointsOf,
  checkAuthzSingleHome,
  checkManifestEdge,
  checkManifestRole,
  clauseIsTypeOnly,
  extractImports,
  findHarnessBranching,
  findRetiredFile,
  findRetiredImports,
  type ImportRef,
  isTestFile,
  loadHarnessLiterals,
  MANIFEST,
  PLANE_SPLIT_ENTRIES,
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

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const SERVER_SRC = 'apps/server/src/'

/** apps/server/src-relative posix path of `file`, or null when outside it. */
function serverSrcRel(file: string): string | null {
  return file.startsWith(SERVER_SRC) ? file.slice(SERVER_SRC.length) : null
}

const MODEL_HOME = 'packages/model'

/** Matches a top-level `export function NAME` / `export const NAME =`
 *  declaration. Deliberately does NOT match `export { NAME }` or
 *  `export { NAME } from '...'` — those re-export an existing binding rather
 *  than declaring a new one, which is exactly the pattern a model consumer
 *  (e.g. client-core re-exporting a model predicate under its original name
 *  for backward-compatible call sites) is expected to use.
 *
 *  The leading `[ \t]*` is what makes this survive `stripComments`, which blanks
 *  a comment to spaces IN PLACE rather than deleting it (POD-296). A block
 *  comment closed immediately before `export` on the same line, with no space
 *  between, leaves blanks where it stood — and a bare `^export` then misses it
 *  entirely (POD-755). `[ \t]` rather than `\s` so it cannot cross a newline. */
const TOP_LEVEL_DECL_RE = /^[ \t]*export (?:function|const)\s+([A-Za-z_$][\w$]*)/gm

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
 * Every cross-package `@podium/*` import must be a DECLARED dependency of the
 * importing workspace (POD-1131).
 *
 * This closes a hole the other rules could not see. All of them reason about
 * DECLARED edges — layer order, platform tags, leaf purity — so an import whose
 * package.json entry is simply MISSING is invisible to the whole gate: there is no
 * edge to judge.
 *
 * Under isolated linking with `hoist = false` such an import no longer resolves at
 * all — the workspace symlink is never created, so it fails outright. This rule is
 * still what you want in front of that: it names the offending file, the specifier
 * and the workspace whose package.json needs the entry, whereas the raw failure is
 * a bare module-not-found or a TS2307 that can surface in an UNRELATED consumer's
 * scoped typecheck long after the edit that caused it. POD-300 produced exactly that:
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
 * The workspaces that must stay PRINCIPAL-FREE libraries (POD-397 / POD-325 AC).
 * They describe SOFTWARE and drive PROCESSES; they never answer "who is acting,
 * and for whom".
 */
const PRINCIPAL_FREE_WORKSPACES: readonly string[] = [
  // POD-2019 joins `packages/agent-runtime` to the set, for the same reason and
  // at the same layer as the other three. The contract describes how a session
  // is DRIVEN, never who may drive it: `SessionSpec`'s account selector names a
  // harness-native login (which `~/.codex/auth.json` to spawn under), not a
  // principal, and carries no user id, grant or visibility class. Authorization
  // belongs at the server projection boundary (POD-1079), which is above this
  // package — and stating it as a lint keeps a future driver from reaching for
  // an authz type when what it actually wants is an account.
  'packages/agent-runtime',
  'packages/harness',
  'packages/pty',
  'packages/transcript',
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
 * Rule: packages/harness, packages/pty and packages/transcript must not import
 * a principal, user, grant or visibility type.
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
    const appPackage = APP_PACKAGES[name]
    if (appPackage !== undefined) return appPackage
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

/**
 * Package imports the replica role may take (POD-1251).
 *
 * `@podium/model` is L0 field vocabulary — change ops, target fields, provenance
 * — not arbitration and not a storage adapter. The direction rule exists to keep
 * merge policy and concrete adapters OUT; composing the change envelope from the
 * model's one definition of those fields is exactly the opposite of restating
 * them inside the role. A second package name here needs the same justification.
 */
const REPLICA_ALLOWED_PACKAGES: ReadonlySet<string> = new Set(['@podium/model'])

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
    if (REPLICA_ALLOWED_PACKAGES.has(ref.specifier)) continue
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
/** npm specifiers the closure check knows are node-only. Short and explicit —
 *  see the note above on what this deliberately does not attempt. */
const BROWSER_FORBIDDEN_NPM: ReadonlySet<string> = new Set([
  'ws',
  'better-sqlite3',
  'drizzle-orm',
  'fake-indexeddb',
])

/**
 * Rule `manifest-browser-reach` (a) — a browser-safe workspace may reach a
 * NEUTRAL workspace only through a declared browser entrypoint.
 *
 * POD-335 generalised this from `@podium/sync` to every neutral workspace, which
 * is what retires legacy rule 8a: "apps/web may import only the bare
 * @podium/runtime specifier, never a subpath" is the same sentence with the
 * subject widened, and `@podium/runtime` is now one row of
 * {@link BROWSER_ENTRYPOINTS} rather than a rule of its own.
 */
export function checkBrowserReach(file: string, ref: ImportRef): Violation | null {
  if (ref.typeOnly || isTestFile(file)) return null
  const spec = ref.specifier
  if (!spec.startsWith('@podium/')) return null
  const to = podiumWorkspaceOf(spec)
  if (tagsFor(to)?.platform !== 'neutral') return null
  const from = workspaceOf(file)
  if (from === to) return null
  if (tagsFor(from)?.platform !== 'browser-safe') return null
  if (BROWSER_ENTRYPOINTS.has(spec)) return null
  const allowed = browserEntrypointsOf(to)
  return {
    file,
    specifier: spec,
    rule: 'manifest-browser-reach',
    message:
      spec === `@podium/${to.slice(to.indexOf('/') + 1)}`
        ? `${file}: browser-safe ${from} imports the ${spec} BARREL. ${to} is tagged NEUTRAL — its barrel value-exports the node-only half — so a browser bundle would inline Node code. Import a declared browser entrypoint instead: ${browserEntrypointsOf(to).join(', ')}.`
        : `${file}: browser-safe ${from} imports '${spec}', which is not a declared browser entrypoint of ${to}. ${to} is tagged NEUTRAL — it has a browser half and a node-only half — so only its declared surface is reachable from a bundle. Declared: ${allowed.length > 0 ? allowed.join(', ') : 'none'}. Adding one is a decision: declare it in BROWSER_ENTRYPOINTS (scripts/architecture-manifest.ts) and its whole import closure is then held to no-Node.`,
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
 * Rule `manifest-browser-reach` (b) — the transitive closure of every declared
 * browser entrypoint is Node-free.
 *
 * Runs over the declared set rather than per-file. This is the half that makes a
 * declaration mean something: (a) alone would be satisfied by an entrypoint that
 * re-exports the Authority, and a list nobody verifies is mechanism-presence,
 * not coverage. It also SUBSUMES legacy rule 8b, which checked the same property
 * one hop deep and said so in its own doc — a barrel re-exporting a file that
 * re-exports a node-tainted file slipped through it and does not slip through
 * this.
 *
 * An entrypoint whose graph cannot be WALKED is reported too: an unresolvable
 * import silently truncates the closure, and a truncated closure is green for
 * the wrong reason.
 */
export function checkBrowserGraphAll(repoRoot: string): Violation[] {
  const violations: Violation[] = []
  for (const [specifier, entry] of BROWSER_ENTRYPOINTS) {
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
          rule: 'manifest-browser-reach',
          message: `${entry}: declared browser entrypoint of '${specifier}' does not exist — a missing entry makes the closure check vacuously green. Create it or remove the row from BROWSER_ENTRYPOINTS.`,
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
              rule: 'manifest-browser-reach',
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
          BROWSER_FORBIDDEN_NPM.has(spec) ||
          (spec.startsWith('@podium/') &&
            tagsFor(podiumWorkspaceOf(spec))?.platform === 'node-only')
        if (bad) {
          violations.push({
            file,
            specifier: spec,
            rule: 'manifest-browser-reach',
            message: `${file}: reachable from browser entrypoint '${specifier}' and imports '${spec}' — a browser bundle would inline Node code. The workspace is tagged NEUTRAL on the strength of this closure staying Node-free; move the dependency behind a port the composition root injects.`,
          })
        }
      }
    }
  }
  return violations
}

/**
 * Rule `manifest-plane-leak` — a plane-split package's browser barrel does not
 * reach the other plane, however the symbols are named (POD-2470).
 *
 * The forbidden set is DERIVED at check time from what the restricted entry
 * re-exports, and the walk is TRANSITIVE. Both properties are load-bearing and
 * each covers a hole the other leaves:
 *
 *   DERIVED, because the leak this rule is named after arrived as a NEW family.
 *     A list would have needed someone to remember it; reading `daemon.ts`
 *     protects the next family the moment that file picks it up.
 *
 *   ON THE EDGE, because the first version of this guard compared export NAMES
 *     and a one-line alias walked through it —
 *     `export { RuntimeEvent as BrowserRuntimeEvent } from './runtime'` rebuilds
 *     the dependency while exposing no name the namespace check was watching
 *     for. The edge is the thing that costs bytes, so the edge is the thing to
 *     assert on.
 *
 *   TRANSITIVE, because the original leak was two hops — `index -> sync ->
 *     runtime`, `sync.ts` parsing one interaction schema out of the daemon-plane
 *     module. A scan of the barrel alone would have been green through the whole
 *     incident.
 *
 * Type-only edges are exempt, matching {@link checkBrowserGraphAll}: they are
 * erased at build and put nothing in a bundle.
 *
 * VACUOUS-GREEN GUARDS, since a closure rule that finds nothing looks identical
 * whether it is satisfied or broken. An entry file that does not exist, an
 * import that resolves to no file (a truncated closure), and a restricted entry
 * that re-exports NOTHING (an empty forbidden set) are each reported rather than
 * skipped.
 */
export function checkPlaneLeakAll(repoRoot: string): Violation[] {
  const violations: Violation[] = []
  for (const [barrel, restricted] of PLANE_SPLIT_ENTRIES) {
    const read = (file: string, why: string): string | null => {
      try {
        return readFileSync(join(repoRoot, file), 'utf8')
      } catch {
        violations.push({
          file,
          specifier: barrel,
          rule: 'manifest-plane-leak',
          message: `${file}: ${why} of the plane split '${barrel}' does not exist, which makes this rule vacuously green. Create it or remove the row from PLANE_SPLIT_ENTRIES (scripts/architecture-manifest.ts).`,
        })
        return null
      }
    }

    // The other plane is whatever the restricted entry re-exports. Derived,
    // never listed — see the note above.
    const restrictedSource = read(restricted, 'the restricted entry')
    if (restrictedSource === null) continue
    const otherPlane = new Set<string>()
    for (const ref of extractImports(restrictedSource)) {
      if (ref.typeOnly || !ref.specifier.startsWith('.')) continue
      const target = resolveRelativeModule(repoRoot, restricted, ref.specifier)
      if (target !== null) otherPlane.add(target)
    }
    if (otherPlane.size === 0) {
      violations.push({
        file: restricted,
        specifier: barrel,
        rule: 'manifest-plane-leak',
        message: `${restricted}: re-exports no module of its own, so the forbidden set for '${barrel}' is EMPTY and this rule passes without checking anything. If the plane split is gone, remove the row from PLANE_SPLIT_ENTRIES (scripts/architecture-manifest.ts) deliberately rather than leaving a guard that cannot fail.`,
      })
      continue
    }

    // Walk the barrel's closure, remembering how each module was first reached
    // so a failure can name the whole chain rather than only its endpoint.
    const selfWorkspace = workspaceOf(barrel)
    const cameFrom = new Map<string, string>()
    const seen = new Set<string>()
    const queue: string[] = [barrel]
    while (queue.length > 0) {
      const file = queue.shift() as string
      if (seen.has(file)) continue
      seen.add(file)
      if (otherPlane.has(file)) {
        const chain = [file]
        for (let at = file; cameFrom.has(at); ) {
          at = cameFrom.get(at) as string
          chain.unshift(at)
        }
        violations.push({
          file: chain[1] ?? barrel,
          specifier: file,
          rule: 'manifest-plane-leak',
          message: `${file} belongs to the plane '${restricted}' owns, and the browser barrel '${barrel}' reaches it: ${chain.join(' -> ')}. Eager schemas are built at module scope, so this edge puts the WHOLE module in every browser bundle and no bundler can shake it out — which is a size regression that names no cause when it lands. Import it from the restricted entry instead, or move the browser-facing part into its own module and re-export that from both. Renaming on the way through (\`export { X as Y } from\`) rebuilds the same edge and is refused for the same reason.`,
        })
        continue
      }
      const source = read(file, 'a module reachable from the barrel')
      if (source === null) continue
      for (const ref of extractImports(source)) {
        if (ref.typeOnly) continue
        const spec = ref.specifier
        if (!spec.startsWith('.')) {
          // A module in the closure importing its OWN workspace by PACKAGE
          // specifier steps outside this walk, which follows relative imports —
          // and the far side of that step is the restricted entry itself. From
          // inside packages/protocol, `export * from '@podium/protocol/daemon'`
          // rebuilds the whole leak by a route no relative-import rule can see.
          // Refused as a class rather than special-cased to the daemon subpath:
          // the barrel has no reason to reach its own package by name.
          if (spec.startsWith('@podium/') && podiumWorkspaceOf(spec) === selfWorkspace) {
            violations.push({
              file,
              specifier: spec,
              rule: 'manifest-plane-leak',
              message: `${file}: reachable from the browser barrel '${barrel}' and imports '${spec}' — its OWN workspace, by package specifier. That edge leaves the relative-import closure this rule walks, so it can route around the plane split entirely: the package's restricted subpath reached this way puts the other plane back into every browser bundle with no relative edge to find. Import the module relatively.`,
            })
          }
          continue
        }
        const target = resolveRelativeModule(repoRoot, file, spec)
        if (target === null) {
          violations.push({
            file,
            specifier: spec,
            rule: 'manifest-plane-leak',
            message: `${file}: reachable from the browser barrel '${barrel}' and imports '${spec}', which resolves to no file here. An unresolvable import TRUNCATES the closure, so the no-leak claim below it would be green for the wrong reason.`,
          })
          continue
        }
        if (!cameFrom.has(target)) cameFrom.set(target, file)
        queue.push(target)
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

// ---------------------------------------------------------------------------
// Rules 13-16 — the STORE BOUNDARY family (POD-3252, epic POD-3221)
//
// Four rules that together do two jobs. Before the drizzle conversion they are
// the COMPLETENESS PROOF for Stage A: a repository is converted when it no
// longer holds a raw SQLite handle, and nothing but a lint can tell you that
// about forty files at once (method §2, first row — "completeness comes from
// the compiler and a lint, never from grep or memory"). After the conversion
// they are the PERMANENT GUARD: the constructs banned here are the ones a
// remote connection cannot rely on, or that belong to the driver and the
// migrations alone, and the hosted server runs on Turso (spec §2.7, §6 rules
// 1-2, §7 decision 5).
//
// WHAT IS NOT BANNED, said explicitly because the temptation is to ban more.
// Under the one-dialect decision (spec §7.5 — SQLite everywhere, bun:sqlite
// locally, Turso remotely) both drivers accept rowid ordering, `INSERT OR
// REPLACE`, `INSERT OR IGNORE`, `ON CONFLICT`, `RETURNING`, `GLOB`,
// `lastInsertRowid` and the JSON functions. None of them is a portability
// problem and none is flagged. The `sql` TAG itself is not banned either:
// spec §6 rule 1 says fragments inside builder queries are fine anywhere;
// what is banned is a WHOLE raw statement handed to drizzle's raw-execution
// methods. And the per-site "an `OR REPLACE` conversion must name every
// column" check stays a REVIEWER rule — it is a property of the column list
// against the schema, which source text cannot see.
//
// THE ONLY SITE-LEVEL ALLOWLIST is a line carrying `// DECISION POD-<n>`
// (method §4). A worker that meets a site no rule covers converts it in the
// most literal form, marks the line, and files the decision issue; Stage A's
// exit gate requires zero markers, so every marker is a filed question rather
// than a permanent excuse. {@link STORE_BOUNDARY_DECISION_MARKER}.
// ---------------------------------------------------------------------------

/**
 * The directories held to rule 13. Exact, and deliberately not "everything
 * that touches SQLite": these are the places the epic converts, so a violation
 * here is unconverted code, and a violation outside here is a different
 * question with a different answer.
 */
const STORE_BOUNDARY_ROOTS: readonly string[] = [
  'apps/server/src/store/',
  'packages/sync/src/adapters/sqlite/',
]

/** The one FILE outside those directories that is a repository (spec §6 rule 2). */
const STORE_BOUNDARY_FILES: ReadonlySet<string> = new Set([
  'apps/server/src/modules/operations/store.ts',
])

/**
 * The SearchIndex port — the two modules that own FTS5, by EXACT PATH.
 *
 * FTS5 stays behind the search port (spec §2.7): `MATCH` is not a builder
 * construct, the index is a virtual table drizzle has no model for, and the
 * queries are whole raw statements by nature. So these two are exempt from
 * rule 13's raw-statement clauses and are the only place rule 16 allows
 * `sql.raw` at all.
 *
 * A SET OF PATHS, NOT A GLOB, on purpose. `store/conversations/` also holds
 * `mirror.ts` and `registry.ts`, which are ordinary repositories; a
 * `conversations/**` exemption would carry them along and nobody would notice.
 * Adding a third search module is then an edit to this line, which is a
 * decision someone makes rather than one the rule absorbs.
 */
const SEARCH_INDEX_PORT: ReadonlySet<string> = new Set([
  'apps/server/src/store/conversations/index.ts',
  'apps/server/src/store/conversations/transcript-index.ts',
])

/**
 * The executor's DRIVER SEAM — the three modules that legitimately name the raw
 * handle, and the only permanent exemption from rule 12's raw-handle clauses.
 *
 * `bun-driver.ts` is the driver: its whole job is to turn the router's
 * per-statement callbacks into `prepare`/`run` on a bun:sqlite connection.
 * `driver.ts` is the interface it implements, and it imports `SqlParam` /
 * `SqlRunResult` — the parameter and result vocabulary every driver needs,
 * including the libsql one E.5 adds. `harness.ts` is the deterministic
 * interleaving harness (POD-3248): test scaffolding whose every importer is a
 * `.test.ts`, but whose filename does not say so, so the test-directory
 * exemption cannot see it. Named here rather than renamed, because renaming it
 * is the executor owner's call and not this rule's business.
 *
 * SPEC §6 RULE 2 SAYS "exactly one file (`store/executor/bun-driver.ts`)" — a
 * single line to allow rather than a package boundary to reason about. As
 * landed (POD-3248, 5dce237f3) it is three, for the reason above; the count is
 * the only part that moved, not the shape.
 *
 * `sync-drizzle.ts` IS THE FOURTH, and it is a seam rather than a holdover.
 * Stage A's converted repositories run their statements through a drizzle
 * instance built OVER the handle, and the adapter that builds it is the one
 * place that must name both sides — that is the whole point of concentrating it
 * in a single file. It cannot sit on {@link STAGE_A_UNCONVERTED} instead:
 * entries there are files a wave converts and then deletes its own line for,
 * and nothing ever converts this one. Absent from both lists it painted
 * `lint:boundaries` red on the integration branch for every wave at once
 * (POD-3394 measured it with its own changes reverted, so it predates the
 * wave). If the seam's shape changes and this module goes, this line goes with
 * it.
 *
 * `executor.ts` IS DELIBERATELY ABSENT even though it imports `SqlDatabase`
 * today. That import is `readonly legacy: SqlDatabase | undefined` — the
 * executor's legacy field, which Stage A's exit gate deletes by name (method
 * §5, Phase A exit). So it sits in {@link STAGE_A_UNCONVERTED} instead, which
 * makes the ledger's last remaining line the exit gate itself: when the field
 * goes, the ledger empties, and both halves of the gate are one check.
 */
const RAW_HANDLE_OWNERS: ReadonlySet<string> = new Set([
  'apps/server/src/store/executor/driver.ts',
  'apps/server/src/store/executor/bun-driver.ts',
  'apps/server/src/store/executor/harness.ts',
  'apps/server/src/store/executor/sync-drizzle.ts',
])

/**
 * THE FILES ALLOWED TO OPEN A TRANSACTION — rule 16's exemption, spec §6 rule 22.
 *
 * A driver IS the transaction port's implementation, so
 * `client.transaction("write")` inside a `DriverSession.begin` is the rule being
 * OBEYED, not broken. Without this list rule 16 flags the one site that must
 * make the call, which is what POD-3342 spotted.
 *
 * BY NAME, NEVER BY DIRECTORY, and that is the whole design. `store/executor/`
 * also holds the scheduler and the executor itself, and neither may ever open a
 * raw transaction — a directory exemption would stop the rule watching the two
 * files it most needs to watch. Same shape as {@link RAW_HANDLE_OWNERS} above,
 * and for the same reason: a list is honest about being a list. Exempting by
 * SYMBOL — "only inside a `DriverSession.begin`" — is the theoretically right
 * answer and is refused on checkability, because it needs the callee's declaring
 * type and a name-matching scan cannot carry that (POD-3257).
 *
 * `bun-driver.ts` IS LISTED THOUGH IT DOES NOT TRIP THE RULE TODAY, and that is
 * deliberate rather than padding. It escapes only because bun:sqlite's
 * `BEGIN IMMEDIATE` is a raw statement rather than a `client.transaction()`
 * call — luck, not design. Listing it now means E.5's real libsql driver adds
 * itself to a list that already says what the list is for, instead of
 * discovering the rule on its first day.
 *
 * THE SPIKE GETS NO BLANKET EXEMPTION (spec §6 rule 22). Its driver is named
 * here like any other driver; `run-proofs.ts` is named because it drives raw
 * transactions DELIBERATELY — the probes measuring the server's idle budget and
 * whether a raw batch is atomic have to go around the port, since going through
 * it would answer their own question. The directory around them stays covered.
 */
const TRANSACTION_OPENERS: ReadonlySet<string> = new Set([
  'apps/server/src/store/executor/bun-driver.ts',
  'apps/server/src/store/spike/turso-append/libsql-driver.ts',
  'apps/server/src/store/spike/turso-append/run-proofs.ts',
])

/** The runtime's SQLite shim: the raw handle, by any subpath spelling. */
const RUNTIME_SQLITE_SPECIFIER = /^@podium\/runtime\/sqlite(?:\/|$)/

/** drizzle, by any subpath spelling (`drizzle-orm`, `drizzle-orm/sqlite-core`, …). */
const DRIZZLE_SPECIFIER = /^drizzle-orm(?:\/|$)/

/**
 * The one allowlist token (method §4). Checked against the RAW source line, not
 * the comment-stripped one, because it IS a comment.
 */
const STORE_BOUNDARY_DECISION_MARKER = /\/\/\s*DECISION POD-\d+/

/** `.prepare(` — a prepared statement is a raw handle by definition. */
const PREPARE_CALL = /\.\s*prepare\s*\(/

/**
 * A WHOLE raw statement handed to one of drizzle's four raw-execution methods.
 *
 * The discriminator is the ARGUMENT, not the method: `db.all(sql`SELECT …`)`
 * is a raw statement wearing a builder's clothes, while `.where(sql`…`)` is a
 * fragment inside a builder query and is explicitly allowed (spec §6 rule 1).
 * So the pattern requires the `sql` tag to open the argument list.
 */
// `(?:<[^<>()]*>)?` IS NOT DECORATION: `db.all<{ site: string }>(sql`…`)` is the
// same banned call with a type argument, and without this the rule reads straight
// past it. Found by defeat-testing the four spellings rather than by review
// (POD-3404); only the bare one was caught.
const RAW_EXECUTION_CALL = /\.\s*(all|get|run|values)\s*(?:<[^<>()]*>)?\s*\(\s*sql\s*`/

/**
 * Constructs banned INSIDE a `sql` template body. Each belongs to the driver or
 * to the migrations, and none of the three survives a remote connection as
 * written: `PRAGMA` is a parse error on Turso for `busy_timeout`,
 * `journal_mode` and `wal_checkpoint` (measured, POD-3251), `sqlite_master` is
 * schema introspection the migrations own, and `ATTACH` names a second local
 * file that does not exist at the other end of a network.
 */
const DRIVER_ONLY_SQL = /\b(PRAGMA|sqlite_master|sqlite_schema|ATTACH)\b/i

/** drizzle's own transaction method, on any receiver. */
const DRIZZLE_TRANSACTION_CALL = /\b[A-Za-z_$][\w$]*\s*\.\s*transaction\s*\(/

/** `sql.raw(` — the one drizzle construct that splices a value in UNBOUND. */
const SQL_RAW_CALL = /\bsql\s*\.\s*raw\s*\(/

/**
 * A string literal written down IN FULL and nothing else: a quoted string, or a
 * template with no `${…}` hole. Anchored at BOTH ends, because the whole point
 * is that the argument is exhaustively readable — `'a' + b` opens with a
 * literal and is not one.
 */
const SQL_RAW_STRING_LITERAL =
  /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`)$/

/** Where drizzle may be imported (spec §6 rule 2). */
const DRIZZLE_IMPORT_ROOTS: readonly string[] = [
  'apps/server/src/store/',
  'apps/server/src/migrations/',
  'packages/sync/src/adapters/sqlite/',
]

/**
 * STAGE A's CONVERSION LEDGER — the repository files that still hold a raw
 * SQLite handle, one exact path per line, and the whole reason this family can
 * be armed BEFORE the conversion instead of after it.
 *
 * WHY IT EXISTS. Rule 13 is the completeness proof for Stage A (method §2,
 * first row), and a proof that is only switched on once the work is finished
 * proves nothing while the work is happening: forty agents convert forty files
 * in parallel over several waves, and the question each of them has to be able
 * to answer is "is MY file done", which a rule that runs nowhere cannot answer.
 * Armed with no ledger it would instead paint `bun run lint:boundaries` — the
 * BLOCKING CI step (ci.yml) and Phase 0's own exit gate — red for every worker
 * on the integration branch until the last wave lands.
 *
 * WHAT IT IS NOT. It is not an allowlist of VIOLATIONS, and it does not
 * weaken the "the only allowlist is `// DECISION POD-<n>`" rule (method §4),
 * which is about SITES. It is the Stage A worklist expressed as code: a file
 * in it is not yet converted and is checked by rules 14-16 and by rule 13's
 * `sql`-body clause but not by rule 13's raw-handle clauses; a file out of it
 * is held to the whole family. Nothing here excuses a construct — it names a
 * FILE that has not been started.
 *
 * WHY IT CANNOT ROT, which is the property that matters. Two checks in
 * {@link checkStoreBoundaryLedger} make the ledger monotone:
 *   - a listed file that no longer has a raw-handle violation FAILS. So the
 *     agent that converts `store/issues.ts` cannot leave its line behind; the
 *     build tells it to delete the line in the same commit. Slack cannot
 *     accumulate, which is how the count is trustworthy as a progress measure.
 *   - a listed file that does not exist FAILS, so a rename cannot silently
 *     turn an entry into a permanent no-op.
 * There are no COUNTS here, only paths, precisely so that a partial conversion
 * cannot be recorded as progress: a file is unconverted until it holds no raw
 * handle at all.
 *
 * STAGE A IS COMPLETE WHEN THIS ARRAY IS EMPTY. That is the gate, it is one
 * `length === 0`, and it is what {@link checkStoreBoundaryLedger} reports.
 *
 * DERIVED, NOT HAND-WRITTEN (2026-09-03, at POD-3252): the initial contents are
 * exactly the files rule 13 flagged on the branch tip, printed by the rule
 * itself. A hand-built list would have been a second opinion about which files
 * are unconverted, and the rule's opinion is the one that gates.
 */
export const STAGE_A_UNCONVERTED: readonly string[] = [
  // NOT a repository, and the one entry here that was not derived from the rule
  // (POD-3281): the temporary raw-handle feed of the statement probe seam. It
  // names the handle because that is its whole job — observing the statements
  // an UNCONVERTED repository issues, so the query-count probes and the
  // hot-path script keep measuring while Stage A is half done. It is on this
  // ledger rather than in RAW_HANDLE_OWNERS because it is deleted at the same
  // gate as the executor's `legacy` field, by POD-3326. The permanent half
  // (`statement-probe.ts`) names no handle and needs no entry.
  'apps/server/src/store/executor/legacy-handle-probe.ts',
  'apps/server/src/modules/operations/store.ts',
  'apps/server/src/store/accounts.ts',
  'apps/server/src/store/approvals.ts',
  'apps/server/src/store/auth.ts',
  'apps/server/src/store/automations.ts',
  'apps/server/src/store/conversations.ts',
  'apps/server/src/store/conversations/mirror.ts',
  'apps/server/src/store/conversations/registry.ts',
  'apps/server/src/store/executor/executor.ts',
  'apps/server/src/store/grants.ts',
  'apps/server/src/store/interactions.ts',
  'apps/server/src/store/locks.ts',
  'apps/server/src/store/machines.ts',
  'apps/server/src/store/maintenance.ts',
  'apps/server/src/store/messages.ts',
  'apps/server/src/store/messaging-topics.ts',
  'apps/server/src/store/notification-facts.ts',
  'apps/server/src/store/observation-checkpoints.ts',
  'apps/server/src/store/quota-history.ts',
  'apps/server/src/store/read-watermarks.ts',
  'apps/server/src/store/repos.ts',
  'apps/server/src/store/server-secrets.ts',
  'apps/server/src/store/sessions.ts',
  'apps/server/src/store/settings-audit.ts',
  'apps/server/src/store/settings.ts',
  'apps/server/src/store/shipping.ts',
  'apps/server/src/store/superagent.ts',
  'apps/server/src/store/telegram-bindings.ts',
  'apps/server/src/store/transcript-costs.ts',
  'apps/server/src/store/user-layout.ts',
  'apps/server/src/store/user-preferences.ts',
  'apps/server/src/store/user-read-position.ts',
  'apps/server/src/store/users.ts',
  'apps/server/src/store/workflows.ts',
  'packages/sync/src/adapters/sqlite/sync-repository.ts',
  'packages/sync/src/adapters/sqlite/test-support.ts',
]

const inStoreBoundary = (file: string): boolean =>
  STORE_BOUNDARY_FILES.has(file) || STORE_BOUNDARY_ROOTS.some((root) => file.startsWith(root))

/**
 * Lines carrying the one allowlist token. Read off the RAW source, because the
 * marker IS a comment and {@link stripComments} has already blanked it by the
 * time a rule looks at a line.
 */
function decisionMarkedLines(source: string): ReadonlySet<number> {
  const marked = new Set<number>()
  source.split('\n').forEach((line, i) => {
    if (STORE_BOUNDARY_DECISION_MARKER.test(line)) marked.add(i + 1)
  })
  return marked
}

/**
 * The bodies of `sql` tagged templates, so that a rule can read what a
 * statement SAYS rather than only which module it came from — the brief's
 * "scans template bodies, not only import lines".
 *
 * `${…}` holes are dropped rather than kept: an interpolation is a bound
 * parameter or a column reference, never the `PRAGMA` keyword, and keeping the
 * text inside them would read a neighbouring identifier as part of the
 * statement. Nesting is counted so a hole containing its own template (a
 * fragment built from a fragment, which the epic's batching work produces)
 * closes at the right brace.
 */
/**
 * The text between `code[open]` (an open paren) and its matching close paren,
 * or null when the parens do not balance before the end of the file. Brackets
 * and braces are counted too, so an argument containing `f(x[y(1)])` closes
 * where a paren-only counter would already have stopped.
 */
function balancedArgument(code: string, open: number): string | null {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    const ch = code[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      if (depth === 0) return code.slice(open + 1, i)
    }
  }
  return null
}

export function sqlTemplateBodies(source: string): { body: string; line: number }[] {
  const code = stripComments(source)
  const bodies: { body: string; line: number }[] = []
  const opener = /\bsql\s*`/g
  let m: RegExpExecArray | null = opener.exec(code)
  while (m !== null) {
    const start = m.index + m[0].length
    let i = start
    let body = ''
    let closed = false
    while (i < code.length) {
      const ch = code[i]
      if (ch === '\\') {
        i += 2
        continue
      }
      if (ch === '`') {
        closed = true
        break
      }
      if (ch === '$' && code[i + 1] === '{') {
        let depth = 1
        i += 2
        while (i < code.length && depth > 0) {
          if (code[i] === '{') depth++
          else if (code[i] === '}') depth--
          i++
        }
        body += ' '
        continue
      }
      body += ch
      i++
    }
    // An unterminated template means the scanner lost the thread; reporting the
    // fragment it did read would be a guess, so it is dropped and the next
    // opener is searched for after the one that failed.
    if (closed) bodies.push({ body, line: code.slice(0, m.index).split('\n').length })
    opener.lastIndex = closed ? i + 1 : m.index + m[0].length
    m = opener.exec(code)
  }
  return bodies
}

/** Rule 13's raw-handle clauses, WITHOUT the Stage A ledger applied. */
function rawHandleViolations(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  const marked = decisionMarkedLines(source)
  const lines = stripComments(source).split('\n')
  const add = (line: number, specifier: string, why: string): void => {
    if (marked.has(line)) return
    violations.push({
      file,
      specifier,
      rule: 'store-raw-handle',
      message: `${file}:${line}: ${why} The repositories run on the executor's query layer, not on a connection: what is banned here is what a remote connection cannot rely on, or what belongs to the driver and the migrations alone (POD-3221 spec §2.7, §6 rules 1-2). If no rule covers this site, convert it literally, mark the line \`// DECISION POD-<n>\` and file the decision issue (method §4).`,
    })
  }
  for (const ref of extractImports(source)) {
    if (!RUNTIME_SQLITE_SPECIFIER.test(ref.specifier)) continue
    // Type-only counts. `import type { SqlDatabase }` is a repository still
    // NAMING the raw handle in its own signature, which is exactly the field
    // Stage A's exit gate deletes; erasure at build time is not the point.
    const line = lines.findIndex((l) => l.includes(ref.specifier)) + 1
    add(line || 1, ref.specifier, `imports '${ref.specifier}' — the raw SQLite handle.`)
  }
  // MATCHED OVER THE WHOLE SOURCE, NOT PER LINE. Both patterns already allow
  // `\s*` between their tokens, and `\s` spans newlines — but testing them one
  // line at a time threw that away, so biome wrapping a long call across two
  // lines made the rule see nothing:
  //
  //     this.db.run(            <- `.run(` ends the line, `sql` starts the next
  //       sql`UPDATE OR IGNORE …`,
  //     )
  //
  // POD-3395 found two such sites reporting clean and marked them anyway rather
  // than take the free pass. A ban that a formatter can switch off is not a ban.
  // The line reported is where the CALL STARTS, which is also the line a
  // `// DECISION` marker has to sit on for `marked` to exempt it.
  const stripped = lines.join('\n')
  const lineAt = (index: number): number => stripped.slice(0, index).split('\n').length
  for (const m of stripped.matchAll(new RegExp(PREPARE_CALL.source, 'g'))) {
    add(lineAt(m.index ?? 0), '.prepare(', 'prepares a statement on a raw connection.')
  }
  for (const m of stripped.matchAll(new RegExp(RAW_EXECUTION_CALL.source, 'g'))) {
    const at = lineAt(m.index ?? 0)
    add(
      at,
      `.${m[1]}(sql\`…\`)`,
      `hands a WHOLE raw statement to drizzle's \`.${m[1]}()\`. A \`sql\` FRAGMENT inside a builder query is fine anywhere; a whole statement belongs behind the search port.`,
    )
  }
  return violations
}

// ---------------------------------------------------------------------------
// Cache-owning tables — a writer outside the owner must ANNOUNCE (POD-3362).
//
// WHAT THIS FIXES, stated as the two claims it separates. POD-3247 replaced a
// `prepare` wrapper that recognised writes by reading SQL text with an
// announcement the store makes (`store/table-writes.ts`). The SEAM works when
// it is called — `store/repos-read-cost.test.ts` drives it with no repository
// involved, and replacing the callback with a no-op fails both of its tests.
// The GUARANTEE did not follow: `TableWrites.wrote()` is a call a writer makes
// or does not make, and until this rule nothing in the tree read the writer's
// source to ask. POD-3292 found the gap; the same test file proves it, at the
// pre-announcement assertion that a bypassing write serves a STALE read.
//
// So the failure this rule refuses is precise: a future write to `repos` or
// `repo_prefixes` from outside `ReposRepository` — the shape every statement
// the async query layer runs through an executor has — that omits the
// announcement, after which `listRepos()` serves rows the write already made
// wrong, indefinitely and silently. That bug reached a live instance once
// already (POD-1638, the boot machine-identity upgrade).
//
// THE OWNER IS EXEMPT BECAUSE IT IS GUARDED HARDER, not because it is trusted.
// `apps/server/src/store/repos.ts` has its own source scan in
// `apps/server/src/store-repos-registry-cache-writers.test.ts`, which requires
// the OPPOSITE ordering: inside the class the invalidation goes BEFORE the
// write (and with no cached read in between), because a read taken in the
// window between write and drop re-holds the stale rows. Outside the class the
// announcement goes AFTER the write, for the same reason read from the other
// side: announcing first leaves the write itself inside the window. Two
// directions, one window; this rule checks the outside one.
//
// WHAT IT CANNOT SEE, said rather than left to be discovered. It reads source
// text, not types and not execution order:
//   - a write whose table name arrives through a variable or a `${…}` hole is
//     invisible, as is a `wrote(table)` whose argument is not a literal;
//   - a branch that skips the announcement at runtime reads as announced here;
//   - `.wrote(` is matched on any receiver, so a same-named method on some
//     other object would satisfy it. Resolving the declaring TYPE is the
//     theoretically right answer and is refused on checkability for the reason
//     this file has already recorded twice (POD-3257, and {@link
//     TRANSACTION_OPENERS}): a name-matching scan cannot carry a type.
// The ceiling is real and the rule is still worth having, because the failure
// it is written for is the ORDINARY one — a new writer that never thought
// about a cache at all, spelled the way every other writer in the store is.
//
// ITS CORRECT COUNT ON THIS TREE IS ZERO, which is the condition under which a
// green means nothing. `scripts/check-boundaries.test.ts` therefore drives it
// against a forgetting writer in each spelling it claims to catch; a rule whose
// only evidence is a clean tree has proven that it ran, not that it works.
// ---------------------------------------------------------------------------

/**
 * The tables a repository holds a CACHED READ of, each with the file that owns
 * that cache and the schema symbol drizzle writes it through.
 *
 * A MAP, NOT A DIRECTORY OR A HEURISTIC. There is no way to detect from source
 * that a table has a cache over it — the cache is a private field and the
 * subscription is a loop over string names. So the set is declared, one line
 * per table, and adding a cache means adding the line. That is the honest
 * shape: the rule fails closed for what is listed and is silent about what is
 * not, rather than pretending to a completeness it cannot have.
 *
 * `repos` and `repo_prefixes` are the two POD-3247's constructor subscribes to
 * (`store/repos.ts`, `for (const table of ['repos', 'repo_prefixes'])`).
 */
const CACHE_OWNED_TABLES: ReadonlyMap<string, { owner: string; schemaSymbol: string }> = new Map([
  ['repos', { owner: 'apps/server/src/store/repos.ts', schemaSymbol: 'repos' }],
  ['repo_prefixes', { owner: 'apps/server/src/store/repos.ts', schemaSymbol: 'repoPrefixes' }],
])

/**
 * Boot-time schema and data movement, exempt as a TREE.
 *
 * The migrations write both tables and are exempt for a reason the writers-test
 * already states: they run before the repository serves its first read, so
 * there is no held read to go stale. This is the one place a directory
 * exemption is right rather than lazy — every file under it runs at that phase
 * by definition, which is not true of `store/executor/`.
 */
const CACHE_ANNOUNCEMENT_EXEMPT_ROOTS: readonly string[] = ['apps/server/src/migrations/']

/** `<anything>.wrote(<args>)` — the announcement, on any receiver. */
const TABLE_WRITES_ANNOUNCEMENT = /\.\s*wrote\s*\(/g

/** A string literal written out in full, the only spelling of a table name this rule reads. */
const QUOTED_TABLE_NAME = /'([^'\\]*)'|"([^"\\]*)"|`([^`\\$]*)`/g

/** Offsets of the announcements naming `table`, in the comment-stripped source. */
function announcementOffsets(code: string, table: string): number[] {
  const offsets: number[] = []
  TABLE_WRITES_ANNOUNCEMENT.lastIndex = 0
  let call: RegExpExecArray | null = TABLE_WRITES_ANNOUNCEMENT.exec(code)
  while (call !== null) {
    const args = balancedArgument(code, call.index + call[0].length - 1)
    if (args !== null) {
      QUOTED_TABLE_NAME.lastIndex = 0
      let name: RegExpExecArray | null = QUOTED_TABLE_NAME.exec(args)
      while (name !== null) {
        if ((name[1] ?? name[2] ?? name[3]) === table) {
          offsets.push(call.index)
          break
        }
        name = QUOTED_TABLE_NAME.exec(args)
      }
    }
    call = TABLE_WRITES_ANNOUNCEMENT.exec(code)
  }
  return offsets
}

/**
 * Offsets of the WRITES to `table`, in both spellings a converted store has.
 *
 * TWO SPELLINGS, BECAUSE THE EPIC HAS TWO. A Stage A repository issues the
 * statement as SQL text (`INSERT OR IGNORE INTO repos …`); a converted one
 * writes through drizzle's builder (`db.update(repos)`), where the table is a
 * schema SYMBOL and the string never appears. A rule that read only one of them
 * would go quiet at exactly the conversion this epic is performing — which is
 * the moment it most needs to be loud.
 *
 * The SQL clause matches the verb and the table together. `repos` and
 * `repo_prefixes` are ordinary English words that appear in this repository's
 * prose and in its string-literal documentation tables, so a bare name match
 * would be noise; requiring `INSERT INTO`/`UPDATE`/`DELETE FROM` in front makes
 * a hit a statement rather than a mention.
 */
function tableWriteSites(code: string, table: string, schemaSymbol: string): number[] {
  const quote = String.raw`["'\[\`]?`
  const patterns = [
    new RegExp(String.raw`\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+${quote}${table}\b`, 'gi'),
    new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${quote}${table}\b`, 'gi'),
    new RegExp(String.raw`\bDELETE\s+FROM\s+${quote}${table}\b`, 'gi'),
    // The builder form. An optional `<ns>.` prefix covers `schema.repos`, the
    // namespace-import spelling the migrations' schema is read through.
    new RegExp(
      String.raw`\.\s*(?:insert|update|delete)\s*\(\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?${schemaSymbol}\s*[,)]`,
      'g',
    ),
  ]
  const offsets: number[] = []
  for (const pattern of patterns) {
    let hit: RegExpExecArray | null = pattern.exec(code)
    while (hit !== null) {
      offsets.push(hit.index)
      hit = pattern.exec(code)
    }
  }
  return offsets.sort((a, b) => a - b)
}

/**
 * Rule POD-3362 — a write to a cache-owning table, from outside the file that
 * owns the cache, must be followed by the store's per-table announcement.
 */
export function checkCacheTableAnnouncement(file: string, source: string): Violation[] {
  if (!file.startsWith('apps/') && !file.startsWith('packages/')) return []
  if (isTestFile(file)) return []
  if (CACHE_ANNOUNCEMENT_EXEMPT_ROOTS.some((root) => file.startsWith(root))) return []
  const code = stripComments(source)
  const marked = decisionMarkedLines(source)
  const lineOf = (offset: number): number => code.slice(0, offset).split('\n').length
  const violations: Violation[] = []
  for (const [table, { owner, schemaSymbol }] of CACHE_OWNED_TABLES) {
    if (file === owner) continue
    const writes = tableWriteSites(code, table, schemaSymbol)
    if (writes.length === 0) continue
    const last = writes[writes.length - 1] as number
    if (announcementOffsets(code, table).some((offset) => offset > last)) continue
    if (marked.has(lineOf(last))) continue
    const announced = announcementOffsets(code, table).length > 0
    violations.push({
      file,
      specifier: table,
      rule: 'cache-table-announcement',
      message: `${file}:${lineOf(last)}: writes \`${table}\` from outside ${owner}, which holds a cached read of it, ${announced ? `and every \`.wrote('${table}')\` in this file comes BEFORE that write — a read taken in the window between the write and the announcement re-holds rows the write already made wrong.` : `and never announces it. \`listRepos()\` would keep serving the pre-write rows indefinitely; that exact bug reached a live instance once (POD-1638).`} Raise the store's per-table announcement AFTER the write — \`store.tableWrites.wrote('${table}')\` (POD-3247, \`store/table-writes.ts\`). If no rule covers this site, mark the line \`// DECISION POD-<n>\` and file the decision issue (method §4).`,
    })
  }
  return violations
}

/**
 * Rule 13 — no raw handles, and no driver-only construct in a `sql` body, over
 * the store directories, the operations store and the sync SQLite adapter.
 */
export function checkStoreRawHandles(file: string, source: string): Violation[] {
  if (!inStoreBoundary(file)) return []
  if (isTestFile(file)) return []
  if (SEARCH_INDEX_PORT.has(file)) return []
  if (RAW_HANDLE_OWNERS.has(file)) return []
  const violations: Violation[] = []
  if (!STAGE_A_UNCONVERTED.includes(file)) violations.push(...rawHandleViolations(file, source))
  // The `sql`-body clause runs even on an UNCONVERTED file. Nothing about
  // being mid-conversion makes a `PRAGMA` acceptable, and a converted-looking
  // `sql` template is exactly where one would arrive unnoticed.
  const marked = decisionMarkedLines(source)
  for (const { body, line } of sqlTemplateBodies(source)) {
    const hit = DRIVER_ONLY_SQL.exec(body)
    if (!hit || marked.has(line)) continue
    violations.push({
      file,
      specifier: hit[1] ?? 'driver-only SQL',
      rule: 'store-raw-handle',
      message: `${file}:${line}: the \`sql\` body names '${hit[1]}'. \`PRAGMA\`, \`sqlite_master\` and \`ATTACH\` belong to the driver and the migrations: on Turso \`busy_timeout\`, \`journal_mode\` and \`wal_checkpoint\` are hard SQL parse errors (measured, POD-3251), schema introspection is the migrations' job, and a second database file does not exist at the far end of a network (POD-3221 spec §2.7).`,
    })
  }
  return violations
}

/**
 * Rule 14 — drizzle's own `db.transaction` / `tx.transaction` is forbidden.
 *
 * The store's `transact` port is the only transaction boundary, because the
 * boundary is where the epic's guarantees live: the scheduler issues `BEGIN
 * IMMEDIATE` on bun:sqlite and `client.transaction("write")` on libsql, and a
 * raw `BEGIN` on Turso executes successfully and is then silently useless —
 * each `execute()` is its own stream (measured, POD-3251). drizzle's own
 * transaction takes neither route: its bun-sqlite transaction defaults to
 * DEFERRED and its libsql transaction relies on a deprecated default (spec §6
 * rule 7). A caller that reaches it gets no write lane, no busy retry, no
 * post-commit tail and no savepoint discipline.
 *
 * SCOPE: everywhere a drizzle handle can be in scope, which — given rule 15 —
 * is exactly the store boundary plus any file importing drizzle. That is a
 * derived closure rather than a name list, and it is what keeps IndexedDB out:
 * `packages/sync/src/adapters/indexeddb/store.ts` calls
 * `db.transaction([...ALL_STORES], 'readwrite')`, which is the browser's
 * IDBDatabase API and has nothing to do with this rule. It is excluded because
 * it cannot hold a drizzle handle, not because its name was recognised.
 *
 * THE DRIVERS ARE EXEMPT BY NAME — see {@link TRANSACTION_OPENERS}. A driver is
 * the port's implementation, so the call this rule flags is the call it exists
 * to require of exactly those files (spec §6 rule 22, answering POD-3342).
 *
 * `scripts/` is out, for rules 14, 15 and 16 alike and for the same two
 * reasons: it is the build tier every other rule in this file already excludes
 * (see the console-ownership block), and this lint's own fixtures live in
 * `scripts/check-boundaries.test.ts`. That second reason is not squeamishness —
 * {@link stripComments} does not strip STRING literals, so a fixture source
 * held in a template literal reads to {@link extractImports} as a real import,
 * and a rule that fired on the text of its own test would have to be written
 * around rather than written.
 */
export function checkDrizzleTransaction(file: string, source: string): Violation[] {
  if (!file.startsWith('apps/') && !file.startsWith('packages/')) return []
  if (TRANSACTION_OPENERS.has(file)) return []
  // Cheap first, because this rule's scope is derived from the import list and
  // {@link extractImports} over every file in apps/ and packages/ is the most
  // expensive thing in this script. The pre-filter runs on the RAW source, so
  // it is a strict superset of what the rule can flag — a mention inside a
  // comment costs one wasted scan and can never cost a miss.
  if (!DRIZZLE_TRANSACTION_CALL.test(source)) return []
  const importsDrizzle = extractImports(source).some((ref) => DRIZZLE_SPECIFIER.test(ref.specifier))
  if (!inStoreBoundary(file) && !importsDrizzle) return []
  const violations: Violation[] = []
  const marked = decisionMarkedLines(source)
  stripComments(source)
    .split('\n')
    .forEach((line, i) => {
      const hit = DRIZZLE_TRANSACTION_CALL.exec(line)
      if (!hit || marked.has(i + 1)) return
      violations.push({
        file,
        specifier: hit[0].trim(),
        rule: 'store-transaction-port',
        message: `${file}:${i + 1}: '${hit[0].trim()}' is drizzle's own transaction. The store's \`transact\` port is the only transaction boundary — it is what issues \`BEGIN IMMEDIATE\` / \`client.transaction("write")\`, applies the bounded busy retry, and runs the post-commit tail; drizzle's own defaults to DEFERRED on bun-sqlite and to a deprecated default on libsql (POD-3221 spec §6 rule 7).`,
      })
    })
  return violations
}

/**
 * Rule 15 — drizzle is imported only from the store, the operations store, the
 * migrations and the sync SQLite adapter (spec §6 rule 2).
 *
 * The rule the other three lean on: it is what makes "a drizzle handle can only
 * exist in persistence" a fact rather than a convention, and therefore what
 * makes rule 14's derived scope a closure rather than a guess. Repositories
 * return the domain row types in `store/types.ts`; a module that imports
 * drizzle to name a row type is a module that has the query layer's types in
 * its signature.
 *
 * `scripts/` IS OUT OF SCOPE, deliberately and not by oversight. It is the
 * build tier for every other rule in this file (see the console-ownership block
 * above), `scripts/new-migration.ts` and `scripts/build-drizzle-manifest.ts`
 * are exactly the tooling that legitimately knows about drizzle, and this
 * lint's own fixtures live in `scripts/check-boundaries.test.ts` — a rule that
 * fired on the string in its own test would be self-defeating.
 */
export function checkDrizzleImportHome(file: string, source: string): Violation[] {
  // Superset pre-filter, same reason as rule 14: every specifier this rule can
  // flag matches /^drizzle-orm(\/|$)/ and so contains this substring.
  if (!source.includes('drizzle-orm')) return []
  if (!file.startsWith('apps/') && !file.startsWith('packages/')) return []
  if (STORE_BOUNDARY_FILES.has(file)) return []
  if (DRIZZLE_IMPORT_ROOTS.some((root) => file.startsWith(root))) return []
  const violations: Violation[] = []
  const marked = decisionMarkedLines(source)
  const lines = stripComments(source).split('\n')
  for (const ref of extractImports(source)) {
    if (!DRIZZLE_SPECIFIER.test(ref.specifier)) continue
    const line = lines.findIndex((l) => l.includes(ref.specifier)) + 1 || 1
    if (marked.has(line)) continue
    violations.push({
      file,
      specifier: ref.specifier,
      rule: 'drizzle-import-home',
      message: `${file}:${line}: imports '${ref.specifier}' outside persistence. drizzle may be imported only from ${DRIZZLE_IMPORT_ROOTS.join(', ')} and apps/server/src/modules/operations/store.ts; everywhere else takes the domain row types in apps/server/src/store/types.ts (POD-3221 spec §6 rule 2).`,
    })
  }
  return violations
}

/**
 * Rule 16 — `sql.raw` of a non-literal, outside the SearchIndex port.
 *
 * `sql.raw` splices its argument into the statement UNBOUND: it is the one
 * drizzle construct that can turn a value into SQL. A string literal written in
 * the source is a decision the author made and a reviewer can read; anything
 * else — an identifier, a call, a template with a `${…}` hole — is a value
 * whose provenance the rule cannot see, and "never `sql.raw` of user input"
 * (spec §6 rule 1) is not a property source text can check one call at a time.
 * So the rule bans the CAPABILITY rather than trying to trace the argument: if
 * it is not literally written down, it is refused.
 *
 * The SearchIndex port is exempt because dynamic identifiers are what it is
 * for — an FTS5 column filter and a table name chosen per index.
 */
export function checkSqlRawLiteral(file: string, source: string): Violation[] {
  // Superset pre-filter, same reason as rule 14.
  if (!SQL_RAW_CALL.test(source)) return []
  if (!file.startsWith('apps/') && !file.startsWith('packages/')) return []
  if (SEARCH_INDEX_PORT.has(file)) return []
  const violations: Violation[] = []
  const marked = decisionMarkedLines(source)
  const code = stripComments(source)
  const call = new RegExp(SQL_RAW_CALL.source, 'g')
  let m: RegExpExecArray | null = call.exec(code)
  while (m !== null) {
    const line = code.slice(0, m.index).split('\n').length
    // The WHOLE argument, not its first token. Checking only the start passes
    // `sql.raw('a' + b)` — a concatenation that opens with a literal — which is
    // exactly the defeat this rule exists to refuse, and a fixture pins it.
    const argument = balancedArgument(code, m.index + m[0].length - 1)
    if (argument !== null && !SQL_RAW_STRING_LITERAL.test(argument.trim()) && !marked.has(line)) {
      violations.push({
        file,
        specifier: 'sql.raw',
        rule: 'sql-raw-literal',
        message: `${file}:${line}: \`sql.raw\` of something other than a string literal written in this file. \`sql.raw\` splices its argument into the statement UNBOUND, so an identifier, a call or a template with a hole is an injection the reviewer cannot rule out by reading the line (POD-3221 spec §6 rule 1). Bind the value as a parameter, or move the statement behind the SearchIndex port.`,
      })
    }
    m = call.exec(code)
  }
  return violations
}

/**
 * The ledger's own ratchet — what stops {@link STAGE_A_UNCONVERTED} from
 * rotting into a permanent exemption list.
 *
 * Three things are checked, and each answers a way a shrinking list stops
 * shrinking:
 *   - SLACK. A listed file with no raw-handle violation left has been
 *     converted, and its line must go in the same commit. Without this the
 *     list would only ever be as accurate as somebody remembering to prune it,
 *     and the count — which is Stage A's progress measure and its exit gate —
 *     would drift upward of the truth.
 *   - STALE. A listed file that does not exist is a rename or a deletion that
 *     turned an entry into a silent no-op.
 *   - OUT OF SCOPE. A listed file outside the store boundary is exempting
 *     nothing, because rule 13 never looked at it.
 *
 * Deliberately NOT allowlistable and NOT ratcheted itself: these three are
 * always errors. An entry here is a claim about work not yet done, and a claim
 * that has stopped being true is worse than no claim at all.
 */
export function checkStoreBoundaryLedger(repoRoot: string): Violation[] {
  const violations: Violation[] = []
  for (const file of STAGE_A_UNCONVERTED) {
    if (!inStoreBoundary(file)) {
      violations.push({
        file,
        specifier: file,
        rule: 'store-boundary-ledger',
        message: `${file}: listed in STAGE_A_UNCONVERTED but outside the store boundary (${[...STORE_BOUNDARY_ROOTS, ...STORE_BOUNDARY_FILES].join(', ')}), so it exempts nothing — rule 13 never looked at it. Delete the line.`,
      })
      continue
    }
    const abs = join(repoRoot, file)
    if (!existsSync(abs)) {
      violations.push({
        file,
        specifier: file,
        rule: 'store-boundary-ledger',
        message: `${file}: listed in STAGE_A_UNCONVERTED but does not exist. A renamed or deleted file leaves an entry that exempts nothing and can never be paid off; delete the line, or list the new path if the file moved.`,
      })
      continue
    }
    if (rawHandleViolations(file, readFileSync(abs, 'utf8')).length === 0) {
      violations.push({
        file,
        specifier: file,
        rule: 'store-boundary-ledger',
        message: `${file}: listed in STAGE_A_UNCONVERTED but holds no raw handle — it is CONVERTED. This is the SIGNAL a wave reports, not a line a wave deletes: STAGE_A_UNCONVERTED is shared by every wave and the coordinator removes entries when landing each one, so a converting branch shows this finding until then and that is expected. Stage A is complete when the array is empty (POD-3221 method §5, Phase A exit).`,
      })
    }
  }
  return violations
}

/**
 * Check one file against the rules that are NOT the architecture manifest.
 *
 * POD-335 emptied most of this. What used to live here — app→app, agent-host
 * consumers, leaf/near-leaf allow-lists, packages-never-apps, cli-no-apps,
 * server role tiers, model single-home and runtime browser-safety — are now
 * MANIFEST constraints derived from workspace tags, one retirement per
 * documented equivalent (docs/gates/pod-335-boundary-lint-end-state.md).
 *
 * What remains is the set of rules that are NOT dependency-matrix facts: they
 * are about the SHAPE of code inside one place (a replica that must not
 * arbitrate, a kernel that must not name a database, a UI that must not touch
 * storage directly), and no tag on a workspace could express them.
 */
export function checkFile(file: string, source: string): Violation[] {
  return [
    ...checkReplicaDirection(file, source),
    ...checkStoreRawHandles(file, source),
    ...checkDrizzleTransaction(file, source),
    ...checkDrizzleImportHome(file, source),
    ...checkSqlRawLiteral(file, source),
    ...checkCacheTableAnnouncement(file, source),
    ...checkSyncKernelPurity(file, source),
    ...checkSessionBindingFieldAccess(file, source),
    ...checkUiStorageOwnership(file, source),
    ...checkConsoleOwnership(file, source),
  ]
}

// ---------------------------------------------------------------------------
// Console ownership (POD-1905, chunk 6 of the logging strategy —
// docs/superpowers/specs/2026-08-11-logging-strategy-plan.md).
//
// Diagnostics go through `@podium/logger`; `console.*` is reserved for the
// places where console output IS the product. Without this rule the sweep is a
// one-time tidy: every chunk before it converted call sites that nothing stops
// being re-added, and a diagnostic written to `console` in a detached server or
// a phone goes nowhere at all — no file, no ring buffer, no forwarding.
//
// WHAT IS OUT OF SCOPE, said rather than left to be inferred:
//   - `scripts/` and `apps/<x>/scripts/**` (both are `workspaceOf` === 'scripts'
//     via APP_BUILD_TIER_RE). Build and audit tooling prints to a terminal by
//     definition; there is no sink to route it to.
//   - RUST. `apps/desktop/src-tauri`'s `println!`/`eprintln!` are not reachable
//     by this check at all — `walk()` only yields `.ts`/`.tsx`. The desktop
//     crate's own stderr mirror lives inside its logging module and is that
//     sink's business; nothing here claims to police it.
//   - Bare REFERENCES to a console method. The pattern matches a CALL, so
//     `apps/server/src/migrations/restore.ts`'s `stdout: (s: string) => void =
//     console.log` — an injected CLI-output default, the plan's first named
//     exemption — is outside it by construction rather than by listing.
//     `const c = console; c.log(x)` would evade it too; that is the accepted
//     ceiling of a source-text rule, not an oversight.
// ---------------------------------------------------------------------------

/** Trees held to the rule. `scripts` is absent on purpose (see the block above). */
const CONSOLE_PRODUCT_ROOTS = ['apps/', 'packages/'] as const

/**
 * Directory-shaped carve-outs, checked as PATH SEGMENTS rather than as a
 * `*.test.ts` glob — POD-1906's review found the glob would have swept
 * `apps/server/src/test-support/capture-logs.ts` and the daemon/web fixtures,
 * which are test infrastructure that simply is not named `.test.ts`.
 * `isTestFile` already covers `.test.`/`.spec.` and `test/ tests/ __tests__/`;
 * these are the two segment names it does not know about.
 */
const CONSOLE_TEST_DIR_SEGMENTS = ['test-support', 'fixtures'] as const

/**
 * Workspaces where console output is the product, exempt WHOLESALE:
 *
 *  - `apps/cli` — every line it prints is the user's answer. The plan says so
 *    in as many words ("CLI user-facing output explicitly stays"), and chunk 2
 *    already routed the CLI's non-user-facing diagnostics (detached spawns, the
 *    safety net) through the logger, so what is left here is output.
 *  - `packages/logger` — the console sink cannot log through itself.
 */
const CONSOLE_EXEMPT_WORKSPACES: ReadonlySet<string> = new Set(['apps/cli', 'packages/logger'])

/**
 * Exact files where console output is the feature. Each needs a positive reason
 * of the same kind as the ones here — "console output IS what this produces" —
 * never "converting it was awkward".
 */
const CONSOLE_EXEMPT_FILES: ReadonlySet<string> = new Set([
  // THE IMPORTANT TWO (whole-epic review): the degraded-notice escape hatches
  // inside the logging module itself. Routing them through the logger builds
  // the log-about-logging loop they exist to break — the forwarding sink
  // reporting that forwarding is degraded, through the degraded sink.
  'packages/client-core/src/logging/forward-sink.ts',
  'packages/client-core/src/logging/crash.ts',
  // Perf harnesses: their measurements ARE console output, and this one uses
  // `console.table`, which the pattern below deliberately covers (any method,
  // not an enumerated list) — so the exemption has to be explicit rather than
  // arriving free because nobody thought of `table`.
  'packages/client-core/src/perf/switch-trace.ts',
  'apps/web/src/perf/large-state.frontend-perf.tsx',
  // Console output behind its own enable flag — the diagnostics ARE the feature.
  'packages/terminal-client/src/terminal-diagnostics.ts',
  // Build-time stdout (the vendored-abduco build step), i.e. the CLI category.
  'packages/pty/src/abduco-bin.ts',
  // Test-fixture BUILD output. Named as well as covered by the `test-support`
  // segment above, because it is the file the plan called out by path.
  'apps/server/src/test-support/pre-migrated-store.build.ts',
  // The Turso append proof's measurement harness (POD-3250): the round-trip and
  // latency table it prints IS its product, same category as the perf harnesses
  // above. It is a spike, not wired into the server, and nothing imports it.
  'apps/server/src/store/spike/turso-append/run-proofs.ts',
  // The same spike's CONCURRENCY check (POD-3358). Its product is the two-arm
  // verdict it prints — two runs at once, namespaced and then deliberately
  // shared — which is evidence a human reads, not a log a service emits.
  'apps/server/src/store/spike/turso-append/namespace-check.ts',
  // The same spike's DEFEAT check (POD-3357). Its product is the defeat list it
  // prints: for each invariant `run-proofs.ts` asserts, the same proof run again
  // with that invariant deliberately broken, shown going red. A human reads the
  // table to decide whether the hosted gate is evidence or decoration.
  'apps/server/src/store/spike/turso-append/defeat-check.ts',
])

/**
 * A console METHOD CALL — any method, `table` and `dir` and `group` included.
 * `\s*` around the dot so a line-broken call cannot slip past; no leading
 * boundary guard, so `globalThis.console.warn(...)` is caught too.
 */
const CONSOLE_METHOD_CALL = /\bconsole\s*\.\s*[A-Za-z_$][\w$]*\s*\(/

/**
 * Rule `console-ownership`: product source logs through `@podium/logger`.
 * Comment-stripped, like every other source-shape rule here, so that
 * DOCUMENTING the prohibition — which this file and docs/agents/logging.md both
 * do at length — cannot trip the lint enforcing it.
 */
export function checkConsoleOwnership(file: string, source: string): Violation[] {
  if (isTestFile(file)) return []
  if (workspaceOf(file) === 'scripts') return []
  if (!CONSOLE_PRODUCT_ROOTS.some((p) => file.startsWith(p))) return []
  if (CONSOLE_EXEMPT_WORKSPACES.has(workspaceOf(file))) return []
  if (CONSOLE_EXEMPT_FILES.has(file)) return []
  const segments = file.split('/')
  if (CONSOLE_TEST_DIR_SEGMENTS.some((d) => segments.includes(d))) return []
  const hit = CONSOLE_METHOD_CALL.exec(stripComments(source))
  if (!hit) return []
  return [
    {
      file,
      specifier: hit[0].replace(/\s*\($/, ''),
      rule: 'console-ownership',
      message: `${file}: '${hit[0].replace(/\s*\($/, '')}' — product code logs through @podium/logger, not the console (POD-1905). Use \`createLogger('<pkg>:<module>')\` and pass structured fields; see docs/agents/logging.md. If console output IS this file's product (CLI stdout, a perf harness, the logger's own degrade notice), add it to CONSOLE_EXEMPT_FILES here with the reason.`,
    },
  ]
}

// ---------------------------------------------------------------------------
// Architecture manifest (POD-296) — the tag-derived matrix, run alongside the
// legacy rules above. See scripts/architecture-manifest.ts for the tags and why
// the two rule families coexist (POD-335 retires the legacy eight, each only
// once an equivalent manifest constraint exists).
// ---------------------------------------------------------------------------

/** Classifier engine is harness-core-internal; provider rules stay private to their owning manifest. */
export function checkHarnessClassifierBoundary(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  for (const ref of extractImports(source)) {
    if (
      ref.specifier.includes('agent-state/transcript-classifier') &&
      !file.startsWith('packages/harness/')
    ) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'harness-classifier-boundary',
        message: `${file}: classifier engine is internal to packages/harness`,
      })
    }
    if (
      ref.specifier.includes('claude-code-classifier') &&
      file !== 'packages/harness/src/manifests/claude-code.ts' &&
      file !== 'packages/harness/src/manifests/claude-code-classifier.ts'
    ) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'harness-classifier-boundary',
        message: `${file}: Claude classifier rules are private to the Claude manifest`,
      })
    }
  }
  return violations
}

// ---------------------------------------------------------------------------
// UI storage ownership (POD-329) — the only places that may call localStorage /
// AsyncStorage method APIs are the ui-state module and the replica persistence
// adapter family (plus platform composition roots that inject storage).
//
// Theme pre-auth raw access lives inside ui-state.ts via read/writePreAuthTheme.
// A new composition root that injects window.localStorage into createReplica
// must be added to SANCTIONED_UI_STORAGE_FILES with a reason comment stating
// why the next entry would need the same justification (POD-1251 standard).
// ---------------------------------------------------------------------------

/**
 * Exact product files permitted to call localStorage / AsyncStorage methods.
 * Adding an entry requires the same positive reason as the others: either the
 * sole UI-state owner, the replica persistence adapter, or a composition root
 * that *injects* storage into that adapter (never a feature component).
 */
const SANCTIONED_UI_STORAGE_FILES: ReadonlySet<string> = new Set([
  // Sole UI persistence module — including the theme pre-auth exception.
  'packages/client-core/src/ui-state.ts',
  // Replica persistence adapter family.
  'packages/client-core/src/replica/replica.ts',
  'packages/client-core/src/replica/async-storage.ts',
  'packages/client-core/src/replica/principal-storage.ts',
  'packages/client-core/src/replica/contract.ts',
  'packages/client-core/src/replica/kernel/side-cache.ts',
  'packages/client-core/src/replica/kernel/facade.ts',
  'packages/client-core/src/replica/legacy-snapshot.ts',
  // Platform composition roots that inject storage into the replica factory.
  // NEXT entry must be a composition root that wires StorageApi into createReplica
  // (or its AsyncStorage twin), never a feature surface that reads a key ad hoc.
  'apps/web/src/lib/kernelReplica.ts',
  'apps/web/src/lib/use-kernel-replica.ts',
  'apps/mobile/src/client/MobileClientProvider.tsx',
])

/** Product trees held to the storage-ownership rule (tests are exempt). */
const UI_STORAGE_PRODUCT_PREFIXES = [
  'apps/web/src/',
  'apps/mobile/src/',
  'packages/client-core/src/',
  'packages/terminal-client/src/',
] as const

/** Method access only — bare mentions and comments are not a finding. */
const UI_STORAGE_METHOD_CALL =
  /(?:(?:globalThis|window)\.)?localStorage\s*\??\.(?:getItem|setItem|removeItem|clear)\b|\bAsyncStorage\s*\??\.(?:getItem|setItem|removeItem|multiGet|multiSet|getAllKeys|clear)\b/

/**
 * Rule: UI storage ownership (POD-329). Feature code routes every persisted
 * key through ui-state / the replica adapter; direct browser or RN storage
 * method calls outside the sanctioned set are a hard failure.
 */
export function checkUiStorageOwnership(file: string, source: string): Violation[] {
  if (isTestFile(file)) return []
  if (!UI_STORAGE_PRODUCT_PREFIXES.some((p) => file.startsWith(p))) return []
  if (SANCTIONED_UI_STORAGE_FILES.has(file)) return []
  // Comment-stripped so documenting the prohibition cannot trip the rule.
  if (!UI_STORAGE_METHOD_CALL.test(stripComments(source))) return []
  return [
    {
      file,
      specifier: 'localStorage|AsyncStorage',
      rule: 'ui-storage-ownership',
      message: `${file}: direct localStorage/AsyncStorage method access is reserved for packages/client-core/src/ui-state.ts and the replica persistence adapter (POD-329). Route the key through ui-state or inject storage at a composition root.`,
    },
  ]
}

/**
 * Rule `feature-single-home` — a workspace's OWNED features have exactly one
 * definition site (POD-335, generalising legacy rule 7).
 *
 * The manifest's `features` tag has always declared ownership and the unit tests
 * have always asserted it is exclusive; what it lacked was an ENFORCEMENT ARM
 * over source. Legacy rule 7 was that arm for one workspace, hard-coded:
 * `@podium/model` is the single home for the predicates it exports, and no
 * `packages/*` file may DECLARE a top-level binding under the same name.
 *
 * TWO THINGS CHANGE HERE, and both make it stricter rather than merely tidier:
 *
 *  1. The home is read from the MANIFEST (`featureHome`) instead of a constant,
 *     so moving a feature moves its rule with it.
 *  2. `apps/*` is held to it too. Rule 7 only ever looked at `packages/*`, which
 *     is the wrong half: a server module re-declaring `issueStageOf` is exactly
 *     as much a second definition as a client one, and rather more likely.
 *
 * Re-EXPORTING the home's binding stays fine and is encouraged — the pattern is
 * `export { x } from '@podium/model'`, which declares nothing. Only a NEW
 * declaration under an owned name is flagged.
 */
const FEATURE_SINGLE_HOME_WORKSPACE = 'packages/model'

export function checkFeatureSingleHome(
  file: string,
  source: string,
  ownedNames: ReadonlySet<string>,
): Violation[] {
  if (ownedNames.size === 0) return []
  if (!file.startsWith('packages/') && !file.startsWith('apps/')) return []
  if (file.startsWith(`${FEATURE_SINGLE_HOME_WORKSPACE}/`)) return []
  if (isTestFile(file)) return []
  const home = tagsFor(FEATURE_SINGLE_HOME_WORKSPACE)
  const violations: Violation[] = []
  for (const m of stripComments(source).matchAll(TOP_LEVEL_DECL_RE)) {
    const name = m[1]
    if (name && ownedNames.has(name)) {
      violations.push({
        file,
        specifier: name,
        rule: 'feature-single-home',
        message: `${file}: redefines '${name}', which ${FEATURE_SINGLE_HOME_WORKSPACE} already exports. That workspace OWNS ${(home?.features ?? []).join(', ')} in the architecture manifest, and ownership is exclusive — import the binding from '@podium/model' instead. Re-exporting the imported binding is fine; declaring a new one under the same name is a second definition that is free to drift.`,
      })
    }
  }
  return violations
}

/**
 * Rule `manifest-open-entrypoint` — the declared open surface of a
 * capability-restricted workspace stays narrow and ENUMERABLE (POD-335).
 *
 * `packages/harness` restricts its consumers to the machine host and the build
 * tier, and declares one open entrypoint (`@podium/harness/metadata`) that
 * anyone may import. This rule is what keeps that declaration from becoming the
 * hole it would otherwise be:
 *
 *  (a) NO STAR RE-EXPORT. `export * from './registry.js'` in an open entrypoint
 *      would re-open the whole package in one line, silently, and the diff would
 *      look like a tidy-up.
 *  (b) NO PROCESS-DRIVING EXPORT NAME, and no direct import of a process API.
 *
 * WHY THIS IS A SURFACE CHECK AND NOT A CLOSURE CHECK, stated rather than left
 * to be discovered: the metadata functions resolve through `AGENT_MANIFESTS`,
 * and the manifests' own closure legitimately reaches `node:child_process`, so a
 * transitive walk would refuse the entire surface and prove nothing about it.
 * What is provable is that the surface cannot WIDEN without someone editing an
 * explicit named list — which is precisely the review checkpoint the exception
 * exists to force. The complementary guarantee comes from
 * `manifest-consumers`: everything except the named entrypoints is still shut.
 */
const PROCESS_DRIVING_EXPORT_RE =
  /\b(launch|spawn|exec|execute|probe|attach|detach|kill|terminate|write|send|drive|resume|start|stop)[A-Z]\w*/

const PROCESS_API_SPECIFIERS = /^(?:node:child_process|node-pty|execa|@podium\/pty)/

export function checkOpenEntrypoints(repoRoot: string): Violation[] {
  const violations: Violation[] = []
  for (const [workspace, tags] of Object.entries(MANIFEST)) {
    for (const specifier of tags.openEntrypoints ?? []) {
      const rel = specifier.slice(specifier.indexOf('/', '@podium/'.length) + 1)
      const file = `${workspace}/src/${rel}.ts`
      let source: string
      try {
        source = readFileSync(join(repoRoot, file), 'utf8')
      } catch {
        violations.push({
          file,
          specifier,
          rule: 'manifest-open-entrypoint',
          message: `${file}: declared open entrypoint '${specifier}' of ${workspace} does not exist — a missing module makes this check vacuously green. Create it or remove the entry from openEntrypoints in scripts/architecture-manifest.ts.`,
        })
        continue
      }
      const stripped = stripComments(source)
      if (/\bexport\s*\*\s*from\b/.test(stripped)) {
        violations.push({
          file,
          specifier,
          rule: 'manifest-open-entrypoint',
          message: `${file}: an open entrypoint may not \`export *\` — that re-opens the whole capability-restricted package in one line. List every export by name, so widening the surface is an edit someone has to make deliberately.`,
        })
      }
      for (const m of stripped.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:,|\}|$)/gm)) {
        const name = m[1] ?? ''
        if (PROCESS_DRIVING_EXPORT_RE.test(name)) {
          violations.push({
            file,
            specifier,
            rule: 'manifest-open-entrypoint',
            message: `${file}: exports '${name}' from the open entrypoint '${specifier}'. The open surface carries FACTS ABOUT SOFTWARE ("what is this CLI, what can it do, what did it write"), never ACTIONS ON A HOST. An action belongs on the machine host (apps/daemon), which is what ${workspace}'s consumer restriction names.`,
          })
        }
      }
      for (const ref of extractImports(stripped)) {
        if (PROCESS_API_SPECIFIERS.test(ref.specifier) && !ref.typeOnly) {
          violations.push({
            file,
            specifier: ref.specifier,
            rule: 'manifest-open-entrypoint',
            message: `${file}: the open entrypoint '${specifier}' directly imports the process API '${ref.specifier}'. That is the capability the consumer restriction exists to contain.`,
          })
        }
      }
    }
  }
  return violations
}

/** Check one file against the MANIFEST rules (layer, platform, role, harness). */
export function checkManifestFile(
  file: string,
  source: string,
  harnessLiterals: readonly string[] = [],
  ownedNames: ReadonlySet<string> = new Set(),
): Violation[] {
  const violations: Violation[] = [
    ...findHarnessBranching(file, source, harnessLiterals),
    ...checkHarnessClassifierBoundary(file, source),
    // POD-333 — the deleted compatibility shims stay deleted: neither the file
    // nor an import that resolves to it may come back.
    ...findRetiredFile(file),
    ...findRetiredImports(file, source),
    // POD-329 ownership also runs under the architecture-manifest path so
    // `lint:architecture` cannot sail past a new raw-storage call.
    ...checkUiStorageOwnership(file, source),
    // POD-335 — the feature-ownership arm and the multi-user guardrail.
    ...checkFeatureSingleHome(file, source, ownedNames),
    ...checkAuthzSingleHome(file, source),
  ]
  const from = workspaceOf(file)
  for (const ref of extractImports(source)) {
    // Role tiers are same-workspace edges, which the cross-workspace matrix skips.
    const roleViolation = checkManifestRole(file, ref)
    if (roleViolation) {
      violations.push(roleViolation)
      continue
    }
    // The declared browser surface of every NEUTRAL workspace.
    const browserReach = checkBrowserReach(file, ref)
    if (browserReach) {
      violations.push(browserReach)
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
  manifest: Violation[]
} {
  const violations: Violation[] = []
  const manifest: Violation[] = []
  const workspaces = new Set<string>()
  const modelExportNames = loadModelExportNames(repoRoot)
  const harnessLiterals = loadHarnessLiterals(repoRoot)
  for (const rootDir of ['apps', 'packages', 'scripts']) {
    for (const abs of walk(join(repoRoot, rootDir))) {
      const file = relative(repoRoot, abs).split(sep).join('/')
      const source = readFileSync(abs, 'utf8')
      workspaces.add(workspaceOf(file))
      violations.push(...checkFile(file, source))
      violations.push(...checkPrincipalFree(file, source))
      manifest.push(...checkManifestFile(file, source, harnessLiterals, modelExportNames))
    }
  }
  violations.push(...checkDeclaredDeps(repoRoot))
  violations.push(...checkStoreBoundaryLedger(repoRoot))
  violations.push(...checkHostEdgeSeparationAll(repoRoot))
  manifest.push(...checkManifestCoverage(workspaces))
  manifest.push(...checkBrowserGraphAll(repoRoot))
  manifest.push(...checkPlaneLeakAll(repoRoot))
  manifest.push(...checkOpenEntrypoints(repoRoot))
  return { violations, manifest }
}

function main(): void {
  // `--manifest-only` runs the ARCHITECTURE MANIFEST alone and takes its exit
  // code from the ratchet only (new/over-count manifest violations), ignoring
  // the legacy rules entirely. That is what makes the ratchet blockable in CI
  // today: `bun run lint` is `continue-on-error: true` because it is already red
  // — ~249 biome errors (podium #30) plus the agent-host-consumers failures
  // (POD-740) — so a ratchet wired only into `bun run lint` would report a NEW
  // violation and CI would sail straight past it. This mode is green as of the
  // committed allowlist, so `lint:architecture` blocks on its own while the
  // legacy rules stay non-blocking until their reds are burned down.
  const manifestOnly = process.argv.includes('--manifest-only')
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const start = performance.now()
  const { violations, manifest } = runCheck(repoRoot)
  if (process.argv.includes('--probe')) {
    const probeSource = readFileSync(
      join(repoRoot, 'scripts/fixtures/harness-axiom-probe.ts.txt'),
      'utf8',
    )
    manifest.push(
      ...checkManifestFile(
        'packages/pty/src/__harness-axiom-probe.ts',
        probeSource,
        loadHarnessLiterals(repoRoot),
      ),
    )
    // POD-333 — the retired-path rule proves it can still say NO. Unlike the
    // harness probe (whose violations join the run and are allowlisted), this
    // one ASSERTS and throws: `manifest-retired-path` is error-level, so its
    // violations can never be allowlisted, and a probe that merely reported
    // would fail the build every time it worked. Asserting here also gives the
    // rule the property docs/rearch-deletion-audit.md demands of anything whose
    // correct count is zero — the detector watches itself, because nothing else
    // can distinguish "no retired paths remain" from "the resolver broke".
    const retiredProbe = checkManifestFile(
      'apps/web/src/features/__retired-path-probe.ts',
      readFileSync(join(repoRoot, 'scripts/fixtures/retired-path-probe.ts.txt'), 'utf8'),
      [],
    ).filter((v) => v.rule === 'manifest-retired-path')
    // EXIT CODE 3, not 1. `--probe` already exits 1 by design — the harness
    // probe's violation is reported as NEW and fails the run, which is how that
    // probe proves its rule fires. A broken retired-path rule would therefore
    // ALSO exit 1, via somebody else's violation, and read as "the probe ran".
    // A distinct code makes "the guard is dead" impossible to mistake for "the
    // guard fired".
    const fileProbe = findRetiredFile('apps/web/src/lib/home.ts')
    if (retiredProbe.length !== 3 || fileProbe.length !== 1) {
      console.error(
        `\nPROBE FAILED (manifest-retired-path): imports ${retiredProbe.length}/3 ` +
          `(aliased, relative, type-only), file ${fileProbe.length}/1. The rule can no longer ` +
          'refuse a retired path — fix findRetiredImports / resolveModulePath / RETIRED_MODULES ' +
          'in scripts/architecture-manifest.ts before trusting any green from this check.',
      )
      process.exit(3)
    }
    console.log('probe: manifest-retired-path refuses 3/3 import forms and 1/1 re-created file')
  }
  // ONE allowlist, but the two rule families must be applied to their OWN
  // violations: applyAllowlist calls any entry with no matching violation stale,
  // so a shared pass would have each family declaring the other's entries dead.
  const [manifestAllowed, legacyAllowed] = partitionAllowlist(BOUNDARY_ALLOWLIST)
  const { warnings, errors, stale } = applyManifestPolicy(manifest, manifestAllowed)
  // The legacy rules run through the SAME ratchet (POD-740): their two known
  // violations are grandfathered in the one phase-mapped allowlist, so
  // lint:boundaries is green while a NEW legacy violation still fails. Before
  // this, any legacy violation failed outright — which is why the check had been
  // red on every branch since accounts.ts/relay.ts grew those imports, and a
  // guardrail everyone has learned to ignore is not a guardrail.
  const legacy = applyAllowlist(violations, legacyAllowed)
  const ms = Math.round(performance.now() - start)

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
