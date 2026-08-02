import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { harnessMcpConfigTransport, resolveCursorBin, resolveOpencodeBin } from '@podium/harness'
import type { ControlMessage } from '@podium/protocol'
import type { UsageBucketWire } from '@podium/model'
import { buildHarnessExec } from '../harness-exec.js'
import { bundleStagePath } from '../handoff-package'
import { repoOpCommand } from '../repo-op'
import { scanClaudeUsage } from '../usage-scan'
import type { ControlHandlers, DaemonContext } from './context'

const execFileAsync = promisify(execFile)

/** Allowlisted git operations for the superagent — each op is a fixed argv. */
async function runRepoOp(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'repoOpRequest' }>,
): Promise<void> {
  /**
   * THE BUNDLE OPS NAME A TRANSFER, NOT A PATH (POD-1405).
   *
   * The server supplies an opaque `token`; the location is derived HERE, inside
   * the daemon's own stage directory, by the same `stagePathFor` the chunk-write
   * side uses — so both ends agree by construction rather than by convention, and
   * a caller can never point either op at an arbitrary file. This mirrors the
   * containment the chunk-READ side already enforces.
   */
  const args = { ...(msg.args ?? {}) }
  if (msg.op === 'bundleCreate' || msg.op === 'bundleFetch') {
    if (!args.token) {
      ctx.send({ type: 'repoOpResult', requestId: msg.requestId, ok: false, output: 'missing args' })
      return
    }
    const staged = bundleStagePath(ctx.homeDir ?? homedir(), args.token)
    if (msg.op === 'bundleCreate') args.out = staged
    else args.bundle = staged
  }
  const cmd = repoOpCommand(msg.op, args)
  if ('error' in cmd) {
    ctx.send({ type: 'repoOpResult', requestId: msg.requestId, ok: false, output: cmd.error })
    return
  }
  try {
    if (msg.op === 'clone' && msg.args?.path) {
      mkdirSync(dirname(msg.args.path), { recursive: true, mode: 0o700 })
    }
    if (msg.op === 'bundleCreate' && args.out) {
      mkdirSync(dirname(args.out), { recursive: true, mode: 0o700 })
    }
    const runArgs = cmd.bin === 'git' ? ['-C', msg.cwd, ...cmd.argv] : cmd.argv
    const opts =
      cmd.bin === 'git'
        ? {
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
            ...(msg.op === 'clone' ? { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } } : {}),
          }
        : { cwd: msg.cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }
    const { stdout, stderr } = await execFileAsync(cmd.bin, runArgs, opts)
    ctx.send({
      type: 'repoOpResult',
      requestId: msg.requestId,
      ok: true,
      // bundleCreate answers "<sizeBytes>\t<stagePath>" — git itself prints only a
      // progress meter. The size drives the chunked transfer, and the PATH is
      // echoed back the same way the handoff export echoes its own `stagePath`:
      // only this daemon knows its home directory, so the server must be told
      // rather than compute a path on a filesystem it cannot see.
      output:
        msg.op === 'bundleCreate' && args.out
          ? `${statSync(args.out).size}\t${args.out}`
          : `${stdout}${stderr ? `\n${stderr}` : ''}`.trim(),
    })
  } catch (err) {
    ctx.send({
      type: 'repoOpResult',
      requestId: msg.requestId,
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    })
  }
}

