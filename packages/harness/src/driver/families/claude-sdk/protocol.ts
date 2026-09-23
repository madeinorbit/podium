// packages/harness/src/driver/families/claude-sdk/protocol.ts
//
// THE CLAUDE STREAM-JSON WIRE (POD-4499): the family speaks the `claude` CLI's
// stream-json control protocol directly, over a line transport someone else
// owns — a host attachment for sessions (see ./engine-host.js), a direct pipe
// for one-shot daemon turns. No SDK, no helper process, no fork: `grep
// child_process` in this directory must stay empty (spec §7), and the daemon
// never loads `@anthropic-ai/claude-agent-sdk` (claude-sdk-isolation.test.ts).
//
// WHAT THE PROTOCOL IS. The Agent SDK (0.3.201, read from its bundle —
// `spawnClaudeCodeProcess` exists precisely so the transport can be replaced)
// is a thin client: it spawns
//   claude --output-format stream-json --verbose --input-format stream-json …
// and talks JSON lines over stdio. Parent → CLI: `control_request/initialize`
// once (system prompt, hooks and MCP servers ride the payload, not argv),
// `user` message lines per turn, `control_response` answers, and
// `control_request/interrupt` for stops. CLI → parent: `control_response`
// (initialize verdict, interrupt acks), `control_request` (`can_use_tool`
// permission asks, `hook_callback`, `elicitation`, `request_user_dialog`,
// token refreshes), and the `system`/`stream_event`/`assistant`/`user`/
// `result` transcript messages the old SDK host already mapped (the mapping
// below is that mapping, moved — not rewritten).
//
// WHAT IS DELIBERATELY NOT HERE. In-process SDK callbacks (`hooks`,
// `createSdkMcpServer` instances, `sessionStore` mirroring, OAuth refresh):
// every one needs the SDK parent to exist, which is what this issue removes.
// What Podium actually sets — permission answers, MCP over `--mcp-config`,
// model/effort/permission-mode, system-prompt append — travels on the wire
// below. The rest is listed as lost in the ADR paragraph (docs/adr/0011).
//
// COMPAT RISK, STATED PLAINLY. The shapes below are recovered from the SDK
// bundle, not from a CLI contract: the initialize payload, the user line, the
// interrupt round-trip and `reinitialize()` (which the SDK documents for
// exactly the transport-gap adopt this family does) are all in-bundle facts,
// but no authenticated `claude` CLI exists in this environment to answer. The
// hermetic stub in the survival test speaks this file's shapes; real-CLI
// interop is verified by a live run, recorded in VERIFY.

import { randomUUID } from 'node:crypto'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { HeadlessTurnFailure } from '../turn-error.js'
import { formatClaudeSdkResultFailure, redactClaudeSdkFailureDetail } from './classify.js'

export { HeadlessTurnFailure }

/** How long a turn may run before the client interrupts and kills its grace. */
export const CLAUDE_STREAM_DEFAULT_TURN_TIMEOUT_MS = 600_000
/**
 * How long an operator interrupt waits for the CLI's own verdict before the
 * answer degrades to `unconfirmed`. Bounds the REPORT, not the wind-down —
 * the operator is owed an answer while still looking at the stop.
 */
export const CLAUDE_STREAM_INTERRUPT_ACK_MS = 5_000

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'plan',
  'dontAsk',
])

/**
 * THE TURN, as this family reads it: prompt facts plus supervisor facts. The
 * executable arrives resolved (inventory); argv building never resolves twice.
 */
export interface ClaudeStreamTurnSpec {
  prompt: string
  cwd: string
  model?: string
  effort?: string
  systemPrompt?: string
  contextPrompt?: string
  /** The raw MCP config JSON ({ mcpServers: { name: { url, headers } } }). */
  mcpConfig?: string
  /** Tools pre-approved so they run headlessly without a permission prompt. */
  allowedTools?: string[]
  permissionMode?: string
  /** Fail-closed capability request. `none` means the adapter must remove every tool. */
  toolPolicy?: 'none'
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** Mint the first-turn session with this UUID. */
  sessionUuid?: string
  /** Route tool authorization through structured driver interactions. */
  structuredPermissions?: true
  /** Instance-owned child environment (HOME + CLI/session routing). */
  env?: Record<string, string>
  timeoutMs?: number
}

