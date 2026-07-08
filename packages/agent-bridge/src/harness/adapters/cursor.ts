import { AGENT_CAPABILITIES } from '@podium/protocol'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import { cursorStateProvider } from '../../agent-state/cursor.js'
import { resolveCursorBin } from '../../cursor/cli.js'
import { cursorSessionPaths } from '../../cursor/paths.js'
import { createCursorConversationProvider } from '../../discovery/providers/cursor.js'
import {
  type HarnessAdapter,
  isSet,
  type TranscriptSourceInput,
  transcriptFileExists,
} from '../adapter.js'

async function chainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  const path = cursorSessionPaths({
    cwd: input.cwd,
    chatId: input.resumeValue,
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  }).transcriptPath
  return (await transcriptFileExists(path)) ? [path] : []
}

export const cursorAdapter: HarnessAdapter = {
  kind: 'cursor',
  capabilities: AGENT_CAPABILITIES.cursor,
  resumeKind: 'cursor-chat',

  launch(opts) {
    // No effort flag (capabilities.effortFlag 'none') and no argv prompt.
    return {
      cmd: resolveCursorBin(),
      args: [
        ...(opts.resume ? ['--resume', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
      ],
      cwd: opts.cwd,
    }
  },

  exec(opts, bins) {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return { cmd: bins.cursor(), args: ['-p', ...(model ? ['--model', model] : []), prompt] }
  },

  headless: {
    driver: 'resume-exec',
    // The chat id is pre-allocated with `cursor-agent create-chat` (bare UUID
    // on stdout) so even the first turn runs pinned via --resume.
    resumeIdAllocation: 'create-chat',
    buildExec(opts, bins) {
      const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
      const sys = opts.systemPrompt?.trim()
      const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
      return {
        cmd: bins.cursor(),
        args: [
          '-p',
          '--resume',
          opts.sessionId ?? '',
          ...(model ? ['--model', model] : []),
          prompt,
        ],
      }
    },
  },

  state: cursorStateProvider,
  discovery: createCursorConversationProvider(),

  transcript: {
    storage: 'file-chain',
    chainPaths,
    async sourceFor(input) {
      const chain = (await chainPaths(input)).map((p) => ({ path: p, fileId: fileIdFor(p) }))
      return fileChainSource(chain, recordToItemsForKind('cursor'))
    },
  },
}
