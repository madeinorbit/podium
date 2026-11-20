/**
 * WHERE A CODEX CONVERSATION IS IN ONE HOME, AND WHAT CANNOT CROSS ACCOUNTS
 * (credential management §9 "Switching", §10 "Homes"; epic Task 11).
 *
 * The rollout file `sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` inside the
 * home. Found by its name, never through the home's `state_5.sqlite`: an index
 * row there may point into another home, and the answer must be a file in this
 * one.
 *
 * Measured in POD-6893 §3:
 * - OpenAI refuses encrypted reasoning another account produced (400
 *   `invalid_encrypted_content`) on both drivers, and answers once the
 *   `response_item` records of type `reasoning` are left out.
 * - Codex refuses a thread recorded under a provider that is not configured,
 *   and the home's `threads` row wins over the file. So a placed rollout
 *   records the target's provider, and the target's row for the thread goes:
 *   Codex indexes the file again.
 */
import { relative } from 'node:path'
import { forgetCodexThreadRow } from '../../discovery/providers/codex-state.js'
import { isRecord } from '../shared/json-util.js'
import { codexProviderInPodiumHome } from './plan-provider.js'
import { findCodexRolloutPath } from './state-provider.js'

export async function locateCodexConversation(input: {
  stateDir: string
  resumeValue: string
}): Promise<string | undefined> {
  const found = await findCodexRolloutPath({
    resumeValue: input.resumeValue,
    homeDir: input.stateDir,
    codexHome: input.stateDir,
    // The filename walk only: an index row may name a file in another home.
    readThreadState: async () => undefined,
  })
  if (!found) return undefined
  const rel = relative(input.stateDir, found)
  return rel.startsWith('..') ? undefined : found
}

/** A record the account that wrote it owns: encrypted reasoning. */
export function isCodexReasoningRecord(record: unknown): boolean {
  return (
    isRecord(record) &&
    record.type === 'response_item' &&
    isRecord(record.payload) &&
    record.payload.type === 'reasoning'
  )
}

export function carryCodexRecord(
  record: unknown,
  change: { accountChanged: boolean; modelProvider?: string; inPodiumHome?: boolean },
): unknown {
  if (change.accountChanged && isCodexReasoningRecord(record)) return undefined
  if (
    isRecord(record) &&
    record.type === 'session_meta' &&
    isRecord(record.payload) &&
    typeof record.payload.model_provider === 'string'
  ) {
    const recorded = record.payload.model_provider
    const wanted = change.modelProvider ?? recorded
    // The Podium home has no login file, so `openai` cannot answer there.
    const provider = change.inPodiumHome ? codexProviderInPodiumHome(wanted) : wanted
    if (provider !== recorded) {
      return { ...record, payload: { ...record.payload, model_provider: provider } }
    }
  }
  return record
}

export const codexConversationFile = {
  locateInHome: locateCodexConversation,
  carryRecord: carryCodexRecord,
  afterPlace: async (input: { stateDir: string; resumeValue: string }): Promise<void> => {
    await forgetCodexThreadRow(input.stateDir, input.resumeValue)
  },
}
