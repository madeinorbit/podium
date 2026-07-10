import { AGENT_CAPABILITIES } from '@podium/protocol'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import { grokSessionPaths, grokStateProvider, observeGrokState } from '../../agent-state/grok.js'
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

  // Grok has no hook channel — a polling observer discovers the session the
  // CLI creates and tails its update stream. On a fresh spawn `startedAtMs` is
  // the spawn time, so discovery skips older sibling sessions in the same cwd.
  // On reattach it's absent → observeGrokState defaults watermarkMs to 0 (no
  // floor), so the latest-by-activity session is found even if it predates
  // this daemon process start.
  observer(input, host) {
    const obs = observeGrokState({
      cwd: input.cwd,
      ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
      onSession: (grokSessionId) => {
        host.onResumeValue(grokSessionId)
        // The session's chat_history.jsonl is derivable once the id is known —
        // tail it so chat has history before (and without) new activity.
        host.tailFile(
          grokSessionPaths({
            cwd: input.cwd,
            sessionId: grokSessionId,
            ...(input.homeDir ? { homeDir: input.homeDir } : {}),
          }).chatHistoryPath,
        )
      },
      onEvents: (events) => host.onStateEvents(events),
    })
    return { stop: () => obs.stop() }
  },

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
