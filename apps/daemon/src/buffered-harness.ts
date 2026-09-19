import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  bindHarnessExec,
  buildResolvedInventory,
  harnessMcpConfigTransport,
  type ResolvedHarnessInventory,
} from '@podium/harness'
import type { ControlMessage } from '@podium/protocol/daemon'
import { buildHarnessExec } from './harness-exec.js'
import type { DaemonHarnessRuntime } from './harness-runtime.js'
import { harnessChildStripEnv, harnessInstanceEnv } from './control/session-env.js'

const execFileAsync = promisify(execFile)

/**
 * BUFFERED HARNESS COMPATIBILITY (POD-4304, F09).
 *
 * The `harnessExecRequest` wire frame is REGISTERED (daemon `execHandlers`,
 * protocol `HarnessExecRequestMessage`, server `DaemonRpcService.harnessExec`
 * at S/modules/machines/rpc.ts:1239) but has no in-tree initiator: production
 * source search finds only the definition, no current caller. That absence is
 * NOT evidence for deletion — an older peer can still send the frame, and
 * dynamic callers were not measured. This module is the compatibility owner:
 * do not remove the handler without a contract replacement or an explicit
 * versioned retirement with no silent execution loss.
 *
 * CONTRACT BACKING. The implementation is bound to:
 * - `AgentManifest.exec` (harness package): argv/stdin/env construction per
 *   harness, including the malformed-codex refusal (no silent tool-less run)
 *   and the declared-unsupported throw (no harness substitution).
 * - `bindHarnessExec` + `DaemonHarnessRuntime.current()`: the executable path
 *   and command environment come from the generation-bound snapshot, never a
 *   re-resolved binary. A stale snapshot is refetched once (POD-4294: reject
 *   stale generation, never invent a turn).
 * - `RuntimeDriver.procedures.oneShot` (AR/driver.ts:184) is declared but has
 *   exactly one site and zero implementations — it is NOT claimed as the
 *   replacement. Name similarity is not proof, and its `TranscriptItem[]`
 *   shape is not the buffered `{ok, output}` old-peer shape preserved here.
 *
 * NARROW CONTEXT (POD-4301). The context is `Pick`-narrow (`homeDir` plus the
 * harness runtime snapshot service) so this path cannot reach runtime handles,
 * bridges, observers or archive state. The wire adapter in `control/exec.ts`
 * passes only those two fields.
 *
 * OLD-PEER RESPONSE SEMANTICS (preserved exactly):
 * - success: `{ok:true, output: stdout.trim()}` with a 240s default kill
 *   budget (`timeoutMs` override), 4MiB stdout cap, prompt on stdin (then EOF),
 *   MCP config via temp file (`path` transport) or inline `-c` overrides,
 *   child env = process.env + manifest env + HOME + instance env minus
 *   inherited harness controls, temp file removed in `finally`.
 * - failure: `{ok:false, output: err.message}` for malformed MCP, unsupported
 *   or unknown harness, temp-write failure, timeout, output cap, missing
 *   executable and child non-zero exit. A temp-write failure refuses rather
 *   than running tool-less, mirroring the malformed-codex refusal.
 */

export const BUFFERED_HARNESS_DEFAULT_TIMEOUT_MS = 240_000
export const BUFFERED_HARNESS_MAX_BUFFER_BYTES = 4 * 1024 * 1024

/** Narrow compatibility context: snapshot service plus agent home. No runtime handles. */
export interface BufferedHarnessContext {
  homeDir: string | undefined
  harnessRuntime?: Pick<DaemonHarnessRuntime, 'current' | 'isCurrent'>
}

export type BufferedHarnessRequest = Extract<ControlMessage, { type: 'harnessExecRequest' }>

export interface BufferedHarnessResult {
  ok: boolean
  output: string
}

export interface BufferedHarnessChildOpts {
  timeout: number
  maxBuffer: number
  cwd?: string
  env: NodeJS.ProcessEnv
}

/** Process-boundary seam: execFile + stdin-close + stdout capture. */
export type BufferedHarnessRunChild = (
  cmd: string,
  args: string[],
  opts: BufferedHarnessChildOpts,
  stdin: string,
) => Promise<{ stdout: string }>

export interface BufferedHarnessIo {
  snapshot?: () => Promise<ResolvedHarnessInventory>
  runChild?: BufferedHarnessRunChild
  writeTemp?: (path: string, data: string) => void
  removeTemp?: (path: string) => void
  makeTempPath?: () => string
}

