/**
 * Architecture manifest (Phase 0 guardrail — POD-296).
 *
 * Every workspace (app or package) carries TAGS; the allowed-dependency matrix
 * is DERIVED from those tags plus a short list of explicit same-layer edges.
 * This replaces "a rule per hand-noticed mistake" with "a property per
 * workspace, and one rule per property".
 *
 * The tags:
 *
 *  - `layer` (L0–L5) — the ordinal dependency tier. Imports point DOWN:
 *      L0 model        (model)
 *      L1 wire/commands/contracts (protocol, issue-client)
 *      L2 kernels/ports (transcript, runtime, sync, agent-bridge, pty, terminal-client)
 *      L3 features/adapters/engine (client-core, terminal-client-react)
 *      L4 app composition roots (apps/*)
 *      L5 build/compose tier (scripts/) — may import anything; nothing may import it.
 *    A same-layer edge is NOT implicit: it must be declared in
 *    {@link SAME_LAYER_ALLOWED}. An upward edge is always a violation.
 *
 *  - `platform` — browser-safe | node-only | neutral. A browser-safe workspace
 *    may import only browser-safe or neutral workspaces; node-only and neutral
 *    are unconstrained here (the `@podium/runtime` barrel nuance — browser-safe
 *    root, node-only subpaths — stays with legacy rule 8 until POD-335 lands an
 *    equivalent).
 *
 *  - `role` (server tiers core < hub < cloud) — file-level WITHIN a workspace,
 *    delegated to the one existing manifest at apps/server/src/roles.ts rather
 *    than restated here. `roleTiered: true` marks the workspace it applies to.
 *
 *  - `features` — the concerns a workspace OWNS. Ownership is exclusive: two
 *    workspaces claiming the same feature is a manifest bug (asserted by the
 *    unit tests, see {@link duplicateFeatureOwners}). The enforcement arm today
 *    is legacy rule 7 (model single-home); POD-335 generalises it over this tag.
 *
 * Plus one non-dependency axiom:
 *
 *  - Harness axiom — BEHAVIORAL BRANCHING on harness identity is confined to
 *    packages/harness. Identifiers and serialized capability descriptors
 *    may flow ANYWHERE (protocol/UI/settings may carry a HarnessAgent value);
 *    only a COMPARISON or `case` on a harness literal is flagged. The axiom's
 *    blessed exception — icon/label maps — needs no declaration: a Record keyed
 *    by harness is a lookup, not a comparison, so the rule never sees it.
 *
 *    That exception extends to ADAPTER SELECTION, and POD-1105 is the precedent:
 *    packages/composer picks a per-harness composer driver, and an `if` chain
 *    doing so was a violation while the same thing written as a registry Record
 *    is not. This is not a loophole — the per-harness BEHAVIOR lives in the
 *    driver objects (they ARE the adapters); only the selection was branching,
 *    and a table makes adding a harness a new row instead of a found-and-edited
 *    `if`. Note the alternative was WORSE: moving that selection into
 *    {@link HARNESS_ADAPTER_HOME} would drag node-only code toward a browser
 *    bundle (composer is browser-safe, aliased by apps/web and re-exported by
 *    terminal-client), which ADR 0008 already rejected for pure mappers. So
 *    composer is NOT a second sanctioned home for harness branching, and no
 *    second home was created: a sanctioned second home is the kind of exception
 *    that quietly becomes N homes, and the registry form needs none.
 *
 * Non-error manifest rules use a ratchet: known violations are declared in
 * scripts/boundary-allowlist.ts with a per-file COUNT and the phase that
 * removes them. Allowlisted-and-within-count warns; anything new or over count
 * fails. See {@link applyAllowlist}.
 *
 * Pure — no IO except the two `load*` functions, which read the live source of
 * truth (never a hardcoded copy). Tested in scripts/architecture-manifest.test.ts.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isCompositionRoot, ROLE_RANK, serverRoleOf } from '../apps/server/src/roles'

// ---------------------------------------------------------------------------
// Shared primitives (imported + re-exported by scripts/check-boundaries.ts)
// ---------------------------------------------------------------------------

export interface ImportRef {
  specifier: string
  /** true when the import is fully erased at build (`import type` / all-`type` specifiers). */
  typeOnly: boolean
}

export interface Violation {
  file: string
  specifier: string
  rule: string
  message: string
}

/**
 * Blank out // line comments and block comments, PRESERVING position: every
 * comment character becomes a space and newlines survive, so an index into the
 * result is still a valid index into the original. Rules that report a line
 * number (the harness axiom) depend on that — deleting the text instead shifts
 * every line after a block comment, and the reported line then points at an
 * innocent neighbour rather than failing loudly.
 *
 * Good enough for import scanning: template literals containing `import ... from`
 * are vanishingly rare in this repo, and false negatives only under-report.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length))
}

const IMPORT_RE =
  // import ... from '...'; export ... from '...'; import '...'; require('...'); import('...')
  // The clause (group 2) may span lines but never contains quotes or semicolons,
  // so one statement's clause can't swallow a neighbouring statement.
  /(?:\b(import|export)\s+([^'";]*?)\s+from\s*|\bimport\s*(?=['"])|\b(?:require|import)\s*\(\s*)['"]([^'"]+)['"]/g

/** True when an import/export clause is fully type-only (erased at build). */
export function clauseIsTypeOnly(clause: string): boolean {
  const c = clause.trim()
  if (/^type\s/.test(c) && !/^type\s*\{?\s*,/.test(c)) {
    // `import type { X }`, `import type X`, `export type { X }` — but a default
    // import alongside (`import type X, { Y }`) is still fully type-only in TS.
    return true
  }
  // `import { type A, type B } from` — type-only iff every named specifier is
  // `type`-prefixed and there is no default/namespace import.
  const named = c.match(/^\{([\s\S]*)\}$/)
  if (!named) return false
  const specs = (named[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s))
}

/** Extract all module specifiers (with type-only flags) from a TS/TSX source. */
export function extractImports(source: string): ImportRef[] {
  const stripped = stripComments(source)
  const refs: ImportRef[] = []
  for (const m of stripped.matchAll(IMPORT_RE)) {
    const clause = m[2]
    const specifier = m[3]
    if (!specifier) continue
    refs.push({ specifier, typeOnly: clause !== undefined ? clauseIsTypeOnly(clause) : false })
  }
  return refs
}

export function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(file) || /\/(test|tests|__tests__)\//.test(file)
}

/**
 * `apps/<x>/scripts/**` is BUILD TIER, not app source (POD-335).
 *
 * The decision the POD-296 allowlist deferred to Phase 7, made here in the open.
 * `apps/desktop/scripts/stage-sidecar.ts` imports `scripts/build-bun.js` and was
 * carried as two allowlist entries (`manifest-layer` + `manifest-platform`) whose
 * own note said the debt was a TAG-GRANULARITY artifact: the manifest tags whole
 * workspaces, so a build script inherited `apps/desktop`'s L4/browser-safe tags
 * and was accused of dragging Node into a browser bundle it never reaches.
 *
 * Of the two resolutions that note named — move the file under `scripts/`, or
 * give `apps/*&#47;scripts` its own build-tier tag — this is the second, and it is
 * the right one: the file is a per-app build step and belongs beside the app it
 * builds. Classifying it as L5 says the true thing (build tooling composes
 * everything; nothing ships it) instead of granting an exception to a false one.
 *
 * NARROW ON PURPOSE. Only `scripts/` directly under an app, never `src/scripts/`
 * and never a deeper match, so an app cannot move product code into a folder
 * named `scripts` and inherit L5's "may import anything".
 */
