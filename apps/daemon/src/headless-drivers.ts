import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  type McpServerConfig,
  type Options,
  type PermissionMode,
  query,
} from '@anthropic-ai/claude-agent-sdk'
import {
  type HarnessHeadless,
  type HeadlessExecOptions,
  harnessAdapterFor,
} from '@podium/agent-bridge'
import type { HarnessAgent, HeadlessTurnEvent } from '@podium/protocol'
import type { HarnessBins } from './harness-exec.js'

const DEFAULT_TURN_TIMEOUT_MS = 600_000

export interface HeadlessTurnSpec {
  agent: HarnessAgent
  model?: string
  effort?: string
  cwd: string
  prompt: string
  systemPrompt?: string
  /** MCP config JSON ({ mcpServers: { name: { url, headers } } }). */
  mcpConfig?: string
  allowedTools?: string[]
  permissionMode?: string
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** Claude only: mint the first-turn session with this UUID. */
  sessionUuid?: string
  timeoutMs?: number
}

export interface HeadlessTurnOutcome {
  harnessSessionId: string
  output: string
}

/**
 * A turn that failed AFTER the harness minted its session. The conversation
 * exists on disk, so the caller must still learn its id — otherwise one
 * interrupted/errored turn orphans the whole thread: no resume ref, no
 * transcript binding, and the next turn silently starts a new conversation.
 */
export class HeadlessTurnError extends Error {
  constructor(
    message: string,
    readonly harnessSessionId?: string,
  ) {
    super(message)
    this.name = 'HeadlessTurnError'
  }
}

export type HeadlessEmit = (event: HeadlessTurnEvent) => void

export interface HeadlessTurnHandle {
  done: Promise<HeadlessTurnOutcome>
  interrupt(): void
}

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'])

/** Parse the Claude-shaped MCP config JSON into SDK mcpServers. Servers without
 *  a `type` are treated as streamable-HTTP (the shape the server composes). */
function sdkMcpServers(mcpConfig: string | undefined): Record<string, McpServerConfig> | undefined {
  if (!mcpConfig) return undefined
  let servers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>
  try {
    servers = (JSON.parse(mcpConfig) as { mcpServers?: typeof servers }).mcpServers ?? {}
  } catch {
    throw new Error('malformed MCP config — refusing a tool-less headless turn')
  }
  const out: Record<string, McpServerConfig> = {}
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.url) continue
    out[name] = {
      type: 'http',
      url: srv.url,
      ...(srv.headers ? { headers: srv.headers } : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * One turn through the Claude Agent SDK. Process-per-turn: `resume` reloads the
 * whole conversation from the harness's own JSONL, so context persists with no
 * long-lived process. First turn mints the session id via `sessionId` (must be
 * a UUID) so the thread ↔ transcript binding is deterministic.
 */
function runClaudeTurn(spec: HeadlessTurnSpec, emit: HeadlessEmit): HeadlessTurnHandle {
  const mode: PermissionMode =
    spec.permissionMode && PERMISSION_MODES.has(spec.permissionMode)
      ? (spec.permissionMode as PermissionMode)
      : 'bypassPermissions'
  const options: Options = {
    cwd: spec.cwd,
    includePartialMessages: true,
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(spec.model && spec.model !== 'auto' ? { model: spec.model } : {}),
    ...(spec.effort && EFFORT_LEVELS.has(spec.effort)
      ? { effort: spec.effort as Options['effort'] }
      : {}),
    ...(spec.allowedTools && spec.allowedTools.length > 0
      ? { allowedTools: spec.allowedTools }
      : {}),
    // The orchestrator prompt APPENDS to the claude_code preset — same posture
    // as harness-exec's --append-system-prompt.
    ...(spec.systemPrompt?.trim()
      ? {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemPrompt.trim() },
        }
      : {}),
    ...(spec.resumeValue
      ? { resume: spec.resumeValue }
      : spec.sessionUuid
        ? { sessionId: spec.sessionUuid }
        : {}),
  }
  const mcpServers = sdkMcpServers(spec.mcpConfig)
  if (mcpServers) options.mcpServers = mcpServers

  const q = query({ prompt: spec.prompt, options })
  let interrupted = false
  const timer = setTimeout(() => {
    interrupted = true
    void q.interrupt().catch(() => {})
  }, spec.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS)
  timer.unref?.()

  const done = (async (): Promise<HeadlessTurnOutcome> => {
    let sessionId = spec.resumeValue ?? spec.sessionUuid ?? ''
    let output = ''
    let partial = ''
    let partialUuid = ''
    emit({ kind: 'status', status: 'starting' })
    // Every throw below happens with `sessionId` possibly already learned from the
    // SDK's init message — carry it out so the thread keeps its conversation.
    const fail = (message: string): never => {
      throw new HeadlessTurnError(message, sessionId || undefined)
    }
    try {
      for await (const msg of q) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              sessionId = msg.session_id
              emit({ kind: 'status', status: 'running' })
            }
            break
          case 'stream_event': {
            const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } }
            if (ev.type === 'message_start') {
              partial = ''
              partialUuid = msg.uuid
            } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              partial += ev.delta.text ?? ''
              emit({ kind: 'partial-text', text: partial, itemHint: partialUuid })
            }
            break
          }
          case 'assistant':
            for (const block of msg.message.content) {
              if (block.type === 'tool_use') {
                emit({ kind: 'status', status: 'tool', label: block.name })
              }
            }
            break
          case 'result':
            if (msg.subtype === 'success') output = msg.result
            else fail(`claude turn failed: ${msg.subtype}`)
            break
          default:
            break
        }
      }
    } catch (err) {
      // An SDK-thrown error (transport, tool crash) gets the same treatment.
      if (err instanceof HeadlessTurnError) throw err
      throw new HeadlessTurnError(
        err instanceof Error ? err.message : String(err),
        sessionId || undefined,
      )
    } finally {
      clearTimeout(timer)
    }
    if (interrupted) fail('turn timed out')
    if (!sessionId) throw new Error('claude turn ended without reporting a session id')
    return { harnessSessionId: sessionId, output }
  })()

  return {
    done,
    interrupt: () => {
      void q.interrupt().catch(() => {})
    },
  }
}

