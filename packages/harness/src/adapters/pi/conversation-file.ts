/**
 * WHERE A PI CONVERSATION IS IN ONE HOME (credential management §9
 * "Switching"; managed installs §4.6 item 4, POD-7372).
 *
 * `<stateDir>/sessions/--<cwd slug>--/<timestamp>_<id>.jsonl`, or the same
 * name in another bucket when the session's cwd moved (`pi/paths.ts` states
 * the layout). The one file is the whole conversation: Pi keeps no index and
 * no side files for it. A session that ran in the person's `~/.pi/agent` on a
 * passed-in key continues in the Podium home from a copy of it; without the
 * copy, Pi's create-or-resume `--session-id` would start an empty
 * conversation there.
 *
 * Only `stateDir` is searched. `PI_CODING_AGENT_SESSION_DIR` would put the
 * sessions elsewhere, and a path outside the home is never an answer here.
 */
import type { HarnessConversationFile } from '../../manifest.js'
import { locatePiSessionFile } from '../../pi/paths.js'

export const piConversationFile: HarnessConversationFile = {
  async locateInHome({ stateDir, cwd, resumeValue }) {
    return await locatePiSessionFile({
      cwd,
      sessionId: resumeValue,
      homeDir: stateDir,
      env: { PI_CODING_AGENT_DIR: stateDir },
    })
  },
}
