/**
 * Server role manifest (docs/offline-sync-architecture.md §4, issue #157).
 *
 * One server codebase, composed by role:
 *
 *  - `core` — everything a single-user node needs: store, registry (relay),
 *    sessions, sync (incl. DIALING an upstream hub), search, web-serving,
 *    transcripts, issues, settings, notify, superagent, login auth.
 *  - `hub`  — only when this server is the rendezvous point for OTHER machines
 *    and nodes: inbound daemon pairing, fleet admin (rename/revoke machines,
 *    join-command minting).
 *  - `cloud` — the private SaaS module (tenancy, billing, managed agents). It
 *    lives in a separate repo and composes in at build time through the
 *    {@link ../plugins PodiumPlugin} seam — the OSS tree never references it.
 *
 * The grouping is encoded by DIRECTORY, not by a per-file table: hub-only code
 * lives physically under `apps/server/src/hub/`; everything else in
 * `apps/server/src` is core. This file declares that mapping (plus the
 * composition roots allowed to bridge roles) so the boundary lint
 * (`scripts/check-boundaries.ts`) and the in-tree walker (`hub/import-boundary.ts`)
 * read ONE manifest instead of hard-coding paths.
 *
 * Rules (lint-enforced, the architecture's "day one rule"):
 *  1. core never imports hub or cloud; hub never imports cloud.
 *  2. Composition roots (below) may import downward across roles — they are the
 *     assembly points that ACTIVATE hub surfaces per the runtime role config.
 *  3. Test files are exempt: a core-located test may construct hub modules to
 *     inject them (e.g. a PairingManager into a SessionRegistry).
 */

/** The role a server-source file belongs to. Ordered: core < hub < cloud. */
export type ServerModuleRole = 'core' | 'hub' | 'cloud'

/** Import direction: a file may only import files of rank <= its own. */
export const ROLE_RANK: Record<ServerModuleRole, number> = { core: 0, hub: 1, cloud: 2 }

/** Directory prefixes (relative to apps/server/src) that are hub-only. */
export const HUB_PATHS: readonly string[] = ['hub/']

/**
 * Reserved for the private cloud module. Nothing in the OSS repo may import a
 * `cloud/` module path — the cloud composes in exclusively via the plugin seam
 * (`plugins.ts`), from a private build entrypoint outside this tree.
 */
export const CLOUD_PATHS: readonly string[] = ['cloud/']

/**
 * Composition roots: the assembly files that wire core + hub together and gate
 * hub surfaces behind the runtime role config. They may import across roles;
 * nothing else in core may.
 */
export const COMPOSITION_ROOTS: ReadonlySet<string> = new Set([
  'index.ts',
  'server.ts',
  'router.ts',
])

/** Role of a file path relative to apps/server/src (posix separators). */
export function serverRoleOf(relPath: string): ServerModuleRole {
  if (HUB_PATHS.some((p) => relPath === p.slice(0, -1) || relPath.startsWith(p))) return 'hub'
  if (CLOUD_PATHS.some((p) => relPath === p.slice(0, -1) || relPath.startsWith(p))) return 'cloud'
  return 'core'
}

/** True for the assembly files allowed to import across roles (rule 2 above). */
export function isCompositionRoot(relPath: string): boolean {
  return COMPOSITION_ROOTS.has(relPath)
}

// ---------------------------------------------------------------------------
// Runtime role composition (distinct from the static import grouping above):
// which module groups this PROCESS activates. Core is always on — it has no
// flag. The cloud tier has no flag either: it arrives as `plugins` on
// startServer from a private build entrypoint, never as OSS code.
// ---------------------------------------------------------------------------

/** Which optional module groups a server process activates. */
export interface ServerRoleConfig {
  /**
   * Hub surfaces: inbound daemon pairing (`pair` handshake + machines.pairingCode)
   * and fleet admin (machines.rename/revoke). Off = this server is a plain NODE:
   * other machines cannot join it; its own local daemon (hello) and everything
   * core — including dialing an upstream hub — is unaffected.
   */
  hub: boolean
}

/**
 * Resolve the process role: an explicit config wins; otherwise the presence of
 * `config.upstream` decides — a server dialing an upstream hub is a NODE, and a
 * node is not a rendezvous point (the architecture's "node = same binary with
 * the upstream sync client enabled and inbound pairing disabled"). No upstream
 * = today's all-in-one/hub deployment: core + hub, the historical behavior.
 */
export function resolveServerRole(
  explicit: Partial<ServerRoleConfig> | undefined,
  config: { upstream?: unknown },
): ServerRoleConfig {
  return { hub: explicit?.hub ?? !config.upstream }
}
