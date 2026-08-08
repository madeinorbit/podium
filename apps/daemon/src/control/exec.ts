import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { harnessMcpConfigTransport, resolveCursorBin, resolveOpencodeBin } from '@podium/harness'
import type { UsageBucketWire } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import { bundleStagePath } from '../handoff-package'
import { buildHarnessExec } from '../harness-exec.js'
import { repoOpCommand } from '../repo-op'
import { scanHostUsage } from '../usage-scan'
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
      ctx.send({
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: false,
        output: 'missing args',
      })
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
            // lsFiles [POD-412] is the one op whose output scales with the size
            // of the checkout rather than with a fixed record count: ~46 bytes
            // per path here, so the shared 1 MiB ceiling would start truncating
            // — as an execFile ERROR, not a short read — at roughly 23k tracked
            // files. 8 MiB carries ~180k. Past that the op fails and the picker
            // simply offers no file rows (see `files.search`), which is the
            // right failure: an @-menu is a convenience, never a correctness
            // surface.
            timeout: 120_000,
            maxBuffer: msg.op === 'lsFiles' ? 8 * 1024 * 1024 : 1024 * 1024,
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
        ...(msg.effort ? { effort: msg.effort } : {}),
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

/**
 * PAST THE TTL, SERVE STALE AND RESCAN BEHIND IT (POD-1624) — the same shape the
 * quota memo uses, and here it protects more than one reader's latency. This scan
 * JSON.parses every usage-bearing line of every Claude and Codex transcript
 * touched in the last 7 days, and it runs on the DAEMON's event loop, which is
 * the loop carrying PTY traffic. POD-570 added the Codex half, roughly doubling
 * the walk (see POD-577). A memo that only bounds how OFTEN the scan runs still
 * lets it block that loop for the duration whenever it does; serving the previous
 * buckets keeps the request off the critical path entirely.
 *
 * WORST-CASE STALENESS: TTL + one scan (~120s + the scan's own duration). The
 * rescan is kicked off by the first read past the TTL, never deferred.
 */
// Keyed by context, never module-global: two daemon runtimes in one process (the
// test lane makes them routinely) must not share one another's in-flight scan.
const usageRescans = new WeakMap<DaemonContext, Promise<void>>()

function rescanUsage(ctx: DaemonContext, sinceMs: number): Promise<void> {
  // One scan at a time — concurrent pollers must not stack copies of a
  // CPU-bound walk onto the loop they are already competing with.
  const pending = usageRescans.get(ctx)
  if (pending) return pending
  const started = (async () => {
    let buckets: UsageBucketWire[]
    try {
      buckets = await scanHostUsage({
        sinceMs,
        ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
      })
    } catch {
      buckets = []
    }
    ctx.usageMemo.value = { atMs: Date.now(), sinceMs, buckets }
  })().finally(() => {
    usageRescans.delete(ctx)
  })
  usageRescans.set(ctx, started)
  return started
}

async function runUsageScan(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'usageRequest' }>,
): Promise<void> {
  const sinceMs = msg.sinceMs ?? Date.now() - 7 * 24 * 3_600_000
  const memo = ctx.usageMemo.value
  const usable = memo && memo.sinceMs <= sinceMs
  if (!usable) {
    // No buckets covering this window have ever been computed — this one caller
    // has nothing to be served and must wait.
    await rescanUsage(ctx, sinceMs)
  } else if (Date.now() - memo.atMs >= USAGE_MEMO_TTL_MS) {
    void rescanUsage(ctx, sinceMs)
  }
  const current = ctx.usageMemo.value
  const buckets = current
    ? current.buckets.filter((b) => Date.parse(b.hour) >= sinceMs - 3_600_000)
    : []
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
