/**
 * THE DAEMON'S HALF OF A LAUNCH'S TERMS (POD-6858, docs/design/
 * harness-session-posture.md §4.4–4.7).
 *
 * Product code says what Podium needs of a session (`SessionPosture`); each
 * adapter says how its harness makes that true. What sits between them is
 * here, on the harness's own machine:
 *
 * - {@link podiumGrantsFor}: Podium's standing facts for one session (the
 *   Podium CLI, the session's own uploads folder, Podium's MCP servers).
 * - {@link launchFoldersFor} and {@link postureRequestFor}: the rest of the
 *   request an adapter's posture section answers.
 * - {@link prepareLaunch}: the three generic steps every process-creating
 *   function runs once, after `harnessCommand` applied the terms and before
 *   the process starts: write the launch's files, apply its home edits, and
 *   return what could not be met. None of them names a harness.
 */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AppliedTerms,
  BoundCommand,
  HarnessContext,
  LaunchFile,
  LaunchFolders,
  LaunchMode,
  PodiumGrants,
  PostureRequest,
  UnmetRequirement,
} from '@podium/harness'
import type { SessionSpec } from '@podium/harness/driver/host'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { applyHomeEdits, type HomeEditPorts, nodeHomeEditPorts } from './harness-home-edits.js'
import { sessionUploadsDir } from './session-uploads.js'
import { gitWorktree } from './worktree-resolve.js'

const log = createLogger('daemon:session-posture')

/** The Podium CLI's name, as a harness rule names the command. */
export const PODIUM_CLI_NAME = 'podium'

/**
 * Podium's standing facts for one session (§4.4), over the session's harness
 * context (`where.stateRoot` is the state root whose `uploads` folder holds
 * staged attachments).
 *
 * - `podiumCli`: the CLI `harnessChildEnv` puts first on the child's PATH,
 *   the context's `PODIUM_CLI_PATH`. Without one, the child resolves `podium`
 *   on its PATH, so the path is that bare name.
 * - `uploadsDir`: this session's own folder under the state root's
 *   `uploads`, where chat attachments are staged. Never the parent folder,
 *   never another session's.
 * - `mcpServers`: the server names the spec's MCP configuration declares.
 */
export function podiumGrantsFor(
  where: { readonly stateRoot: string },
  sessionId: SessionId | string,
  spec: Pick<SessionSpec, 'mcpServers'>,
  context: Pick<HarnessContext, 'env'>,
): PodiumGrants {
  const cliPath = context.env.PODIUM_CLI_PATH?.trim()
  return {
    podiumCli: { name: PODIUM_CLI_NAME, path: cliPath || PODIUM_CLI_NAME },
    uploadsDir: sessionUploadsDir(sessionId, where.stateRoot),
    mcpServers: mcpServerNames(spec.mcpServers),
  }
}

