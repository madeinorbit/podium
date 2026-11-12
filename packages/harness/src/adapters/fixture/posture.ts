import { unchangedPosture } from '../../posture.js'
import type { PostureLaunch, PostureRequest, PostureResult } from '../../posture-types.js'

/**
 * the fixture harness's launch terms (POD-6858, docs/design/harness-session-posture.md §4.8).
 * The identity section until this harness's posture task fills it: the launch
 * passes through unchanged and nothing is reported.
 */
export function fixturePosture(launch: PostureLaunch, _request: PostureRequest): PostureResult {
  return unchangedPosture(launch)
}
