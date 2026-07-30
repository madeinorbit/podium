import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type AgentSession,
  abducoHasSessionAsync,
  attachAbducoAgent,
  killAbducoSession,
  shellQuote,
  spawnAbducoAgent,
} from '@podium/agent-bridge'
import { stateDir } from '@podium/runtime/config'
import type { HarnessBins } from './harness-exec.js'
import {
  buildHeadlessExec,
  type HeadlessEmit,
  HeadlessTurnError,
  type HeadlessTurnHandle,
  type HeadlessTurnOutcome,
  type HeadlessTurnSpec,
} from './headless-drivers.js'

interface DurableResult {
  ok: boolean
  error?: string
  harnessSessionId?: string
  output?: string
}

interface DurablePaths {
  dir: string
  script: string
  stdout: string
  stderr: string
  exit: string
  result: string
  running: string
  createdAt: string
  input: string
  mcp: string
  cursorSession: string
}

function turnDir(turnId: string): string {
  const safe = createHash('sha256').update(turnId).digest('hex')
  return join(stateDir(), 'headless-turns', safe)
}

function pathsFor(turnId: string): DurablePaths {
  const dir = turnDir(turnId)
  return {
    dir,
    script: join(dir, 'run.sh'),
    stdout: join(dir, 'stdout.jsonl'),
    stderr: join(dir, 'stderr.log'),
    exit: join(dir, 'exit-code'),
    result: join(dir, 'result.json'),
    running: join(dir, 'running'),
    createdAt: join(dir, 'created-at'),
    input: join(dir, 'input.txt'),
    mcp: join(dir, 'mcp.json'),
    cursorSession: join(dir, 'cursor-session'),
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

function combinedInstructions(spec: HeadlessTurnSpec): string | undefined {
  const value = [spec.systemPrompt, spec.contextPrompt]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n')
  return value || undefined
}

export function buildClaudeDurableExec(
  spec: HeadlessTurnSpec,
  paths: Pick<DurablePaths, 'mcp'>,
): { cmd: string; args: string[]; stdin: string } {
  const instructions = combinedInstructions(spec)
  const mode = spec.permissionMode === 'bypassPermissions' ? 'auto' : spec.permissionMode || 'auto'
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    mode,
    ...(instructions ? ['--append-system-prompt', instructions] : []),
    ...(spec.model && spec.model !== 'auto' ? ['--model', spec.model] : []),
    ...(spec.effort ? ['--effort', spec.effort] : []),
    ...(spec.mcpConfig ? ['--mcp-config', paths.mcp] : []),
    ...(spec.resumeValue
      ? ['--resume', spec.resumeValue]
      : spec.sessionUuid
        ? ['--session-id', spec.sessionUuid]
        : []),
    // Variadic: keep last, and feed the real user prompt on stdin.
    ...(spec.allowedTools?.length ? ['--allowedTools', spec.allowedTools.join(',')] : []),
  ]
  return { cmd: 'claude', args, stdin: spec.prompt }
}

function cursorSessionId(
  paths: DurablePaths,
  bins: HarnessBins,
  env?: Record<string, string>,
): string {
  if (existsSync(paths.cursorSession)) return readFileSync(paths.cursorSession, 'utf8').trim()
  const output = execFileSync(bins.cursor(), ['create-chat'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  })
  const id = output.split('\n').at(-1)?.trim() ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`cursor create-chat did not print a chat id: ${output.trim()}`)
  }
  writeAtomic(paths.cursorSession, id)
  return id
}

