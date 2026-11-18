import { optionArgs } from '../../posture.js'
import type {
  PostureLaunch,
  PostureRequest,
  PostureResult,
  UnmetRequirement,
} from '../../posture-types.js'

/**
 * Pi's launch terms (POD-6858, docs/design/harness-session-posture.md §4.8).
 *
 * - Trust: `--approve`, in every launch mode. With a fresh home Pi asks
 *   "Trust project folder?" in every folder, an empty one included, and
 *   `--approve` removes the question (measured, 1.5.0).
 * - The Podium CLI: met by default. Pi has no approval gate: it never asks
 *   before it runs a tool.
 * - The mode: for the same reason Pi cannot be supervised, and has no mode a
 *   native pick could name. Autonomous is met by default.
 * - Quiet start: met. The update notice is a transcript line, not a menu.
 * - Podium material: met by default (no gate on reads, and Pi mounts no MCP).
 */
export function piPosture(launch: PostureLaunch, request: PostureRequest): PostureResult {
  return {
    launch: {
      // Before a `--` prompt boundary, or at the end (a turn's prompt rides
      // stdin).
      args: optionArgs(launch.args, ['--approve']),
      env: launch.env,
      files: launch.files,
    },
    homeEdits: [],
    requestedMode: null,
    unmet: autonomyUnmet(request),
  }
}

function autonomyUnmet(request: PostureRequest): UnmetRequirement[] {
  const mode = request.posture.mode
  if (mode === 'autonomous') return []
  if (mode === 'supervised') {
    return [
      {
        requirement: 'autonomy',
        reason: 'Pi has no approval gate: it never asks before it runs a tool',
      },
    ]
  }
  return [
    {
      requirement: 'autonomy',
      reason: `Pi has no permission mode named "${mode.native}": it has no approval gate and never asks before it runs a tool`,
    },
  ]
}