async function defaultSnapshot(ctx: BufferedHarnessContext): Promise<ResolvedHarnessInventory> {
  const snapshot = ctx.harnessRuntime
    ? await ctx.harnessRuntime.current()
    : await buildResolvedInventory({ ...(ctx.homeDir ? { machineHome: ctx.homeDir } : {}) })
  // Stale-generation fence (POD-4294): the snapshot was current at fetch; a
  // concurrent refresh may have superseded it before the child spawns. Re-fetch
  // once rather than executing against a superseded executable set, and never
  // invent a turn when the runtime cannot name the current generation.
  if (ctx.harnessRuntime && !ctx.harnessRuntime.isCurrent(snapshot)) {
    return await ctx.harnessRuntime.current()
  }
  return snapshot
}

/** Process-boundary seam, exported for tests: proves stdin-EOF, timeout and cap
 *  against a real child without a harness binary on PATH. */
export function defaultRunChild(
  cmd: string,
  args: string[],
  opts: BufferedHarnessChildOpts,
  stdin: string,
): Promise<{ stdout: string }> {
  const pending = execFileAsync(cmd, args, {
    timeout: opts.timeout,
    maxBuffer: opts.maxBuffer,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: opts.env,
  })
  // ALWAYS close stdin: stdin-appending CLIs (codex) block on EOF, and
  // claude's variadic --allowedTools would eat an argv prompt, so the prompt
  // rides stdin even when the manifest also places it positionally.
  pending.child.stdin?.end(stdin)
  return pending.then(({ stdout }) => ({ stdout }))
}

export async function executeBufferedHarnessTurn(
  ctx: BufferedHarnessContext,
  msg: BufferedHarnessRequest,
  io?: BufferedHarnessIo,
): Promise<BufferedHarnessResult> {
  const snapshotFor = io?.snapshot ?? (() => defaultSnapshot(ctx))
  const runChild = io?.runChild ?? defaultRunChild
  const writeTemp = io?.writeTemp ?? ((path: string, data: string) => writeFileSync(path, data))
  const removeTemp = io?.removeTemp ?? ((path: string) => rmSync(path, { force: true }))
  const makeTempPath =
    io?.makeTempPath ?? (() => join(tmpdir(), `podium-mcp-${randomUUID()}.json`))

  // Claude's --mcp-config must be a file path: stage the JSON per run. Codex
  // takes inline `-c` overrides (translated in buildHarnessExec) — no file.
  let mcpConfigPath: string | undefined
  if (msg.mcpConfig && harnessMcpConfigTransport(msg.agent) === 'path') {
    mcpConfigPath = makeTempPath()
    try {
      writeTemp(mcpConfigPath, msg.mcpConfig)
    } catch (err) {
      // A temp write failure must refuse, not run tool-less: the caller asked
      // for orchestrator tools and silence would execute without them.
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      }
    }
  }
  try {
    // buildHarnessExec THROWS on malformed codex MCP config (refusing a silent
    // tool-less run) and on declared-unsupported or unknown harnesses — both
    // must surface as a failed turn with the harness named, never a fallback.
    const snapshot = await snapshotFor()
    const {
      cmd,
      args,
      stdin,
      env: execEnv,
    } = bindHarnessExec(
      snapshot,
      msg.agent,
      buildHarnessExec(msg.agent, {
        env: snapshot.commandEnvironment.env,
        prompt: msg.prompt,
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.effort ? { effort: msg.effort } : {}),
        ...(msg.systemPrompt ? { systemPrompt: msg.systemPrompt } : {}),
        ...(mcpConfigPath ? { mcpConfigPath } : {}),
        ...(msg.mcpConfig ? { mcpConfig: msg.mcpConfig } : {}),
        ...(msg.allowedTools ? { allowedTools: msg.allowedTools } : {}),
      }),
    )
    // codex's MCP bearer token rides `execEnv` (POD-1021), merged over process.env.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...execEnv,
      ...(ctx.homeDir ? { HOME: ctx.homeDir } : {}),
      ...harnessInstanceEnv(msg.agent, ctx.homeDir),
    }
    for (const key of harnessChildStripEnv(msg.agent, execEnv)) delete childEnv[key]
    const { stdout } = await runChild(
      cmd,
      args,
      {
        timeout: msg.timeoutMs ?? BUFFERED_HARNESS_DEFAULT_TIMEOUT_MS,
        maxBuffer: BUFFERED_HARNESS_MAX_BUFFER_BYTES,
        ...(msg.cwd ? { cwd: msg.cwd } : {}),
        env: childEnv,
      },
      stdin ?? '',
    )
    return { ok: true, output: stdout.trim() }
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) }
  } finally {
    if (mcpConfigPath) {
      try {
        removeTemp(mcpConfigPath)
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}
