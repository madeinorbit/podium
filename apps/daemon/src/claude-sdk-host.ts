// apps/daemon/src/claude-sdk-host.ts
//
// THE ONLY MODULE IN THIS REPO THAT LOADS `@anthropic-ai/claude-agent-sdk`, and it
// never runs in the daemon's process. The daemon spawns it as a child (see
// claude-sdk-client.ts), speaks the line protocol in claude-sdk-protocol.ts to it,
// and can lose it at any moment: an SDK crash, an unbounded allocation, an OOM
// kill. Losing it degrades the one session whose turn it was running. That is the
// entire point — before this split the same event took down the process that
// supervises every session on the machine.
//
// The turn semantics below are a faithful move of what ran in-process before, not
// a rewrite: same options, same event mapping, same "carry the session id out of
// a failure" rule. The transport underneath them is what changed.

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  type McpServerConfig,
  type Options,
  type PermissionMode,
  query,
} from '@anthropic-ai/claude-agent-sdk'
import { formatClaudeSdkResultFailure, redactClaudeSdkFailureDetail } from '@podium/agent-runtime'
import {
  CLAUDE_SDK_HOST_ENV,
  type ClaudeSdkHostCommand,
  type ClaudeSdkHostFrame,
} from './claude-sdk-protocol.js'
import { type HeadlessTurnSpec, headlessChildEnv } from './headless-drivers.js'

/** How long the SDK gets to wind a turn down after the daemon disappears. */
const ORPHAN_GRACE_MS = 5_000

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'plan',
  'dontAsk',
])

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
export function buildClaudeSdkOptions(
  spec: HeadlessTurnSpec,
  canUseTool?: NonNullable<Options['canUseTool']>,
): Options {
  const mode: PermissionMode =
    spec.permissionMode && PERMISSION_MODES.has(spec.permissionMode)
      ? (spec.permissionMode as PermissionMode)
      : 'auto'
  const options: Options = {
    cwd: spec.cwd,
    includePartialMessages: true,
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    // The CLI refuses --dangerously-skip-permissions as root unless IS_SANDBOX=1;
    // without it every headless turn on a root-run daemon dies with exit code 1.
    // Options.env REPLACES the subprocess env, so process.env must be spread in.
    env: {
      ...headlessChildEnv(spec.agent, spec.env),
      ...(mode === 'bypassPermissions' && process.getuid?.() === 0 ? { IS_SANDBOX: '1' } : {}),
    } as Record<string, string>,
    ...(spec.model && spec.model !== 'auto' ? { model: spec.model } : {}),
    ...(spec.executablePath ? { pathToClaudeCodeExecutable: spec.executablePath } : {}),
    ...(spec.effort && EFFORT_LEVELS.has(spec.effort)
      ? { effort: spec.effort as Options['effort'] }
      : {}),
    ...(spec.allowedTools && spec.allowedTools.length > 0
      ? { allowedTools: spec.allowedTools }
      : {}),
    ...(spec.toolPolicy === 'none' ? { tools: [] as string[], allowedTools: [] } : {}),
    // An empty settings-source list prevents user/project/local hooks, plugins,
    // and permissions from being inherited by a bounded repair turn.
    ...(spec.toolPolicy === 'none' ? { settingSources: [] } : {}),
    // The orchestrator prompt APPENDS to the claude_code preset — same posture
    // as harness-exec's --append-system-prompt.
    ...([spec.systemPrompt, spec.contextPrompt].filter(Boolean).join('\n\n').trim()
      ? {
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: [spec.systemPrompt, spec.contextPrompt].filter(Boolean).join('\n\n').trim(),
          },
        }
      : {}),
    ...(spec.resumeValue
      ? { resume: spec.resumeValue }
      : spec.sessionUuid
        ? { sessionId: spec.sessionUuid }
        : {}),
    ...(canUseTool ? { canUseTool } : {}),
  }
  const mcpServers = sdkMcpServers(spec.mcpConfig)
  if (mcpServers && spec.toolPolicy !== 'none') options.mcpServers = mcpServers
  return options
}

