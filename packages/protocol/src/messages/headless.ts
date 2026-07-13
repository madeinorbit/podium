import { z } from 'zod'
import { HarnessAgent } from './harness'
import { AgentKind } from './terminal'

// ---- Headless harness sessions (concierge unification, Phase A) ----
// A headless session is a persistent harness session driven turn-by-turn by the
// daemon (Claude Agent SDK / `codex exec resume` / session-pinned one-shots)
// with NO PTY — the harness owns context via its resume id, and its transcript
// file feeds the normal tail → transcriptDelta pipeline. The request/result
// frames live below; the event schemas are defined first because the
// server→web activity frame joins the ServerMessage union.

/** Mid-turn progress from the daemon driver: cumulative partial assistant text
 *  (claude/codex only) or a coarse status change. Small on purpose — the real
 *  transcript items arrive via the transcript tail; these only animate the turn. */
export const HeadlessTurnEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('partial-text'),
    /** Cumulative text of the CURRENT assistant message (not a delta). */
    text: z.string(),
    /** Driver-specific hint identifying the in-progress item (message uuid/item id). */
    itemHint: z.string().optional(),
  }),
  z.object({
    kind: z.literal('status'),
    status: z.enum(['starting', 'running', 'tool']),
    /** Human label (e.g. the tool name) for status 'tool'. */
    label: z.string().optional(),
  }),
])
export type HeadlessTurnEvent = z.infer<typeof HeadlessTurnEvent>

// server -> web: live turn activity for a headless session (Phase B emits it;
// schema defined now). Extends the turn event with turn boundary markers.
export const HeadlessActivityEvent = z.discriminatedUnion('kind', [
  ...HeadlessTurnEvent.options,
  z.object({ kind: z.literal('turn-start') }),
  z.object({ kind: z.literal('turn-end'), error: z.string().optional() }),
])
export type HeadlessActivityEvent = z.infer<typeof HeadlessActivityEvent>
export const HeadlessActivityMessage = z.object({
  type: z.literal('headlessActivity'),
  sessionId: z.string(),
  event: HeadlessActivityEvent,
})
export type HeadlessActivityMessage = z.infer<typeof HeadlessActivityMessage>

// server -> daemon: run one turn of a headless harness session.
export const HeadlessTurnRequestMessage = z.object({
  type: z.literal('headlessTurnRequest'),
  requestId: z.string(),
  /** Stable across server/daemon restarts. The daemon uses this to reattach to
   *  (or return the completed result of) the same durable abduco turn. */
  turnId: z.string(),
  sessionId: z.string(),
  /** Superagent thread this turn belongs to (opaque to the daemon). */
  threadId: z.string(),
  agent: HarnessAgent,
  model: z.string().optional(),
  effort: z.string().optional(),
  cwd: z.string(),
  /** The human-authored text only. Machine context is carried separately so
   *  harnesses with a native hidden instruction channel need not fold it into
   *  the transcript's visible user message. */
  prompt: z.string(),
  contextPrompt: z.string().optional(),
  systemPrompt: z.string().optional(),
  /** MCP config JSON ({ mcpServers: … }), same shape harnessExec takes. */
  mcpConfig: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  permissionMode: z.string().optional(),
  /** Harness session id to resume; absent = first turn (mint a new session). */
  resumeValue: z.string().optional(),
  /** Claude only: mint the session with this UUID on the first turn so the
   *  thread ↔ transcript binding is deterministic. */
  sessionUuid: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
})
export const HeadlessInterruptMessage = z.object({
  type: z.literal('headlessInterrupt'),
  requestId: z.string(),
  sessionId: z.string(),
})
export const HeadlessTurnAckMessage = z.object({
  type: z.literal('headlessTurnAck'),
  turnId: z.string(),
  sessionId: z.string(),
})
// server -> daemon: (re)establish the per-kind transcript observers/tails for a
// headless session — exactly what reattach does for a PTY session, minus the PTY.
export const HeadlessBindMessage = z.object({
  type: z.literal('headlessBind'),
  requestId: z.string(),
  sessionId: z.string(),
  agentKind: AgentKind,
  cwd: z.string(),
  resumeValue: z.string(),
})

// daemon -> server
export const HeadlessTurnEventMessage = z.object({
  type: z.literal('headlessTurnEvent'),
  requestId: z.string(),
  sessionId: z.string(),
  event: HeadlessTurnEvent,
})
export const HeadlessTurnResultMessage = z.object({
  type: z.literal('headlessTurnResult'),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  /** The harness's own session id (resume value for the next turn). */
  harnessSessionId: z.string().optional(),
  /** Final assistant text — durability/fallback; the transcript tail is canonical. */
  output: z.string().optional(),
})
export const HeadlessBindResultMessage = z.object({
  type: z.literal('headlessBindResult'),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
})
