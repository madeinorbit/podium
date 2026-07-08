import { stat } from 'node:fs/promises'
import type { AgentCapabilities, HarnessAgent, ResumeRef } from '@podium/protocol'
import type { TranscriptSource } from '@podium/transcript'
import type { AgentStateProvider } from '../agent-state/types.js'
import type { ConversationProvider } from '../discovery/types.js'

/** The harness kinds — every AgentKind except 'shell' (a shell is spawned by the
 *  daemon directly; it has no CLI conventions, transcript, or observers). */
export type HarnessKind = HarnessAgent

// ---------------------------------------------------------------------------
// Launch (interactive PTY spawn) — the agentLaunchCommand axis.
// ---------------------------------------------------------------------------

export interface HarnessLaunchOptions {
  /** Working directory the agent runs in (a project or worktree path). */
  cwd: string
  /** Present to resume an existing on-disk conversation; absent to start fresh. */
  resume?: ResumeRef
  /** Model override from settings; absent (or 'auto') = the CLI's own default. */
  model?: string
  /** Reasoning-effort override; absent (or 'auto') = the CLI's own default. */
  effort?: string
  /** A first prompt handed as a trailing positional argv token where the CLI
   *  supports it (capabilities.argvPrompt); ignored otherwise. */
  initialPrompt?: string
}

export interface LaunchSpec {
  cmd: string
  args: string[]
  cwd: string
}

// ---------------------------------------------------------------------------
// One-shot exec (superagent full-harness turn) — the buildHarnessExec axis.
// ---------------------------------------------------------------------------

export interface HarnessExecOptions {
  prompt: string
  model?: string
  systemPrompt?: string
  /** Path to a written MCP config JSON (Claude `--mcp-config`). */
  mcpConfigPath?: string
  /** The raw MCP config JSON ({ mcpServers: { name: { url, headers } } }). */
  mcpConfig?: string
  /** Tools pre-approved so they run headlessly without a permission prompt. */
  allowedTools?: string[]
}

export interface HarnessExecSpec {
  cmd: string
  args: string[]
  /** Delivered on the child's stdin (then EOF) — Claude's headless prompt path. */
  stdin?: string
}

/** Bin resolvers for agents whose executable path isn't a fixed name. */
export interface HarnessBins {
  opencode: () => string
  cursor: () => string
}

// ---------------------------------------------------------------------------
// Headless sessions (persistent, process-per-turn) — the headless-drivers axis.
// ---------------------------------------------------------------------------

export interface HeadlessExecOptions {
  prompt: string
  model?: string
  effort?: string
  systemPrompt?: string
  mcpConfig?: string
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** The pinned harness session id (pre-minted for grok/cursor). */
  sessionId?: string
}

export interface HarnessHeadless {
  /**
   * Which daemon driver runs a turn:
   *   'claude-sdk'  — the Claude Agent SDK (in-process query, partial events);
   *   'codex-json'  — `codex exec --json` child with a typed event stream;
   *   'resume-exec' — session-pinned one-shot child (grok/opencode/cursor).
   */
  driver: 'claude-sdk' | 'codex-json' | 'resume-exec'
  /**
   * How the persistent session id is allocated on the FIRST turn:
   *   'sdk-session-uuid' — server-minted UUID passed via the SDK's sessionId;
   *   'stream-captured'  — the harness mints it; captured from its JSON stream;
   *   'daemon-minted-uuid' — daemon mints a UUID (grok -s is create-or-resume);
   *   'create-chat'      — pre-allocated via a CLI call (cursor create-chat).
   */
  resumeIdAllocation: 'sdk-session-uuid' | 'stream-captured' | 'daemon-minted-uuid' | 'create-chat'
  /** Pure argv builder for the child-process drivers. Absent for 'claude-sdk'
   *  (the SDK builds its own invocation). */
  buildExec?: (opts: HeadlessExecOptions, bins: HarnessBins) => { cmd: string; args: string[] }
}

// ---------------------------------------------------------------------------
// Transcript reads.
// ---------------------------------------------------------------------------

export interface TranscriptSourceInput {
  cwd: string
  resumeValue?: string
  /** Recorded segment evidence: absolute transcript path, checked before any
   *  cwd-derived location (conversation registry §3.3). */
  pathHint?: string
  homeDir?: string
}

export interface HarnessTranscript {
  storage: 'file-chain' | 'sqlite'
  /** Ordered oldest→newest JSONL files for a session ('file-chain' storage only).
   *  Every file-based harness resolves the SPECIFIC conversation by its resume
   *  value — a cwd bucket holds many DISTINCT conversations, so globbing the
   *  bucket would merge unrelated sessions; no resume value ⇒ []. */
  chainPaths?(input: TranscriptSourceInput): Promise<string[]>
  /** Resolve this session's transcript read source (file chain or DB-backed). */
  sourceFor(input: TranscriptSourceInput): Promise<TranscriptSource>
}

// ---------------------------------------------------------------------------
// The adapter — ONE object per harness; the registry is the only dispatch.
// ---------------------------------------------------------------------------

/**
 * Everything Podium needs to drive one coding-agent CLI (#158). A new harness
 * is ONE adapter file + a registry entry (the exhaustive Record makes a missing
 * kind a type error) + its AGENT_CAPABILITIES row in @podium/protocol. The
 * daemon keeps two small per-kind tables of its own (observer wiring and the
 * headless driver bodies) — both keyed by the same HarnessKind and exhaustive,
 * so they fail the same way when a kind is missing.
 */
export interface HarnessAdapter {
  kind: HarnessKind
  /** This harness's row of the protocol capability table (@podium/protocol). */
  capabilities: AgentCapabilities
  /** The resume.kind stamped on this harness's native conversations. */
  resumeKind: string
  /** Interactive spawn command (fresh vs resume, model/effort flags, argv prompt). */
  launch(opts: HarnessLaunchOptions): LaunchSpec
  /** One-shot full-harness turn (`claude -p` / `codex exec` …). */
  exec(opts: HarnessExecOptions, bins: HarnessBins): HarnessExecSpec
  headless: HarnessHeadless
  /** Hook/observer state provider; undefined ⇒ phase stays 'unknown'. */
  state: AgentStateProvider | undefined
  /** Native-conversation discovery provider. */
  discovery: ConversationProvider
  transcript: HarnessTranscript
}

/** 'auto' (or empty) is the sentinel for "no override" — the CLI decides. */
export function isSet(value: string | undefined): value is string {
  return !!value && value !== 'auto'
}

/** Shared by the file-chain adapters' `chainPaths` existence checks. */
export async function transcriptFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
