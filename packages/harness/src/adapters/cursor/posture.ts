import type {
  PostureLaunch,
  PostureRequest,
  PostureResult,
  UnmetRequirement,
} from '../../posture-types.js'

/**
 * Cursor's own approval words a native pick may name: `allowlist` is its
 * default `approvalMode` (asks for anything not on the allow list),
 * `auto-review` is `--auto-review` (its server classifier decides). Podium's
 * two levels are these two. Any other word is reported as unmet autonomy.
 */
export const CURSOR_APPROVAL_MODES: readonly string[] = ['allowlist', 'auto-review']

const UNMEASURED = 'no signed-in Cursor account was available to the spike'

/**
 * Cursor's launch terms (POD-6858, docs/design/harness-session-posture.md §4.8).
 *
 * Cursor's row is documented (`--help` 2026.07.23 and the installed bundle),
 * not measured: no signed-in Cursor account was available to the spike. What
 * Podium cannot show it meets is reported as unmet, with that reason.
 *
 * - Trust: a turn takes `--trust`. The terminal keeps folder trust in a
 *   vendor-private marker file Podium does not write (decision 3).
 * - The Podium CLI: unmet in every mode. Allow rules come only from Cursor's
 *   own settings files, and no per-launch channel is documented.
 * - The mode: a turn takes nothing (`allowlist`) / `--auto-review`. The
 *   terminal gets no mode flag: none was run in Cursor's terminal UI.
 * - Quiet start: unmeasured in the terminal; a turn draws nothing.
 * - Podium material: whether reads outside the folder ask is unmeasured.
 *   Podium mounts no MCP server in Cursor, and `--approve-mcps` would approve
 *   every server the repository declares too, so it is never sent.
 *
 * Cursor has no engine and no client; were one built, an engine would be
 * headless like a turn, and a client a terminal UI like the terminal.
 */
export function cursorPosture(launch: PostureLaunch, request: PostureRequest): PostureResult {
  const headless = request.mode === 'turn' || request.mode === 'engine'
  const unmet: UnmetRequirement[] = []

  if (!headless) {
    unmet.push({
      requirement: 'workspace-trust',
      reason: 'Cursor keeps interactive folder trust in private state that Podium does not write',
    })
  }
  unmet.push({
    requirement: 'podium-cli',
    reason:
      'Cursor takes allow rules only from a settings file shared with every Cursor session, which Podium does not edit',
  })

  let requestedMode: string | null = null
  const options: string[] = []
  if (headless) {
    options.push('--trust')
    requestedMode = approvalMode(request, unmet)
    if (requestedMode === 'auto-review') options.push('--auto-review')
  } else {
    unmet.push({
      requirement: 'autonomy',
      reason: `unmeasured: Cursor's mode flags were not run in its terminal UI (${UNMEASURED}), so it starts in the mode its own settings choose`,
    })
    unmet.push({ requirement: 'quiet-start', reason: `unmeasured: ${UNMEASURED}` })
  }
  unmet.push({
    requirement: 'podium-material',
    reason: `unmeasured: whether Cursor asks before reading Podium's attachments outside the working folder; ${UNMEASURED}`,
  })

  return {
    launch: {
      // A turn's prompt is its last positional, so its options go right
      // before it. A terminal gets none.
      args:
        options.length > 0 && launch.args.length > 0
          ? [...launch.args.slice(0, -1), ...options, ...launch.args.slice(-1)]
          : [...launch.args, ...options],
      env: launch.env,
      files: launch.files,
    },
    homeEdits: [],
    requestedMode,
    unmet,
  }
}

/** Cursor's approval word for this posture, or null (and unmet) when it has none. */
function approvalMode(request: PostureRequest, unmet: UnmetRequirement[]): string | null {
  const mode = request.posture.mode
  if (mode === 'supervised') return 'allowlist'
  if (mode === 'autonomous') return 'auto-review'
  if (CURSOR_APPROVAL_MODES.includes(mode.native)) return mode.native
  unmet.push({
    requirement: 'autonomy',
    reason: `Cursor has no permission mode named "${mode.native}", so it starts in the mode its own settings choose`,
  })
  return null
}
