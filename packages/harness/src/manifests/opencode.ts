import { join } from 'node:path'
import {
  type OpencodeMessagePartRow,
  sliceItemsByAnchor,
  stampOpencodeItems,
  type TranscriptSource,
} from '@podium/transcript'
import { observeOpencodeState, opencodeStateProvider } from '../agent-state/opencode.js'
import { createOpencodeConversationProvider } from '../discovery/providers/opencode.js'
import { composeAgentInstructions } from '../instructions.js'
import { type AgentManifest, isSet, supported, unsupported } from '../manifest.js'
import { opencodeBinCandidates, resolveOpencodeBin } from '../opencode/cli.js'
import { loadOpencodeTranscriptTail, openOpencodeDb } from '../opencode/db.js'

/**
 * Source for opencode. opencode stores transcript "parts" in SQLite ordered by
 * `(time_updated ASC, id ASC)`. A single session's parts are bounded (≤8000, the
 * `loadOpencodeTranscriptTail` cap), so loading them in one indexed query is
 * cheap and IS the bounded read — there is no per-call full-DB scan beyond this
 * one session's capped part list. We then build the full ordered item list and
 * index-slice it in memory, exactly matching `readTranscriptSlice`'s semantics.
 */
export function opencodeDbSource(input: { sessionId: string; homeDir?: string }): TranscriptSource {
  return {
    readSlice: async (opts) => {
      if (opts.limit <= 0) return { items: [], hasMore: false }
      const db = openOpencodeDb(input.homeDir)
      if (!db) return { items: [], hasMore: false }
      let rows: OpencodeMessagePartRow[]
      try {
        rows = loadOpencodeTranscriptTail(db, input.sessionId)
      } catch {
        return { items: [], hasMore: false }
      } finally {
        db.close()
      }
      // ASC by (time_updated, id); each part expands to 0..N stamped items in
      // intra-part order, so `all` is the session's full transcript in total order.
      const all = stampOpencodeItems(rows, input.sessionId)
      return sliceItemsByAnchor(all, opts)
    },
  }
}

export const opencodeManifest: AgentManifest = {
  kind: 'opencode',
  displayName: 'opencode',
  capabilities: {
    argvPrompt: false,
    effortFlag: 'variant',
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
  },
  resumeKind: 'opencode-session',

  inventory: {
    binCandidates: opencodeBinCandidates,
    detectLogin: () => ({ state: 'unknown' }),
  },

  launch(opts) {
    const base = {
      cmd: resolveOpencodeBin(),
      args: [
        ...(opts.resume ? ['--session', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['-m', opts.model] : []),
        ...(isSet(opts.effort) ? ['--variant', opts.effort] : []),
      ],
      cwd: opts.cwd,
    }
    const instructions = composeAgentInstructions(opts.instructions)
    if (!instructions) return base
    if (!opts.runtimeDir)
      throw new Error('opencode launch requires an instruction runtime directory')
    const instructionPath = join(opts.runtimeDir, 'podium-instructions.md')
    let config: Record<string, unknown>
    try {
      config = JSON.parse(
        opts.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? '{}',
      ) as Record<string, unknown>
    } catch {
      throw new Error('malformed OPENCODE_CONFIG_CONTENT — refusing to discard existing config')
    }
    const configuredInstructions = Array.isArray(config.instructions)
      ? config.instructions.filter((item): item is string => typeof item === 'string')
      : []
    return {
      ...base,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...config,
          instructions: [...configuredInstructions, instructionPath],
        }),
      },
      files: [{ path: instructionPath, contents: instructions }],
    }
  },

  exec: supported((opts, bins) => {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return { cmd: bins.opencode(), args: ['run', ...(model ? ['-m', model] : []), prompt] }
  }),

  headless: supported({
    driver: 'resume-exec',
    // First turn has no id (opencode mints ses_… internally; captured from the
    // --format json event stream); later turns pin with -s.
    resumeIdAllocation: 'stream-captured',
    buildExec: supported((opts, bins) => {
      const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
      const sys = opts.systemPrompt?.trim()
      const context = opts.contextPrompt?.trim()
      const prompt = [sys, context, opts.prompt].filter(Boolean).join('\n\n---\n\n')
      return {
        cmd: bins.opencode(),
        args: [
          'run',
          '--format',
          'json',
          ...(opts.resumeValue ? ['-s', opts.resumeValue] : []),
          ...(model ? ['-m', model] : []),
          prompt,
        ],
      }
    }),
  }),

  state: supported(opencodeStateProvider),

  // No hook channel and no file to tail (SQLite store): the observer polls the
  // DB, discovers the session, and pushes live transcript items itself. Items
  // are already cursor-stamped (stampOpencodeItems), so the live delta carries
  // the same cursors the on-demand read produces.
  observer: supported((input, host) => {
    const obs = observeOpencodeState({
      cwd: input.cwd,
      ...(input.statTick ? { statTick: input.statTick } : {}),
      ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
      onSession: (opencodeSessionId) => host.onResumeValue(opencodeSessionId),
      onEvents: (events) => host.onStateEvents(events),
      onTranscriptItems: (items, reset) => host.onTranscriptItems(items, reset),
    })
    return { stop: () => obs.stop() }
  }),

  discovery: createOpencodeConversationProvider(),

  transcript: supported({
    // SQLite-backed — no file chain; the DB adapter serves the same cursor
    // contract as the chain reader.
    storage: 'sqlite',
    recordToItems: unsupported('opencode maps typed SQLite rows rather than native JSONL records'),
    chainPaths: unsupported('opencode stores transcripts in SQLite — there are no files to chain'),
    async sourceFor(input) {
      // No resume value → nothing to read; hand back an inert empty source so
      // the caller need not special-case it.
      if (!input.resumeValue) {
        return { readSlice: async () => ({ items: [], hasMore: false }) }
      }
      return opencodeDbSource({
        sessionId: input.resumeValue,
        ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
      })
    },
  }),

  classifyBrowserOpen: unsupported(
    'no catalogued opencode login/link domains yet — the daemon generic redirect_uri heuristic decides (POD-738)',
  ),
}
