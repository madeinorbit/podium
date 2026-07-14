/** Titling doctrine, stated once and reused by every surface that instructs an
 *  agent: the issue prime (server), the claude system pointer (agent-bridge),
 *  and the CLI/MCP command summaries (issue-client). Three copies of this text
 *  would drift; one does not. [spec:SP-eb60]
 */

/** How an agent must title an issue. Injected into the prime rules verbatim. */
export const TITLE_RULE =
  'Issue titles: 3–5 words naming the thing or the outcome, not the activity. ' +
  'Do not open with a generic descriptor such as "Implement", "Complete", "Investigate", "Add" or "Update" — ' +
  'name what changes, not what you will do to it. Only a bug may lead with a "Bug:" prefix. ' +
  'Good: "Merge lock lease expiry", "Bug: duplicate session rows". ' +
  'Bad: "Implement merge locking", "Investigate the session duplication issue".'

/** The same doctrine, compressed for the always-on system prompt (token-tight). */
export const TITLE_RULE_TERSE =
  'Issue and session titles: 3–5 words naming the thing, not the activity. No "Implement"/"Complete"/"Investigate" openers. Only bugs may lead with "Bug:".'

/** How an agent must title its own session. `siblings` are the other session
 *  titles already on the issue — the new title has to be distinguishable from
 *  them, since they all sit under the same issue in the sidebar. */
export function sessionTitleRule(seq: number, siblings: string[]): string {
  const lines = [
    `This session has no name. Name it for what THIS session is doing: \`podium session title "…"\`.`,
    `Same rules as an issue title: 3–5 words naming the thing, not the activity; no "Implement"/"Complete"/"Investigate" openers.`,
    `It sits under #${seq} in the sidebar, so it must say what distinguishes this session from its siblings — not restate the issue.`,
  ]
  if (siblings.length > 0) {
    lines.push(
      `Other sessions on this issue (do not duplicate these):\n${siblings.map((t) => `  - ${t}`).join('\n')}`,
    )
  }
  lines.push('Retitle it if the work turns out to be something else.')
  return lines.join('\n')
}