/**
 * The `claude` CLI invocation for a streaming-input session.
 *
 * Mirrors what the SDK itself passes when it spawns the CLI (bundle-read):
 * `--output-format stream-json --verbose --input-format stream-json`, then
 * model/effort/permission/tool flags. The system prompt is NOT argv — the SDK
 * carries it in the `initialize` control payload (see `initializePayload`),
 * and so do we. MCP servers ride `--mcp-config` as INLINE JSON (the SDK's
 * shape, not the `-p` path's staged file). `toolPolicy: 'none'` removes tools
 * and setting sources rather than merely declining to mount them.
 */
export function buildClaudeStreamInvocation(
  spec: ClaudeStreamTurnSpec,
  executable: string,
): { cmd: string; args: string[] } {
  const mode: string =
    spec.permissionMode && PERMISSION_MODES.has(spec.permissionMode)
      ? spec.permissionMode
      : spec.structuredPermissions
        ? 'default'
        : 'auto'
  const args = [
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    mode,
    ...(mode === 'bypassPermissions' ? ['--allow-dangerously-skip-permissions'] : []),
    ...(spec.model && spec.model !== 'auto' ? ['--model', spec.model] : []),
    ...(spec.effort && EFFORT_LEVELS.has(spec.effort) ? ['--effort', spec.effort] : []),
    ...(spec.structuredPermissions ? ['--permission-prompt-tool', 'stdio'] : []),
    ...(spec.allowedTools && spec.allowedTools.length > 0 && spec.toolPolicy !== 'none'
      ? ['--allowedTools', spec.allowedTools.join(',')]
      : []),
    ...(spec.toolPolicy === 'none' ? ['--tools', ''] : []),
    ...(spec.mcpConfig && spec.toolPolicy !== 'none'
      ? ['--mcp-config', mcpConfigInline(spec.mcpConfig)]
      : []),
    // An empty settings-source list prevents user/project/local hooks, plugins,
    // and permissions from being inherited by a bounded repair turn.
    ...(spec.toolPolicy === 'none' ? ['--setting-sources', ''] : []),
    ...(spec.resumeValue
      ? ['--resume', spec.resumeValue]
      : spec.sessionUuid
        ? ['--session-id', spec.sessionUuid]
        : []),
  ]
  return { cmd: executable, args }
}

/**
 * The MCP servers the CLI actually mounts, as inline `--mcp-config` JSON.
 * Servers without a `url` are dropped; a config that parses to nothing mounts
 * nothing. Throws on malformed JSON — refusing a tool-less turn fail-closed,
 * exactly as the old SDK host did.
 */
export function mcpConfigInline(mcpConfig: string): string {
  let servers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>
  try {
    servers = (JSON.parse(mcpConfig) as { mcpServers?: typeof servers }).mcpServers ?? {}
  } catch {
    throw new Error('malformed MCP config — refusing a tool-less headless turn')
  }
  const out: Record<string, { type: string; url: string; headers?: Record<string, string> }> = {}
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.url) continue
    out[name] = {
      type: 'http',
      url: srv.url,
      ...(srv.headers ? { headers: srv.headers } : {}),
    }
  }
  return JSON.stringify({ mcpServers: out })
}

/**
 * The environment overlay the streaming child needs beyond the composed
 * child env. The CLI refuses `--allow-dangerously-skip-permissions` as root
 * unless IS_SANDBOX=1; without it every headless bypass turn on a root-run
 * daemon dies. Pure so both transports share it; `isRoot` arrives as a value.
 */
export function claudeStreamEnvOverlay(input: {
  permissionMode?: string
  isRoot: boolean
}): Record<string, string> {
  if (input.permissionMode === 'bypassPermissions' && input.isRoot) return { IS_SANDBOX: '1' }
  return {}
}

