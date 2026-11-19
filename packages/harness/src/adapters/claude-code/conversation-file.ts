/**
 * WHERE A CLAUDE CODE CONVERSATION IS IN ONE HOME (credential management §9
 * "Switching", §10 "Homes"; epic Task 11).
 *
 * `<stateDir>/projects/<slug(cwd)>/<id>.jsonl`, or the same name in another
 * bucket when the session's cwd moved. A copy of that one file is enough for
 * a resume in another home (POD-6893 §3); the directory of the same name
 * (subagent transcripts, large tool results) goes with it when it exists.
 * Thinking blocks signed by another account need nothing: the API drops them.
 */
import { join } from 'node:path'
import { locateClaudeSessionFile } from './state-locate.js'

export async function locateClaudeConversation(input: {
  stateDir: string
  cwd: string
  resumeValue: string
}): Promise<string | undefined> {
  const found = await locateClaudeSessionFile({
    cwd: input.cwd,
    resumeValue: input.resumeValue,
    homeDir: input.stateDir,
    env: { CLAUDE_CONFIG_DIR: input.stateDir },
  })
  return found ?? undefined
}

/** The directory beside the conversation file that holds its side files. */
export function claudeConversationCompanions(path: string): string[] {
  return path.endsWith('.jsonl') ? [path.slice(0, -'.jsonl'.length)] : []
}

export const claudeConversationFile = {
  locateInHome: locateClaudeConversation,
  companions: claudeConversationCompanions,
}

/** Exported for tests: the path a conversation of `cwd` has under `stateDir`. */
export const claudeConversationPathFor = (stateDir: string, bucket: string, id: string): string =>
  join(stateDir, 'projects', bucket, `${id}.jsonl`)
