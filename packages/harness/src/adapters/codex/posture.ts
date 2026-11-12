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
import { parseHarnessVersion } from '../../version-policy.js'

/**
 * Codex's own approval words a native pick may name. `on-request` and
 * `auto-review` are Podium's two levels in Codex's words (`auto-review` is
 * `--approve-for-me`); `never` is the other value `-a` takes (0.167). Any
 * other word is reported as unmet autonomy.
 */
export const CODEX_APPROVAL_MODES: readonly string[] = ['on-request', 'auto-review', 'never']

/** The release that brought `--approve-for-me` and `approvals_reviewer`
 *  (measured on 0.147.0, also the version floor). */
const AUTO_REVIEW_SINCE = { major: 0, minor: 147, patch: 0 } as const

/** The rule file Podium owns in the Codex home (§4.7, decision 6). */
const RULE_FILE = ['rules', 'podium.rules'] as const

/**
 * Codex's launch terms (POD-6858, docs/design/harness-session-posture.md §4.8).
 *
 * - Trust: `-c projects={"<repo>"={trust_level="trusted"}}` in terminal,
 *   engine and turn. Only the inline-table form works; the dotted form is
 *   accepted and does nothing (measured, 0.167.1). A `resume --remote` client
 *   ignores its own copy: the engine it attaches to decides trust.
 * - The Podium CLI: a rule file Podium owns, `<CODEX_HOME>/rules/podium.rules`.
 *   Codex has no per-launch channel for rules (`-c rules…` is ignored); the
 *   TUI and the app-server both load this file, and an allowed command runs
 *   outside the sandbox with no ask and no review. Loopback stays open in the
 *   sandbox in every mode for the other tools that dial the daemon.
 * - The mode: terminal `-a on-request` / `--approve-for-me`; engine: asks
 *   reach chat / `approvals_reviewer="auto_review"`; turn: nobody to ask /
 *   `--approve-for-me`. A client gets no permission flag: Codex refuses any
 *   permission override on `resume --remote`.
 * - Quiet start: `check_for_update_on_startup=false` in terminal and client,
 *   the two launches that draw the update menu.
 * - Podium material: Podium's MCP servers mounted by this launch get
 *   `default_tools_approval_mode="approve"`. Reads outside the folder are
 *   unrestricted by default.
 */
