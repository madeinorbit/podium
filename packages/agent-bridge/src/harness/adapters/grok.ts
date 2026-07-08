import { AGENT_CAPABILITIES } from '@podium/protocol'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import { grokSessionPaths, grokStateProvider } from '../../agent-state/grok.js'
import { createGrokConversationProvider } from '../../discovery/providers/grok.js'
import {
  type HarnessAdapter,
  isSet,
  type TranscriptSourceInput,
  transcriptFileExists,
} from '../adapter.js'

async function chainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  const path = grokSessionPaths({
    cwd: input.cwd,
    sessionId: input.resumeValue,
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  }).chatHistoryPath
  return (await transcriptFileExists(path)) ? [path] : []
}

export const grokAdapter: HarnessAdapter = {
  kind: 'grok',
  capabilities: AGENT_CAPABILITIES.grok,
  resumeKind: 'grok-session',

  launch(opts) {
    return {
      cmd: 'grok',
      args: [
        ...(opts.resume ? ['--resume', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
        ...(isSet(opts.effort) ? ['--effort', opts.effort] : []),
        ...(opts.initialPrompt?.trim() ? [opts.initialPrompt] : []),
      ],
      cwd: opts.cwd,
    }
  },

  exec(opts) {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return { cmd: 'grok', args: ['-p', ...(model ? ['--model', model] : []), prompt] }
  },

  headless: {
    driver: 'resume-exec',
    // -s/--session-id is create-or-resume — the daemon mints the UUID on the
    // first turn, so every turn uses the same pinned invocation.
    resumeIdAllocation: 'daemon-minted-uuid',
    buildExec(opts) {
      const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
      const sys = opts.systemPrompt?.trim()
      const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
      return {
        cmd: 'grok',
        args: [
          '-p',
          '--session-id',
          opts.sessionId ?? '',
          ...(model ? ['--model', model] : []),
          prompt,
        ],
      }
    },
  },

  state: grokStateProvider,
  discovery: createGrokConversationProvider(),

  transcript: {
    storage: 'file-chain',
    chainPaths,
    async sourceFor(input) {
      const chain = (await chainPaths(input)).map((p) => ({ path: p, fileId: fileIdFor(p) }))
      return fileChainSource(chain, recordToItemsForKind('grok'))
    },
  },
}
