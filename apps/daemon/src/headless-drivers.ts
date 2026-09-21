import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  bindHarnessExec,
  declaredValue,
  type HarnessHeadless,
  type HeadlessExecOptions,
  harnessAdapterFor,
  LineDecoder,
  type ResolvedHarnessInventory,
  resolvedHarnessPath,
} from '@podium/harness'
import {
  buildClaudeStreamInvocation,
  claudeStreamEnvOverlay,
  claudeSdkExecutablePath,
  codexHarnessKind,
  type ClaudeStreamTransport,
  createClaudeStreamClient,
  cursorCreateChatInvocation,
  HeadlessTurnFailure,
  parseCursorChatId,
  runCodexExecTurn,
} from '@podium/harness/driver/host'
import { harnessChildStripEnv, harnessInstanceEnv } from './control/session-env.js'
import type { AccountId, HarnessAgent, SessionId } from '@podium/model'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { createPiStreamReducer, type PiStreamEffect } from '@podium/harness/driver/host'

const DEFAULT_TURN_TIMEOUT_MS = 600_000

export interface HeadlessTurnSpec {
  agent: HarnessAgent
  accountId: AccountId
  requestDigest: string
  model?: string
  effort?: string
  cwd: string
  prompt: string
  contextPrompt?: string
  systemPrompt?: string
  /** MCP config JSON ({ mcpServers: { name: { url, headers } } }). */
  mcpConfig?: string
  allowedTools?: string[]
  permissionMode?: string
  toolPolicy?: 'none'
  /** Harness session id to resume; absent = first turn. */
  resumeValue?: string
  /** Claude only: mint the first-turn session with this UUID. */
  sessionUuid?: string
  timeoutMs?: number
  /** Instance-owned child environment (HOME + CLI/session routing). */
  env?: Record<string, string>
  /** Exact durable host label for the owning instance/session. */
  durableLabel?: string
  /** Absolute executable captured from the current generation. */
  executablePath?: string
  /** Route SDK tool authorization through structured RuntimeDriver interactions. */
  structuredPermissions?: true
}

export interface HeadlessTurnOutcome {
  /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
  harnessSessionId: string
  output: string
  observedModel?: string
  observedEffort?: string
}

/**
 * A turn that failed AFTER the harness minted its session. The conversation
 * exists on disk, so the caller must still learn its id — otherwise one
 * interrupted/errored turn orphans the whole thread: no resume ref, no
 * transcript binding, and the next turn silently starts a new conversation.
 */
export class HeadlessTurnError extends HeadlessTurnFailure {
  constructor(
    message: string,
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    harnessSessionId?: string,
  ) {
    super(message, harnessSessionId)
    this.name = 'HeadlessTurnError'
  }
}

export type HeadlessEmit = (event: HeadlessTurnEvent) => void

export interface HeadlessTurnHandle {
  /** Stable durable turn id when the control layer assigned one. */
  turnId?: string
  /** Established by the control layer before this handle enters the live map.
   * Reuse is legal only for a byte-identical durable identity. */
  identity?: HeadlessTurnIdentity
  done: Promise<HeadlessTurnOutcome>
  interrupt(): void
  /** Detach local resources without killing a durable master. */
  dispose?(): void
  /** Claude SDK only: answer the exact canUseTool callback that opened this ask. */
  answerPermission?(
    interactionId: string,
    answer: {
      decision: 'allow-once' | 'allow-always' | 'deny'
      feedback?: string
    },
  ): void
}

export interface HeadlessTurnIdentity {
  sessionId: SessionId
  turnId: string
  requestDigest: string
  accountId: AccountId
}

/**
 * The complete environment for a headless harness child.
 *
 * Headless processes are another way to launch the same CLI, so the manifest's
 * stored-login precedence rule applies here exactly as it does to terminal and
 * server-driver children (POD-2296). Explicit per-turn values are managed
 * credentials selected by Podium and therefore win; only inherited daemon
 * values are removed.
 */
export function headlessChildEnv(
  agent: HarnessAgent,
  explicit?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env = {
    ...process.env,
    ...explicit,
    ...harnessInstanceEnv(agent, explicit?.HOME),
  } as Record<string, string>
  for (const key of harnessChildStripEnv(agent, explicit)) delete env[key]
  return env
}

