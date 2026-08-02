import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveCursorBin, resolveOpencodeBin } from '@podium/agent-bridge'
import type { ControlMessage, UsageBucketWire } from '@podium/protocol'
import { stageDirFor } from '../handoff-package.js'
import { buildHarnessExec } from '../harness-exec.js'
import { repoOpCommand } from '../repo-op'
import { scanClaudeUsage } from '../usage-scan'
import type { ControlHandlers, DaemonContext } from './context'

const execFileAsync = promisify(execFile)

/**
 * A transfer token names a BUNDLE, never a location (POD-1424).
 *
 * The server sends an opaque `transferId`; each daemon derives the file inside its own
 * stage directory and echoes the path it used back in the result. A server-computed
 * path would be a guess about a filesystem the server cannot see, and a server able to
 * name paths on another machine's disk is a traversal surface no validation closes.
 *
 * The token is restricted to the shape the server actually mints, so no separator,
 * parent segment or NUL can survive into a filename.
 */
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,64}$/

export function bundlePathFor(transferId: string, home: string): string | { error: string } {
  if (!TRANSFER_ID.test(transferId)) {
    return { error: `unsafe transferId: expected [A-Za-z0-9_-]{1,64} (got '${transferId}')` }
  }
  return join(stageDirFor(home), `${transferId}.bundle`)
}

/** Allowlisted git operations for the superagent — each op is a fixed argv. */
async function runRepoOp(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'repoOpRequest' }>,
): Promise<void> {
  // Bundle verbs take a TOKEN, not a path: resolve it here, in the daemon, against
  // this machine's own stage — and report the resolved path so the caller can hand
  // the same transfer to the other side without ever naming a location itself.
  let bundlePath: string | undefined
  if (msg.op === 'bundleCreate' || msg.op === 'bundleFetch') {
    const derived = bundlePathFor(msg.args?.transferId ?? '', homedir())
    if (typeof derived !== 'string') {
      ctx.send({ type: 'repoOpResult', requestId: msg.requestId, ok: false, output: derived.error })
      return
    }
    bundlePath = derived
    mkdirSync(dirname(bundlePath), { recursive: true, mode: 0o700 })
  }
  const cmd = repoOpCommand(msg.op, {
    ...(msg.args ?? {}),
    ...(bundlePath && msg.op === 'bundleCreate' ? { out: bundlePath } : {}),
    ...(bundlePath && msg.op === 'bundleFetch' ? { bundle: bundlePath } : {}),
  })
  if ('error' in cmd) {
    ctx.send({ type: 'repoOpResult', requestId: msg.requestId, ok: false, output: cmd.error })
    return
  }
  try {
    if (msg.op === 'clone' && msg.args?.path) {
      mkdirSync(dirname(msg.args.path), { recursive: true, mode: 0o700 })
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
      // The bundle verbs echo the path this daemon chose. git itself prints nothing
      // useful here, and the caller needs to know where the file landed on THIS disk
      // without having been allowed to name it.
      output: bundlePath ? bundlePath : `${stdout}${stderr ? `\n${stderr}` : ''}`.trim(),
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
  if (msg.mcpConfig && msg.agent === 'claude-code') {
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