/** One-shot `claude -p` / `codex exec` / `grok -p` for the harness-backed superagent. */
async function runHarnessExec(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'harnessExecRequest' }>,
): Promise<void> {
  // Claude's --mcp-config must be a file path, so write the JSON to a temp
  // file for the run and clean it up afterwards. Codex takes the raw JSON
  // instead (translated to `-c` overrides in buildHarnessExec) — no file.
  let mcpConfigPath: string | undefined
  if (msg.mcpConfig && harnessMcpConfigTransport(msg.agent) === 'path') {
    mcpConfigPath = join(tmpdir(), `podium-mcp-${randomUUID()}.json`)
    try {
      writeFileSync(mcpConfigPath, msg.mcpConfig)
    } catch {
      mcpConfigPath = undefined
    }
  }
  try {
    // Inside the try: buildHarnessExec THROWS on a malformed codex MCP config
    // (refusing a silent tool-less run) — that must surface as a failed turn.
    const {
      cmd,
      args,
      stdin,
      env: execEnv,
    } = buildHarnessExec(
      msg.agent,
      {
        prompt: msg.prompt,
        ...(msg.model ? { model: msg.model } : {}),
        ...(msg.systemPrompt ? { systemPrompt: msg.systemPrompt } : {}),
        ...(mcpConfigPath ? { mcpConfigPath } : {}),
        ...(msg.mcpConfig ? { mcpConfig: msg.mcpConfig } : {}),
        ...(msg.allowedTools ? { allowedTools: msg.allowedTools } : {}),
      },
      { opencode: resolveOpencodeBin, cursor: resolveCursorBin },
    )
    // promisified execFile still exposes the child: deliver the prompt on
    // stdin (claude — variadic --allowedTools would eat an argv prompt) and
    // ALWAYS close the pipe, or stdin-appending CLIs (codex) block on EOF.
    // Timeout/maxBuffer kill-budget semantics are execFileAsync's, unchanged.
    // codex's MCP bearer token rides `execEnv` (POD-1021), merged over process.env.
    const pending = execFileAsync(cmd, args, {
      timeout: msg.timeoutMs ?? 240_000,
      maxBuffer: 4 * 1024 * 1024,
      ...(msg.cwd ? { cwd: msg.cwd } : {}),
      ...(execEnv ? { env: { ...process.env, ...execEnv } } : {}),
    })
    pending.child.stdin?.end(stdin ?? '')
    const { stdout } = await pending
    ctx.send({
      type: 'harnessExecResult',
      requestId: msg.requestId,
      ok: true,
      output: stdout.trim(),
    })
  } catch (err) {
    ctx.send({
      type: 'harnessExecResult',
      requestId: msg.requestId,
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    })
  } finally {
    if (mcpConfigPath) {
      try {
        rmSync(mcpConfigPath, { force: true })
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}

// A usage scan reads every recently-active transcript — memo it (ctx.usageMemo)
// so the status chip's poll doesn't redo the walk per client. The TTL must exceed
// the chip's poll interval (UsageView polls every 90s); at 60s the memo was always
// stale by the next poll, so every poll re-read every recent transcript end to end.
const USAGE_MEMO_TTL_MS = 120_000

async function runUsageScan(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'usageRequest' }>,
): Promise<void> {
  const sinceMs = msg.sinceMs ?? Date.now() - 7 * 24 * 3_600_000
  const memo = ctx.usageMemo.value
  let buckets: UsageBucketWire[]
  if (memo && Date.now() - memo.atMs < USAGE_MEMO_TTL_MS && memo.sinceMs <= sinceMs) {
    buckets = memo.buckets.filter((b) => Date.parse(b.hour) >= sinceMs - 3_600_000)
  } else {
    try {
      buckets = await scanClaudeUsage({
        sinceMs,
        ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
      })
    } catch {
      buckets = []
    }
    ctx.usageMemo.value = { atMs: Date.now(), sinceMs, buckets }
  }
  ctx.send({ type: 'usageResult', requestId: msg.requestId, hostname: hostname(), buckets })
}

async function runAgentQuotaScan(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'agentQuotaRequest' }>,
): Promise<void> {
  const agents = await ctx.quotaFetcher.getAgentQuota(msg.refresh ?? false)
  ctx.send({ type: 'agentQuotaResult', requestId: msg.requestId, hostname: hostname(), agents })
}

export const execHandlers: Pick<
  ControlHandlers,
  'repoOpRequest' | 'harnessExecRequest' | 'usageRequest' | 'agentQuotaRequest'
> = {
  repoOpRequest: (ctx, msg) => {
    void runRepoOp(ctx, msg)
  },
  harnessExecRequest: (ctx, msg) => {
    void runHarnessExec(ctx, msg)
  },
  usageRequest: (ctx, msg) => {
    void runUsageScan(ctx, msg)
  },
  agentQuotaRequest: (ctx, msg) => {
    void runAgentQuotaScan(ctx, msg)
  },
}