/**
 * The `initialize` control payload. The SDK sends hooks, in-process MCP
 * servers, JSON schema and full init config here; this family sends what it
 * owns: the appended system prompt (the orchestrator prompt APPENDS to the
 * claude_code preset — same posture as harness-exec's --append-system-prompt)
 * and nothing else. Every key is optional on the CLI side.
 */
export function initializePayload(spec: Pick<ClaudeStreamTurnSpec, 'systemPrompt' | 'contextPrompt'>): {
  subtype: 'initialize'
  appendSystemPrompt?: string
} {
  const append = [spec.systemPrompt, spec.contextPrompt].filter(Boolean).join('\n\n').trim()
  return append ? { subtype: 'initialize', appendSystemPrompt: append } : { subtype: 'initialize' }
}

/** One user turn, as the CLI reads it in streaming-input mode. Byte-identical
 *  in shape to what the SDK writes for a string prompt (`session_id: ""`,
 *  `parent_tool_use_id: null`): the conversation rides the one long-lived
 *  child, not the line. */
export function userMessageLine(prompt: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: null,
  })
}

/** The content blocks of a `user` message, whatever shape it arrived in. */
function userContentBlocks(
  content: unknown,
): readonly { type?: string; tool_use_id?: unknown; content?: unknown; is_error?: unknown }[] {
  if (!Array.isArray(content)) return []
  return content.filter(
    (
      block,
    ): block is { type?: string; tool_use_id?: unknown; content?: unknown; is_error?: unknown } =>
      typeof block === 'object' && block !== null,
  )
}

/**
 * Flatten a tool_result's content to text. Absent and empty both become `''`
 * on purpose (see the old host): the provider spells "printed nothing"
 * several ways and none of them mean the call did not return.
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (typeof part !== 'object' || part === null) continue
    const text = (part as { text?: unknown }).text
    if (typeof text === 'string' && text) parts.push(text)
  }
  return parts.join('\n')
}

/** A line transport someone else owns: a host attachment's WRITE + ring for
 *  sessions, a direct pipe pair for one-shot daemon turns. */
export interface ClaudeStreamTransport {
  writeLine(line: string): void
  /** One JSON object per line; returns an unsubscribe. */
  onLine(cb: (line: string) => void): () => void
  onExit(cb: (code: number | null, signal: string | null) => void): () => void
  close(): void
}

export interface ClaudeStreamPermissionRequest {
  id: string
  toolName: string
  input?: unknown
  suggestions?: readonly unknown[]
}

export interface ClaudeStreamToolCall {
  toolUseId: string
  toolName: string
  input?: unknown
}

export interface ClaudeStreamToolResult {
  toolUseId: string
  output: string
  isError?: boolean
}

export interface ClaudeStreamTurnOutcome {
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  harnessSessionId: string
  output: string
  observedModel?: string
  observedEffort?: string
}

export type ClaudeStreamEmit = (event: HeadlessTurnEvent) => void

/**
 * What the CLI did with one interrupt request. `unconfirmed` is not a
 * failure to model the world; it IS the world — a host killed while winding
 * down never reports back, so a verdict never received must stay
 * distinguishable from one that was.
 */
export type ClaudeStreamInterruptAck =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; detail: string }
  | { outcome: 'unconfirmed'; detail: string }

export interface ClaudeStreamTurnCallbacks {
  onPartialText(text: string, itemHint?: string): void
  onPermission(request: ClaudeStreamPermissionRequest): void
  onToolCall(call: ClaudeStreamToolCall): void
  onToolResult(result: ClaudeStreamToolResult): void
  emit(event: HeadlessTurnEvent): void
}

export interface ClaudeStreamTurn {
  done: Promise<ClaudeStreamTurnOutcome>
  /** Teardown's poke: fire and forget, deliberately unacknowledged. */
  interrupt(): void
  /** The operator's interrupt, which owes an answer. Absent verdict → unconfirmed, never success. */
  requestInterrupt(): Promise<ClaudeStreamInterruptAck>
  answerPermission(
    interactionId: string,
    answer: { decision: 'allow-once' | 'allow-always' | 'deny'; feedback?: string },
  ): void
}

