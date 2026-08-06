import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { declaredValue, type HarnessHeadless, harnessAdapterFor } from '@podium/harness'
import type { HarnessAgent, SessionId } from '@podium/model'
import {
  type AgentSession,
  abducoHasSession,
  attachAbducoAgent,
  killAbducoSession,
  shellQuote,
  spawnAbducoAgent,
} from '@podium/pty'
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
function headlessFor(agent: HarnessAgent): HarnessHeadless {
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
  const headless = headlessFor(spec.agent)
  if (headless.driver === 'claude-sdk') {
    if (spec.mcpConfig) writeAtomic(paths.mcp, spec.mcpConfig)
    const exec = buildClaudeDurableExec(spec, paths)
    return {
      ...exec,
      knownSessionId: spec.resumeValue ?? spec.sessionUuid,
    }
  }
  let sessionId = spec.resumeValue ?? spec.sessionUuid
  if (headless.resumeIdAllocation === 'create-chat' && !sessionId)
    sessionId = cursorSessionId(paths, bins, spec.env)
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
): HeadlessTurnOutcome {
  const stdout = existsSync(paths.stdout) ? readFileSync(paths.stdout, 'utf8') : ''
  const stderr = existsSync(paths.stderr) ? readFileSync(paths.stderr, 'utf8').trim() : ''
  const outputFormat = headlessFor(spec.agent).outputFormat

  const exitCode = Number.parseInt(readFileSync(paths.exit, 'utf8').trim(), 10)
  let harnessSessionId = knownSessionId ?? spec.resumeValue ?? spec.sessionUuid ?? ''
  let output = ''

  if (outputFormat === 'claude-stream-json') {
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
  } else if (outputFormat === 'codex-jsonl') {
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
  } else if (outputFormat === 'opencode-jsonl') {
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

interface DurableProgressParser {
  push(chunk: string, flush?: boolean): void
}

/**
 * Incrementally translate a durable runner's stdout JSONL into the same live
 * events as the non-durable drivers. The durable process writes stdout to a
 * journal (not the attached PTY), so this parser is the bridge that keeps a
 * running turn visible before its exit marker exists.
 */
export function createDurableProgressParser(
  agent: HarnessAgent,
  emit: HeadlessEmit,
): DurableProgressParser {
  const outputFormat = headlessFor(agent).outputFormat
  let remainder = ''
  let partialText = ''
  let partialItem = ''
  let opencodeText = ''

  const emitPartial = (text: string, itemHint?: string): void => {
    if (!text || (text === partialText && itemHint === partialItem)) return
    partialText = text
    partialItem = itemHint ?? ''
    emit({
      kind: 'partial-text',
      text,
      ...(itemHint ? { itemHint } : {}),
    })
  }

  const parseLine = (line: string): void => {
    if (!line.trim()) return
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    if (outputFormat === 'claude-stream-json') {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined
      if (event.type === 'system' && event.subtype === 'init') {
        emit({
          kind: 'status',
          status: 'running',
          ...(sessionId ? { harnessSessionId: sessionId } : {}),
        })
        return
      }
      if (event.type === 'stream_event') {
        const stream = event.event as
          | { type?: string; delta?: { type?: string; text?: string } }
          | undefined
        if (stream?.type === 'message_start') {
          partialText = ''
          partialItem = ''
        } else if (stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta') {
          emitPartial(
            partialText + (stream.delta.text ?? ''),
            typeof event.uuid === 'string' ? event.uuid : undefined,
          )
        }
        return
      }
      if (event.type === 'assistant') {
        const message = event.message as
          | { content?: Array<{ type?: string; text?: string; name?: string }> }
          | undefined
        const content = message?.content ?? []
        for (const block of content) {
          if (block.type === 'tool_use') {
            emit({ kind: 'status', status: 'tool', label: block.name ?? 'tool' })
          }
        }
        const text = content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('')
        emitPartial(text, typeof event.uuid === 'string' ? event.uuid : undefined)
      }
      return
    }

    if (outputFormat === 'codex-jsonl') {
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        emit({
          kind: 'status',
          status: 'running',
          harnessSessionId: event.thread_id,
        })
        return
      }
      const item = event.item as
        | { id?: string; type?: string; text?: string; name?: string }
        | undefined
      if (event.type === 'item.started' && item?.type && item.type !== 'agent_message') {
        emit({
          kind: 'status',
          status: 'tool',
          label: item.name ?? item.type,
        })
      } else if (event.type === 'item.completed' && item?.type === 'agent_message') {
        emitPartial(item.text ?? '', item.id)
      }
      return
    }

    if (outputFormat === 'opencode-jsonl') {
      const sessionId = typeof event.sessionID === 'string' ? event.sessionID : undefined
      if (sessionId) {
        emit({ kind: 'status', status: 'running', harnessSessionId: sessionId })
      }
      const part = event.part as { type?: string; text?: string } | undefined
      if (event.type === 'text' && part?.type === 'text') {
        opencodeText += part.text ?? ''
        emitPartial(opencodeText)
      }
    }
  }

  return {
    push(chunk, flush = false): void {
      remainder += chunk
      const lines = remainder.split('\n')
      remainder = lines.pop() ?? ''
      for (const line of lines) parseLine(line)
      if (flush && remainder) {
        parseLine(remainder)
        remainder = ''
      }
    },
  }
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
  sessionId: SessionId,
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
  let stdoutOffset = 0
  const progress = createDurableProgressParser(spec.agent, emit)
  const stdoutDecoder = new StringDecoder('utf8')
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

  const readProgress = (flush = false): void => {
    if (disposed || !existsSync(paths.stdout)) return
    const size = statSync(paths.stdout).size
    if (size < stdoutOffset) stdoutOffset = 0
    if (size > stdoutOffset) {
      const length = size - stdoutOffset
      const bytes = Buffer.allocUnsafe(length)
      const fd = openSync(paths.stdout, 'r')
      try {
        const read = readSync(fd, bytes, 0, length, stdoutOffset)
        stdoutOffset += read
        const chunk = bytes.subarray(0, read)
        progress.push(flush ? stdoutDecoder.end(chunk) : stdoutDecoder.write(chunk), flush)
      } finally {
        closeSync(fd)
      }
    } else if (flush) {
      progress.push(stdoutDecoder.end(), true)
    }
  }

  const collect = (): void => {
    if (disposed) return
    readProgress()
    if (!existsSync(paths.exit)) return
    readProgress(true)
    try {
      const outcome = outcomeFromOutput(spec, paths, knownSessionId)
      if (headlessFor(spec.agent).outputFormat === 'text' && outcome.output) {
        emit({ kind: 'partial-text', text: outcome.output })
      }
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
      if (await abducoHasSession(label)) {
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
        attachment = await spawnAbducoAgent({
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
    void (async () => {
      await killAbducoSession(label)
    })()
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
      void (async () => {
        await killAbducoSession(label)
      })()
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
