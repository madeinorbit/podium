import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_CAPABILITIES } from '@podium/protocol'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import { claudeCodeStateProvider } from '../../agent-state/claude-code.js'
import { claudeProjectSlug, locateClaudeSessionFile } from '../../agent-state/claude-locate.js'
import { createClaudeCodeConversationProvider } from '../../discovery/providers/claude-code.js'
import { type HarnessAdapter, isSet, type TranscriptSourceInput } from '../adapter.js'
import { ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER } from '../issue-system-pointer.js'

// The claude session_id (resume value) IS the JSONL basename. The locator
// tries the current-cwd bucket first, then sweeps all buckets — session.cwd is
// mutable (worktree moves restamp it) while the file stays in the bucket of
// the cwd it was CREATED under (docs/spec/conversation-registry.md §3.3).
async function chainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  const path = await locateClaudeSessionFile({
    cwd: input.cwd,
    resumeValue: input.resumeValue,
    ...(input.pathHint ? { pathHint: input.pathHint } : {}),
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  })
  return path ? [path] : []
}

export const claudeCodeAdapter: HarnessAdapter = {
  kind: 'claude-code',
  capabilities: AGENT_CAPABILITIES['claude-code'],
  resumeKind: 'claude-session',

  launch(opts) {
    return {
      cmd: 'claude',
      args: [
        ...(opts.resume ? ['--resume', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
        ...(isSet(opts.effort) ? ['--effort', opts.effort] : []),
        '--append-system-prompt',
        `${ISSUE_SYSTEM_POINTER}\n\n${SPEC_SYSTEM_POINTER}`,
        ...(opts.initialPrompt?.trim() ? [opts.initialPrompt] : []),
      ],
      cwd: opts.cwd,
    }
  },

  exec(opts) {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    return {
      cmd: 'claude',
      args: [
        '-p',
        ...(sys ? ['--append-system-prompt', sys] : []),
        ...(model ? ['--model', model] : []),
        // MCP gives the orchestrator Podium's own tools (list/start/steer agents);
        // --allowedTools pre-approves them (and read-only built-ins) so they run
        // without a permission prompt in headless print mode.
        ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
        ...(opts.allowedTools && opts.allowedTools.length > 0
          ? ['--allowedTools', opts.allowedTools.join(',')]
          : []),
      ],
      // NO trailing prompt positional: --allowedTools is variadic and would
      // swallow it as junk tool rules, leaving claude promptless ("Input must
      // be provided either through stdin or as a prompt argument"). `-p` with
      // stdin is the documented headless mode and dodges ARG_MAX too.
      stdin: opts.prompt,
    }
  },

  headless: {
    // One turn through the Claude Agent SDK; the first turn mints the session id
    // via the SDK's `sessionId` (a server-minted UUID) so the thread ↔ transcript
    // binding is deterministic. The SDK builds its own invocation — no buildExec.
    driver: 'claude-sdk',
    resumeIdAllocation: 'sdk-session-uuid',
  },

  state: claudeCodeStateProvider,

  // Claude Code needs no polling state observer — state arrives on the hook
  // channel. Observation here is the transcript-tail bootstrap: eagerly tail
  // the session's resume transcript (the JSONL the harness is already writing)
  // so the chat view has history before the first hook fires. Essential on
  // reattach: a fresh daemon's tail registry is empty and an idle survivor
  // fires no hook to register one, so chat would stay blank while the PTY
  // scrollback (native view) still shows the whole conversation. Hooks remain
  // a fast-path: when one lands, its transcript_path re-points the tail at the
  // live file.
  observer(input, host) {
    // Honor a discovery homeDir override (tests / isolated HOME) so the live
    // tail reads the SAME location the on-demand read source does — otherwise
    // a daemon run against an isolated home would tail the real ~/.claude and
    // find nothing.
    const home = input.homeDir ?? homedir()
    const resumeValue = input.resumeValue
    if (resumeValue) {
      void (async () => {
        // Locate, don't derive: after a worktree move the file lives in the
        // ORIGINAL cwd's bucket (docs/spec/conversation-registry.md §3.3). Fall
        // back to the derived path when nothing exists yet — a fresh resume
        // creates the file a moment later and the tailer waits on it. Reattach
        // carries the server's recorded segment path (pathHint) — evidence
        // beats cwd derivation.
        const located = await locateClaudeSessionFile({
          cwd: input.cwd,
          resumeValue,
          ...(input.pathHint ? { pathHint: input.pathHint } : {}),
          homeDir: home,
        })
        host.tailFile(
          located ??
            join(home, '.claude', 'projects', claudeProjectSlug(input.cwd), `${resumeValue}.jsonl`),
        )
      })()
    } else {
      // No resume ref (a fresh spawn that hasn't yet reported a session id, or
      // a reattach where the server never learned the resume value): fall back
      // to the cwd bucket's chain. NOTE: chainPaths resolves the SPECIFIC
      // conversation by resume value, so without one this resolves nothing
      // today — the first hook's transcript_path binds the tail instead.
      void (async () => {
        const paths = await chainPaths({ cwd: input.cwd, homeDir: home })
        const newest = paths.at(-1)
        if (newest) host.tailFile(newest)
      })()
    }
    // Nothing to stop — the host owns the tail registry, and hooks (not a
    // poller) drive state.
    return { stop() {} }
  },

  discovery: createClaudeCodeConversationProvider(),

  transcript: {
    storage: 'file-chain',
    chainPaths,
    async sourceFor(input) {
      const chain = (await chainPaths(input)).map((p) => ({ path: p, fileId: fileIdFor(p) }))
      return fileChainSource(chain, recordToItemsForKind('claude-code'))
    },
  },
}
