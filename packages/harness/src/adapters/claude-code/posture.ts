import { resolveCredentialFilePath } from '../../manifest.js'
import { optionArgs } from '../../posture.js'
import type {
  HomeEdit,
  PodiumGrants,
  PostureLaunch,
  PostureRequest,
  PostureResult,
  UnmetRequirement,
} from '../../posture-types.js'
import { claudeCredentials } from './credentials.js'

/**
 * Claude Code's own permission modes, as `--permission-mode` takes them. A
 * native pick from this list passes through as itself; any other word is
 * reported as unmet autonomy.
 */
export const CLAUDE_PERMISSION_MODES: readonly string[] = [
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'plan',
  'dontAsk',
]

/**
 * Podium's two levels in Claude's words (§4.8). `default` is accepted by every
 * version (`manual` is only a newer alias for it). When auto mode is not
 * available to an account, Claude starts in `default` without an error and
 * says so in its init event: `requestedMode` is what Podium asked for, not
 * proof of the mode in force.
 */
const LEVEL_MODES = { supervised: 'default', autonomous: 'auto' } as const

/**
 * Claude Code's launch terms (POD-6858, docs/design/harness-session-posture.md §4.8).
 *
 * Every launch mode gets the same terms, because Claude takes all of them per
 * launch except folder trust:
 *
 * - `--permission-mode` for the session's mode, then one `--allowedTools=<rule>`
 *   per rule, both ahead of the `--` prompt boundary. The `=` form matters:
 *   `--allowedTools` is variadic, and the spaced form swallows a following
 *   prompt as a rule (measured, 2.1.322). The rules are the Podium CLI (Bash
 *   and, for Windows, PowerShell), reads in this session's uploads folder,
 *   and every tool of each of Podium's MCP servers. Allow rules merge with the
 *   person's own and replace none. No `--add-dir`: it grants editing.
 * - Trust: one documented key, `projects[<repo>].hasTrustDialogAccepted`, in
 *   the `.claude.json` the child reads. Claude has no flag for it. The key on
 *   the main checkout also covers its linked worktrees.
 * - Terminal only: the feedback survey is switched off. The other startup
 *   notices are transcript lines, not menus; the settings keys that remove
 *   the bypass-mode confirmation ride the per-session settings file
 *   (`claudeHookSettings`).
 */
export function claudeCodePosture(launch: PostureLaunch, request: PostureRequest): PostureResult {
  const unmet: UnmetRequirement[] = []
  const mode = permissionModeFor(request.posture.mode)
  if (mode === null) {
    const native = request.posture.mode as { native: string }
    unmet.push({
      requirement: 'autonomy',
      reason: `Claude Code has no permission mode named "${native.native}", so it starts in the mode the person's own settings choose`,
    })
  }
  const options = [
    ...(mode !== null ? ['--permission-mode', mode] : []),
    ...allowRules(request.grants).map((rule) => `--allowedTools=${rule}`),
  ]
  let env = launch.env
  if (request.context.installation.provenance === 'managed')
    env = { ...env, DISABLE_AUTOUPDATER: '1' }
  if (request.mode === 'terminal') env = { ...env, CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1' }
  return {
    launch: {
      args: optionArgs(launch.args, options),
      env,
      files: launch.files,
    },
    homeEdits: [trustEdit(request)],
    requestedMode: mode,
    unmet,
  }
}

function permissionModeFor(mode: PostureRequest['posture']['mode']): string | null {
  if (typeof mode === 'string') return LEVEL_MODES[mode]
  return CLAUDE_PERMISSION_MODES.includes(mode.native) ? mode.native : null
}

/** The allow rules every Claude launch carries, in Claude's rule syntax. */
function allowRules(grants: PodiumGrants): string[] {
  const cli = grants.podiumCli.name
  return [
    `Bash(${cli} *)`,
    `PowerShell(${cli} *)`,
    // An absolute folder takes two slashes: `Read(/<abs>/**)` with one did not
    // match (measured, 2.1.322).
    `Read(/${posixFolder(grants.uploadsDir)}/**)`,
    ...grants.mcpServers.map((server) => `mcp__${mcpServerRuleName(server)}`),
  ]
}

/**
 * A folder in the form Claude matches path rules in: Claude normalises a
 * Windows path to POSIX before matching (`C:\Users\a` is `/c/Users/a`, vendor
 * permissions docs). No trailing separator.
 */
function posixFolder(dir: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(dir)
  const posix = drive ? `/${drive[1]?.toLowerCase()}/${dir.slice(3).replaceAll('\\', '/')}` : dir
  return posix.length > 1 ? posix.replace(/\/+$/, '') : posix
}

/**
 * The server's name as it appears in Claude's tool names (`mcp__<server>__<tool>`):
 * Claude replaces every character outside `[A-Za-z0-9_-]` with `_`.
 */
function mcpServerRuleName(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The `.claude.json` layout entry: the file that holds `projects`. */
const CLAUDE_STATE_FILE = claudeCredentials.files.find((file) => file.kind === 'claude-code-state')

/**
 * Folder trust: the one documented key, in the `.claude.json` the child reads.
 * That file sits in the home unless the context selects a config folder:
 * Claude reads `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`, and the
 * stream engine pins `CLAUDE_CONFIG_DIR` (read in the 2.1.323 bundle).
 *
 * A selected config folder is Podium's own agent home: its `.claude.json` does
 * not exist until Claude's first start there, so the edit may create it, and
 * the very first launch is trusted too. The person's own `~/.claude.json` is
 * never created by Podium.
 */
function trustEdit(request: PostureRequest): HomeEdit {
  if (!CLAUDE_STATE_FILE) throw new Error('Claude credentials declare no .claude.json layout')
  const configDir = request.context.env.CLAUDE_CONFIG_DIR?.trim()
  const file = resolveCredentialFilePath(
    { ...CLAUDE_STATE_FILE, homeEnvVar: 'CLAUDE_CONFIG_DIR' },
    request.context.home,
    { env: request.context.env },
  )
  return {
    kind: 'json-key',
    file,
    path: ['projects', request.repoRoot ?? request.workdir, 'hasTrustDialogAccepted'],
    value: true,
    serves: 'workspace-trust',
    ...(configDir ? { createIfMissing: true as const } : {}),
  }
}
