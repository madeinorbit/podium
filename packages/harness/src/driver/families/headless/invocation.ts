// packages/harness/src/driver/families/headless/invocation.ts
//
// WHAT ONE HEADLESS TURN RUNS (POD-4614).
//
// One place turns a turn spec into the harness invocation: the argv, what the
// child reads on stdin, the per-invocation env the adapter binds (codex's MCP
// bearer, POD-1021), and the conversation id the turn is pinned to when the
// harness does not mint its own. Merged from the two daemon paths it replaces
// (apps/daemon/src/headless-drivers.ts for the in-process children,
// apps/daemon/src/durable-headless.ts for the abduco runner): there is one
// path now, so there is one shape.
//
// Pure: nothing here spawns, stages a file or reads the environment.

import { randomUUID } from 'node:crypto'
import type { HarnessAgent } from '@podium/model'
import { bindHarnessExec } from '../../../executable-runtime.js'
import type { ResolvedHarnessInventory } from '../../../inventory/build-inventory.js'
import {
  declaredValue,
  type HarnessHeadless,
  type HeadlessExecOptions,
} from '../../../manifest.js'
import { cursorCreateChatInvocation, harnessAdapterFor } from '../../../registry.js'
import { buildClaudeDurableTurn, claudeDurableExecutable } from '../claude-sdk/exec.js'
import {
  buildClaudeStreamInvocation,
  claudeStreamEnvOverlay,
  mcpConfigInline,
} from '../claude-sdk/protocol.js'
import { buildCodexExecTurn } from '../codex/exec-turn.js'
import type { HeadlessTurnSpec } from './types.js'

/** The adapter's declared headless section, or a loud refusal. */
export function headlessFor(agent: HarnessAgent): HarnessHeadless {
  const manifest = harnessAdapterFor(agent)
  if (!manifest) throw new Error(`agent kind ${String(agent)} has no harness manifest`)
  const headless = declaredValue(manifest.headless)
  if (!headless)
    throw new Error(
      `harness ${manifest.kind} declares headless unsupported: ${
        manifest.headless.supported ? '' : manifest.headless.reason
      }`,
    )
  return headless
}

/** Pure argv builder for the resume-exec drivers (grok/opencode/cursor/pi)
 *  so the exact invocation shape is unit-testable. `sessionId` is the pinned
 *  harness session id (pre-minted for grok/cursor/pi; absent on an opencode
 *  first turn, where the id is captured from the JSON event stream). Pure
 *  dispatch into the harness adapter registry (#158): each adapter's
 *  `headless.buildExec` owns its CLI's invocation shape. */
export function buildHeadlessExec(
  agent: HarnessAgent,
  opts: HeadlessExecOptions,
  snapshot: ResolvedHarnessInventory,
): { cmd: string; args: string[]; env?: Record<string, string>; stdin?: string } {
  const manifest = harnessAdapterFor(agent)
  const headless = manifest && declaredValue(manifest.headless)
  const buildExec = headless && declaredValue(headless.buildExec)
  if (!buildExec) throw new Error(`agent kind ${String(agent)} has no headless exec builder`)
  return bindHarnessExec(
    snapshot,
    agent,
    buildExec({
      ...opts,
      env: opts.env ?? snapshot.commandEnvironment.env,
    }),
  )
}

/**
 * How the turn's stdin is wired. `none`: EOF at once. `bytes`: the payload,
 * then EOF (pi and `claude -p` read the prompt there). `live`: the host's
 * write channel stays open for the whole turn (the stream-json claude turn
 * answers permission asks over it).
 */
export type HeadlessStdin =
  | { kind: 'none' }
  | { kind: 'bytes'; data: string }
  | { kind: 'live' }

export interface HeadlessInvocation {
  cmd: string
  args: string[]
  stdin: HeadlessStdin
  /** Adapter-bound env for THIS invocation (codex MCP bearer, POD-1021);
   *  merged under the instance-owned keys by the supervisor's composition. */
  execEnv?: Record<string, string>
  /** Env the child needs beyond composition (claude's IS_SANDBOX as root). */
  envOverlay?: Record<string, string>
  /** UNBRANDED BY DECISION: a provider/harness-native session id. The
   *  conversation this turn is pinned to, when known before it runs. */
  pinnedSessionId?: string
}

/** Whether the turn needs a conversation id allocated by a separate command
 *  before it can run (cursor's `create-chat`). */
export function needsAllocation(spec: HeadlessTurnSpec): boolean {
  const headless = headlessFor(spec.agent)
  return (
    headless.resumeIdAllocation === 'create-chat' && !spec.resumeValue && !spec.sessionUuid
  )
}