export interface ClaudeSdkHostIo {
  /** One command line at a time from the daemon. */
  commands: AsyncIterable<string>
  /** Emit one frame; the caller newline-delimits. */
  send(frame: ClaudeSdkHostFrame): void
}

/**
 * Run the host loop over an injected transport. Exported so the framing can be
 * tested without a real process pair; `main()` below binds it to stdio.
 *
 * Returns when the turn settles. Exactly one terminal frame (`done` or `error`)
 * is written — a caller that sees the child exit with neither knows the SDK took
 * the process down, which is the case the daemon must survive.
 */
export async function runClaudeSdkHost(io: ClaudeSdkHostIo): Promise<void> {
  let spec: HeadlessTurnSpec | undefined
  let interrupt: (() => void) | undefined
  type CanUseTool = NonNullable<Options['canUseTool']>
  type PermissionResult = Awaited<ReturnType<CanUseTool>>
  type PermissionSuggestions = Parameters<CanUseTool>[2]['suggestions']
  const pendingPermissions = new Map<
    string,
    {
      input: Record<string, unknown>
      suggestions?: PermissionSuggestions
      resolve(result: PermissionResult): void
    }
  >()
  const denyPendingPermissions = (): void => {
    for (const [id, pending] of pendingPermissions) {
      pending.resolve({
        behavior: 'deny',
        message: 'SDK host stopped before permission was answered',
        interrupt: true,
      })
      pendingPermissions.delete(id)
    }
  }
  let pendingInterrupt = false
  let finish: () => void = () => {}
  // Resolves when the turn settles — NOT when stdin closes. The daemon keeps the
  // command pipe open for the whole turn so it can interrupt, so waiting on the
  // pipe would mean this process outlived its own work by exactly as long as the
  // daemon took to notice.
  const settled = new Promise<void>((resolve) => {
    finish = resolve
  })

  // Commands arrive on their own loop: `interrupt` has to be readable WHILE the
  // turn is being awaited, or it could only ever arrive after the thing it was
  // meant to stop.
  const commandLoop = (async () => {
    for await (const line of io.commands) {
      let cmd: ClaudeSdkHostCommand
      try {
        cmd = JSON.parse(line) as ClaudeSdkHostCommand
      } catch {
        continue
      }
      if (cmd.t === 'turn' && !spec) {
        spec = cmd.spec
        startTurn()
      } else if (cmd.t === 'interrupt') {
        if (interrupt) interrupt()
        else pendingInterrupt = true
      } else if (cmd.t === 'answer') {
        const pending = pendingPermissions.get(cmd.interactionId)
        if (!pending) continue
        pendingPermissions.delete(cmd.interactionId)
        if (cmd.decision === 'deny') {
          pending.resolve({
            behavior: 'deny',
            message: cmd.feedback?.trim() || 'Denied by the Podium operator',
            interrupt: false,
          })
        } else {
          pending.resolve({
            behavior: 'allow',
            // Required by the SDK version shipped here even when unchanged.
            updatedInput: pending.input,
            ...(cmd.decision === 'allow-always' && pending.suggestions?.length
              ? { updatedPermissions: pending.suggestions }
              : {}),
          })
        }
      }
    }
    // STDIN ENDED: the daemon is gone. Nothing upstream is listening, so this
    // process has no reason to keep an agent running — and an agent that keeps
    // running is a real cost, not a tidiness point: it holds a model session, a
    // working directory and whatever the CLI spawned, with nobody to stop it.
    //
    // The previous version only handled the no-turn-yet case (`if (!spec)`), so
    // once a turn had started EOF did nothing at all and the host outlived its
    // daemon indefinitely — while the comment above `main()` claimed otherwise.
    if (!spec) {
      finish()
      return
    }
    if (interrupt) interrupt()
    denyPendingPermissions()
    // Give the SDK a moment to end the turn cleanly, then go regardless: a host
    // that refuses to die on its parent's death is the orphan we are avoiding.
    const grace = setTimeout(finish, ORPHAN_GRACE_MS)
    grace.unref?.()
  })()
  commandLoop.catch(() => finish())

  function startTurn(): void {
    void (async () => {
      // `spec` is set by the only caller, immediately above.
      const turnSpec = spec as HeadlessTurnSpec
      let sessionId = turnSpec.resumeValue ?? turnSpec.sessionUuid ?? ''
      let output = ''
      let partial = ''
      let partialUuid = ''
      // Report the id we were handed before the SDK confirms it, so a child that
      // dies during startup is still attributable to the right conversation.
      if (sessionId) io.send({ t: 'session', harnessSessionId: sessionId })
      io.send({ t: 'event', event: { kind: 'status', status: 'starting' } })

      const canUseTool: NonNullable<Options['canUseTool']> = async (toolName, input, context) =>
        new Promise<PermissionResult>((resolve) => {
          const interactionId = randomUUID()
          const suggestions = context.suggestions
          pendingPermissions.set(interactionId, {
            input,
            ...(suggestions ? { suggestions } : {}),
            resolve,
          })
          io.send({
            t: 'permission',
            interactionId,
            toolName,
            input,
            ...(suggestions?.length ? { suggestions } : {}),
          })
        })
      const q = query({
        prompt: turnSpec.prompt,
        options: buildClaudeSdkOptions(
          turnSpec,
          turnSpec.structuredPermissions ? canUseTool : undefined,
        ),
      })
      interrupt = () => {
        void q.interrupt().catch(() => {})
      }
      if (pendingInterrupt) interrupt()

      try {
        for await (const msg of q) {
          switch (msg.type) {
            case 'system':
              if (msg.subtype === 'init') {
                sessionId = msg.session_id
                io.send({ t: 'session', harnessSessionId: sessionId })
                io.send({ t: 'event', event: { kind: 'status', status: 'running' } })
              }
              break
            case 'stream_event': {
              const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } }
              if (ev.type === 'message_start') {
                partial = ''
                partialUuid = msg.uuid
              } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
                partial += ev.delta.text ?? ''
                io.send({
                  t: 'event',
                  event: { kind: 'partial-text', text: partial, itemHint: partialUuid },
                })
              }
              break
            }
            case 'assistant':
              for (const block of msg.message.content) {
                if (block.type === 'tool_use') {
                  io.send({
                    t: 'event',
                    event: { kind: 'status', status: 'tool', label: block.name },
                  })
                }
              }
              break
            case 'result':
              if (msg.subtype === 'success') output = msg.result
              else {
                // SDKResultError has `errors: string[]` and no `result`. Passing
                // the whole message used to look like it preserved diagnostics
                // while tests stuffed spend text on `result`, which production
                // never sends. Read the error-shape fields by name.
                io.send({
                  t: 'error',
                  message: formatClaudeSdkResultFailure({
                    subtype: msg.subtype,
                    errors: msg.errors,
                  }),
                  ...(sessionId ? { harnessSessionId: sessionId } : {}),
                })
                return
              }
              break
            default:
              break
          }
        }
      } catch (err) {
        // An SDK-thrown error (transport, tool crash) gets the same treatment:
        // report it WITH whatever session id we learned, so the thread survives.
        const thrown = redactClaudeSdkFailureDetail(
          err instanceof Error ? err.message : String(err),
        )
        io.send({
          t: 'error',
          message: thrown || 'claude turn failed',
          ...(sessionId ? { harnessSessionId: sessionId } : {}),
        })
        return
      }
      if (!sessionId) {
        io.send({ t: 'error', message: 'claude turn ended without reporting a session id' })
        return
      }
      io.send({ t: 'done', harnessSessionId: sessionId, output })
    })().finally(() => {
      denyPendingPermissions()
      finish()
    })
  }

  await settled
}

async function main(): Promise<void> {
  // A closed stdin means the daemon is gone. Nothing upstream is listening any
  // more, so wind the SDK down rather than leaving an orphaned agent running.
  const rl = createInterface({ input: process.stdin })
  await runClaudeSdkHost({
    commands: rl,
    send: (frame) => {
      process.stdout.write(`${JSON.stringify(frame)}\n`)
    },
  })
  rl.close()
}

if (process.env[CLAUDE_SDK_HOST_ENV] === '1') {
  await main()
  // Do not linger: the SDK leaves timers and sockets behind and this process has
  // one job, which is now done.
  process.exit(0)
}
