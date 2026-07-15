import { join } from 'node:path'
import { AGENT_CAPABILITIES } from '@podium/protocol'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import { cursorStateProvider, observeCursorState } from '../../agent-state/cursor.js'
import { cursorBinCandidates, resolveCursorBin } from '../../cursor/cli.js'
import { cursorSessionPaths } from '../../cursor/paths.js'
import { createCursorConversationProvider } from '../../discovery/providers/cursor.js'
import {
  type HarnessAdapter,
  isSet,
  type TranscriptSourceInput,
  transcriptFileExists,
} from '../adapter.js'
import { composeAgentInstructions } from '../instructions.js'

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

  inventory: {
    binCandidates: (homeDir) => [...cursorBinCandidates(homeDir), 'cursor-agent'],
    detectLogin: () => ({ state: 'unknown' }),
  },

  launch(opts) {
    const args = [
      ...(opts.resume ? ['--resume', opts.resume.value] : []),
      ...(isSet(opts.model) ? ['--model', opts.model] : []),
    ]
    const instructions = composeAgentInstructions(opts.instructions)
    if (!instructions) return { cmd: resolveCursorBin(), args, cwd: opts.cwd }
    if (!opts.runtimeDir) throw new Error('cursor launch requires an instruction runtime directory')
    const manifestPath = join(opts.runtimeDir, '.cursor-plugin', 'plugin.json')
    const rulePath = join(opts.runtimeDir, 'rules', 'podium-session-context.mdc')
    const manifest = `${JSON.stringify(
      {
        name: 'podium-session-context',
        displayName: 'Podium Session Context',
        version: '1.0.0',
        description: 'Machine-authored instructions supplied by Podium for this session.',
        author: { name: 'Podium' },
        license: 'MIT',
      },
      null,
      2,
    )}\n`
    const rule = `---\ndescription: Podium session context\nalwaysApply: true\n---\n\n${instructions}\n`
    // No effort flag (capabilities.effortFlag 'none') and no argv prompt.
    return {
      cmd: resolveCursorBin(),
      args: [...args, '--plugin-dir', opts.runtimeDir],
      cwd: opts.cwd,
      files: [
        { path: manifestPath, contents: manifest },
        { path: rulePath, contents: rule },
      ],
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
      const context = opts.contextPrompt?.trim()
      const prompt = [sys, context, opts.prompt].filter(Boolean).join('\n\n---\n\n')
      return {
        cmd: bins.cursor(),
        args: [
          '-p',
          '--resume',
          opts.sessionId ?? '',
          ...(model ? ['--model', model] : []),
          ...(opts.permissionMode === 'auto' ? ['--auto-review'] : []),
          prompt,
        ],
      }
    },
  },

  state: cursorStateProvider,

  // No hook channel — a polling observer discovers/pins the chat and tails its
  // per-chat transcript file.
  observer(input, host) {
    const transcriptPathFor = (chatId: string): string =>
      cursorSessionPaths({
        cwd: input.cwd,
        chatId,
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      }).transcriptPath
    // With a known chat id the transcript path is derivable — tail immediately
    // so reattached chat has history before new activity.
    if (input.resumeValue) host.tailFile(transcriptPathFor(input.resumeValue))
    const obs = observeCursorState({
      cwd: input.cwd,
      ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
      onSession: (chatId) => {
        host.onResumeValue(chatId)
        host.tailFile(transcriptPathFor(chatId))
      },
      onEvents: (events) => host.onStateEvents(events),
    })
    return { stop: () => obs.stop() }
  },

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