/** The allocation command (`create-chat`), run to completion before the turn. */
export function allocationInvocation(snapshot: ResolvedHarnessInventory): HeadlessInvocation {
  const invocation = cursorCreateChatInvocation(snapshot)
  return { cmd: invocation.cmd, args: [...invocation.args], stdin: { kind: 'none' } }
}

/**
 * Fail closed on a no-tools turn a harness cannot enforce, BEFORE anything
 * runs: a turn that was promised no tools must never start with them.
 */
export function assertHeadlessToolPolicy(spec: HeadlessTurnSpec): void {
  const headless = headlessFor(spec.agent)
  if (spec.toolPolicy === 'none' && headless.noTools !== 'enforced') {
    throw new Error(`harness ${spec.agent} cannot enforce a no-tools headless turn`)
  }
}

/**
 * The invocation for one turn. `allocated` is the conversation id a prior
 * allocation step produced (cursor). A structured turn is the stream-json
 * claude surface — the only one with a permission channel; every other turn
 * is a bounded, non-interactive CLI run whose whole output is its result.
 */
export function composeHeadlessInvocation(
  spec: HeadlessTurnSpec,
  snapshot: ResolvedHarnessInventory,
  opts: { allocated?: string; isRoot: boolean },
): HeadlessInvocation {
  assertHeadlessToolPolicy(spec)
  const headless = headlessFor(spec.agent)
  if (headless.driver === 'claude-sdk') {
    const executable = spec.executablePath ?? claudeDurableExecutable(snapshot)
    const envOverlay = claudeStreamEnvOverlay({
      ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
      isRoot: opts.isRoot,
    })
    if (spec.structuredPermissions) {
      const { cmd, args } = buildClaudeStreamInvocation({ ...spec }, executable)
      const pinned = spec.resumeValue ?? spec.sessionUuid
      return {
        cmd,
        args,
        stdin: { kind: 'live' },
        ...(Object.keys(envOverlay).length > 0 ? { envOverlay } : {}),
        ...(pinned ? { pinnedSessionId: pinned } : {}),
      }
    }
    // MCP rides argv as inline JSON, the same shape the stream-json surface
    // already uses — no staged file, so nothing outlives the turn but its host.
    const turn = buildClaudeDurableTurn(
      spec,
      {
        mcp: spec.mcpConfig && spec.toolPolicy !== 'none' ? mcpConfigInline(spec.mcpConfig) : '',
      },
      executable,
    )
    return {
      cmd: turn.cmd,
      args: turn.args,
      stdin: { kind: 'bytes', data: turn.stdin },
      ...(Object.keys(envOverlay).length > 0 ? { envOverlay } : {}),
      ...(turn.knownSessionId ? { pinnedSessionId: turn.knownSessionId } : {}),
    }
  }
  const common: HeadlessExecOptions = {
    prompt: spec.prompt,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.contextPrompt ? { contextPrompt: spec.contextPrompt } : {}),
    ...(spec.mcpConfig ? { mcpConfig: spec.mcpConfig } : {}),
    ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
    ...(spec.toolPolicy ? { toolPolicy: spec.toolPolicy } : {}),
    ...(spec.resumeValue ? { resumeValue: spec.resumeValue } : {}),
  }
  if (headless.driver === 'codex-json') {
    const manifest = harnessAdapterFor(spec.agent)
    if (!manifest) throw new Error(`no harness adapter for '${spec.agent}'`)
    const { cmd, args, env } = buildCodexExecTurn(common, snapshot, { headless: manifest.headless })
    return {
      cmd,
      args,
      stdin: { kind: 'none' },
      ...(env && Object.keys(env).length > 0 ? { execEnv: env } : {}),
      ...(spec.resumeValue ? { pinnedSessionId: spec.resumeValue } : {}),
    }
  }
  // resume-exec. `spec.sessionUuid` IS THE SERVER'S PRE-MINTED ID AND MUST WIN
  // (POD-782): the control layer binds the transcript tail to it before the
  // turn starts, so a second id minted here would write the conversation
  // where nobody is tailing.
  let sessionId = spec.resumeValue ?? spec.sessionUuid ?? opts.allocated
  if (!sessionId && headless.resumeIdAllocation === 'daemon-minted-uuid') sessionId = randomUUID()
  if (!sessionId && headless.resumeIdAllocation === 'create-chat') {
    throw new Error('headless turn needs an allocated conversation id before it can run')
  }
  const exec = buildHeadlessExec(spec.agent, { ...common, ...(sessionId ? { sessionId } : {}) }, snapshot)
  return {
    cmd: exec.cmd,
    args: exec.args,
    stdin: exec.stdin !== undefined ? { kind: 'bytes', data: exec.stdin } : { kind: 'none' },
    ...(exec.env && Object.keys(exec.env).length > 0 ? { execEnv: exec.env } : {}),
    ...(sessionId ? { pinnedSessionId: sessionId } : {}),
  }
}