/**
 * The explicit overlay a headless turn hands {@link headlessChildEnv}.
 *
 * Three inputs, and the order between them is load-bearing:
 *  - `commandEnv` — the machine's recovered command environment. Its `HOME` is
 *    `commandEnvironment.machineHome`, the OPERATOR account home.
 *  - `specEnv` — the instance-owned child environment (control/headless.ts).
 *    It is built ON TOP of `commandEnv`, and the keys where the two differ are
 *    the ones the instance decided: `HOME` (the named instance's agent home),
 *    the agent-relay routing, the Podium CLI binding.
 *  - `execEnv` — what the harness adapter bound for this exact invocation.
 *    `bindHarnessExec` folds `commandEnv` into it (executable-runtime.ts
 *    `effectiveEnv`), so it too carries the machine `HOME` alongside genuinely
 *    per-turn keys like codex's MCP bearer (POD-1021).
 *
 * Letting `execEnv` win outright put the machine `HOME` back on the child. On a
 * named instance the harness then wrote its transcript under the operator
 * account home while the reader resolved the file under the instance's agent
 * home (control/transcripts.ts `sourceForRead`), and every `sessions.read`
 * answered empty — the whole conversation, prompt and answer included, not one
 * item type (POD-3059). `claude-code` declares no `instanceHome` selector, so
 * the trailing {@link harnessInstanceEnv} layer cannot catch it: for that
 * harness `HOME` alone decides where the record lands.
 *
 * So the adapter contributes the keys the instance did not decide, and never
 * overrides the ones it did.
 */
export function headlessSpawnEnv(input: {
  specEnv?: Readonly<Record<string, string>>
  execEnv?: Readonly<Record<string, string>>
  commandEnv: Readonly<Record<string, string>>
}): Record<string, string> {
  const base = input.specEnv ?? input.commandEnv
  const instanceOwned = Object.entries(base).filter(
    ([key, value]) => input.commandEnv[key] !== value,
  )
  return { ...base, ...input.execEnv, ...Object.fromEntries(instanceOwned) }
}

/** How long a politely-interrupted one-shot gets to wind down before it is killed. */
const CLAUDE_ONE_SHOT_INTERRUPT_GRACE_MS = 15_000

/**
 * The stream-json line channel over a directly-spawned one-shot child.
 * Sessions run the same wire over a host-held engine (the family's
 * engine-host); one-shot A2A turns are inherently per-turn work and keep the
 * daemon-side spawn every other one-shot driver already has — including on
 * backend=none daemons with no durable host. SDK-free: the family owns argv
 * and the line protocol (see `createClaudeStreamClient`), this file owns the
 * pipes.
 */
function claudePipeTransport(child: ChildProcess): ClaudeStreamTransport {
  const decoder = new LineDecoder()
  const lineCbs = new Set<(line: string) => void>()
  const exitCbs = new Set<(code: number | null, signal: string | null) => void>()
  child.stdout?.on('data', (d: Buffer) => {
    for (const line of decoder.push(d)) for (const cb of [...lineCbs]) cb(line)
  })
  child.on('close', (code, signal) => {
    const tail = decoder.flush()
    if (tail?.trim()) for (const cb of [...lineCbs]) cb(tail)
    for (const cb of [...exitCbs]) cb(code, signal ?? null)
  })
  return {
    writeLine(line) {
      try {
        child.stdin?.write(`${line}\n`)
      } catch {
        // A dead child's stdin is not an error path of its own — the exit
        // handler reports the death, once, with the real reason.
      }
    },
    onLine(cb) {
      lineCbs.add(cb)
      return () => lineCbs.delete(cb)
    },
    onExit(cb) {
      exitCbs.add(cb)
      return () => exitCbs.delete(cb)
    },
    close() {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone; that is the state we wanted.
      }
    },
  }
}

/**
 * One Claude turn through a directly-spawned streaming `claude` child.
 *
 * The contract is the turn handle every other one-shot driver returns — same
 * outcome (carrying the harness session id out of a failure), same
 * permission/tool hooks, same interrupt-then-kill discipline — with the
 * stream-json wire spoken directly instead of through the old SDK helper
 * child. stderr is not protocol, but it IS the only explanation a crashed
 * child gets to leave behind, so a bounded tail rides the death message.
 */