export interface ClaudeStreamClient {
  /** Resolves once initialize is answered, with the harness session id: the
   *  CLI-reported one, else the one the invocation named — or, with neither,
   *  once the CLI reports one. Never a gate on the first user line. */
  readonly ready: Promise<string>
  /** Run one turn over the long-lived child. Strictly serial: one open turn. */
  turn(prompt: string, callbacks: ClaudeStreamTurnCallbacks): ClaudeStreamTurn
  answerPermission(
    interactionId: string,
    answer: { decision: 'allow-once' | 'allow-always' | 'deny'; feedback?: string },
  ): void
  close(): void
}

interface PendingPermission {
  /** The CLI's own `request_id`: what the `control_response` must echo. Kept
   *  apart from the interaction id Podium answers with — the SDK keeps the
   *  same two identities, and conflating them answers a question nobody asked. */
  cliRequestId: string
  input: Record<string, unknown>
  suggestions?: readonly unknown[]
  toolUseId: string
}

interface PendingControl {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
}

/**
 * One streaming-input conversation over a line transport.
 *
 * The client sends `initialize` first and the first turn's user line once it
 * is answered; later turns arrive via `turn()` on the same child, so context
 * persists with no resume dance and no new process. A turn ends on the CLI's
 * `result` message (success → done, error → fail); the child dying mid-turn
 * fails the turn with a true statement about what happened instead of hanging.
 * Control requests the client did not ask for (`can_use_tool` asks,
 * `hook_callback`, `elicitation`, dialogs, token refreshes) are answered the
 * way the SDK answers them — allow/deny shapes verbatim, unanswerable ones as
 * errors or silence — so the CLI never parks on a question nobody owns.
 */
