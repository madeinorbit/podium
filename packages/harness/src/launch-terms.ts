/**
 * THE TERMS EACH LAUNCH SITE STATES (POD-6858, docs/design/
 * harness-session-posture.md §4.6).
 *
 * `harnessCommand` takes the terms as a required argument. A site that runs an
 * agent hands it the agent's posture section and the request for its launch
 * mode; a site that runs no agent hands it the reason. One rule holds for
 * every agent site and lives here, so no site restates it: a tool-less turn
 * (`toolPolicy: 'none'`) has no tools to govern and must not gain a tool flag,
 * so it runs on no-agent terms whatever its harness's section would add.
 */
import type { AgentManifest } from './manifest.js'
import { launchTerms, noAgentTerms } from './posture.js'
import type { LaunchMode, LaunchTerms, PostureRequest } from './posture-types.js'
import { manifestFor } from './registry.js'

/**
 * Everything a launch needs to state its terms except the launch mode, which
 * the site itself knows. Built by the daemon on the harness's own machine.
 */
export type LaunchPosture = Omit<PostureRequest, 'mode'>

/** The reason a tool-less turn runs on no-agent terms. */
export const TOOL_LESS_TERMS_REASON = 'tool-less turn: no tools to govern'

/**
 * The terms an agent launch runs on: the manifest's posture section for this
 * launch mode, or no-agent terms for a tool-less turn.
 */
export function agentLaunchTerms(
  manifest: Pick<AgentManifest, 'posture'>,
  mode: LaunchMode,
  posture: LaunchPosture,
  toolPolicy?: 'none',
): LaunchTerms {
  if (toolPolicy === 'none') return noAgentTerms(TOOL_LESS_TERMS_REASON)
  return launchTerms(manifest, { ...posture, mode })
}

/**
 * What a launch builder that runs an agent is handed to state its terms: the
 * harness's posture section (its manifest) and the launch posture. The
 * builder knows its own launch mode and its turn's tool policy.
 */
export interface AgentTermsInput {
  readonly manifest: Pick<AgentManifest, 'posture'>
  readonly posture: LaunchPosture
}

/**
 * A session's launch folders, from the daemon: the session-scoped folder for
 * generated config files, and the main checkout when the working folder is a
 * worktree (absent otherwise).
 */
export interface LaunchFolders {
  readonly runtimeDir: string
  readonly repoRoot?: string
}

/** The launch posture of one session, from its parts. */
export function launchPosture(
  parts: Pick<PostureRequest, 'posture' | 'grants' | 'workdir' | 'context'>,
  folders: LaunchFolders,
): LaunchPosture {
  return {
    posture: parts.posture,
    grants: parts.grants,
    workdir: parts.workdir,
    context: parts.context,
    runtimeDir: folders.runtimeDir,
    ...(folders.repoRoot !== undefined ? { repoRoot: folders.repoRoot } : {}),
  }
}

/** The posture section of harness `kind`, with the launch posture: loud for
 *  a kind the registry does not hold, never another harness's section. */
export function agentTermsFor(kind: string, posture: LaunchPosture): AgentTermsInput {
  const manifest = manifestFor(kind)
  if (!manifest) throw new Error(`no harness manifest for '${kind}' to state launch terms`)
  return { manifest, posture }
}
