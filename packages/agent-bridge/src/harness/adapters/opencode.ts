import { AGENT_CAPABILITIES } from '@podium/protocol'
import {
  type OpencodeMessagePartRow,
  sliceItemsByAnchor,
  stampOpencodeItems,
  type TranscriptSource,
} from '@podium/transcript'
import { observeOpencodeState, opencodeStateProvider } from '../../agent-state/opencode.js'
import { createOpencodeConversationProvider } from '../../discovery/providers/opencode.js'
import { resolveOpencodeBin } from '../../opencode/cli.js'
import { loadOpencodeTranscriptTail, openOpencodeDb } from '../../opencode/db.js'
import { type HarnessAdapter, isSet } from '../adapter.js'

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

export const opencodeAdapter: HarnessAdapter = {
  kind: 'opencode',
  capabilities: AGENT_CAPABILITIES.opencode,
  resumeKind: 'opencode-session',

  launch(opts) {
    return {
      cmd: resolveOpencodeBin(),
      args: [
        ...(opts.resume ? ['--session', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['-m', opts.model] : []),
        ...(isSet(opts.effort) ? ['--variant', opts.effort] : []),
      ],
      cwd: opts.cwd,
    }
  },

  exec(opts, bins) {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return { cmd: bins.opencode(), args: ['run', ...(model ? ['-m', model] : []), prompt] }
  },

  headless: {
    driver: 'resume-exec',
    // First turn has no id (opencode mints ses_… internally; captured from the
    // --format json event stream); later turns pin with -s.
    resumeIdAllocation: 'stream-captured',
    buildExec(opts, bins) {
      const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
      const sys = opts.systemPrompt?.trim()
      const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
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
    },
  },

  state: opencodeStateProvider,

  // No hook channel and no file to tail (SQLite store): the observer polls the
  // DB, discovers the session, and pushes live transcript items itself. Items
  // are already cursor-stamped (stampOpencodeItems), so the live delta carries
  // the same cursors the on-demand read produces.
  observer(input, host) {
    const obs = observeOpencodeState({
      cwd: input.cwd,
      ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
      onSession: (opencodeSessionId) => host.onResumeValue(opencodeSessionId),
      onEvents: (events) => host.onStateEvents(events),
      onTranscriptItems: (items, reset) => host.onTranscriptItems(items, reset),
    })
    return { stop: () => obs.stop() }
  },

  discovery: createOpencodeConversationProvider(),

  transcript: {
    // SQLite-backed — no file chain; the DB adapter serves the same cursor
    // contract as the chain reader.
    storage: 'sqlite',
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
  },
}
