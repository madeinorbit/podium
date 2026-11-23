import type {
  LaunchMode,
  PostureLaunch,
  PostureRequest,
  PostureResult,
  UnmetRequirement,
} from '../../posture-types.js'

/**
 * OpenCode's own permission words a native pick may name: `ask` is its
 * supervised setup (shell and edit rules that ask), `auto` its `--auto` flag.
 * Any other word is reported as unmet autonomy.
 */
export const OPENCODE_PERMISSION_MODES: readonly string[] = ['ask', 'auto']

/** The inline config variable OpenCode reads, already used for instructions. */
const CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'

type Level = 'ask' | 'auto'
type Rules = Record<string, unknown>

/**
 * OpenCode's launch terms (POD-6858, docs/design/harness-session-posture.md §4.8).
 *
 * - Trust and quiet start: met by default. OpenCode draws no folder prompt and
 *   no startup menu (measured, 1.18.35).
 * - The Podium CLI: `permission.bash["<cli> *"] = "allow"` in the inline
 *   config, `OPENCODE_CONFIG_CONTENT`, as the LAST bash rule so it wins over
 *   every glob above it. The object form with glob keys is the one measured on
 *   1.18.35; the version floor (1.18) admits no release with another syntax.
 * - Podium material: `permission.external_directory["<uploads>/*"] = "allow"`.
 *   OpenCode asks before reading outside its folder; Podium's MCP tools are
 *   allowed by default.
 * - The mode, terminal and turn: supervised puts an ask on every shell command
 *   and every edit, first, so the person's narrower rules still win;
 *   autonomous is `--auto`, which approves every ask not denied. The engine:
 *   `serve` takes no `--auto`, so autonomous runs OpenCode's own default (shell
 *   and edits run unasked) and the asks that remain reach chat, as today. A
 *   client gets nothing: the engine it attaches to evaluates every permission.
 *
 * The inline config is read from the launch env, then the context env, then
 * `{}`, and everything else in it survives. A malformed one throws, as
 * `launch()` does, rather than be replaced.
 */
export function opencodePosture(launch: PostureLaunch, request: PostureRequest): PostureResult {
  // Podium owns updates for its release in every mode, including an attached TUI.
  if (request.context.installation.provenance === 'managed') {
    launch = { ...launch, env: { ...launch.env, OPENCODE_DISABLE_AUTOUPDATE: '1' } }
  }
  if (request.mode === 'client') {
    return { launch, homeEdits: [], requestedMode: null, unmet: [] }
  }

  const unmet: UnmetRequirement[] = []
  const level = levelFor(request, unmet)
  if (level === 'ask' && request.mode === 'turn') {
    unmet.push({
      requirement: 'autonomy',
      reason: 'a one-shot OpenCode run has nobody to answer its asks',
    })
  }

  const config = existingConfig(launch, request)
  config.permission = permissionFor(config.permission, request, level)

  const auto = level === 'auto' && request.mode !== 'engine' ? ['--auto'] : []
  return {
    launch: {
      args: placeOptions(request.mode, launch.args, auto),
      env: { ...launch.env, [CONFIG_ENV]: JSON.stringify(config) },
      files: launch.files,
    },
    homeEdits: [],
    requestedMode: requestedModeFor(request.mode, level),
    unmet,
  }
}

/** Podium's level in OpenCode's words, or none for a word OpenCode lacks. */
function levelFor(request: PostureRequest, unmet: UnmetRequirement[]): Level | undefined {
  const mode = request.posture.mode
  if (mode === 'supervised') return 'ask'
  if (mode === 'autonomous') return 'auto'
  if (OPENCODE_PERMISSION_MODES.includes(mode.native)) return mode.native as Level
  unmet.push({
    requirement: 'autonomy',
    reason: `OpenCode has no permission mode named "${mode.native}", so it starts on its own permission settings`,
  })
  return undefined
}

/**
 * The word Podium asked for. The engine's autonomous level is OpenCode's own
 * default, which has no name and no flag, so it reports none.
 */
function requestedModeFor(mode: LaunchMode, level: Level | undefined): string | null {
  if (level === 'auto' && mode === 'engine') return null
  return level ?? null
}

/**
 * Where a launch takes `--auto`. A turn's prompt is its last positional, so the
 * flag goes right after `run`; every other launch takes it before a `--`
 * boundary, or at the end.
 */
function placeOptions(
  mode: LaunchMode,
  args: readonly string[],
  options: readonly string[],
): string[] {
  if (options.length === 0) return [...args]
  if (mode === 'turn' && args[0] === 'run') return [args[0], ...options, ...args.slice(1)]
  const boundary = args.indexOf('--')
  if (boundary < 0) return [...args, ...options]
  return [...args.slice(0, boundary), ...options, ...args.slice(boundary)]
}

function malformed(detail: string): Error {
  return new Error(
    `malformed OPENCODE_CONFIG_CONTENT (${detail}) — refusing to discard existing config`,
  )
}

/** The inline config this launch already carries, as a fresh object. */
function existingConfig(launch: PostureLaunch, request: PostureRequest): Rules {
  const raw = launch.env[CONFIG_ENV] ?? request.context.env[CONFIG_ENV] ?? '{}'
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw malformed('not JSON')
  }
  if (!isRules(parsed)) throw malformed('not an object')
  return { ...parsed }
}

/** The `permission` block with Podium's rules merged in. */
function permissionFor(
  existing: unknown,
  request: PostureRequest,
  level: Level | undefined,
): Rules {
  let permission: Rules
  if (existing === undefined) permission = {}
  // One word for every tool: keep it, as the first rule, under its own key.
  else if (typeof existing === 'string') permission = { '*': existing }
  else if (isRules(existing)) permission = { ...existing }
  else throw malformed('permission is neither a word nor an object')

  const cliRule = `${request.grants.podiumCli.name} *`
  const supervised = level === 'ask'

  permission.bash = withRules(permission.bash, 'bash', {
    ...(supervised ? { base: 'ask' } : {}),
    last: [cliRule, 'allow'],
  })
  permission.external_directory = withRules(permission.external_directory, 'external_directory', {
    last: [`${request.grants.uploadsDir}/*`, 'allow'],
  })
  if (supervised) permission.edit = withRules(permission.edit, 'edit', { base: 'ask' })
  return permission
}

/**
 * One permission's rules with Podium's added. `base`: the `*` rule, placed
 * first so every narrower rule of the person's still wins over it; a `deny`
 * there is kept, never loosened to an ask. `last`: one rule placed after every
 * other, so it wins over every glob above it.
 */
function withRules(
  existing: unknown,
  key: string,
  add: { base?: 'ask'; last?: readonly [string, string] },
): string | Rules {
  let rules: Rules
  if (existing === undefined) rules = {}
  else if (typeof existing === 'string') rules = { '*': existing }
  else if (isRules(existing) && Object.values(existing).every((v) => typeof v === 'string'))
    rules = { ...existing }
  else throw malformed(`permission.${key} is neither a word nor rules`)

  if (add.base) {
    const { '*': current, ...rest } = rules
    rules = { '*': current === 'deny' ? 'deny' : add.base, ...rest }
  }
  if (add.last) {
    const [pattern, action] = add.last
    delete rules[pattern]
    rules[pattern] = action
  }
  // A word stays a word when nothing was added beside its `*` rule.
  const keys = Object.keys(rules)
  if (!isRules(existing) && keys.length === 1 && keys[0] === '*') return rules['*'] as string
  return rules
}

function isRules(value: unknown): value is Rules {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