/** Pure argv builder for the child-process drivers (codex/grok/opencode/cursor)
 *  so the exact invocation shape is unit-testable. `sessionId` is the pinned
 *  harness session id (pre-minted for grok/cursor; absent on a codex/opencode
 *  first turn, where the id is captured from the JSON event stream). Pure
 *  dispatch into the harness adapter registry (#158): each adapter's
 *  `headless.buildExec` owns its CLI's invocation shape.  */
export function buildHeadlessExec(
  agent: Exclude<HarnessAgent, 'claude-code'>,
  opts: HeadlessExecOptions,
  bins: HarnessBins,
): { cmd: string; args: string[] } {
  const buildExec = harnessAdapterFor(agent)?.headless.buildExec
  if (!buildExec) throw new Error(`agent kind ${String(agent)} has no headless exec builder`)
  return buildExec(opts, bins)
}

function runChild<T>(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  consume: (child: ChildProcess) => Promise<T>,
): { child: ChildProcess; done: Promise<T> } {
  const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin?.end()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  timer.unref?.()
  const done = consume(child)
    .then((r) => {
      if (timedOut) throw new Error('turn timed out')
      return r
    })
    .finally(() => clearTimeout(timer))
  return { child, done }
}

/** Collect a child's exit; rejects on nonzero exit with stderr context. */
function childExit(child: ChildProcess, stderrTail: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(
            `harness exited ${signal ?? code}${stderrTail() ? `: ${stderrTail().slice(-2000)}` : ''}`,
          ),
        )
    })
  })
}

function collectStderr(child: ChildProcess): () => string {
  let buf = ''
  child.stderr?.on('data', (d: Buffer) => {
    buf = (buf + d.toString()).slice(-8192)
  })
  return () => buf.trim()
}

/**
 * Codex headless turn over `codex exec --json` (first turn) / `codex exec
 * resume <id> --json` (turns ≥2). TRANSPORT NOTE: the design names `codex
 * app-server` JSON-RPC as the target surface; this ships the exec --json
 * variant because its event stream (`thread.started`/`item.*`/`turn.completed`)
 * was VERIFIED against the installed codex-cli 0.142.5, while the app-server
 * handshake specifics were not. The transport is contained to this function —
 * swapping in an app-server client later changes nothing upstream.
 */
function runCodexTurn(spec: HeadlessTurnSpec, emit: HeadlessEmit): HeadlessTurnHandle {
  const { cmd, args } = buildHeadlessExec(
    'codex',
    {
      prompt: spec.prompt,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
      ...(spec.mcpConfig ? { mcpConfig: spec.mcpConfig } : {}),
      ...(spec.resumeValue ? { resumeValue: spec.resumeValue } : {}),
    },
    { opencode: () => 'opencode', cursor: () => 'cursor-agent' },
  )
  emit({ kind: 'status', status: 'starting' })
  const { child, done } = runChild(
    cmd,
    args,
    spec.cwd,
    spec.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    async (child) => {
      const stderrTail = collectStderr(child)
      let threadId = spec.resumeValue ?? ''
      let output = ''
      const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream })
      rl.on('line', (line) => {
        let ev: {
          type?: string
          thread_id?: string
          item?: { id?: string; type?: string; text?: string }
        }
        try {
          ev = JSON.parse(line)
        } catch {
          return
        }
        if (ev.type === 'thread.started' && ev.thread_id) {
          threadId = ev.thread_id
          emit({ kind: 'status', status: 'running' })
        } else if (
          ev.type === 'item.started' &&
          ev.item?.type &&
          ev.item.type !== 'agent_message'
        ) {
          emit({ kind: 'status', status: 'tool', label: ev.item.type })
        } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
          output = ev.item.text ?? ''
          emit({
            kind: 'partial-text',
            text: output,
            ...(ev.item.id ? { itemHint: ev.item.id } : {}),
          })
        }
      })
      await childExit(child, stderrTail)
      if (!threadId) throw new Error('codex turn ended without reporting a thread id')
      return { harnessSessionId: threadId, output }
    },
  )
  return { done, interrupt: () => child.kill('SIGKILL') }
}

