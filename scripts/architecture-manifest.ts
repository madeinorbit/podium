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
 *      L0 model        (domain)
 *      L1 wire/commands/contracts (protocol, issue-client)
 *      L2 kernels/ports (transcript, runtime, sync, agent-bridge, terminal-client)
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
 *    is legacy rule 7 (domain single-home); POD-335 generalises it over this tag.
 *
 * Plus one non-dependency axiom:
 *
 *  - Harness axiom — BEHAVIORAL BRANCHING on harness identity is confined to
 *    packages/agent-bridge. Identifiers and serialized capability descriptors
 *    may flow ANYWHERE (protocol/UI/settings may carry a HarnessAgent value);
 *    only a COMPARISON or `case` on a harness literal is flagged. The axiom's
 *    blessed exception — icon/label maps — needs no declaration: a Record keyed
 *    by harness is a lookup, not a comparison, so the rule never sees it.
 *
 * Shipped in WARN mode: known violations are declared in
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

/** Workspace a repo-relative file path belongs to: 'apps/x', 'packages/y' or 'scripts'. */
export function workspaceOf(file: string): string {
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
  // L0 — model.
  'packages/domain': {
    layer: 0,
    platform: 'browser-safe',
    features: ['entity-predicates', 'issue-stage', 'issue-authz', 'session-dedup', 'git-identity'],
  },

  // L1 — wire / commands / contracts.
  'packages/protocol': { layer: 1, platform: 'browser-safe', features: ['wire-schema', 'titles'] },
  'packages/issue-client': { layer: 1, platform: 'node-only', features: ['issue-command-table'] },

  // L2 — kernels / ports.
  'packages/transcript': { layer: 2, platform: 'node-only', features: ['transcript-parsing'] },
  'packages/runtime': {
    layer: 2,
    platform: 'neutral',
    features: ['config', 'sqlite', 'git-port', 'connectivity', 'auth-store', 'settings'],
  },
  'packages/sync': { layer: 2, platform: 'node-only', features: ['oplog', 'upstream-sync'] },
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
  },
  'packages/agent-bridge': {
    layer: 2,
    platform: 'node-only',
    features: ['harness-adapters', 'pty-port'],
  },
  'packages/terminal-client': { layer: 2, platform: 'browser-safe', features: ['terminal-port'] },
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
  // L2: sync, telemetry and agent-bridge are ports built on runtime's
  // config/sqlite plumbing.
  'packages/sync -> packages/runtime',
  'packages/telemetry -> packages/runtime',
  'packages/agent-bridge -> packages/runtime',
  // L2: agent-bridge parses transcripts through the shared parser rather than
  // carrying a second copy.
  'packages/agent-bridge -> packages/transcript',
  // L2: terminal-client's prompt-extract is now a re-export of the shared,
  // pure composer rather than a second copy of the extractors.
  'packages/terminal-client -> packages/composer',
])

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

const HARNESS_ENUM_SOURCE = 'packages/protocol/src/messages/harness.ts'

/** The workspace that OWNS harness behavioral branching. */
export const HARNESS_ADAPTER_HOME = 'packages/agent-bridge'

/**
 * The canonical harness identifiers, read LIVE from the protocol enum so this
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
  'harness-branching',
])

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
  /** Allowlisted and within count — reported, does not fail. */
  warnings: Violation[]
  /** New rule/file, or over the declared count — fails the build. */
  errors: Violation[]
  /**
   * Entries whose declared count exceeds reality (lower it) or that are dead.
   * These FAIL the build too — see {@link applyAllowlist}. Kept separate from
   * `errors` because they are a different instruction to the reader: `errors`
   * means "you added debt", `stale` means "you paid debt down, now bank it".
   */
  stale: string[]
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