function runClaudeStreamOneShotTurn(
  spec: HeadlessTurnSpec,
  emit: HeadlessEmit,
  snapshot: ResolvedHarnessInventory,
  hooks?: HeadlessTurnHooks,
): HeadlessTurnHandle {
  const { cmd, args } = buildClaudeStreamInvocation(
    { ...spec },
    claudeSdkExecutablePath(snapshot),
  )
  const child = spawn(cmd, args, {
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...headlessChildEnv(spec.agent, spec.env),
      ...claudeStreamEnvOverlay({
        ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
        isRoot: process.getuid?.() === 0,
      }),
    },
  })
  // stderr is not protocol, but it IS the only explanation a crashed child
  // gets to leave behind, so keep a bounded tail for the death message.
  let stderrTail = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-8192)
  })
  const client = createClaudeStreamClient(claudePipeTransport(child), {
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.contextPrompt ? { contextPrompt: spec.contextPrompt } : {}),
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
  })
  const turn = client.turn(
    spec.prompt,
    {
      onPartialText: (text, itemHint) =>
        emit({ kind: 'partial-text', text, ...(itemHint ? { itemHint } : {}) }),
      onPermission: (request) => hooks?.onPermission?.(request),
      onToolCall: (call) => hooks?.onToolCall?.(call),
      onToolResult: (result) => hooks?.onToolResult?.(result),
      emit,
    },
  )
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const killAfterGrace = (): void => {
    if (killTimer) return
    killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, CLAUDE_ONE_SHOT_INTERRUPT_GRACE_MS)
    killTimer.unref?.()
  }
  const done: Promise<HeadlessTurnOutcome> = turn.done.catch((err: unknown) => {
    const tail = stderrTail.trim().slice(-2000)
    if (err instanceof HeadlessTurnFailure && tail) {
      throw new HeadlessTurnFailure(`${err.message}: ${tail}`, err.harnessSessionId)
    }
    throw err
  })
  // An owner that only interrupts still needs the silence: the rejection is
  // the turn's own, already observed above.
  done.catch(() => {})
  return {
    done,
    interrupt: () => {
      turn.interrupt()
      killAfterGrace()
    },
    answerPermission: (interactionId, answer) => client.answerPermission(interactionId, answer),
    dispose: () => {
      turn.interrupt()
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      client.close()
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
 * Spawn one headless turn child with piped stdio and an immediate stdin EOF.
 * Timeout, output folding and kill discipline belong to the calling family
 * (its turn shape); this is only the supervisor's side of the spawn. The env
 * arrives fully composed — stored-login precedence is the supervisor's merge,
 * applied by the caller.
 */
function spawnTurnChild(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  child.stdin?.end()
  return child
}

function runChild<T>(
  agent: HarnessAgent,
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string> | undefined,
  consume: (child: ChildProcess) => Promise<T>,
  /** Delivered on stdin, then EOF (pi reads its prompt there). Absent ⇒ EOF at once. */
  stdin?: string,
): { child: ChildProcess; done: Promise<T> } {
  const child = spawn(cmd, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: headlessChildEnv(agent, env),
  })
  if (stdin !== undefined) child.stdin?.write(stdin)
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
 * resume <id> --json` (turns ≥2). The turn shape — argv off the adapter's
 * `headless.buildExec` section, the `thread.started`/`item.*` fold — lives in
 * the codex family; this file owns the supervisor's side (spawn, composed
 * env, timeout budget). The headless section is read here — the one place on
 * this path allowed to name the harness — and handed to the family.
 */
function runCodexTurn(
  spec: HeadlessTurnSpec,
  emit: HeadlessEmit,
  snapshot: ResolvedHarnessInventory,
): HeadlessTurnHandle {
  const manifest = harnessAdapterFor(codexHarnessKind)
  if (!manifest) throw new Error(`no harness adapter for '${codexHarnessKind}'`)
  const turn = runCodexExecTurn({
    prompt: spec.prompt,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.contextPrompt ? { contextPrompt: spec.contextPrompt } : {}),
    ...(spec.mcpConfig ? { mcpConfig: spec.mcpConfig } : {}),
    ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
    ...(spec.toolPolicy ? { toolPolicy: spec.toolPolicy } : {}),
    ...(spec.resumeValue ? { resumeValue: spec.resumeValue } : {}),
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    env: headlessSpawnEnv({
      ...(spec.env ? { specEnv: spec.env } : {}),
      commandEnv: snapshot.commandEnvironment.env,
    }),
    sections: { headless: manifest.headless },
    snapshot,
    emit,
    spawnChild: (cmd, args, opts) => spawnTurnChild(cmd, args, opts.cwd, opts.env),
  })
  return { done: turn.done, interrupt: turn.interrupt }
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

/**
 * Session-pinned one-shot turns for grok / opencode / cursor. Message-level
 * only: no partial events, one status, whole output on completion. The harness
 * still owns context via its session store; each turn pins the same id.
 */
function runResumeExecTurn(
  spec: HeadlessTurnSpec,
  emit: HeadlessEmit,
  snapshot: ResolvedHarnessInventory,
): HeadlessTurnHandle {
  const headless = headlessFor(spec.agent)
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const common = {
    prompt: spec.prompt,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.contextPrompt ? { contextPrompt: spec.contextPrompt } : {}),
    ...(spec.permissionMode ? { permissionMode: spec.permissionMode } : {}),
    ...(spec.toolPolicy ? { toolPolicy: spec.toolPolicy } : {}),
    ...(spec.resumeValue ? { resumeValue: spec.resumeValue } : {}),
  }
  emit({ kind: 'status', status: 'starting' })

  if (headless.outputFormat === 'opencode-jsonl') {
    // This protocol mints its own session id in the JSON event stream.
    const { cmd, args } = buildHeadlessExec(spec.agent, common, snapshot)
    const { child, done } = runChild(
      spec.agent,
      cmd,
      args,
      spec.cwd,
      timeoutMs,
      spec.env,
      async (child) => {
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
            emit({ kind: 'status', status: 'running', harnessSessionId: sessionId })
          }
          if (ev.type === 'text' && ev.part?.type === 'text') output += ev.part.text ?? ''
        })
        await childExit(child, stderrTail)
        if (!sessionId) throw new Error('opencode turn ended without reporting a session id')
        return { harnessSessionId: sessionId, output: output.trim() }
      },
    )
    return { done, interrupt: () => child.kill('SIGKILL') }
  }

  let interrupt: () => void = () => {}
  const done = (async (): Promise<HeadlessTurnOutcome> => {
    // grok: create via --session-id, then resume via --resume; id minted here.
    // cursor: chat id pre-allocated via `create-chat`, then always --resume.
    //
    // `spec.sessionUuid` IS THE SERVER'S PRE-MINTED ID AND MUST WIN (POD-782).
    // The manifest declares `daemon-minted-uuid` as PRE-MINTABLE, so the server
    // sends a uuid and the control layer binds the transcript tail to it before
    // the turn starts (control/headless.ts). This branch used to ignore that
    // field and mint a second uuid — so the harness wrote its conversation under
    // an id nobody was tailing, and the thread rendered an empty transcript
    // until the turn ended (by which time the tail was already bound to the
    // wrong file and never rebound). The durable driver has always honoured it;
    // this is the in-process path catching up.
    let sessionId = spec.resumeValue ?? spec.sessionUuid
    if (!sessionId) {
      if (headless.resumeIdAllocation === 'daemon-minted-uuid') {
        sessionId = randomUUID()
      } else if (headless.resumeIdAllocation === 'create-chat') {
        const invocation = cursorCreateChatInvocation(snapshot)
        const alloc = runChild(
          spec.agent,
          invocation.cmd,
          [...invocation.args],
          spec.cwd,
          60_000,
          spec.env,
          readAllStdout,
        )
        interrupt = () => alloc.child.kill('SIGKILL')
        const printed = await alloc.done
        sessionId = parseCursorChatId(printed)
      } else {
        throw new Error(
          `headless driver cannot allocate a session id via ${headless.resumeIdAllocation}`,
        )
      }
    }
    const { cmd, args, stdin } = buildHeadlessExec(spec.agent, { ...common, sessionId }, snapshot)
    if (headless.outputFormat === 'pi-jsonl') {
      // pi: the id is pinned like grok's, but the turn streams `--mode json`
      // events — partial text, tool labels, and the in-turn error verdict that
      // its exit code (always 0) does not carry.
      const pinned = sessionId
      const turn = runChild(
        spec.agent,
        cmd,
        args,
        spec.cwd,
        timeoutMs,
        spec.env,
        async (child) => {
          const stderrTail = collectStderr(child)
          const reducer = createPiStreamReducer()
          // Pi's JSONL is `\n`-only; U+2028/2029 may appear inside strings, so
          // no readline here.
          const decoder = new LineDecoder()
          const apply = (effect: PiStreamEffect | undefined): void => {
            if (!effect) return
            if (effect.toolLabel) emit({ kind: 'status', status: 'tool', label: effect.toolLabel })
            if (effect.partialText) {
              emit({
                kind: 'partial-text',
                text: effect.partialText,
                ...(effect.itemHint ? { itemHint: effect.itemHint } : {}),
              })
            }
          }
          child.stdout?.on('data', (d: Buffer) => {
            for (const line of decoder.push(d)) apply(reducer.pushLine(line))
          })
          child.stdout?.on('end', () => {
            const last = decoder.flush()
            if (last) apply(reducer.pushLine(last))
          })
          await childExit(child, stderrTail)
          const result = reducer.result()
          if (result.error) throw new HeadlessTurnError(result.error, result.sessionId ?? pinned)
          return { harnessSessionId: result.sessionId ?? pinned, output: result.output }
        },
        stdin,
      )
      interrupt = () => turn.child.kill('SIGKILL')
      emit({ kind: 'status', status: 'running', harnessSessionId: pinned })
      return await turn.done
    }
    const turn = runChild(
      spec.agent,
      cmd,
      args,
      spec.cwd,
      timeoutMs,
      spec.env,
      readAllStdout,
      stdin,
    )
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
  snapshot: ResolvedHarnessInventory,
) => HeadlessTurnHandle

const resumeExecDriver: HeadlessDriver = runResumeExecTurn

/** Driver body per adapter-declared driver KIND (`adapter.headless.driver`) —
 *  the closed set of runtime strategies this daemon can host. Which agent uses
 *  which is no longer enumerated here: it derives from the harness adapter
 *  registry, so a new agent picks its driver in its adapter file (and the
 *  registry's exhaustive Record still fails typecheck until it exists). */
const DRIVER_IMPLS: Record<HarnessHeadless['driver'], HeadlessDriver> = {
  // SDK-FREE BY CONSTRUCTION (POD-4499). The Claude Agent SDK used to run
  // right here — inside the process that supervises every session on this
  // machine, where its crashes and its memory were the daemon's crashes and
  // the daemon's memory — and then in a per-turn helper child the family
  // spawned itself. One-shot turns now spawn the `claude` CLI directly (like
  // every other one-shot driver) and speak its stream-json wire over the
  // pipes; sessions run the same wire over a host-held engine. Nothing
  // reachable from this file loads `@anthropic-ai/claude-agent-sdk`.
  'claude-sdk': (spec, emit, snapshot) =>
    runClaudeStreamOneShotTurn(spec, emit, snapshot),
  'codex-json': (spec, emit, snapshot) => runCodexTurn(spec, emit, snapshot),
  'resume-exec': resumeExecDriver,
}

/** Live SDK callbacks a contract caller may route into PendingInteractions.
 *  Only the `claude-sdk` driver kind honours `onPermission`; child-process
 *  drivers have no permission channel and ignore these hooks. */
export interface HeadlessTurnHooks {
  onPermission?: (request: {
    id: string
    toolName: string
    input?: unknown
    suggestions?: readonly unknown[]
  }) => void
  onToolCall?: (call: { toolUseId: string; toolName: string; input?: unknown }) => void
  onToolResult?: (result: { toolUseId: string; output: string; isError?: boolean }) => void
}

/** Driver selection by agent — an adapter registry lookup (#249). */
export function runHeadlessTurn(
  spec: HeadlessTurnSpec,
  emit: HeadlessEmit,
  snapshot: ResolvedHarnessInventory,
  hooks?: HeadlessTurnHooks,
): HeadlessTurnHandle {
  const headless = headlessFor(spec.agent)
  if (spec.toolPolicy === 'none' && headless.noTools !== 'enforced') {
    throw new Error(`harness ${spec.agent} cannot enforce a no-tools headless turn`)
  }
  if (headless.driver === 'claude-sdk') {
    return runClaudeStreamOneShotTurn(spec, emit, snapshot, hooks)
  }
  return DRIVER_IMPLS[headless.driver](spec, emit, snapshot)
}