function prepareInvocation(
  spec: HeadlessTurnSpec,
  paths: DurablePaths,
  bins: HarnessBins,
): {
  cmd: string
  args: string[]
  stdin?: string
  knownSessionId?: string
  env?: Record<string, string>
} {
  if (spec.agent === 'claude-code') {
    if (spec.mcpConfig) writeAtomic(paths.mcp, spec.mcpConfig)
    const exec = buildClaudeDurableExec(spec, paths)
    return {
      ...exec,
      knownSessionId: spec.resumeValue ?? spec.sessionUuid,
    }
  }
  let sessionId = spec.resumeValue ?? spec.sessionUuid
  if (spec.agent === 'cursor' && !sessionId) sessionId = cursorSessionId(paths, bins, spec.env)
  const exec = buildHeadlessExec(
    spec.agent,
    {
      prompt: spec.prompt,
      ...(spec.contextPrompt ? { contextPrompt: spec.contextPrompt } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
      ...(spec.mcpConfig ? { mcpConfig: spec.mcpConfig } : {}),
      ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
      ...(spec.resumeValue ? { resumeValue: spec.resumeValue } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
    bins,
  )
  return { ...exec, ...(sessionId ? { knownSessionId: sessionId } : {}) }
}

function writeRunner(
  spec: HeadlessTurnSpec,
  paths: DurablePaths,
  bins: HarnessBins,
): { knownSessionId?: string; env?: Record<string, string> } {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  if (!existsSync(paths.createdAt)) writeAtomic(paths.createdAt, String(Date.now()))
  const invocation = prepareInvocation(spec, paths, bins)
  if (invocation.stdin !== undefined) writeAtomic(paths.input, invocation.stdin)
  const command = [invocation.cmd, ...invocation.args].map(shellQuote).join(' ')
  const stdin = invocation.stdin !== undefined ? ` < ${shellQuote(paths.input)}` : ''
  const script = `#!/bin/sh
printf '%s\\n' "$$" > ${shellQuote(paths.running)}
${command}${stdin} > ${shellQuote(paths.stdout)} 2> ${shellQuote(paths.stderr)}
code=$?
tmp=${shellQuote(paths.exit)}.tmp-$$
printf '%s\\n' "$code" > "$tmp"
mv "$tmp" ${shellQuote(paths.exit)}
exit "$code"
`
  writeFileSync(paths.script, script, { mode: 0o700 })
  chmodSync(paths.script, 0o700)
  return {
    ...(invocation.knownSessionId ? { knownSessionId: invocation.knownSessionId } : {}),
    // Adapter-supplied env (codex's MCP bearer token, POD-1021) — merged into the
    // abduco child's environment at spawn, never written into the run script.
    ...(invocation.env && Object.keys(invocation.env).length > 0 ? { env: invocation.env } : {}),
  }
}

function readResult(paths: DurablePaths): DurableResult | undefined {
  if (!existsSync(paths.result)) return undefined
  try {
    return JSON.parse(readFileSync(paths.result, 'utf8')) as DurableResult
  } catch {
    return undefined
  }
}

function outcomeFromOutput(
  spec: HeadlessTurnSpec,
  paths: DurablePaths,
  knownSessionId: string | undefined,
  emit: HeadlessEmit,
): HeadlessTurnOutcome {
  const stdout = existsSync(paths.stdout) ? readFileSync(paths.stdout, 'utf8') : ''
  const stderr = existsSync(paths.stderr) ? readFileSync(paths.stderr, 'utf8').trim() : ''
  const exitCode = Number.parseInt(readFileSync(paths.exit, 'utf8').trim(), 10)
  let harnessSessionId = knownSessionId ?? spec.resumeValue ?? spec.sessionUuid ?? ''
  let output = ''

  if (spec.agent === 'claude-code') {
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line) as {
          type?: string
          subtype?: string
          session_id?: string
          result?: string
          message?: { content?: Array<{ type?: string; text?: string }> }
        }
        if (event.session_id) harnessSessionId = event.session_id
        if (event.type === 'result' && typeof event.result === 'string') output = event.result
        if (event.type === 'assistant') {
          const text = event.message?.content
            ?.filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('')
          if (text) output = text
        }
      } catch {}
    }
  } else if (spec.agent === 'codex') {
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line) as {
          type?: string
          thread_id?: string
          item?: { type?: string; text?: string }
        }
        if (event.type === 'thread.started' && event.thread_id) {
          harnessSessionId = event.thread_id
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          output = event.item.text ?? output
        }
      } catch {}
    }
  } else if (spec.agent === 'opencode') {
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line) as {
          type?: string
          sessionID?: string
          part?: { type?: string; text?: string }
        }
        if (event.sessionID) harnessSessionId = event.sessionID
        if (event.type === 'text' && event.part?.type === 'text') {
          output += event.part.text ?? ''
        }
      } catch {}
    }
    output = output.trim()
  } else {
    output = stdout.trim()
  }

  if (output) emit({ kind: 'partial-text', text: output })
  if (exitCode !== 0) {
    throw new HeadlessTurnError(
      `harness exited ${Number.isNaN(exitCode) ? 'unknown' : exitCode}${stderr ? `: ${stderr.slice(-2000)}` : ''}`,
      harnessSessionId || undefined,
    )
  }
  if (!harnessSessionId) {
    throw new Error(`${spec.agent} turn ended without reporting a session id`)
  }
  return { harnessSessionId, output }
}

function settledHandle(result: DurableResult, turnId: string): HeadlessTurnHandle {
  const done = result.ok
    ? Promise.resolve({
        harnessSessionId: result.harnessSessionId ?? '',
        output: result.output ?? '',
      })
    : Promise.reject(
        new HeadlessTurnError(result.error ?? 'durable turn failed', result.harnessSessionId),
      )
  return { turnId, done, interrupt() {} }
}