/** The server names an MCP configuration declares; none when it declares none or cannot be read. */
export function mcpServerNames(
  mcp: SessionSpec['mcpServers'],
  readConfig: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string[] {
  if (!mcp.supported) return []
  let text: string
  try {
    text = mcp.value.transport === 'inline' ? mcp.value.config : readConfig(mcp.value.path)
  } catch (err) {
    log.warn('could not read the session MCP config for its grants', { err })
    return []
  }
  try {
    const parsed = JSON.parse(text) as { mcpServers?: unknown }
    const servers = parsed?.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return []
    return Object.keys(servers).sort()
  } catch {
    return []
  }
}

/**
 * A session's launch folders: its runtime folder for generated config (the
 * same per-session folder the terminal launch writes its instruction files
 * in) and, when the working folder is a linked worktree, the main checkout
 * that owns its git dir. A folder that is not a worktree has no `repoRoot`.
 */
export async function launchFoldersFor(
  input: { settingsDir: string; sessionId: SessionId | string; workdir: string },
  resolveWorktree: typeof gitWorktree = gitWorktree,
): Promise<LaunchFolders> {
  const runtimeDir = sessionRuntimeDir(input.settingsDir, input.sessionId)
  const repoRoot = await repoRootOf(input.workdir, resolveWorktree)
  return repoRoot !== undefined ? { runtimeDir, repoRoot } : { runtimeDir }
}

/** The main checkout that owns `workdir`'s git dir, when `workdir` is a
 *  linked worktree; `undefined` for any other folder. */
export async function repoRootOf(
  workdir: string,
  resolveWorktree: typeof gitWorktree = gitWorktree,
): Promise<string | undefined> {
  const info = await resolveWorktree(workdir).catch(() => null)
  return info?.kind === 'worktree' && info.repoRoot ? info.repoRoot : undefined
}

/** The session-scoped folder for a launch's generated files. */
export function sessionRuntimeDir(settingsDir: string, sessionId: SessionId | string): string {
  return join(settingsDir, 'session-instructions', sessionId)
}

/** The request an adapter's posture section answers, for one launch. */
export function postureRequestFor(input: {
  mode: LaunchMode
  spec: Pick<SessionSpec, 'posture' | 'grants' | 'workdir'>
  context: HarnessContext
  runtimeDir: string
  repoRoot?: string
}): PostureRequest {
  return {
    mode: input.mode,
    posture: input.spec.posture,
    grants: input.spec.grants,
    workdir: input.spec.workdir,
    runtimeDir: input.runtimeDir,
    ...(input.repoRoot !== undefined ? { repoRoot: input.repoRoot } : {}),
    context: input.context,
  }
}

/** The launch posture a terminal launch is handed: the request without its
 *  mode (the site's) and its context (the launch's own). */
export function launchPosturePart(
  spec: Pick<SessionSpec, 'posture' | 'grants' | 'workdir'>,
  folders: LaunchFolders,
): Omit<PostureRequest, 'mode' | 'context'> {
  return {
    posture: spec.posture,
    grants: spec.grants,
    workdir: spec.workdir,
    runtimeDir: folders.runtimeDir,
    ...(folders.repoRoot !== undefined ? { repoRoot: folders.repoRoot } : {}),
  }
}

/** What {@link prepareLaunch} touches. */
export interface PrepareLaunchPorts {
  /** Write one launch file, creating its folder; the file is private (0600). */
  writeLaunchFile(file: LaunchFile): Promise<void>
  /** The home-edit mechanism's file access. */
  homeEdits: HomeEditPorts
  log(message: string, fields: Record<string, unknown>): void
}

/** The real filesystem, logging through the daemon's logger with `context`
 *  (the session, the launch) on every line. */
export function nodePrepareLaunchPorts(context: Record<string, unknown> = {}): PrepareLaunchPorts {
  const info = (message: string, fields: Record<string, unknown>) =>
    log.info(message, { ...context, ...fields })
  return {
    async writeLaunchFile(file) {
      await mkdir(dirname(file.path), { recursive: true })
      await writeFile(file.path, file.contents, { mode: 0o600 })
    },
    homeEdits: nodeHomeEditPorts(info),
    log: info,
  }
}

/**
 * THE THREE GENERIC STEPS BEFORE A HARNESS PROCESS IS CREATED (§4.6).
 *
 * Writes the command's files, applies its home edits, and returns its applied
 * terms with one `unmet` entry per edit that could not be made, naming the
 * requirement the edit served. A failed edit never stops the launch: the
 * session still starts, and the next launch tries again. A file that cannot
 * be written does stop it, as it always has: the adapter's own launch needs
 * that file.
 */
export async function prepareLaunch(
  command: Pick<BoundCommand, 'files' | 'terms'>,
  ports: PrepareLaunchPorts,
): Promise<AppliedTerms> {
  for (const file of command.files) await ports.writeLaunchFile(file)
  const outcomes = await applyHomeEdits(command.terms.homeEdits, ports.homeEdits)
  const failed: UnmetRequirement[] = []
  for (const outcome of outcomes) {
    if (outcome.status !== 'failed') continue
    failed.push({ requirement: outcome.edit.serves, reason: outcome.reason })
  }
  const applied: AppliedTerms = {
    homeEdits: command.terms.homeEdits,
    requestedMode: command.terms.requestedMode,
    unmet: [...command.terms.unmet, ...failed],
  }
  if (applied.requestedMode !== null || applied.unmet.length > 0) {
    ports.log('harness launch terms', {
      requestedMode: applied.requestedMode,
      unmet: applied.unmet.map((entry) => ({ ...entry })),
    })
  }
  return applied
}