/** Read all of stdout as text (grok/cursor: whole-output, no partial events). */
async function readAllStdout(child: ChildProcess): Promise<string> {
  let out = ''
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString()
  })
  const stderrTail = collectStderr(child)
  await childExit(child, stderrTail)
  return out.trim()
}

/**
 * Session-pinned one-shot turns for grok / opencode / cursor. Message-level
 * only: no partial events, one status, whole output on completion. The harness
 * still owns context via its session store; each turn pins the same id.
 */
function runResumeExecTurn(
  spec: HeadlessTurnSpec & { agent: 'grok' | 'opencode' | 'cursor' },
  emit: HeadlessEmit,
  bins: HarnessBins,
): HeadlessTurnHandle {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const common = {
    prompt: spec.prompt,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.resumeValue ? { resumeValue: spec.resumeValue } : {}),
  }
  emit({ kind: 'status', status: 'starting' })

  if (spec.agent === 'opencode') {
    // opencode mints its own ses_… id; captured from the --format json stream.
    const { cmd, args } = buildHeadlessExec('opencode', common, bins)
    const { child, done } = runChild(cmd, args, spec.cwd, timeoutMs, async (child) => {
      const stderrTail = collectStderr(child)
      let sessionId = spec.resumeValue ?? ''
      let output = ''
      const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream })
      rl.on('line', (line) => {
        let ev: { type?: string; sessionID?: string; part?: { type?: string; text?: string } }
        try {
          ev = JSON.parse(line)
        } catch {
          return
        }
        if (ev.sessionID && !sessionId) {
          sessionId = ev.sessionID
          emit({ kind: 'status', status: 'running' })
        }
        if (ev.type === 'text' && ev.part?.type === 'text') output += ev.part.text ?? ''
      })
      await childExit(child, stderrTail)
      if (!sessionId) throw new Error('opencode turn ended without reporting a session id')
      return { harnessSessionId: sessionId, output: output.trim() }
    })
    return { done, interrupt: () => child.kill('SIGKILL') }
  }

  let interrupt: () => void = () => {}
  const done = (async (): Promise<HeadlessTurnOutcome> => {
    // grok: create-or-resume via -s, id minted here on the first turn.
    // cursor: chat id pre-allocated via `create-chat`, then always --resume.
    let sessionId = spec.resumeValue
    if (!sessionId) {
      if (spec.agent === 'grok') {
        sessionId = randomUUID()
      } else {
        const alloc = runChild(bins.cursor(), ['create-chat'], spec.cwd, 60_000, readAllStdout)
        interrupt = () => alloc.child.kill('SIGKILL')
        const printed = await alloc.done
        sessionId = printed.split('\n').at(-1)?.trim() ?? ''
        if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
          throw new Error(`cursor create-chat did not print a chat id: ${printed}`)
        }
      }
    }
    const { cmd, args } = buildHeadlessExec(spec.agent, { ...common, sessionId }, bins)
    const turn = runChild(cmd, args, spec.cwd, timeoutMs, readAllStdout)
    interrupt = () => turn.child.kill('SIGKILL')
    emit({ kind: 'status', status: 'running' })
    const output = await turn.done
    return { harnessSessionId: sessionId, output }
  })()
  return { done, interrupt: () => interrupt() }
}

type HeadlessDriver = (
  spec: HeadlessTurnSpec,
  emit: HeadlessEmit,
  bins: HarnessBins,
) => HeadlessTurnHandle

const resumeExecDriver: HeadlessDriver = (spec, emit, bins) =>
  runResumeExecTurn(
    spec as HeadlessTurnSpec & { agent: 'grok' | 'opencode' | 'cursor' },
    emit,
    bins,
  )

/** Driver body per adapter-declared driver KIND (`adapter.headless.driver`) —
 *  the closed set of runtime strategies this daemon can host. Which agent uses
 *  which is no longer enumerated here: it derives from the harness adapter
 *  registry, so a new agent picks its driver in its adapter file (and the
 *  registry's exhaustive Record still fails typecheck until it exists). */
const DRIVER_IMPLS: Record<HarnessHeadless['driver'], HeadlessDriver> = {
  'claude-sdk': (spec, emit) => runClaudeTurn(spec, emit),
  'codex-json': (spec, emit) => runCodexTurn(spec, emit),
  'resume-exec': resumeExecDriver,
}

/** Driver selection by agent — an adapter registry lookup (#249). */
export function runHeadlessTurn(
  spec: HeadlessTurnSpec,
  emit: HeadlessEmit,
  bins: HarnessBins,
): HeadlessTurnHandle {
  const adapter = harnessAdapterFor(spec.agent)
  if (!adapter) throw new Error(`agent kind ${String(spec.agent)} has no harness adapter`)
  return DRIVER_IMPLS[adapter.headless.driver](spec, emit, bins)
}
