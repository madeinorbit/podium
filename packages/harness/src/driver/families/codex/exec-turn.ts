// packages/harness/src/driver/families/codex/exec-turn.ts
//
// THE CODEX HEADLESS TURN OVER `codex exec --json` (moved from
// apps/daemon/src/headless-drivers.ts in 1.5: the daemon stops knowing this
// headless harness's turn shape).
//
// TRANSPORT NOTE (carried over): the design names `codex app-server` JSON-RPC
// as the target surface; this ships the exec --json variant because its event
// stream (`thread.started`/`item.*`/`turn.completed`) was VERIFIED against a
// real CLI, while the app-server handshake specifics were not. The transport
// is contained to this function — swapping in an app-server client later
// changes nothing upstream.
//
// The supervisor owns the process (spawn, timeout, kill) and the composed
// environment; this module owns the argv (read off the adapter's
// `headless.buildExec` section, never restated), the JSONL fold, and the
// failure shape. First turn is `codex exec --json`, turns ≥2 resume the
// journalled thread.

import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { bindHarnessExec } from '../../../executable-runtime.js'
import type { ResolvedHarnessInventory } from '../../../inventory/build-inventory.js'
import { declaredValue, type AgentManifest, type HeadlessExecOptions } from '../../../manifest.js'
import { HeadlessTurnFailure } from '../turn-error.js'

/** The turn, as this family reads it: prompt facts plus supervisor facts. */
export interface CodexExecTurnInput {
  prompt: string
  model?: string
  effort?: string
  systemPrompt?: string
  contextPrompt?: string
  mcpConfig?: string
  permissionMode?: string
  toolPolicy?: 'none'
  /** Harness thread id to resume; absent = first turn. */
  resumeValue?: string
  cwd: string
  timeoutMs: number
  /** Fully composed child env (stored-login precedence is the supervisor's). */
  env: Record<string, string>
  /** The turn's headless section, handed by the composition root (which may
   *  read the registry) — this family never fetches an adapter by name. */
  sections: Pick<AgentManifest, 'headless'>
  snapshot: ResolvedHarnessInventory
  emit: (event: HeadlessTurnEvent) => void
  /**
   * Spawn the turn child with piped stdio. The supervisor owns the spawn and
   * its environment; this family owns everything the child then says.
   */
  spawnChild(
    cmd: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string> },
  ): ChildProcess
}

export interface CodexExecTurnOutcome {
  /** UNBRANDED BY DECISION: a provider/harness-native thread id, not a Podium SessionId. */
  harnessSessionId: string
  output: string
}

/**
 * Pure argv builder for the codex-json turn, so the exact invocation shape is
 * unit-testable. Reads the HANDED headless section: the adapter's
 * `headless.buildExec` owns the CLI's invocation shape.
 */
export function buildCodexExecTurn(
  opts: HeadlessExecOptions,
  snapshot: ResolvedHarnessInventory,
  sections: Pick<AgentManifest, 'headless'>,
): { cmd: string; args: string[]; env?: Record<string, string> } {
  const headless = declaredValue(sections.headless)
  const buildExec = headless && declaredValue(headless.buildExec)
  if (!buildExec) throw new Error('codex adapter has no headless exec builder')
  return bindHarnessExec(snapshot, 'codex', buildExec({ ...opts, env: opts.env ?? snapshot.commandEnvironment.env }))
}

/** One codex-json turn. Never resolves without a thread id: a turn that ends
 *  without reporting one has no conversation to resume. */
export function runCodexExecTurn(input: CodexExecTurnInput): {
  done: Promise<CodexExecTurnOutcome>
  interrupt(): void
} {
  const { cmd, args, env: execEnv } = buildCodexExecTurn(
    {
      prompt: input.prompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.contextPrompt ? { contextPrompt: input.contextPrompt } : {}),
      ...(input.mcpConfig ? { mcpConfig: input.mcpConfig } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
      ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
    },
    input.snapshot,
    input.sections,
  )
  input.emit({ kind: 'status', status: 'starting' })
  // Merge order matches the supervisor's spawn composition: explicitly
  // composed instance keys outrank the adapter's per-turn env, exactly as
  // headlessSpawnEnv layers them.
  const child = input.spawnChild(cmd, args, {
    cwd: input.cwd,
    env: { ...execEnv, ...input.env },
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, input.timeoutMs)
  timer.unref?.()

  const done: Promise<CodexExecTurnOutcome> = new Promise((resolve, reject) => {
    let threadId = input.resumeValue ?? ''
    let output = ''
    const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream })
    rl.on('line', (line) => {
      let ev: {
        type?: string
        /** UNBRANDED BY DECISION: a provider/harness-native thread id. */
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
        input.emit({ kind: 'status', status: 'running', harnessSessionId: threadId })
      } else if (
        ev.type === 'item.started' &&
        ev.item?.type &&
        ev.item.type !== 'agent_message'
      ) {
        input.emit({ kind: 'status', status: 'tool', label: ev.item.type })
      } else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') {
        output = ev.item.text ?? ''
        input.emit({
          kind: 'partial-text',
          text: output,
          ...(ev.item.id ? { itemHint: ev.item.id } : {}),
        })
      }
    })
    let stderrTail = ''
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-8192)
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(
        new HeadlessTurnFailure(
          `harness child could not start: ${err.message}`,
          threadId || undefined,
        ),
      )
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new HeadlessTurnFailure('turn timed out', threadId || undefined))
        return
      }
      if (code !== 0) {
        const tail = stderrTail.trim()
        reject(
          new HeadlessTurnFailure(
            `harness exited ${signal ?? code}${tail ? `: ${tail.slice(-2000)}` : ''}`,
            threadId || undefined,
          ),
        )
        return
      }
      if (!threadId) {
        reject(new HeadlessTurnFailure('codex turn ended without reporting a thread id'))
        return
      }
      resolve({ harnessSessionId: threadId, output })
    })
  })
  return { done, interrupt: () => child.kill('SIGKILL') }
}
