import { join } from 'node:path'
import { optionArgs } from '../../posture.js'
import type {
  HomeEdit,
  LaunchMode,
  PostureLaunch,
  PostureRequest,
  PostureResult,
  UnmetRequirement,
} from '../../posture-types.js'

/**
 * Grok's own permission-mode words (`--permission-mode`, and the ACP
 * `session/set_mode` ids). `default` and `auto` are Podium's two levels in
 * Grok's words; a native pick may name any of these. Any other word is
 * reported as unmet autonomy.
 */
export const GROK_PERMISSION_MODES: readonly string[] = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
]

/**
 * Grok's launch terms (POD-6858, docs/design/harness-session-posture.md §4.8).
 *
 * - Trust: met by default. A signed-in Grok draws no folder prompt (measured,
 *   1.0.70).
 * - The Podium CLI: `--allow 'Bash(<cli> *)'` in the TUI and a `--single`
 *   turn; in `Bash(...)` a `*` matches anything, spaces included (measured in
 *   the TUI, 1.0.70). The ACP engine takes no allow rule per launch and its
 *   `GROK_CONFIG` overlay ignores permission rules, so there the rule goes
 *   into `[permission] allow` of `$GROK_HOME/config.toml`, the user config
 *   (operator decision, 2026-11-16). It applies to every Grok session that
 *   uses that home, Podium's or not.
 * - The mode: `--permission-mode default` / `auto`. The engine takes no flag:
 *   the grok-acp family sets the session's initial mode from `requestedMode`
 *   (`_meta.autoMode` for `auto`, `session/set_mode` otherwise).
 * - Quiet start: met by default (a "New /learn skill!" line, nothing modal).
 * - Podium material: reads outside the folder never ask (read-only tools run
 *   without prompting in every mode); Podium's MCP servers get
 *   `--allow 'MCPTool(<server>__*)'` where `--allow` exists. The engine's asks
 *   reach chat.
 *
 * A `client` is the stock TUI reopening the engine's session through Grok's
 * own store. It runs the tools of any turn typed into it itself, so it gets
 * the terminal's terms.
 */
export function grokPosture(launch: PostureLaunch, request: PostureRequest): PostureResult {
  const unmet: UnmetRequirement[] = []
  const mode = permissionMode(request, unmet)

  if (request.mode === 'engine') {
    const edit = podiumAllowEdit(request)
    if (!edit) {
      unmet.push({
        requirement: 'podium-cli',
        reason:
          'the Grok home folder is not known for this launch, so the Podium CLI allow rule has nowhere to go',
      })
    }
    return { launch, homeEdits: edit ? [edit] : [], requestedMode: mode, unmet }
  }

  const options = [
    ...(mode ? ['--permission-mode', mode] : []),
    '--allow',
    `Bash(${request.grants.podiumCli.name} *)`,
    ...request.grants.mcpServers.flatMap((server) => ['--allow', `MCPTool(${server}__*)`]),
  ]
  return {
    launch: {
      args: placeOptions(request.mode, launch.args, options),
      env: launch.env,
      files: launch.files,
    },
    homeEdits: [],
    requestedMode: mode,
    unmet,
  }
}

/**
 * `Bash(<cli> *)` in `[permission] allow` of the user config Grok reads,
 * `$GROK_HOME/config.toml` (default `~/.grok/config.toml`). Grok has no
 * PowerShell rule form: its rule tool names are `Bash`, `Read`, `Edit`,
 * `Grep`, `MCPTool`, `WebFetch` and `WebSearch` (user guide, 1.0.77).
 *
 * The edit creates a missing `config.toml`, in the person's own home too
 * (operator decision, 2026-11-16), holding only that table. Measured on 1.0.70:
 * a home whose config holds only the table starts exactly like one with none
 * (same sign-in state, nothing modal), and Grok adds its own first-start keys
 * below the table.
 */
function podiumAllowEdit(request: PostureRequest): HomeEdit | undefined {
  const state = request.context.roots.state
  if (!state) return undefined
  return {
    kind: 'toml-array-entry',
    file: join(state, 'config.toml'),
    path: ['permission', 'allow'],
    value: `Bash(${request.grants.podiumCli.name} *)`,
    serves: 'podium-cli',
    createIfMissing: true,
  }
}

/** The Grok mode word for this posture, or null (and unmet) when it has none. */
function permissionMode(request: PostureRequest, unmet: UnmetRequirement[]): string | null {
  const mode = request.posture.mode
  if (mode === 'supervised') return 'default'
  if (mode === 'autonomous') return 'auto'
  if (GROK_PERMISSION_MODES.includes(mode.native)) return mode.native
  unmet.push({
    requirement: 'autonomy',
    reason: `Grok has no permission mode named "${mode.native}", so it starts in the mode its own settings choose`,
  })
  return null
}

/**
 * Where a launch takes options. A turn's prompt is the value of `--single`,
 * the last two tokens, so a turn's options go right before it; found by
 * position, so a prompt that reads `--single` is never taken for the flag.
 * Every other launch takes them before its `--` prompt boundary, or at the end.
 */
function placeOptions(
  mode: Exclude<LaunchMode, 'engine'>,
  args: readonly string[],
  options: readonly string[],
): string[] {
  const single = args.length - 2
  if (mode === 'turn' && single >= 0 && args[single] === '--single') {
    return [...args.slice(0, single), ...options, ...args.slice(single)]
  }
  return optionArgs(args, options)
}