/** Run or reattach one process-per-turn harness invocation under the same
 * abduco label convention as normal Podium sessions. Output and the terminal
 * result are journaled beside the socket because abduco intentionally does not
 * retain detached output. */
export function runDurableHeadlessTurn(
  turnId: string,
  sessionId: string,
  spec: HeadlessTurnSpec,
  emit: HeadlessEmit,
  bins: HarnessBins,
): HeadlessTurnHandle {
  const paths = pathsFor(turnId)
  const previous = readResult(paths)
  if (previous) return settledHandle(previous, turnId)

  const label = spec.durableLabel ?? `podium-${sessionId}`
  const { knownSessionId, env: execEnv } = writeRunner(spec, paths, bins)
  const spawnEnv = { ...spec.env, ...execEnv }
  let attachment: AgentSession | undefined
  let settled = false
  let disposed = false
  let poll: ReturnType<typeof setInterval> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let resolveDone!: (value: HeadlessTurnOutcome) => void
  let rejectDone!: (reason: unknown) => void
  const done = new Promise<HeadlessTurnOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const finish = (result: DurableResult): void => {
    if (settled || disposed) return
    settled = true
    if (poll) clearInterval(poll)
    if (timeout) clearTimeout(timeout)
    attachment?.dispose()
    writeAtomic(paths.result, JSON.stringify(result))
    if (result.ok) {
      resolveDone({
        harnessSessionId: result.harnessSessionId ?? '',
        output: result.output ?? '',
      })
    } else {
      rejectDone(
        new HeadlessTurnError(result.error ?? 'durable turn failed', result.harnessSessionId),
      )
    }
  }

  const collect = (): void => {
    if (disposed || !existsSync(paths.exit)) return
    try {
      const outcome = outcomeFromOutput(spec, paths, knownSessionId, emit)
      finish({ ok: true, ...outcome })
    } catch (error) {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof HeadlessTurnError && error.harnessSessionId
          ? { harnessSessionId: error.harnessSessionId }
          : {}),
      })
    }
  }

  void (async () => {
    try {
      // The harness may have completed while no daemon was attached. Consume
      // its journal before deciding that a vanished abduco socket is a failure.
      collect()
      if (settled || disposed) return
      if (await abducoHasSessionAsync(label)) {
        attachment = attachAbducoAgent({ label, cols: 120, rows: 40 })
      } else if (existsSync(paths.running)) {
        // Close the race where the process writes its exit journal between the
        // first collect() and the socket check.
        collect()
        if (settled || disposed) return
        finish({
          ok: false,
          error: 'durable headless abduco session disappeared before writing a result',
          ...(knownSessionId ? { harnessSessionId: knownSessionId } : {}),
        })
        return
      } else {
        emit({ kind: 'status', status: 'starting' })
        attachment = spawnAbducoAgent({
          label,
          cmd: '/bin/sh',
          args: [paths.script],
          cwd: spec.cwd,
          cols: 120,
          rows: 40,
          ...(Object.keys(spawnEnv).length > 0 ? { env: spawnEnv } : {}),
        })
      }
      if (disposed) {
        attachment.dispose()
        return
      }
      emit({ kind: 'status', status: 'running' })
      attachment.onExit(collect)
      poll = setInterval(collect, 100)
      poll.unref?.()
      collect()
    } catch (error) {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(knownSessionId ? { harnessSessionId: knownSessionId } : {}),
      })
    }
  })()

  const createdAt = Number.parseInt(readFileSync(paths.createdAt, 'utf8'), 10)
  const remaining = Math.max(1, (spec.timeoutMs ?? 600_000) - (Date.now() - createdAt))
  timeout = setTimeout(() => {
    killAbducoSession(label)
    finish({
      ok: false,
      error: 'turn timed out',
      ...(knownSessionId ? { harnessSessionId: knownSessionId } : {}),
    })
  }, remaining)
  timeout.unref?.()

  return {
    turnId,
    done,
    interrupt() {
      killAbducoSession(label)
      finish({
        ok: false,
        error: 'turn interrupted',
        ...(knownSessionId ? { harnessSessionId: knownSessionId } : {}),
      })
    },
    dispose() {
      disposed = true
      if (poll) clearInterval(poll)
      if (timeout) clearTimeout(timeout)
      attachment?.dispose()
    },
  }
}

export function acknowledgeDurableHeadlessTurn(turnId: string): void {
  rmSync(turnDir(turnId), { recursive: true, force: true })
}