const APP_BUILD_TIER_RE = /^apps\/[^/]+\/scripts\//

/** Workspace a repo-relative file path belongs to: 'apps/x', 'packages/y' or 'scripts'. */
export function workspaceOf(file: string): string {
  if (APP_BUILD_TIER_RE.test(file)) return 'scripts'
  const parts = file.split('/')
  if (parts[0] === 'apps' || parts[0] === 'packages') return `${parts[0]}/${parts[1]}`
  if (parts[0] === 'scripts') return 'scripts'
  return parts[0] ?? file
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Ordinal dependency tier. Imports point down; equal needs an explicit edge. */
export type Layer = 0 | 1 | 2 | 3 | 4 | 5

/** Where a workspace's code is allowed to RUN. */
export type Platform = 'browser-safe' | 'node-only' | 'neutral'

export interface WorkspaceTags {
  layer: Layer
  platform: Platform
  /** Concerns this workspace OWNS. Exclusive — see {@link duplicateFeatureOwners}. */
  features: readonly string[]
  /** Server role tiers (core<hub<cloud) apply file-level inside this workspace. */
  roleTiered?: boolean
  /**
   * The CLOSED set of workspaces this one may import (POD-335).
   *
   * The layer ordinal alone is strictly weaker than the near-leaf rules it
   * replaces, and the gap is not hypothetical: `packages/runtime` is L2 and
   * `packages/commands` is L1, so the layer axiom would happily admit
   * `runtime -> commands` while legacy rule 3b's allow-list never did. Same for
   * `transcript -> commands` and `composer -> commands`. A tag that says "down is
   * free" cannot express "down, but only to these two", so the matrix carries
   * both: an ordinal for the general direction and a closed set where the
   * workspace's whole point is that its dependencies are enumerable.
   *
   * ABSENT means "governed by the layer axiom alone" — the right default for an
   * app composition root, which by definition composes whatever it needs. An
   * empty array is not the same thing: it means "imports NO workspace package",
   * which is what makes `packages/model` a leaf.
   */
  deps?: readonly string[]
  /**
   * The CLOSED set of workspaces that may import THIS one (POD-335) — the
   * inverse direction, and it needs its own tag because a capability is a
   * property of the TARGET, not of any one edge.
   *
   * `packages/pty` and `packages/harness` drive real agent PROCESSES and PTYs.
   * That is a host capability: the machine host (apps/daemon) and the build tier
   * may take it; nothing else may. No ordinal can say this — the edges it
   * forbids (apps/server L4 -> packages/harness L2) all point correctly DOWN.
   *
   * See {@link WorkspaceTags.openEntrypoints} for the narrow surface everyone
   * else may still reach.
   */
  consumers?: readonly string[]
  /**
   * Subpath specifiers of a `consumers`-restricted workspace that ANY workspace
   * may import (POD-335), because their transitive closure carries none of the
   * capability the restriction exists to contain.
   *
   * This is the mechanism that lets the restriction be PRECISE instead of merely
   * strict. Legacy rule 2 was a whole-package ban, so four `apps/server` files
   * that read static software metadata — display names, capability descriptors,
   * pure transcript mappers, two string constants, a protocol-level causal state
   * machine — were indistinguishable from a file that spawns a process, and all
   * four sat in the allowlist as debt nobody could pay without moving modules
   * between packages.
   *
   * A declaration here is a DECISION, and {@link Violation}-producing closure
   * checks in scripts/check-boundaries.ts hold it: an open entrypoint whose graph
   * reaches a process-spawning API, or whose graph cannot be walked at all, is a
   * violation. Same shape as the browser-entrypoint pair, and for the same
   * reason — a declaration list nobody verifies is mechanism-presence, not
   * coverage.
   */
  openEntrypoints?: readonly string[]
}

/**
 * THE MANIFEST. Every app and package is tagged; a workspace missing here is
 * itself a violation (rule `manifest-untagged`) so a new package can't silently
 * escape the matrix.
 *
 * `scripts` is the build/compose tier (L5): it composes apps (e.g. scripts/cli.ts
 * injects in-process host modules), so it sits ABOVE them and may import
 * anything. Nothing may import scripts — apps/desktop currently does, which is
 * an allowlisted violation removed by POD-294.
 */
export const MANIFEST: Readonly<Record<string, WorkspaceTags>> = {
  // L0 — model. The zero-dependency root (POD-299): zod-only, importing no
  // workspace package at all, which is what makes it the one definition site.
  // Absorbed the deleted `packages/domain` wholesale, and owns that package's
  // features plus the one clock representation (`Instant` + edge adapters).
  // POD-300 added `entity-schemas`: every replicated-entity zod schema — the
  // session, issue, conversation, transcript and handoff aggregates and the
  // per-machine fact group — moved here out of `packages/protocol`, which now
  // holds only frames and imports these.
  'packages/model': {
    layer: 0,
    platform: 'browser-safe',
    features: [
      'entity-schemas',
      'entity-predicates',
      'issue-stage',
      'issue-authz',
      'session-dedup',
      'git-identity',
      'clock',
    ],
    // THE LEAF (legacy rule 3). An empty closed set, not an absent one: model
    // imports NO workspace package at all, which is what makes it the one
    // definition site every other layer can depend on without a cycle.
    deps: [],
  },

  // L1 — wire / commands / contracts.
  // Near-leaf (legacy rule 3): since POD-300 the entity schemas live in L0 model
  // and protocol imports them. That single edge is the whole set.
  'packages/protocol': {
    layer: 1,
    platform: 'browser-safe',
    features: ['wire-schema', 'titles'],
    deps: ['packages/model'],
  },
  // The issue-client seam (IssueTrpc + the CLI's rendering table) sits between
  // apps/cli and apps/server — it must never import app code or IO packages.
  'packages/issue-client': {
    layer: 1,
    platform: 'node-only',
    features: ['issue-command-table'],
    deps: ['packages/commands', 'packages/protocol', 'packages/model'],
  },
  // The command CONTRACT framework (ADR 3 D1, POD-311's split; landed by POD-728
  // with agent-mail as its first tenant). Pure data + pure policy functions —
  // browser-safe by construction, because a contract that needed a service could
  // not live at L1 at all.
  'packages/commands': {
    layer: 1,
    platform: 'browser-safe',
    features: ['command-contracts'],
    deps: ['packages/protocol', 'packages/model'],
  },

  // L2 — kernels / ports.
  // Pure parsing/paging over protocol types — it must never grow IO or harness
  // dependencies, which the ordinal alone would permit (transcript L2 could
  // reach commands L1 on the layer axiom; the closed set is what refuses it).
  'packages/transcript': {
    layer: 2,
    platform: 'node-only',
    features: ['transcript-parsing'],
    deps: ['packages/protocol', 'packages/model'],
  },
  'packages/runtime': {
    layer: 2,
    platform: 'neutral',
    features: ['config', 'sqlite', 'git-port', 'connectivity', 'auth-store', 'settings'],
    // Node-runtime plumbing that may reach the pure leaves and nothing else.
    deps: ['packages/protocol', 'packages/model'],
  },
  // The sync kernel. NEUTRAL, and this is a CLASSIFICATION change rather than a
  // code change (POD-307; the decision POD-374 and POD-375 both declined to make
  // because it belongs to the issue that owns the CONSUMERS).
  //
  // What was wrong with `node-only`: the tag is one bit per workspace, and this
  // workspace has always had two halves. The Authority write funnel, the Ledger,
  // `mirror.ts` and the SQLite repository are node-only; the Replica and Outbox
  // ROLES take storage and transport as injected ports and name no technology at
  // all (rule 11 in scripts/check-boundaries.ts enforces exactly that), and ADR 6
  // D1 puts the browser's and the phone's storage adapters in this package
  // beside the SQLite one. Tagging the whole workspace node-only falsely accused
  // `adapters/indexeddb` — which exists to run in a browser and cannot run
  // anywhere else — and left apps/web and apps/mobile unable to import the
  // adapters built for them (POD-1195, measured by both adapter issues).
  //
  // Why NEUTRAL and not a package split: ADR 8 D4's today→target table says
  // `packages/sync` → `packages/sync` (Authority/Replica/Outbox), "reshape in
  // place", and the end-state layer map lists no browser-side sibling. A split
  // would also cut the conformance suite, which is parameterized by
  // instantiation and must stay ONE suite across every adapter (ADR 6 D3).
  // `packages/runtime` and `packages/telemetry` are the standing precedent for
  // this exact shape, in this exact file: a browser-safe surface behind explicit
  // subpaths, node-only concerns behind their own, and the tag saying `neutral`
  // because one bit cannot say both.
  //
  // NEUTRAL IS UNCONSTRAINED HERE, so on its own it would be a hole: it would let
  // apps/web import the bare barrel, which value-exports the Authority and the
  // SQLite repository. That hole is closed in the same commit by rule 12
  // (`sync-browser-reach`) in scripts/check-boundaries.ts, which names the
  // browser-safe entrypoints and holds their transitive import closure to
  // no-Node. Retagging without that rule would be trading a false accusation for
  // a real one.
  'packages/sync': {
    layer: 2,
    platform: 'neutral',
    features: ['oplog', 'upstream-sync'],
    deps: [
      'packages/commands',
      'packages/protocol',
      'packages/runtime',
      'packages/model',
    ],
  },
  // Opt-in telemetry [spec:SP-f933]. NEUTRAL for the same reason as runtime,
  // and by the same construction: the barrel and the pure slices (schema,
  // example, scrub) are browser-safe — apps/web imports './example' for its
  // privacy/setup copy — while node-only concerns (consent's node:crypto,
  // queue's state dir) sit behind their own subpaths. Tagging it node-only
  // would falsely accuse those two real, browser-safe web imports.
  'packages/telemetry': {
    layer: 2,
    platform: 'neutral',
    features: ['telemetry-schema', 'telemetry-consent', 'telemetry-queue'],
    deps: ['packages/protocol', 'packages/runtime', 'packages/model'],
  },
  // The PTY kernel split out of agent-bridge (POD-396, ADR 8 D4): backends,
  // durable hosts (abduco/tmux + the vendored-C build), byte framing, OSC scan,
  // redraw. It owns `pty-port`, which agent-bridge used to claim alongside
  // `harness-adapters` — feature ownership is exclusive, so the tag moves rather
  // than being duplicated. HARNESS-AGNOSTIC by construction: HARNESS_ADAPTER_HOME
  // is now packages/harness (POD-397), so the axiom APPLIES here and a harness
  // comparison appearing in pty is a violation — exactly the seam POD-325 wants.
  'packages/pty': {
    layer: 2,
    platform: 'node-only',
    features: ['pty-port', 'durable-host'],
    deps: ['packages/protocol', 'packages/model', 'packages/runtime'],
    // HOST CAPABILITY (legacy rule 2). Importing this package means spawning
    // PTYs. The machine host and the build tier may; nothing else may, and there
    // is no open entrypoint because every export here drives a process.
    consumers: ['apps/daemon', 'scripts'],
  },
  // The home for coding-agent CLI variance: one AgentManifest per CLI
  // (launch/exec/headless/state/discovery/transcript), the native-state
  // providers, conversation discovery and machine inventory. L2 like the rest of
  // the kernel/port family (ADR 8 D4 end-state `packages/harness`). node-only:
  // child_process probes, fs transcript reads, SQLite via @podium/runtime.
  // PRINCIPAL-FREE by construction — it must never import a user/principal/
  // capability type; authorization belongs at the server projection boundary
  // (POD-1079), enforced here by the manifest-principal-free rule in
  // scripts/check-boundaries.ts.
  'packages/harness': {
    layer: 2,
    platform: 'node-only',
    features: ['harness-adapters'],
    deps: ['packages/protocol', 'packages/model', 'packages/runtime', 'packages/transcript'],
    // HOST CAPABILITY (legacy rule 2), with a declared open surface.
    consumers: ['apps/daemon', 'scripts'],
    openEntrypoints: ['@podium/harness/metadata'],
  },
  'packages/terminal-client': {
    layer: 2,
    platform: 'browser-safe',
    features: ['terminal-port'],
  },
  // The harness composer port: pure prompt-draft extraction + keystroke
  // injection, imported only from @podium/protocol. BROWSER-SAFE by
  // construction and by consumer — apps/web aliases it in vite.config.ts, and
  // packages/terminal-client re-exports the extractors into the browser
  // bundle; tagging it node-only would falsely accuse both. Same L2 family as
  // agent-bridge/terminal-client (ADR 8 D4 end-state `packages/harness` /
  // `packages/terminal-ui`), not L3: it is a port with no engine of its own.
  'packages/composer': {
    layer: 2,
    platform: 'browser-safe',
    features: ['composer-driver', 'prompt-draft'],
    deps: ['packages/protocol', 'packages/model'],
  },

  // L3 — features / adapters / engine.
  'packages/client-core': { layer: 3, platform: 'browser-safe', features: ['viewmodels'] },
  'packages/terminal-client-react': {
    layer: 3,
    platform: 'browser-safe',
    features: ['terminal-react'],
  },

  // L4 — app composition roots.
  'apps/cli': { layer: 4, platform: 'node-only', features: ['cli-surface'] },
  'apps/daemon': { layer: 4, platform: 'node-only', features: ['daemon-surface'] },
  'apps/desktop': { layer: 4, platform: 'browser-safe', features: ['desktop-shell'] },
  // Maintenance/steward jobs (change-log + event prune, auto-archive, message
  // expiry, connect scan) lifted out of apps/server into their own composition
  // root. node-only: node:crypto/node:path plus @podium/runtime's sqlite and
  // config subpaths. NOT roleTiered — role tiers are file-level and delegated
  // to apps/server/src/roles.ts, which janitor has no counterpart to.
  'apps/janitor': { layer: 4, platform: 'node-only', features: ['maintenance-jobs'] },
  'apps/mobile': { layer: 4, platform: 'browser-safe', features: ['mobile-surface'] },
  'apps/server': {
    layer: 4,
    platform: 'node-only',
    features: ['server-surface'],
    roleTiered: true,
  },
  'apps/web': { layer: 4, platform: 'browser-safe', features: ['web-surface'] },

  // L5 — build / compose tier.
  scripts: { layer: 5, platform: 'node-only', features: ['build', 'lint', 'compose'] },
}

/**
 * Explicit same-layer edges. A same-layer dependency is legal ONLY if declared
 * here — the point of the layer axiom is that peers don't get to reach sideways
 * by default. Each entry is a deliberate decision, not a discovered fact.
 */
export const SAME_LAYER_ALLOWED: ReadonlySet<string> = new Set<string>([
  // L1: the issue command table is defined in terms of the wire schema.
  'packages/issue-client -> packages/protocol',
  // L1: contracts are defined in terms of the wire schema (input caps, brands).
  'packages/commands -> packages/protocol',
  // L2: sync, telemetry and agent-bridge are ports built on runtime's
  // config/sqlite plumbing.
  'packages/sync -> packages/runtime',
  'packages/telemetry -> packages/runtime',
  // L2: pty resolves the abduco binary cache under runtime's stateDir() rather
  // than re-deriving the state directory (the `state-dir-defs` audit item is at 0
  // and must stay there).
  'packages/pty -> packages/runtime',
  // L2: agent-bridge parses transcripts through the shared parser rather than
  // carrying a second copy.
  // L2: harness reads config/stateDir/sqlite from runtime and parses transcripts
  // through the shared parser — the same two edges agent-bridge had, inherited by
  // the half that actually uses them (POD-397).
  'packages/harness -> packages/runtime',
  'packages/harness -> packages/transcript',
  // L3: the React adapter binds hooks to client-core's transport port; it owns no
  // socket protocol state of its own.
  'packages/terminal-client-react -> packages/client-core',
  // L2: terminal-client's DOM readiness check uses the shared,
  // pure composer extractor rather than carrying a second copy.
  'packages/terminal-client -> packages/composer',
])

/**
 * THE BROWSER SURFACE of every NEUTRAL workspace (POD-335) — specifier → the
 * source module it names.
 *
 * `neutral` means "one bit cannot say both": the workspace has a browser-safe
 * half and a node-only half behind explicit subpaths. That makes it
 * unconstrained by the platform rule, which on its own is a hole — a
 * browser-safe app could import the bare barrel and inline Node. This map is the
 * half that closes it, and it is where legacy rule 8 (runtime browser-safety)
 * comes to rest: rule 8a said "apps/web may import only the bare @podium/runtime
 * specifier, never a subpath", which is exactly one row here, generalised from
 * one app to every browser-safe workspace because ADR 6 puts a client adapter on
 * mobile too.
 *
 * Adding a row is a DECISION that the module's whole import closure is
 * browser-safe, and the closure check in scripts/check-boundaries.ts holds you to
 * it — including reporting an entry that does not exist or cannot be walked,
 * since a truncated closure is green for the wrong reason. That closure check is
 * also strictly stronger than the rule 8b it replaces: 8b stopped at one hop and
 * said so, so a barrel re-exporting a file that re-exports a node-tainted file
 * slipped through.
 */
export const BROWSER_ENTRYPOINTS: ReadonlyMap<string, string> = new Map([
  // packages/runtime — the root barrel only. Every node-only concern (config,
  // sqlite, git, connectivity, auth-store) lives behind its own subpath, which
  // is what makes "the bare specifier is the whole browser surface" true.
  ['@podium/runtime', 'packages/runtime/src/index.ts'],
  // packages/telemetry — the pure display example apps/web renders in its
  // privacy and setup copy. The bare specifier pulls the emitter and node:fs.
  ['@podium/telemetry/example', 'packages/telemetry/src/example.ts'],
  // packages/sync — the Replica and Outbox ROLES and the storage adapters built
  // for a browser and a phone (POD-307).
  ['@podium/sync/replica', 'packages/sync/src/replica/index.ts'],
  ['@podium/sync/outbox', 'packages/sync/src/outbox/index.ts'],
  ['@podium/sync/span', 'packages/sync/src/span.ts'],
  ['@podium/sync/adapters/indexeddb', 'packages/sync/src/adapters/indexeddb/index.ts'],
  ['@podium/sync/adapters/mobile-sqlite', 'packages/sync/src/adapters/mobile-sqlite/index.ts'],
  ['@podium/sync/adapters/legacy-replica', 'packages/sync/src/adapters/legacy-replica/index.ts'],
])

/** The declared browser specifiers of one workspace, for a failure message that
 *  names the alternatives instead of only the refusal. */
export function browserEntrypointsOf(workspace: string): string[] {
  const prefix = `@podium/${workspace.slice(workspace.indexOf('/') + 1)}`
  return [...BROWSER_ENTRYPOINTS.keys()]
    .filter((s) => s === prefix || s.startsWith(`${prefix}/`))
    .sort()
}

export function tagsFor(workspace: string): WorkspaceTags | null {
  return MANIFEST[workspace] ?? null
}

/** Features claimed by more than one workspace — a manifest bug. */
export function duplicateFeatureOwners(
  manifest: Readonly<Record<string, WorkspaceTags>> = MANIFEST,
): string[] {
  const owners = new Map<string, string[]>()
  for (const [workspace, tags] of Object.entries(manifest)) {
    for (const feature of tags.features) {
      owners.set(feature, [...(owners.get(feature) ?? []), workspace])
    }
  }
  return [...owners.entries()].filter(([, ws]) => ws.length > 1).map(([feature]) => feature)
}

// ---------------------------------------------------------------------------
// Matrix rules
// ---------------------------------------------------------------------------

const LAYER_NAMES: Record<Layer, string> = {
  0: 'L0 model',
  1: 'L1 wire/commands',
  2: 'L2 kernels/ports',
  3: 'L3 features/adapters',
  4: 'L4 app composition',
  5: 'L5 build/compose',
}

/**
 * Layer axiom + platform rule for ONE cross-workspace edge. `from`/`to` are
 * workspace ids the caller already resolved; same-workspace edges never reach
 * here.
 *
 * Type-only imports are exempt from BOTH: they are erased at build, so they
 * create no runtime dependency and cannot drag Node code into a browser bundle.
 *
 * Test files are exempt from the SAME-LAYER and PLATFORM rules but NOT from the
 * upward one — mirroring the split the legacy rules already make deliberately:
 *  - rule 1 (app→app, a same-layer edge) exempts tests, because an e2e test
 *    legitimately composes peer apps and is never shipped;
 *  - rule 4 (packages→apps, an UPWARD edge) exempts nothing.
 * The reasons differ: "never shipped" answers whether an edge reaches a bundle
 * (same-layer, platform), but an upward edge from a package's own tests means
 * the package can no longer be built or tested without a higher layer — an
 * architectural fact that shipping has no say over.
 */
export function checkManifestEdge(
  file: string,
  from: string,
  to: string,
  ref: ImportRef,
): Violation[] {
  if (ref.typeOnly) return []
  const fromTags = tagsFor(from)
  const toTags = tagsFor(to)
  if (!fromTags || !toTags) return []

  const violations: Violation[] = []
  const edge = `${from} -> ${to}`
  const testFile = isTestFile(file)

  // Layer axiom: down is free, sideways must be declared, up is never allowed.
  if (toTags.layer > fromTags.layer) {
    violations.push({
      file,
      specifier: ref.specifier,
      rule: 'manifest-layer',
      message: `${file}: ${from} (${LAYER_NAMES[fromTags.layer]}) imports UP into ${to} (${LAYER_NAMES[toTags.layer]}) via '${ref.specifier}' — imports must point down the layer order`,
    })
  } else if (toTags.layer === fromTags.layer && !SAME_LAYER_ALLOWED.has(edge) && !testFile) {
    violations.push({
      file,
      specifier: ref.specifier,
      rule: 'manifest-layer',
      message: `${file}: undeclared same-layer import '${edge}' (both ${LAYER_NAMES[fromTags.layer]}) via '${ref.specifier}' — add it to SAME_LAYER_ALLOWED in scripts/architecture-manifest.ts if it is deliberate`,
    })
  }

  // Closed dependency set: where a workspace declares one, DOWN is not enough.
  // Tests are NOT exempt — a near-leaf whose tests need a package it may not
  // import is a near-leaf that can no longer be built or tested without it,
  // which is the same architectural fact the upward rule refuses.
  if (fromTags.deps && !fromTags.deps.includes(to)) {
    violations.push({
      file,
      specifier: ref.specifier,
      rule: 'manifest-deps',
      message: `${file}: ${from} declares a CLOSED dependency set and '${to}' is not in it (allowed: ${fromTags.deps.length > 0 ? [...fromTags.deps].sort().join(', ') : 'none — this is a leaf'}) — imported via '${ref.specifier}'. Widening the set is a decision: edit the workspace's \`deps\` in scripts/architecture-manifest.ts.`,
    })
  }

  // Capability consumers: a property of the TARGET, so no ordinal can say it.
  // The open entrypoints are checked by the caller against the SPECIFIER, since
  // the whole point is that one subpath of the package is reachable and the
  // barrel is not.
  if (toTags.consumers && !toTags.consumers.includes(from) && from !== to) {
    const open = toTags.openEntrypoints ?? []
    if (!open.includes(ref.specifier) && !testFile) {
      violations.push({
        file,
        specifier: ref.specifier,
        rule: 'manifest-consumers',
        message: `${file}: ${to} restricts its consumers to ${[...toTags.consumers].sort().join(', ')} — importing it means taking a host capability (spawning agent processes / PTYs), which ${from} is not entitled to. ${open.length > 0 ? `Its declared open surface is: ${[...open].sort().join(', ')}.` : 'It declares no open entrypoint: every export drives a process.'}`,
      })
    }
  }

  // Platform: a browser-safe workspace may only reach browser-safe or neutral.
  if (fromTags.platform === 'browser-safe' && toTags.platform === 'node-only' && !testFile) {
    violations.push({
      file,
      specifier: ref.specifier,
      rule: 'manifest-platform',
      message: `${file}: browser-safe ${from} imports node-only ${to} via '${ref.specifier}' — a browser bundle would inline Node code`,
    })
  }

  return violations
}

/**
 * Role tiers as a MATRIX rule: within a role-tiered workspace, a file may only
 * import files of its own role rank or below. The rank table and the
 * composition-root exemptions come from apps/server/src/roles.ts — the one
 * manifest — rather than being restated here.
 *
 * `cloud` is unreachable for everyone (the private module composes via the
 * plugins.ts seam), exemptions included.
 */
export function checkManifestRole(file: string, ref: ImportRef): Violation | null {
  const workspace = workspaceOf(file)
  if (!tagsFor(workspace)?.roleTiered) return null
  const srcPrefix = `${workspace}/src/`
  if (!file.startsWith(srcPrefix) || !ref.specifier.startsWith('.')) return null

  const fromRel = file.slice(srcPrefix.length)
  const abs = resolve('/', dirname(file), ref.specifier)
  const toPath = relative('/', abs).split(sep).join('/')
  if (!toPath.startsWith(srcPrefix)) return null
  const toRel = toPath.slice(srcPrefix.length)

  const fromRole = serverRoleOf(fromRel)
  const toRole = serverRoleOf(toRel)
  if (toRole === 'cloud' && fromRole !== 'cloud') {
    return {
      file,
      specifier: ref.specifier,
      rule: 'manifest-role',
      message: `${file}: nothing in the OSS tree may import cloud code ('${ref.specifier}') — the cloud module composes via the plugins.ts seam only`,
    }
  }
  if (ROLE_RANK[toRole] <= ROLE_RANK[fromRole]) return null
  if (isCompositionRoot(fromRel) || isTestFile(file)) return null
  return {
    file,
    specifier: ref.specifier,
    rule: 'manifest-role',
    message: `${file}: role tier ${fromRole} must not import ${toRole} code ('${ref.specifier}') — see ${workspace}/src/roles.ts`,
  }
}

// ---------------------------------------------------------------------------
// Harness axiom
// ---------------------------------------------------------------------------

const HARNESS_ENUM_SOURCE = 'packages/model/src/entities/agent.ts'

/**
 * The workspace that OWNS harness behavioral branching. POD-397 moved the
 * manifests out of packages/harness into packages/harness, so this is the
 * home; agent-bridge (soon packages/pty) is now subject to the axiom like anyone
 * else, which is the point — the PTY layer must not know which CLI it is driving.
 *
 * Error level: violations bypass the allowlist and fail immediately.
 */
export const HARNESS_ADAPTER_HOME = 'packages/harness'

/**
 * The canonical harness identifiers, read LIVE from the model enum so this
 * lint can never drift from the actual union. Returns [] when the enum can't be
 * read or parsed — which would silently disable the rule, so
 * architecture-manifest.test.ts asserts against the REAL repo that it returns
 * the full set. That test, not this function, is the drift guard.
 */
export function loadHarnessLiterals(repoRoot: string): string[] {
  let source: string
  try {
    source = readFileSync(join(repoRoot, HARNESS_ENUM_SOURCE), 'utf8')
  } catch {
    return []
  }
  const enumBody = stripComments(source).match(
    /export const HarnessAgent\s*=\s*z\.enum\(\s*\[([^\]]*)\]/,
  )
  if (!enumBody) return []
  return [...(enumBody[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((literal): literal is string => literal !== undefined)
}

/**
 * An expression only counts as harness identity if it NAMES one. Without this,
 * `'cursor'` alone is hopeless: the repo compares CSS cursors and pagination
 * cursors too. Deliberately narrow — a miss is a warn-mode gap, a false positive
 * would pollute the allowlist with noise nobody can act on.
 *
 * `provider` is deliberately NOT here. `ApiProvider` (settings.ts) is a separate
 * enum — `['openrouter','anthropic','openai','codex']` — that happens to share
 * the literal 'codex' with HarnessAgent, and resolving exactly that kind of
 * same-literal collision is what this guard is FOR. Including it would flag
 * `backend.provider === 'codex'` (an ApiProvider) while still missing
 * `switch (p) { case 'codex': }` in providerLabel — the same type, one variable
 * named `provider` and one named `p`. Coverage that depends on a variable's name
 * for a type it doesn't hold is arbitrary, so the rule tracks HarnessAgent
 * identity only. Codex-the-provider's variance is real but is POD-292's broader
 * "confine agent-CLI variance to the harness layer", not this axiom.
 */
const HARNESS_CONTEXT_RE = /harness|agent|kind/i

/**
 * The discriminant of the switch that ENCLOSES the `case` at `index`, or null.
 *
 * Brace-matched rather than "search backwards for the nearest `switch`", which
 * is wrong three ways: an inner `switch (mode)` swallows the outer switch's
 * later cases — and the inverse is worse than a miss, since the outer switch's
 * message would confidently name a discriminant that isn't the real one; any
 * lowercase substring (`switchToTab(1)` in a case body) shadows the keyword and
 * silences every case after it; and a discriminant containing parens
 * (`switch (getSession().agentKind)`) truncates at the first `)`.
 *
 * So: walk back to the `{` opening this case's own block, require a balanced
 * `( … )` immediately before it, and require the `switch` keyword before that.
 */
function enclosingSwitchDiscriminant(src: string, index: number): string | null {
  // 1. The `{` opening the block that holds `index`, skipping nested blocks.
  let depth = 0
  let i = index - 1
  for (; i >= 0; i--) {
    const c = src[i]
    if (c === '}') depth++
    else if (c === '{') {
      if (depth === 0) break
      depth--
    }
  }
  if (i < 0) return null

  // 2. A switch head ends in `)` — any other block shape disqualifies.
  let close = i - 1
  while (close >= 0 && /\s/.test(src[close] ?? '')) close--
  if (src[close] !== ')') return null

  // 3. Back to its matching `(`, so the discriminant may contain parens itself.
  let parens = 0
  let open = close
  for (; open >= 0; open--) {
    const c = src[open]
    if (c === ')') parens++
    else if (c === '(') {
      parens--
      if (parens === 0) break
    }
  }
  if (open < 0) return null

  // 4. The keyword must be `switch` on a word boundary — not switchToTab/doSwitch.
  if (!/\bswitch\s*$/.test(src.slice(0, open))) return null
  return src.slice(open + 1, close)
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

/**
 * Harness axiom — flag BEHAVIORAL BRANCHING on a harness literal outside the
 * adapter home.
 *
 * Flagged: `x.agentKind === 'codex'`, `'codex' !== h.harness`, and
 * `case 'codex':` under a `switch (agentKind)`.
 *
 * NOT flagged (by design, per the corrected axiom): a harness identifier being
 * passed, stored, serialized, or typed. Only comparisons branch. A Record keyed
 * by harness (`KIND_ICON[kind]`) is a lookup, not a comparison — which is how
 * the axiom's blessed "icon maps" stay legal without needing an allowlist entry.
 *
 * KNOWN LIMITATION — this is text matching, not an AST walk. Comments are
 * blanked first, but STRING LITERALS cannot be (extractImports needs them, and
 * the compared literal is itself a string), so prose that spells out a
 * comparison inside a quoted string reads as real code. Observed for real: an
 * earlier draft of scripts/boundary-allowlist.ts described a violation verbatim
 * in a note and this rule flagged the note. Rare, always visible (it fails
 * loudly rather than passing silently), and the fix is to reword the prose.
 */
export function findHarnessBranching(
  file: string,
  source: string,
  literals: readonly string[],
): Violation[] {
  if (literals.length === 0) return []
  const workspace = workspaceOf(file)
  if (workspace === HARNESS_ADAPTER_HOME || isTestFile(file)) return []

  const stripped = stripComments(source)
  const alternation = literals.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const violations: Violation[] = []

  // `expr === 'lit'` / `expr !== 'lit'` (and the mirrored `'lit' === expr`).
  const cmp = new RegExp(
    `([\\w$.?\\[\\]'"]+)\\s*(?:===|!==|==|!=)\\s*['"](${alternation})['"]` +
      `|['"](${alternation})['"]\\s*(?:===|!==|==|!=)\\s*([\\w$.?\\[\\]]+)`,
    'g',
  )
  for (const m of stripped.matchAll(cmp)) {
    const expr = m[1] ?? m[4]
    const literal = m[2] ?? m[3]
    if (!expr || !literal || !HARNESS_CONTEXT_RE.test(expr)) continue
    violations.push({
      file,
      specifier: literal,
      rule: 'harness-branching',
      message: `${file}:${lineOf(stripped, m.index)}: branches on harness identity ('${expr}' vs '${literal}') outside ${HARNESS_ADAPTER_HOME} — behavior keyed on a harness belongs in its adapter; the identifier itself may flow anywhere`,
    })
  }

  // `case 'lit':` under a harness-ish switch discriminant.
  const caseRe = new RegExp(`\\bcase\\s+['"](${alternation})['"]\\s*:`, 'g')
  for (const m of stripped.matchAll(caseRe)) {
    const literal = m[1]
    const disc = enclosingSwitchDiscriminant(stripped, m.index)
    if (!literal || !disc || !HARNESS_CONTEXT_RE.test(disc)) continue
    violations.push({
      file,
      specifier: literal,
      rule: 'harness-branching',
      message: `${file}:${lineOf(stripped, m.index)}: switches on harness identity (switch (${disc.trim()}) case '${literal}') outside ${HARNESS_ADAPTER_HOME} — behavior keyed on a harness belongs in its adapter; the identifier itself may flow anywhere`,
    })
  }

  return violations
}

// ---------------------------------------------------------------------------
// Feature ownership — identity / authorization / visibility single-home
// ---------------------------------------------------------------------------

/**
 * THE DECLARED HOMES of identity, authorization and visibility resolution
 * (POD-335; docs/multi-user-readiness.md §3.1.1, §3.1.4 M6, §3.2).
 *
 * PINNED TO WHAT SHIPPED, not invented here. §3.2 is explicit that the closed
 * `IssueScope` set is to be EXTENDED with owner/grant scopes *"rather than
 * inventing a parallel check"*, and §3.1.4 M6 says machine access is expressed
 * as grants on the same principal model *"rather than as a separate fleet ACL"*.
 * These four paths are where POD-1073 / POD-1075 / POD-1077 put that machinery:
 *
 *   packages/model/src/authz/        capability, role, the closed IssueScope set
 *                                    and the ONE `authorize` decision
 *   packages/model/src/identity/     user, grant edge, delegation, client session
 *   packages/model/src/annotations/  ADR 1's ownership matrix and the visibility
 *                                    classes `visibilityClassOf` resolves over
 *   packages/sync/src/feed/          the authority-side per-principal evaluation
 *                                    (POD-1077) that reads all three
 *
 * Everything else CONSULTS them. A server module, a client viewmodel or a
 * machines module that re-derives the answer is a second authorization surface,
 * and — this is the part a review cannot catch — it is a second surface that
 * PASSES ITS OWN TESTS while disagreeing with the first one.
 */
export const AUTHZ_HOMES: readonly string[] = [
  'packages/model/src/authz/',
  'packages/model/src/identity/',
  'packages/model/src/annotations/',
  'packages/sync/src/feed/',
]

/**
 * The classes the TABLE detector counts — ADR 9 D3's set minus `secret`.
 *
 * `'secret'` is excluded and the exclusion is measured, not cautious: the
 * literal is also a resource kind (`resource: 'secret'` in the instance command
 * contracts) and a discriminant (`kind: 'secret'` in the settings write plan),
 * and counting it made this rule report three `packages/commands` files that
 * hold no classification at all. A table that really is a second classification
 * carries the other four alongside it, so nothing is lost — the memory module
 * this rule was written against matches six times without it.
 */
const UNAMBIGUOUS_VISIBILITY_CLASSES = [
  'personal',
  'per-user-state',
  'owned-compute',
  'deployment-substrate',
]

/** The full class set, as ADR 1's matrix spells them. */
const VISIBILITY_CLASS_LITERALS = [
  'personal',
  'per-user-state',
  'owned-compute',
  'deployment-substrate',
  'secret',
]

/**
 * Names that DECIDE a visibility or grant question. Matched at DECLARATION sites
 * only — a top-level `function`/`const`, or a class method — never at call sites
 * and never on an interface member or an object property.
 *
 * That distinction is the whole difference between a rule and a noise generator.
 * The repo is full of PORTS that name these verbs (`canSee(principal, entity)`
 * on `packages/protocol`'s plane contract, `hasGrant` on the workflows ownership
 * port) and of composition roots that INJECT an implementation (`relay.ts`
 * passes `mayRead:`/`canSee:` closures into the kernel). Declaring the port is
 * how the decision gets asked for; supplying it at the composition root is how
 * the one implementation gets wired. Neither is a parallel check. Writing the
 * decision yourself, in a module that consults none of the homes, is.
 */
const AUTHZ_DECISION_NAMES = [
  'canSee',
  'maySee',
  'mayView',
  'mayRead',
  'mayReadSession',
  'isVisibleTo',
  'visibleTo',
  'evaluateVisibility',
  'resolveVisibility',
  'filterVisible',
  'hasGrant',
  'hasReadGrant',
  'grantsFor',
  'checkAccess',
  'visibilityClassOf',
  'grantVerbsOf',
]

const AUTHZ_DECL_RE = new RegExp(
  // A DEFINITION site: `export function foo(`, `function foo(`, `const foo = (`,
  // or a class method `private foo(` / `foo(`. The trailing shape is checked by
  // {@link hasBody}, which is what separates a definition from a PORT.
  `^[ \\t]*(?:export\\s+)?(?:async\\s+)?(?:function\\s+|const\\s+|private\\s+|public\\s+|protected\\s+|static\\s+)?(${AUTHZ_DECISION_NAMES.join('|')})\\s*(?:=\\s*(?:async\\s*)?)?\\(`,
  // LINE-ANCHORED, which is what keeps a CALL SITE out of a rule about
  // DECLARATIONS: `deps.ceiling.canSee({ kind: 'session', id })` matched an
  // unanchored pattern and then satisfied the body scan on the `{` of the
  // ternary that followed it. Asking the one authority is the behaviour this
  // rule exists to encourage; flagging it would invert the whole guardrail.
  'gm',
)

/**
 * True when the `(` at `open` begins a function DEFINITION rather than a port
 * DECLARATION — i.e. a body follows the parameter list and its optional return
 * type annotation.
 *
 * This is the discriminator the whole rule rests on, so it is a scan and not a
 * regex. `packages/protocol`'s plane contract declares `canSee(principal,
 * entity): boolean` and `packages/commands`' workflows port declares
 * `hasGrant(user, entity, verb): boolean`; both are how the ONE implementation
 * gets ASKED for, and flagging them would make the rule fire hardest on the code
 * that is doing the right thing.
 */
function hasBody(src: string, open: number): boolean {
  let depth = 0
  let i = open
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) break
    }
  }
  if (i >= src.length) return false
  // Past the parameter list: skip an optional `: ReturnType` and any whitespace.
  // A `{` reached before a statement terminator means a body follows.
  for (let j = i + 1; j < src.length && j < i + 400; j++) {
    const c = src[j] as string
    if (c === '{') return true
    if (c === ';' || c === ',' || c === ')' || c === '}' || c === '=') return false
    if (c === '\n') {
      // A blank line, or a line that starts a new member, ends the candidate.
      if (src[j + 1] === '\n') return false
    }
  }
  return false
}

/**
 * A SECOND CLASSIFICATION TABLE: two or more entries whose VALUE is a visibility
 * class under a key the file invented.
 *
 * The `visibility:` key is deliberately excluded, and that exclusion is the rule
 * rather than a hole in it. Declaring `visibility: 'owned-compute'` on a command
 * contract or a canonical aggregate is exactly what §3.1.1 rule 2 ASKS for — a
 * class declared against ADR 1's matrix, checked against it by
 * `classificationViolations`. What must not exist is a lookup table that ANSWERS
 * the classification question a second time, like a
 * `{ session: 'personal', issue: 'personal', setting: 'deployment-substrate' }`
 * keyed by a locally-invented document-class enum: nothing checks it against the
 * matrix, and on the day the two disagree the caller's reach decides which one
 * is true.
 */
/**
 * Keys whose value is a DECLARATION against the matrix, or a homonym, rather
 * than a classification the file is making up.
 *
 * `visibility:` is §3.1.1 rule 2 being obeyed. `resource:`/`scope:`/`kind:` are
 * ADR 3 D2's policy vocabulary, which shares the literal `per-user-state` with
 * ADR 9 D3's class set — measured on
 * `packages/commands/src/sessions/session-state-commands.ts`, five contracts
 * declaring `resource: 'per-user-state'` and holding no class table at all.
 */
const DECLARATION_KEYS: ReadonlySet<string> = new Set([
  'visibility',
  'resource',
  'scope',
  'kind',
])

const VISIBILITY_VALUE_RE = new RegExp(
  `(?:^|[{,\\s])['"]?([A-Za-z_$][\\w$-]*)['"]?\\s*:\\s*'(?:${UNAMBIGUOUS_VISIBILITY_CLASSES.join('|')})'`,
  'gm',
)

function secondClassificationTable(stripped: string): boolean {
  let count = 0
  for (const m of stripped.matchAll(VISIBILITY_VALUE_RE)) {
    if (DECLARATION_KEYS.has(m[1] ?? '')) continue
    count++
    if (count >= 2) return true
  }
  return false
}

/** True when the file consults a declared home — the discriminator between a
 *  module that ASKS the one authority and one that answers for itself. */
function importsAnAuthzHome(source: string): boolean {
  // The IMPORT CLAUSE, not the package name. `import { asIssueId } from
  // '@podium/model'` is not consulting the authorization home — it is asking for
  // an id brand — and treating it as if it were is how this rule would have
  // passed the very module it was written to catch
  // (apps/server/src/modules/memory/visibility.ts, measured).
  for (const m of source.matchAll(
    /\b(?:import|export)\s+(?:type\s+)?(\{[^}]*\}|[A-Za-z_$][\w$]*)\s+from\s*['"][^'"]+['"]/g,
  )) {
    if (AUTHZ_HOME_VOCABULARY_RE.test(m[1] ?? '')) return true
  }
  return false
}

/**
 * The symbols a module imports when it CONSULTS the one authority rather than
 * answering for itself: the decision, the capability vocabulary it is asked in,
 * the grant edge, and the matrix resolver.
 */
const AUTHZ_HOME_VOCABULARY_RE =
  /\b(?:authorize|Capability|IssueScope|IssueAction|IssueRole|AuthTarget|AuthDecision|IssueAccessIndex|OPERATOR|visibilityClassOf|VisibilityClass|grantVerbsOf|GrantEdge|GrantVerb|evaluateVisibility|checkIssueAccess|mayReadOwned)\b/

/**
 * Rule `authz-single-home` — identity, authorization and visibility resolution
 * live in their declared home (POD-335). A guardrail with NO legacy predecessor:
 * it arrives with multi-user, not with the rewrite.
 *
 * TWO ARMS, because the two ways to build a parallel check look nothing alike:
 *
 *  (a) A SECOND CLASSIFICATION TABLE. A literal map to `VisibilityClass` members
 *      outside `annotations/`. ADR 1's matrix is the normative column set and
 *      `visibilityClassOf` is the total, default-closed resolver over it; a
 *      hand-written table beside it is a fact that can silently disagree, and it
 *      fails OPEN when the two drift because whichever module the caller reached
 *      is the one that answered.
 *
 *  (b) A DECISION DECLARED WITHOUT CONSULTING A HOME. A module outside the homes
 *      that declares one of the decision verbs and imports no home is answering
 *      "may this principal see X" on its own authority. The import test is what
 *      keeps this from flagging every delegator: `apps/server/src/issue-authz.ts`
 *      declares `checkIssueAccess` and passes, because it imports `authorize`
 *      from the model and only shapes the throw.
 */
export function checkAuthzSingleHome(file: string, source: string): Violation[] {
  if (isTestFile(file)) return []
  if (AUTHZ_HOMES.some((home) => file.startsWith(home))) return []
  if (!file.startsWith('apps/') && !file.startsWith('packages/')) return []
  const stripped = stripComments(source)
  const violations: Violation[] = []

  if (secondClassificationTable(stripped)) {
    violations.push({
      file,
      specifier: 'VisibilityClass table',
      rule: 'authz-single-home',
      message: `${file}: declares a SECOND visibility-class table. ADR 1's ownership matrix (packages/model/src/annotations/matrix.ts) is the one normative classification and \`visibilityClassOf\` is its total, default-closed resolver — derive the class from the matrix row instead of restating it, so the two cannot drift (docs/multi-user-readiness.md §3.1.1 rule 2).`,
    })
  }

  if (!importsAnAuthzHome(stripped)) {
    AUTHZ_DECL_RE.lastIndex = 0
    for (const m of stripped.matchAll(AUTHZ_DECL_RE)) {
      const open = stripped.indexOf('(', m.index + (m[0]?.length ?? 1) - 1)
      if (open < 0 || !hasBody(stripped, open)) continue
      violations.push({
        file,
        specifier: m[1] ?? 'authz decision',
        rule: 'authz-single-home',
        message: `${file}:${lineOf(stripped, m.index)}: declares '${m[1]}', a visibility/grant DECISION, in a module that consults none of the declared homes (${AUTHZ_HOMES.join(', ')}). Identity, authorization and visibility have exactly one home: extend the closed IssueScope set and call \`authorize\` rather than inventing a parallel check (docs/multi-user-readiness.md §3.2; §3.1.4 M6 for machine grants). Declaring a PORT with this name, or injecting an implementation at a composition root, is fine — this fires only on a declaration that answers the question itself.`,
      })
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Allowlist / ratchet
// ---------------------------------------------------------------------------

/**
 * Every rule id the MANIFEST can emit. Anything else in the allowlist belongs to
 * a legacy rule in check-boundaries.ts.
 *
 * The two families share one allowlist but must be applied SEPARATELY, each
 * against its own violations: applyAllowlist reports any entry with no matching
 * violation as stale, so handing the manifest pass a legacy entry (or vice
 * versa) makes each family declare the other's entries dead and fails the build.
 */
export const MANIFEST_RULES: ReadonlySet<string> = new Set([
  'manifest-layer',
  'manifest-platform',
  'manifest-role',
  'manifest-untagged',
  // POD-335 — the tags that retired the legacy eight. `manifest-deps` and
  // `manifest-consumers` are the dependency matrix's closed sets (legacy rules
  // 1/3/3b/4/5 and 2); `manifest-open-entrypoint` and `manifest-browser-reach`
  // hold the two declared surfaces honest (legacy rules 2 and 8);
  // `feature-single-home` and `authz-single-home` are the feature-ownership arm
  // (legacy rule 7, and the multi-user guardrail that has no predecessor).
  'manifest-deps',
  'manifest-consumers',
  'manifest-open-entrypoint',
  'manifest-browser-reach',
  'feature-single-home',
  'authz-single-home',
  'harness-branching',
  'harness-classifier-boundary',
  // Rule 12 (POD-307). A MANIFEST rule, not a legacy one, because it is the
  // guard that replaces what `packages/sync`'s node-only tag used to provide:
  // it has to run in `lint:architecture`, the BLOCKING step, or the retag would
  // be protected only by a check CI is allowed to sail past.
  'sync-browser-reach',
])

/**
 * Rules enforced at error level: allowlist entries cannot downgrade them.
 *
 * POD-335 made this EVERY manifest rule. The set is kept — rather than deleted
 * along with the allowlist — because it is what makes "empty" a property the
 * build defends instead of a state of a file: `applyManifestPolicy` reports an
 * allowlist entry naming an error-level rule as a FORBIDDEN entry, so the way
 * back to a ratchet is a build failure, not an edit nobody notices.
 */
export const ERROR_LEVEL_MANIFEST_RULES: ReadonlySet<string> = new Set(MANIFEST_RULES)

/** Split one allowlist into [manifest entries, legacy entries]. */
export function partitionAllowlist(
  allowlist: readonly AllowlistEntry[],
): [manifest: AllowlistEntry[], legacy: AllowlistEntry[]] {
  return [
    allowlist.filter((e) => MANIFEST_RULES.has(e.rule)),
    allowlist.filter((e) => !MANIFEST_RULES.has(e.rule)),
  ]
}

export interface AllowlistEntry {
  /** Manifest rule id, e.g. 'manifest-layer'. */
  rule: string
  /** Repo-relative file the violations live in. */
  file: string
  /** How many violations of `rule` this file is allowed to have. New ones fail. */
  count: number
  /** The phase/issue that removes this entry. 'permanent-exception' never does. */
  phase: string
  note: string
}

export interface AllowlistResult {
  warnings: Violation[]
  errors: Violation[]
  stale: string[]
}

/** Apply manifest policy while keeping error-level rules outside the ratchet. */
export function applyManifestPolicy(
  violations: readonly Violation[],
  allowlist: readonly AllowlistEntry[],
): AllowlistResult {
  const errorViolations = violations.filter((v) => ERROR_LEVEL_MANIFEST_RULES.has(v.rule))
  const ratchetedViolations = violations.filter((v) => !ERROR_LEVEL_MANIFEST_RULES.has(v.rule))
  const forbiddenEntries = allowlist.filter((entry) => ERROR_LEVEL_MANIFEST_RULES.has(entry.rule))
  const ratchetedEntries = allowlist.filter((entry) => !ERROR_LEVEL_MANIFEST_RULES.has(entry.rule))
  const result = applyAllowlist(ratchetedViolations, ratchetedEntries)
  return {
    warnings: result.warnings,
    errors: [...errorViolations, ...result.errors],
    stale: [
      ...forbiddenEntries.map(
        (entry) =>
          `allowlist entry [${entry.rule}] ${entry.file} is forbidden: this rule is error-level`,
      ),
      ...result.stale,
    ],
  }
}

/**
 * The ratchet. Known violations warn; anything NEW fails; a count that has gone
 * SLACK fails too.
 *
 * Counts are per (rule, file) rather than per file, so a second violation of a
 * DIFFERENT rule in an already-dirty file still fails — and adding a 6th
 * harness branch to a file allowed 5 fails too. That is the whole point: the
 * allowlist freezes the debt at today's size, it doesn't bless the file.
 *
 * Why `stale` is fatal and not a warning: a count of 10 against an actual 6
 * leaves four slots someone can silently refill, and CI stays green the whole
 * way — the ratchet would only ever have held at its loosest historical
 * setting. "The list can only shrink" is only true if NOT shrinking it stops
 * the build. So paying debt down without banking it fails, with the exact
 * number to write. Mildly rude, and the only version that ratchets.
 */
export function applyAllowlist(
  violations: readonly Violation[],
  allowlist: readonly AllowlistEntry[],
): AllowlistResult {
  // The separator is a real NUL, written as an ESCAPE on purpose. NUL cannot
  // occur in a rule id or a path, so the key can never collide - but a literal
  // NUL BYTE in the source makes `file`, grep and friends classify this module
  // as binary, and plain grep then reports NOTHING and exits 1 rather than
  // erroring. This file carried one for 8 commits and silently answered "no
  // match" for code that was sitting right here.
  const key = (rule: string, file: string) => `${rule}\u0000${file}`
  const allowed = new Map(allowlist.map((e) => [key(e.rule, e.file), e]))
  const seen = new Map<string, Violation[]>()
  for (const v of violations) {
    const k = key(v.rule, v.file)
    seen.set(k, [...(seen.get(k) ?? []), v])
  }

  const warnings: Violation[] = []
  const errors: Violation[] = []
  for (const [k, group] of seen) {
    const entry = allowed.get(k)
    if (!entry) {
      errors.push(...group)
      continue
    }
    // Within the declared budget: warn. Over it: the excess fails.
    warnings.push(...group.slice(0, entry.count))
    errors.push(...group.slice(entry.count))
  }

  const stale: string[] = []
  for (const entry of allowlist) {
    const actual = seen.get(key(entry.rule, entry.file))?.length ?? 0
    if (actual === 0) {
      stale.push(
        `allowlist entry [${entry.rule}] ${entry.file} is dead (0 violations) — remove it from scripts/boundary-allowlist.ts`,
      )
    } else if (actual < entry.count) {
      stale.push(
        `allowlist entry [${entry.rule}] ${entry.file} allows ${entry.count} but only ${actual} remain — lower the count to ${actual} to hold the ground you gained`,
      )
    }
  }
  return { warnings, errors, stale }
}