export function createClaudeStreamClient(
  transport: ClaudeStreamTransport,
  spec: Pick<ClaudeStreamTurnSpec, 'systemPrompt' | 'contextPrompt' | 'timeoutMs'> & {
    /** The harness session id the invocation named (`--session-id` or
     *  `--resume`), which the CLI keeps. What `ready` answers with until the
     *  CLI reports one itself. */
    sessionId?: string
  },
): ClaudeStreamClient {
  const namedSessionId = spec.sessionId ?? ''
  let sessionId = ''
  let handshaken = false
  let closed = false
  let resolveReady!: (id: string) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<string>((res, rej) => {
    resolveReady = res
    rejectReady = rej
  })
  // A ready that never settles must not become an unhandled rejection when the
  // transport dies first: the turn's own failure carries the news.
  ready.catch(() => {})

  const pendingControls = new Map<string, PendingControl>()
  const pendingPermissions = new Map<string, PendingPermission>()
  let openTurn:
    | {
        callbacks: ClaudeStreamTurnCallbacks
        output: string
        partial: string
        partialUuid: string
        observedModel?: string
        observedEffort?: string
        timedOut: boolean
        settled: boolean
        resolve(value: ClaudeStreamTurnOutcome): void
        reject(error: Error): void
        timer: ReturnType<typeof setTimeout>
        killTimer?: ReturnType<typeof setTimeout>
      }
    | undefined

  const denyPendingPermissions = (): void => {
    for (const [id, pending] of pendingPermissions) {
      pendingPermissions.delete(id)
      writeControlResponse(pending.cliRequestId, {
        behavior: 'deny',
        message: 'client stopped before permission was answered',
        interrupt: true,
        toolUseID: pending.toolUseId,
      })
    }
  }

  const clearOpenTurn = (turn: NonNullable<typeof openTurn>): void => {
    if (openTurn === turn) openTurn = undefined
  }

  const failOpenTurn = (message: string): void => {
    const turn = openTurn
    if (!turn || turn.settled) return
    turn.settled = true
    clearOpenTurn(turn)
    clearTimeout(turn.timer)
    if (turn.killTimer) clearTimeout(turn.killTimer)
    turn.reject(new HeadlessTurnFailure(message, sessionId || undefined))
  }

  const succeedOpenTurn = (): void => {
    const turn = openTurn
    if (!turn || turn.settled) return
    turn.settled = true
    clearOpenTurn(turn)
    clearTimeout(turn.timer)
    if (turn.killTimer) clearTimeout(turn.killTimer)
    if (!sessionId) {
      turn.reject(new HeadlessTurnFailure('claude turn ended without reporting a session id'))
      return
    }
    turn.resolve({
      harnessSessionId: sessionId,
      output: turn.output,
      ...(turn.observedModel ? { observedModel: turn.observedModel } : {}),
      ...(turn.observedEffort ? { observedEffort: turn.observedEffort } : {}),
    })
  }

  function writeLine(line: string): void {
    if (closed) return
    try {
      transport.writeLine(line)
    } catch {
      // A dead transport is not an error path of its own — the exit handler
      // reports the death, once, with the real reason.
    }
  }

  function writeControlResponse(
    requestId: string,
    response: Record<string, unknown>,
  ): void {
    writeLine(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }))
  }

  function writeControlError(requestId: string, error: Error | string): void {
    const message = error instanceof Error ? error.message : error
    writeLine(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: message },
      }),
    )
  }

  /** Interrupt requests waiting on the CLI's verdict, by request id. Each
   *  resolves EXACTLY ONCE — from the CLI's answer, the transport dying, or
   *  the ack deadline — so a CLI that answers twice cannot produce two
   *  receipts for one stop. */
  const pendingAcks = new Map<string, (ack: ClaudeStreamInterruptAck) => void>()
  function pendingAcksReceive(
    requestId: string | undefined,
    ack: ClaudeStreamInterruptAck,
  ): void {
    const key = requestId ?? ''
    const resolve = pendingAcks.get(key)
    if (!resolve) return
    pendingAcks.delete(key)
    resolve(ack)
  }
  function settleAllAcks(ack: ClaudeStreamInterruptAck): void {
    for (const key of [...pendingAcks.keys()]) {
      const resolve = pendingAcks.get(key)
      if (resolve) {
        pendingAcks.delete(key)
        resolve(ack)
      }
    }
  }

  const sendInterrupt = (requestId?: string): void => {
    writeLine(
      JSON.stringify({
        type: 'control_request',
        ...(requestId ? { request_id: requestId } : {}),
        request: { subtype: 'interrupt' },
      }),
    )
  }

  function onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Stray non-protocol output is ignored rather than fatal: a dependency
      // that logs must not be able to fail a live turn.
      return
    }
    const type = msg.type
    if (type === 'control_response') {
      const response = msg.response as { request_id?: string; subtype?: string; response?: Record<string, unknown>; error?: string } | undefined
      const id = response?.request_id ?? ''
      const pending = pendingControls.get(id)
      if (pending) {
        pendingControls.delete(id)
        if (response?.subtype === 'error') pending.reject(new Error(response.error || 'control request failed'))
        else pending.resolve(response?.response ?? {})
        return
      }
      // An interrupt ack for a request the turn layer already gave up on —
      // still an answer, routed by request id when one is waiting.
      if (typeof response?.response === 'object' && response?.response !== null) {
        pendingAcksReceive(id, { outcome: 'accepted' })
      }
      return
    }
    if (type === 'control_request') {
      const requestId = msg.request_id as string | undefined
      const request = msg.request as { subtype?: string } | undefined
      const subtype = request?.subtype
      if (subtype === 'can_use_tool') {
        const req = request as {
          tool_name?: string
          input?: Record<string, unknown>
          permission_suggestions?: readonly unknown[]
          tool_use_id?: string
        }
        const interactionId = randomUUID()
        pendingPermissions.set(interactionId, {
          cliRequestId: typeof requestId === 'string' ? requestId : '',
          input: req.input ?? {},
          ...(req.permission_suggestions ? { suggestions: req.permission_suggestions } : {}),
          toolUseId: typeof req.tool_use_id === 'string' ? req.tool_use_id : '',
        })
        openTurn?.callbacks.onPermission({
          id: interactionId,
          toolName: req.tool_name ?? 'unknown',
          ...(req.input !== undefined ? { input: req.input } : {}),
          ...(req.permission_suggestions?.length
            ? { suggestions: req.permission_suggestions }
            : {}),
        })
        return
      }
      if (subtype === 'hook_callback') {
        // Podium registers no in-process hooks, so the CLI must never ask —
        // answer as an error rather than parking the turn on a callback that
        // does not exist.
        if (requestId) writeControlError(requestId, new Error('no hook callback is registered'))
        return
      }
      if (subtype === 'elicitation') {
        // The SDK's default with no handler: decline.
        if (requestId) writeControlResponse(requestId, { action: 'decline' })
        return
      }
      if (subtype === 'request_user_dialog') {
        // The SDK's default with no dialog handler is SILENCE: no
        // control_response at all, so a capable client (or the worker's park
        // deadline) settles it. Answering "cancelled" here would be a verdict
        // nobody gave.
        return
      }
      if (subtype === 'mcp_message' || subtype === 'mcp_connect') {
        // In-process SDK MCP servers do not exist on this client.
        if (requestId) writeControlError(requestId, new Error('no in-process MCP server is registered'))
        return
      }
      if (subtype === 'oauth_token_refresh' || subtype === 'host_auth_token_refresh') {
        if (requestId) writeControlError(requestId, new Error('no token refresh handler is registered'))
        return
      }
      if (requestId) writeControlError(requestId, new Error(`unsupported control request: ${subtype ?? 'unknown'}`))
      return
    }
    if (type === 'control_cancel_request') {
      // The CLI withdrawing a question it already asked: drop the matching
      // pending permission so a late answer cannot act on it.
      return
    }
    if (type === 'keep_alive' || type === 'transcript_mirror') return
    const turn = openTurn
    switch (type) {
      case 'system': {
        const init = msg as { subtype?: string; session_id?: string }
        if (init.subtype === 'init' && typeof init.session_id === 'string') {
          sessionId = init.session_id
          if (handshaken) resolveReady(sessionId)
          turn?.callbacks.emit({ kind: 'status', status: 'running' })
        }
        return
      }
      case 'stream_event': {
        const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event
        if (ev?.type === 'message_start') {
          if (turn) {
            turn.partial = ''
            turn.partialUuid = (msg as { uuid?: string }).uuid ?? ''
          }
        } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          if (turn) {
            turn.partial += ev.delta.text ?? ''
            turn.callbacks.onPartialText(turn.partial, turn.partialUuid || undefined)
            turn.callbacks.emit({
              kind: 'partial-text',
              text: turn.partial,
              ...(turn.partialUuid ? { itemHint: turn.partialUuid } : {}),
            })
          }
        }
        return
      }
      case 'assistant': {
        const message = (msg as { message?: { content?: unknown[]; model?: unknown; effort?: unknown } }).message
        if (typeof message?.model === 'string' && turn) turn.observedModel = message.model
        if (typeof message?.effort === 'string' && turn) turn.observedEffort = message.effort
        for (const block of message?.content ?? []) {
          const use = block as { type?: string; id?: unknown; name?: string; input?: unknown }
          if (use.type !== 'tool_use') continue
          turn?.callbacks.emit({ kind: 'status', status: 'tool', label: use.name ?? 'tool' })
          if (typeof use.id === 'string' && use.id && turn) {
            turn.callbacks.onToolCall({
              toolUseId: use.id,
              toolName: use.name ?? 'unknown',
              ...(use.input !== undefined ? { input: use.input } : {}),
            })
          }
        }
        return
      }
      case 'user': {
        // The CLI reports every tool's return as a user message holding
        // tool_result blocks — the same shape Claude Code writes to its own
        // JSONL. A result is ALWAYS emitted, even empty: a tool that printed
        // nothing ran, and dropping the frame would leave the call looking
        // like it never returned.
        const content = (msg as { message?: { content?: unknown } }).message?.content
        for (const block of userContentBlocks(content)) {
          if (block.type !== 'tool_result') continue
          const toolUseId = block.tool_use_id
          if (typeof toolUseId !== 'string' || !toolUseId || !turn) continue
          turn.callbacks.onToolResult({
            toolUseId,
            output: toolResultText(block.content),
            ...(block.is_error === true ? { isError: true } : {}),
          })
        }
        return
      }
      case 'result': {
        const result = msg as { subtype?: string; result?: unknown; errors?: unknown }
        if (result.subtype === 'success') {
          if (turn) {
            turn.output = typeof result.result === 'string' ? result.result : turn.partial
            // A TIMED-OUT TURN IS NEVER A SUCCESS, however gracefully it ended:
            // the wound-down stream reports `done` with whatever text it had,
            // so without this a turn cut off at its deadline would arrive as
            // the assistant's complete reply.
            if (turn.timedOut) failOpenTurn('turn timed out')
            else {
              turn.callbacks.emit({ kind: 'status', status: 'running' })
              succeedOpenTurn()
            }
          }
        } else {
          failOpenTurn(
            turn?.timedOut
              ? 'turn timed out'
              : formatClaudeSdkResultFailure({
                  subtype: result.subtype,
                  errors: result.errors,
                }),
          )
        }
        return
      }
      default:
        return
    }
  }

  function answerPermission(
    interactionId: string,
    answer: { decision: 'allow-once' | 'allow-always' | 'deny'; feedback?: string },
  ): void {
    const pending = pendingPermissions.get(interactionId)
    if (!pending) return
    pendingPermissions.delete(interactionId)
    if (answer.decision === 'deny') {
      writeControlResponse(pending.cliRequestId, {
        behavior: 'deny',
        message: answer.feedback?.trim() || 'Denied by the Podium operator',
        interrupt: false,
        toolUseID: pending.toolUseId,
      })
    } else {
      writeControlResponse(pending.cliRequestId, {
        behavior: 'allow',
        updatedInput: pending.input,
        ...(answer.decision === 'allow-always' && pending.suggestions
          ? { updatedPermissions: pending.suggestions }
          : {}),
        toolUseID: pending.toolUseId,
      })
    }
  }
  const offLine = transport.onLine(onLine)
  const offExit = transport.onExit((code, signal) => {
    offLine()
    settleAllAcks({
      outcome: 'unconfirmed',
      detail: 'the Claude model host exited before it confirmed the interrupt',
    })
    denyPendingPermissions()
    if (!openTurn) {
      // A no-op once ready has settled.
      rejectReady(
        new HeadlessTurnFailure(
          handshaken
            ? 'the Claude model host process exited before it reported a session id'
            : 'the Claude model host process exited before it initialized',
        ),
      )
      return
    }
    if (openTurn && !openTurn.settled) {
      const how = signal ? `on ${signal}` : `with code ${code}`
      failOpenTurn(`the Claude model host process exited ${how} before the turn finished`)
    }
  })

  // The handshake goes out before any turn: the CLI answers with a
  // control_response whose pending_* fields redeliver the questions a
  // transport gap orphaned — which is exactly the adopt case.
  const initializeId = randomUUID()
  const initializing = new Promise<Record<string, unknown>>((resolve, reject) => {
    pendingControls.set(initializeId, { resolve, reject })
  })
  writeLine(
    JSON.stringify({
      type: 'control_request',
      request_id: initializeId,
      request: initializePayload(spec),
    }),
  )
  /**
   * THE HANDSHAKE IS THE ONLY GATE ON THE FIRST USER LINE (POD-4636). The CLI
   * writes `system/init` in reply to a user line — never to `initialize`
   * (claude-code 2.1.280) — so a line held for `system/init` is held forever.
   * The id `ready` answers with is the CLI's if it already reported one, else
   * the one the invocation named, which the CLI keeps; with neither, `ready`
   * waits for the `system/init` the first turn draws out.
   */
  const handshake = initializing.then(
    (response) => {
      handshaken = true
      const pending = response.pending_permission_requests as
        | Array<{ request_id?: string; request?: { subtype?: string } }>
        | undefined
      for (const redelivered of pending ?? []) {
        if (redelivered.request?.subtype === 'can_use_tool' && redelivered.request_id) {
          onLine(
            JSON.stringify({
              type: 'control_request',
              request_id: redelivered.request_id,
              request: redelivered.request,
            }),
          )
        }
      }
      const known = sessionId || namedSessionId
      if (known) resolveReady(known)
    },
    (error) => {
      const failure =
        error instanceof HeadlessTurnFailure
          ? error
          : new HeadlessTurnFailure(
              redactClaudeSdkFailureDetail(error instanceof Error ? error.message : String(error)) ||
                'claude turn failed',
              undefined,
            )
      rejectReady(failure)
      throw failure
    },
  )
  // Like ready: a handshake the transport killed must not surface unhandled.
  handshake.catch(() => {})

  return {
    ready,
    turn(prompt, callbacks) {
      if (closed) throw new Error('the Claude stream client is closed')
      if (openTurn && !openTurn.settled) throw new Error('a Claude stream turn is already open')
      let resolve!: (value: ClaudeStreamTurnOutcome) => void
      let reject!: (error: Error) => void
      const done = new Promise<ClaudeStreamTurnOutcome>((res, rej) => {
        resolve = res
        reject = rej
      })
      // A turn that never settles must not become an unhandled rejection when
      // the transport dies first: the exit handler above rejects it, and the
      // owner always awaits `done` — but an owner that only interrupts still
      // needs the silence.
      done.catch(() => {})
      const turn = {
        callbacks,
        output: '',
        partial: '',
        partialUuid: '',
        timedOut: false,
        settled: false,
        resolve,
        reject,
        timer: setTimeout(() => undefined, 0),
      }
      clearTimeout(turn.timer)
      const timeoutMs = spec.timeoutMs ?? CLAUDE_STREAM_DEFAULT_TURN_TIMEOUT_MS
      turn.timer = setTimeout(() => {
        const current = openTurn
        if (!current || current.settled) return
        current.timedOut = true
        sendInterrupt()
      }, timeoutMs)
      turn.timer.unref?.()
      openTurn = turn
      callbacks.emit({ kind: 'status', status: 'starting' })
      // The first turn waits for the handshake: a user line before the
      // initialize answer would race the CLI's setup.
      void handshake
        .then(() => {
          if (turn.settled || closed) return
          writeLine(userMessageLine(prompt))
        })
        .catch((error: unknown) => {
          if (!turn.settled) {
            turn.settled = true
            clearTimeout(turn.timer)
            reject(
              error instanceof Error ? error : new HeadlessTurnFailure(String(error), undefined),
            )
          }
        })
      const requestInterruptFor = (requestId: string): Promise<ClaudeStreamInterruptAck> => {
        const answered = new Promise<ClaudeStreamInterruptAck>((res) => {
          pendingAcks.set(requestId, res)
        })
        const deadline = setTimeout(() => {
          const resolveAck = pendingAcks.get(requestId)
          if (resolveAck) {
            pendingAcks.delete(requestId)
            resolveAck({
              outcome: 'unconfirmed',
              detail: 'the Claude model host did not confirm the interrupt in time',
            })
          }
        }, CLAUDE_STREAM_INTERRUPT_ACK_MS)
        deadline.unref?.()
        sendInterrupt(requestId)
        return answered.finally(() => clearTimeout(deadline))
      }
      return {
        done,
        interrupt: () => {
          sendInterrupt()
        },
        requestInterrupt: () => requestInterruptFor(randomUUID()),
        answerPermission,
      }
    },
    answerPermission,
    close() {
      if (closed) return
      closed = true
      offLine()
      offExit()
      denyPendingPermissions()
      settleAllAcks({
        outcome: 'unconfirmed',
        detail: 'the Claude stream client closed before the interrupt was confirmed',
      })
      failOpenTurn('the Claude stream client closed before the turn finished')
      try {
        transport.close()
      } catch {
        // Closing is best-effort teardown.
      }
    },
  }
}
