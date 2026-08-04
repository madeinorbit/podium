import { join } from 'node:path'
import { cursorRecordToItems } from '@podium/transcript'
import { cursorStateProvider, observeCursorState } from '../agent-state/cursor.js'
import { withStateChannel } from '../agent-state/types.js'
import { cursorBinCandidates, resolveCursorBin } from '../cursor/cli.js'
import { cursorSessionPaths } from '../cursor/paths.js'
import { createCursorConversationProvider } from '../discovery/providers/cursor.js'
import { composeAgentInstructions } from '../instructions.js'
import {
  type AgentManifest,
  fileTranscript,
  isSet,
  supported,
  type TranscriptSourceInput,
  transcriptFileExists,
  unsupported,
} from '../manifest.js'

async function chainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  const path = cursorSessionPaths({
    cwd: input.cwd,
    chatId: input.resumeValue,
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  }).transcriptPath
  return (await transcriptFileExists(path)) ? [path] : []
}

export const cursorManifest: AgentManifest = {
  kind: 'cursor',
  displayName: 'Cursor',
  capabilities: {
    argvPrompt: false,
    effortFlag: 'none',
    systemPromptFlag: false,
    quota: false,
    cloud: false,
    composerScrape: false,
    oscTitle: true,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: false,
    mcp: 'none',
    hookInstall: 'none',
    observationProvider: 'none',
    observationProtocol: 'generic',
    submitVerification: false,
    exclusiveInteractiveResume: false,
    promptTitleFallback: false,
    mcpConfigTransport: 'none',
  },
  resumeKind: 'cursor-chat',

  inventory: {
    binCandidates: (homeDir) => [...cursorBinCandidates(homeDir), 'cursor-agent'],
    loginIdentity: unsupported('Cursor does not expose a stable local account identity yet'),
    portableCredential: unsupported('Cursor credential portability is not supported yet'),
    // Cursor deliberately installs as the generic `agent` executable. Grok also
    // exposes an `agent` alias, so require Cursor's own help marker before
    // reporting this machine as Cursor-capable.
    identityProbe: {
      args: ['--help'],
      accepts: (output) => output.includes('Cursor Agent'),
    },
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

  exec: supported((opts, bins) => {
    // Cursor can persist a named CLI default that the current account cannot use;
    // pin Podium's absent/auto selection to Cursor's real Auto model.
    const model = opts.model || 'auto'
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return { cmd: bins.cursor(), args: ['-p', '--model', model, prompt] }
  }),

  headless: supported({
    driver: 'resume-exec',
    outputFormat: 'text',
    // The chat id is pre-allocated with `cursor-agent create-chat` (bare UUID
    // on stdout) so even the first turn runs pinned via --resume.
    resumeIdAllocation: 'create-chat',
    buildExec: supported((opts, bins) => {
      // A preallocated chat otherwise inherits Cursor's persisted named model.
      // Pin Auto explicitly when Podium supplied no model override.
      const model = opts.model || 'auto'
      const sys = opts.systemPrompt?.trim()
      const context = opts.contextPrompt?.trim()
      const prompt = [sys, context, opts.prompt].filter(Boolean).join('\n\n---\n\n')
      return {
        cmd: bins.cursor(),
        args: [
          '-p',
          '--resume',
          opts.sessionId ?? '',
          '--model',
          model,
          ...(opts.permissionMode === 'auto' ? ['--auto-review'] : []),
          prompt,
        ],
      }
    }),
  }),

  state: supported(cursorStateProvider),
  stateChannels: [
    {
      source: 'poll',
      confidence: 0.7,
      mechanism: 'Cursor per-chat transcript tail; turn_ended is the turn boundary',
    },
  ],

  // No hook channel — a polling observer discovers/pins the chat and tails its
  // per-chat transcript file.
  observer: supported((input, host) => {
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
      ...(input.statTick ? { statTick: input.statTick } : {}),
      ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
      onSession: (chatId) => {
        host.onResumeValue(chatId)
        host.tailFile(transcriptPathFor(chatId))
      },
      onEvents: (events) => host.onStateEvents(withStateChannel(events, 'poll')),
    })
    return { stop: () => obs.stop() }
  }),

  discovery: createCursorConversationProvider(),

  transcript: supported(fileTranscript(chainPaths, cursorRecordToItems)),

  handoffTranscript: unsupported('cross-machine handoff is not supported for cursor sessions'),

  classifyBrowserOpen: unsupported(
    'no catalogued cursor login/link domains yet — the daemon generic redirect_uri heuristic decides (POD-738)',
  ),
}