export function codexPosture(launch: PostureLaunch, request: PostureRequest): PostureResult {
  const unmet: UnmetRequirement[] = []
  const approval = approvalFor(request, unmet)
  const options = [
    ...(request.mode !== 'client'
      ? ['-c', trustOverride(request.repoRoot ?? request.workdir)]
      : []),
    ...(request.mode === 'terminal' || request.mode === 'client'
      ? ['-c', 'check_for_update_on_startup=false']
      : []),
    // The app-server's sandbox, moved here from `codexAppServerConfigArgs`.
    ...(request.mode === 'engine' ? ['-c', 'sandbox_mode="workspace-write"'] : []),
    ...(request.mode !== 'client' ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...mountedPodiumServers(launch.args, request.grants.mcpServers).flatMap((name) => [
      '-c',
      `${codexMcpServerKey(name)}.default_tools_approval_mode="approve"`,
    ]),
    ...approval.args,
  ]

  const ruleEdit = podiumRuleEdit(request)
  if (!ruleEdit) {
    unmet.push({
      requirement: 'podium-cli',
      reason:
        'the Codex home folder is not known for this launch, so the Podium CLI rule has nowhere to go',
    })
  }

  return {
    launch: {
      args: placeOptions(request.mode, launch.args, options),
      env: launch.env,
      files: launch.files,
    },
    homeEdits: ruleEdit ? [ruleEdit] : [],
    requestedMode: approval.mode,
    unmet,
  }
}

/** `mcp_servers.<name>` as Codex's `-c` takes it: the name as a quoted key. */
export function codexMcpServerKey(name: string): string {
  return `mcp_servers.${JSON.stringify(name)}`
}

/**
 * Where a launch takes options. A turn's prompt is its last positional, and
 * `exec resume` takes no `--approve-for-me`, so a turn's options go right
 * after `exec`, where the parent command takes them and its `-c` values merge
 * with the subcommand's (measured, 0.167.2). Every other launch takes them
 * before its `--` prompt boundary, or at the end.
 */
function placeOptions(
  mode: LaunchMode,
  args: readonly string[],
  options: readonly string[],
): string[] {
  if (mode === 'turn' && args[0] === 'exec') return [args[0], ...options, ...args.slice(1)]
  return optionArgs(args, options)
}

/** The approval mode for this launch, as args and the word Podium asked for. */
function approvalFor(
  request: PostureRequest,
  unmet: UnmetRequirement[],
): { args: string[]; mode: string | null } {
  if (request.mode === 'client') return { args: [], mode: null }

  let word: string
  const mode = request.posture.mode
  if (typeof mode === 'string') {
    word = mode === 'autonomous' ? 'auto-review' : 'on-request'
  } else if (CODEX_APPROVAL_MODES.includes(mode.native)) {
    word = mode.native
  } else {
    unmet.push({
      requirement: 'autonomy',
      reason: `Codex has no approval mode named "${mode.native}", so it starts in the mode its own settings choose`,
    })
    return { args: [], mode: null }
  }

  const tooOld = word === 'auto-review' ? versionWithoutAutoReview(request) : undefined
  if (tooOld) {
    const out = approvalArgs(request.mode, 'on-request', unmet)
    unmet.push({
      requirement: 'autonomy',
      reason: `Codex ${tooOld} has no automatic review; it arrived in ${dotted(AUTO_REVIEW_SINCE)}`,
    })
    return out
  }
  return approvalArgs(request.mode, word, unmet)
}

function approvalArgs(
  mode: Exclude<LaunchMode, 'client'>,
  word: string,
  unmet: UnmetRequirement[],
): { args: string[]; mode: string | null } {
  if (word === 'auto-review') {
    return mode === 'engine'
      ? { args: ['-c', 'approvals_reviewer="auto_review"'], mode: word }
      : { args: ['--approve-for-me'], mode: word }
  }
  if (word === 'on-request') {
    if (mode === 'terminal') return { args: ['-a', 'on-request'], mode: word }
    // The app-server's own default: its asks reach chat over JSON-RPC.
    if (mode === 'engine') return { args: [], mode: word }
    unmet.push({ requirement: 'autonomy', reason: 'a one-shot Codex run has nobody to ask' })
    return { args: [], mode: null }
  }
  return mode === 'terminal'
    ? { args: ['-a', word], mode: word }
    : { args: ['-c', `approval_policy=${tomlString(word)}`], mode: word }
}

/**
 * The installed version, when it predates automatic review. A version the
 * inventory could not read is taken to have it: the version floor already
 * admits only releases that do, and a guess the other way would quietly lower
 * every session.
 */
function versionWithoutAutoReview(request: PostureRequest): string | undefined {
  const parsed = parseHarnessVersion(request.context.installation.version)
  if (!parsed) return undefined
  const since = AUTO_REVIEW_SINCE
  const below =
    parsed.major - since.major || parsed.minor - since.minor || parsed.patch - since.patch
  return below < 0 ? dotted(parsed) : undefined
}

function dotted(version: { major: number; minor: number; patch: number }): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

/** `projects={"<folder>"={trust_level="trusted"}}`: the inline-table form. */
function trustOverride(folder: string): string {
  return `projects={${tomlString(folder)}={trust_level="trusted"}}`
}

/**
 * A TOML basic string. `"` and `\` are escaped, and so is every control
 * character TOML does not allow raw; everything else, non-ASCII letters
 * included, stays as it is (TOML is UTF-8).
 */
export function tomlString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\t') out += '\\t'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f)
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

/**
 * The Podium servers this launch mounts, in grant order. Approving a server
 * the launch does not mount would declare it half-way, and Codex refuses to
 * start on a server with no transport (measured, 0.167.2).
 */
function mountedPodiumServers(args: readonly string[], servers: readonly string[]): string[] {
  return servers.filter((name) => {
    const prefix = `${codexMcpServerKey(name)}.`
    return args.some((arg) => arg.startsWith(prefix))
  })
}

/** The rule file, or none when the context has no Codex home. */
function podiumRuleEdit(request: PostureRequest): HomeEdit | undefined {
  const state = request.context.roots.state
  if (!state) return undefined
  const cli = request.grants.podiumCli.name
  return {
    kind: 'owned-file',
    file: join(state, ...RULE_FILE),
    contents:
      '# Written by Podium. Lets agents run the Podium CLI without asking.\n' +
      `prefix_rule(pattern = [${JSON.stringify(cli)}], decision = "allow", justification = "Podium CLI: required for an agent to work inside Podium")\n`,
    serves: 'podium-cli',
  }
}
