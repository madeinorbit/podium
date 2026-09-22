/**
 * ONE-SHOT HEADLESS TURNS UNDER THE HOST (POD-4614).
 *
 * The family never spawns: it asks the session layer's `EngineProcessOwner`.
 * These tests hand it a FAKE owner that behaves like podium-host --no-pty —
 * a real `/bin/sh` child per label, stdout+stderr merged into one
 * sequence-numbered ring, the ring kept after the child exits, replay from a
 * seq, one writer lease — including the two hazards the real host has:
 *  - the attachment `startEngine` returns may MISS the child's first bytes
 *    (the real spawn awaits WELCOME before the caller can subscribe), so this
 *    fake's start attachment joins at the tail, late;
 *  - a start under a label whose host still LINGERS adopts that host (the real
 *    `create` exits 3 and the spawn adopts the socket owner).
 * Real children, real wrapper script, real stand-in harness binaries; the
 * real podium-host across a real daemon restart is the daemon's
 * `headless-turn-restart.integration.test.ts`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asAccountId, asSessionId, type SessionId } from '@podium/model'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type {
  EngineAttachment,
  EngineProcessOwner,
  EngineSpawnRequest,
} from '../engine-supervision.js'
import { testHarnessSnapshot } from './test-support.js'
import {
  acknowledgeHostedTurn,
  HEADLESS_TURN_RETENTION,
  type HostedTurnDeps,
  runHostedHeadlessTurn,
} from './turn.js'
import { HeadlessTurnError, type HeadlessTurnSpec, type HostedTurnIdentity } from './types.js'
import { TURN_MARKER_PREFIX } from './wrapper.js'

// ---------------------------------------------------------------------------
// A podium-host double over real children
// ---------------------------------------------------------------------------

interface Conn {
  data: Set<(seq: bigint, data: Buffer) => void>
  exit: Set<(code: number, signal: number) => void>
  live: boolean
}

interface FakeHost {
  label: string
  child: ChildProcess
  chunks: { seq: bigint; data: Buffer }[]
  seqHigh: bigint
  exited?: { code: number; signal: number }
  conns: Set<Conn>
  writer?: Conn
  exitedPromise: Promise<void>
}

function createFakeHosts() {
  const hosts = new Map<string, FakeHost>()
  const starts: EngineSpawnRequest[] = []
  const destroyed: string[] = []

  const attach = (host: FakeHost, fromSeq: bigint | 'tail', lateJoin: boolean): EngineAttachment => {
    const conn: Conn = { data: new Set(), exit: new Set(), live: true }
    const lease = !host.writer
    if (lease) host.writer = conn
    // Frames arrive on a later tick, as they do over a socket.
    setTimeout(
      () => {
        if (!conn.live) return
        if (fromSeq !== 'tail') {
          for (const chunk of host.chunks) {
            if (chunk.seq >= fromSeq) for (const cb of conn.data) cb(chunk.seq, chunk.data)
          }
        }
        host.conns.add(conn)
        if (host.exited) for (const cb of conn.exit) cb(host.exited.code, host.exited.signal)
      },
      lateJoin ? 30 : 0,
    )
    return {
      ready: Promise.resolve({ lease, ...(host.child.pid ? { childPid: host.child.pid } : {}) }),
      connection: {
        onData(cb) {
          conn.data.add(cb)
          return () => conn.data.delete(cb)
        },
        onExit(cb) {
          conn.exit.add(cb)
          return () => conn.exit.delete(cb)
        },
        signal(signum) {
          // The real host answers ERR NOT_WRITER; the signal never lands.
          if (host.writer !== conn || host.exited || !host.child.pid) return
          try {
            process.kill(-host.child.pid, signum)
          } catch {
            // already gone
          }
        },
        async write(data) {
          if (host.writer !== conn) throw new Error('not the writer')
          host.child.stdin?.write(Buffer.from(data))
          return data.length
        },
      },
      dispose() {
        conn.live = false
        host.conns.delete(conn)
        if (host.writer === conn) host.writer = undefined
      },
    }
  }

  const noHost = (): EngineAttachment => ({
    ready: Promise.reject(new Error('connect ENOENT (no host)')),
    connection: {
      onData: () => () => {},
      onExit: () => () => {},
      signal: () => {},
    },
    dispose: () => {},
  })

  const owner: EngineProcessOwner = {
    async startEngine(req) {
      const existing = hosts.get(req.label)
      // A live OR lingering host under the label is adopted, never replaced.
      if (existing) return { attachment: attach(existing, 'tail', true) }
      starts.push(req)
      const env: Record<string, string> = { ...(process.env as Record<string, string>), ...req.env }
      for (const key of req.stripEnv) delete env[key]
      const child = spawn(req.cmd, req.args, {
        cwd: req.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
      let resolveExited!: () => void
      const host: FakeHost = {
        label: req.label,
        child,
        chunks: [],
        seqHigh: 0n,
        conns: new Set(),
        exitedPromise: new Promise((resolve) => {
          resolveExited = resolve
        }),
      }
      hosts.set(req.label, host)
      const onBytes = (data: Buffer): void => {
        const seq = host.seqHigh
        host.chunks.push({ seq, data })
        host.seqHigh += BigInt(data.length)
        for (const conn of host.conns) for (const cb of conn.data) cb(seq, data)
      }
      child.stdout?.on('data', onBytes)
      child.stderr?.on('data', onBytes)
      child.on('close', (code, signal) => {
        host.exited = {
          code: code ?? 0,
          signal: signal ? (constants.signals[signal] ?? 0) : 0,
        }
        for (const conn of host.conns) for (const cb of conn.exit) cb(host.exited.code, host.exited.signal)
        resolveExited()
      })
      return { attachment: attach(host, 'tail', true) }
    },
    async reattachEngine(input) {
      const host = hosts.get(input.label)
      return { attachment: host ? attach(host, input.fromSeq, false) : noHost() }
    },
    async engineAlive(label) {
      const host = hosts.get(label)
      return host !== undefined && host.exited === undefined
    },
    async destroyEngine(label) {
      destroyed.push(label)
      const host = hosts.get(label)
      if (!host) return
      if (!host.exited && host.child.pid) {
        try {
          process.kill(-host.child.pid, 'SIGTERM')
        } catch {
          // already gone
        }
        await host.exitedPromise
      }
      hosts.delete(label)
    },
  }
  return {
    owner,
    hosts,
    starts,
    destroyed,
    async killAll() {
      for (const label of [...hosts.keys()]) await owner.destroyEngine(label)
    },
  }
}

// ---------------------------------------------------------------------------
// Stand-in harness binaries
// ---------------------------------------------------------------------------

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'podium-hosted-turn-'))
  dirs.push(dir)
  return dir
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}`)
  chmodSync(path, 0o755)
  return path
}

/**
 * A stand-in `grok` (text output, a daemon-pinned session id): appends one
 * line per incarnation, echoes the prompt, writes to stderr, and obeys
 * WAIT:<file> (block until it exists) and FAIL (exit 3) in the prompt.
 */
function fakeGrok(dir: string): string {
  return script(
    dir,
    'grok',
    `sid=""
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--resume) shift; sid="$1" ;;
    --single) shift; prompt="$1" ;;
  esac
  shift
done
echo "$$" >> "$INCARNATIONS"
echo "grok says hello on stderr" >&2
case "$prompt" in
  WAIT:*) f="\${prompt#WAIT:}"; while [ ! -f "$f" ]; do sleep 0.05; done ;;
esac
case "$prompt" in
  *FAIL*) echo "simulated failure for $sid" >&2; exit 3 ;;
esac
printf 'answer for %s: %s\\n' "$sid" "$prompt"
`,
  )
}

/** A stand-in `codex exec --json` (moved from codex/exec-turn.test.ts). */
function fakeCodex(dir: string, opts: { silent?: boolean } = {}): string {
  return script(
    dir,
    'codex',
    opts.silent
      ? 'exit 0\n'
      : `thread=thr-fake-1
prev=""
for a in "$@"; do
  if [ "$prev" = resume ]; then thread="$a"; fi
  prev="$a"
  prompt="$a"
done
printf '%s\\n' "{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"$thread\\"}"
printf '%s\\n' '{"type":"item.started","item":{"id":"i1","type":"todo"}}'
printf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"i2\\",\\"type\\":\\"agent_message\\",\\"text\\":\\"done:$prompt\\"}}"
`,
  )
}

/** A stand-in `pi` speaking pi 0.84.4's verified `--mode json` stream (moved
 *  from apps/daemon/src/headless-drivers.test.ts): prompt on stdin. */
function fakePi(dir: string): string {
  return script(
    dir,
    'pi',
    `sid=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--session-id" ]; then shift; sid="$1"; fi
  shift
done
prompt=$(cat)
prompt=$(printf '%s' "$prompt" | sed ':a;N;$!ba;s/\\n/\\\\n/g')
printf '%s\\n' "{\\"type\\":\\"session\\",\\"version\\":3,\\"id\\":\\"$sid\\",\\"timestamp\\":\\"2026-09-02T09:48:46.898Z\\",\\"cwd\\":\\"/w\\"}"
printf '%s\\n' '{"type":"agent_start"}'
printf '%s\\n' '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending","responseId":"r1"}}'
case "$prompt" in
  *FAIL*)
    printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"500: simulated provider outage"}}'
    printf '%s\\n' '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"500: simulated provider outage"}'
    ;;
  *)
    printf '%s\\n' '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls"}}'
    printf '%s\\n' '{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Echo: "}}'
    printf '%s\\n' "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Echo: $prompt\\"}],\\"stopReason\\":\\"stop\\"}}"
    ;;
esac
printf '%s\\n' '{"type":"agent_settled"}'
exit 0
`,
  )
}

/** A stand-in `cursor-agent`: `create-chat` prints a chat id; a turn echoes. */
function fakeCursor(dir: string): string {
  return script(
    dir,
    'cursor-agent',
    `if [ "$1" = create-chat ]; then
  echo "allocating" >&2
  echo "11111111-2222-3333-4444-555555555555"
  exit 0
fi
chat=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--resume" ]; then shift; chat="$1"; fi
  last="$1"
  shift
done
printf 'cursor answer in %s: %s\\n' "$chat" "$last"
`,
  )
}

// ---------------------------------------------------------------------------
// Turn plumbing
// ---------------------------------------------------------------------------

const ACCOUNT = asAccountId('native:grok:test')
let fakes: ReturnType<typeof createFakeHosts>
afterEach(async () => {
  await fakes?.killAll()
})

function identityFor(sessionId: SessionId, turnId = 'turn-1', digest = 'a'.repeat(64)): HostedTurnIdentity {
  return { sessionId, turnId, requestDigest: digest, accountId: ACCOUNT }
}

function deps(owner: EngineProcessOwner, extraEnv: Record<string, string> = {}, now?: () => number): HostedTurnDeps {
  return {
    owner,
    childEnv: ({ execEnv, envOverlay }) => ({
      env: { ...extraEnv, ...execEnv, ...envOverlay },
      stripEnv: [],
    }),
    ...(now ? { now } : {}),
  }
}

function runTurn(input: {
  owner: EngineProcessOwner
  spec: Omit<HeadlessTurnSpec, 'accountId' | 'requestDigest' | 'durableLabel'>
  sessionId: SessionId
  turnId?: string
  digest?: string
  snapshot: ReturnType<typeof testHarnessSnapshot>
  env?: Record<string, string>
  now?: () => number
}) {
  const events: HeadlessTurnEvent[] = []
  const identity = identityFor(input.sessionId, input.turnId, input.digest)
  const handle = runHostedHeadlessTurn(deps(input.owner, input.env, input.now), {
    spec: {
      ...input.spec,
      accountId: identity.accountId,
      requestDigest: identity.requestDigest,
      durableLabel: `podium-${input.sessionId}`,
    },
    identity,
    snapshot: input.snapshot,
    emit: (event) => events.push(event),
  })
  return { handle, events, identity, label: `podium-${input.sessionId}` }
}

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function incarnations(path: string): number {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length : 0
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('a hosted one-shot turn', () => {
  it('starts through the owner under the session label, wrapped, with the turn retention', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const count = join(dir, 'incarnations')
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const sessionId = asSessionId('s-start')
    const { handle, events } = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'hi', sessionUuid: 'pinned-1' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: count },
    })
    const outcome = await handle.done
    // stdout only: the stderr line the stand-in wrote is not the answer.
    expect(outcome).toEqual({ harnessSessionId: 'pinned-1', output: 'answer for pinned-1: hi' })
    expect(fakes.starts).toHaveLength(1)
    const start = fakes.starts[0] as EngineSpawnRequest
    expect(start.label).toBe(`podium-${sessionId}`)
    expect(start.cmd).toBe('/bin/sh')
    expect(start.args[0]).toBe('-c')
    expect(start.args[3]?.startsWith(TURN_MARKER_PREFIX)).toBe(true)
    expect(start.retention).toEqual(HEADLESS_TURN_RETENTION)
    expect(events).toContainEqual({ kind: 'status', status: 'starting' })
    expect(events).toContainEqual({ kind: 'status', status: 'running', harnessSessionId: 'pinned-1' })
    expect(events.at(-1)).toEqual({ kind: 'partial-text', text: 'answer for pinned-1: hi' })
    // The host keeps the ring after the child exits: the result survives.
    expect(fakes.hosts.get(`podium-${sessionId}`)?.exited).toEqual({ code: 0, signal: 0 })
  })

  it('a nonzero exit fails with the stderr tail and the pinned session id', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const { handle } = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'please FAIL', sessionUuid: 'pinned-2' },
      sessionId: asSessionId('s-fail'),
      snapshot,
      env: { INCARNATIONS: join(dir, 'n') },
    })
    const error = await handle.done.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(HeadlessTurnError)
    expect((error as HeadlessTurnError).message).toMatch(/^harness exited 3: .*simulated failure for pinned-2/s)
    expect((error as HeadlessTurnError).harnessSessionId).toBe('pinned-2')
  })

  it('codex: captures the thread id, the agent message and live tool/partial events', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const snapshot = testHarnessSnapshot({ codex: fakeCodex(dir) })
    const { handle, events } = runTurn({
      owner: fakes.owner,
      spec: { agent: 'codex', cwd: dir, prompt: 'hello' },
      sessionId: asSessionId('s-codex'),
      snapshot,
    })
    const outcome = await handle.done
    expect(outcome.harnessSessionId).toBe('thr-fake-1')
    expect(outcome.output).toBe('done:hello')
    expect(events).toContainEqual({ kind: 'status', status: 'running', harnessSessionId: 'thr-fake-1' })
    expect(events).toContainEqual({ kind: 'status', status: 'tool', label: 'todo' })
    expect(events).toContainEqual({ kind: 'partial-text', text: 'done:hello', itemHint: 'i2' })
  })

  it('codex: a turn that ends without a thread id fails rather than orphaning it', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const snapshot = testHarnessSnapshot({ codex: fakeCodex(dir, { silent: true }) })
    const { handle } = runTurn({
      owner: fakes.owner,
      spec: { agent: 'codex', cwd: dir, prompt: 'hello' },
      sessionId: asSessionId('s-codex-silent'),
      snapshot,
    })
    await expect(handle.done).rejects.toThrow('codex turn ended without reporting a session id')
  })

  it('pi: the prompt reaches stdin (then EOF), the pinned id holds, partials and tools stream', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const snapshot = testHarnessSnapshot({ pi: fakePi(dir) })
    const { handle, events } = runTurn({
      owner: fakes.owner,
      spec: {
        agent: 'pi',
        cwd: dir,
        prompt: 'multi\nline prompt',
        sessionUuid: '9e804279-978a-4644-adc4-f815f25a5728',
      },
      sessionId: asSessionId('s-pi'),
      snapshot,
    })
    const outcome = await handle.done
    expect(outcome).toEqual({
      harnessSessionId: '9e804279-978a-4644-adc4-f815f25a5728',
      output: 'Echo: multi\nline prompt',
    })
    expect(events).toContainEqual({ kind: 'status', status: 'tool', label: 'bash' })
    expect(events).toContainEqual({ kind: 'partial-text', text: 'Echo: ', itemHint: 'r1' })
    expect(events.at(-1)).toEqual({
      kind: 'partial-text',
      text: 'Echo: multi\nline prompt',
      itemHint: 'r1',
    })
  })

  it('pi: an in-turn provider error fails the turn WITH its session id, despite exit 0', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const snapshot = testHarnessSnapshot({ pi: fakePi(dir) })
    const { handle } = runTurn({
      owner: fakes.owner,
      spec: { agent: 'pi', cwd: dir, prompt: 'please FAIL', resumeValue: 'resumed-1' },
      sessionId: asSessionId('s-pi-fail'),
      snapshot,
    })
    const error = await handle.done.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(HeadlessTurnError)
    expect((error as HeadlessTurnError).message).toBe('500: simulated provider outage')
    expect((error as HeadlessTurnError).harnessSessionId).toBe('resumed-1')
  })

  it('cursor: allocates the chat in its own hosted run, then pins the turn to it', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const snapshot = testHarnessSnapshot({ cursor: fakeCursor(dir) })
    const { handle, events } = runTurn({
      owner: fakes.owner,
      spec: { agent: 'cursor', cwd: dir, prompt: 'go' },
      sessionId: asSessionId('s-cursor'),
      snapshot,
    })
    const outcome = await handle.done
    expect(outcome).toEqual({
      harnessSessionId: '11111111-2222-3333-4444-555555555555',
      output: 'cursor answer in 11111111-2222-3333-4444-555555555555: go',
    })
    // Two runs under the one label: the allocation, released, then the turn.
    expect(fakes.starts).toHaveLength(2)
    expect(fakes.starts[0]?.args[3]).toContain(' alloc ')
    expect(fakes.starts[1]?.args[3]).toContain(' turn ')
    expect(events).toContainEqual({
      kind: 'status',
      status: 'running',
      harnessSessionId: '11111111-2222-3333-4444-555555555555',
    })
  })
})

describe('a hosted turn across a daemon restart (the ring, not a rerun)', () => {
  it('adopts the SAME running turn after the handle is dropped, and completes it', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const count = join(dir, 'incarnations')
    const release = join(dir, 'release')
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const sessionId = asSessionId('s-adopt')
    const first = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: `WAIT:${release}`, sessionUuid: 'pinned-a' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: count },
    })
    await waitFor(() => incarnations(count) === 1)
    // The daemon goes away: this generation lets go without killing anything.
    first.handle.dispose?.()
    expect(await fakes.owner.engineAlive(first.label)).toBe(true)

    // The next generation receives the same turn again.
    const second = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: `WAIT:${release}`, sessionUuid: 'pinned-a' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: count },
    })
    writeFileSync(release, '')
    const outcome = await second.handle.done
    expect(outcome).toEqual({
      harnessSessionId: 'pinned-a',
      output: `answer for pinned-a: WAIT:${release}`,
    })
    // Replay, not rerun: one incarnation, one start.
    expect(incarnations(count)).toBe(1)
    expect(fakes.starts).toHaveLength(1)
  })

  it('replays a turn that FINISHED while no daemon watched, without rerunning it', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const count = join(dir, 'incarnations')
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const sessionId = asSessionId('s-replay')
    const first = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'once', sessionUuid: 'pinned-r' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: count },
    })
    await first.handle.done
    const again = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'once', sessionUuid: 'pinned-r' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: count },
    })
    await expect(again.handle.done).resolves.toEqual({
      harnessSessionId: 'pinned-r',
      output: 'answer for pinned-r: once',
    })
    expect(incarnations(count)).toBe(1)
    expect(fakes.starts).toHaveLength(1)
  })

  it('keeps the ORIGINAL deadline: an adopted turn past it times out', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const release = join(dir, 'release')
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const sessionId = asSessionId('s-deadline')
    let clock = 1_000_000
    const spec = {
      agent: 'grok' as const,
      cwd: dir,
      prompt: `WAIT:${release}`,
      sessionUuid: 'pinned-d',
      timeoutMs: 60_000,
    }
    const first = runTurn({
      owner: fakes.owner,
      spec,
      sessionId,
      snapshot,
      env: { INCARNATIONS: join(dir, 'n') },
      now: () => clock,
    })
    await waitFor(() => fakes.starts.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    first.handle.dispose?.()
    // The new generation starts 10 minutes later: the turn's own budget is spent.
    clock += 600_000
    const second = runTurn({
      owner: fakes.owner,
      spec,
      sessionId,
      snapshot,
      env: { INCARNATIONS: join(dir, 'n') },
      now: () => clock,
    })
    await expect(second.handle.done).rejects.toThrow('turn timed out')
  })

  it('refuses a DIFFERENT turn while one runs under the session label, and leaves it running', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const count = join(dir, 'incarnations')
    const release = join(dir, 'release')
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const sessionId = asSessionId('s-mismatch')
    const first = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: `WAIT:${release}`, sessionUuid: 'pinned-m' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: count },
    })
    await waitFor(() => incarnations(count) === 1)
    const other = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'something else', sessionUuid: 'pinned-m' },
      sessionId,
      turnId: 'turn-2',
      snapshot,
      env: { INCARNATIONS: count },
    })
    await expect(other.handle.done).rejects.toThrow(/identity mismatch/)
    expect(await fakes.owner.engineAlive(first.label)).toBe(true)
    writeFileSync(release, '')
    await expect(first.handle.done).resolves.toMatchObject({ harnessSessionId: 'pinned-m' })
    expect(incarnations(count)).toBe(1)
  })

  it("releases a PREVIOUS turn's lingering host and runs the new turn (never adopts it)", async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const count = join(dir, 'incarnations')
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const sessionId = asSessionId('s-next')
    const first = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'one', sessionUuid: 'pinned-n' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: count },
    })
    await first.handle.done
    const next = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'two', resumeValue: 'pinned-n' },
      sessionId,
      turnId: 'turn-2',
      snapshot,
      env: { INCARNATIONS: count },
    })
    await expect(next.handle.done).resolves.toEqual({
      harnessSessionId: 'pinned-n',
      output: 'answer for pinned-n: two',
    })
    expect(fakes.destroyed).toContain(first.label)
    expect(incarnations(count)).toBe(2)
  })
})

describe('interrupting and acknowledging a hosted turn', () => {
  it('interrupt fails the turn at once and signals the process group', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const count = join(dir, 'incarnations')
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const { handle, label } = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: `WAIT:${join(dir, 'never')}`, sessionUuid: 'pinned-i' },
      sessionId: asSessionId('s-interrupt'),
      snapshot,
      env: { INCARNATIONS: count },
    })
    await waitFor(() => incarnations(count) === 1)
    handle.interrupt()
    const error = await handle.done.then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect((error as HeadlessTurnError).message).toBe('turn interrupted')
    expect((error as HeadlessTurnError).harnessSessionId).toBe('pinned-i')
    await waitFor(() => fakes.hosts.get(label)?.exited !== undefined)
    expect(fakes.hosts.get(label)?.exited?.signal).toBe(constants.signals.SIGTERM)
  })

  it('an interrupt before the turn holds its host never kills what the label runs', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const count = join(dir, 'incarnations')
    const release = join(dir, 'release')
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const sessionId = asSessionId('s-early')
    const running = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: `WAIT:${release}`, sessionUuid: 'pinned-e' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: count },
    })
    await waitFor(() => incarnations(count) === 1)
    // A different turn arrives and is interrupted before it has probed.
    const other = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'other', sessionUuid: 'pinned-e' },
      sessionId,
      turnId: 'turn-2',
      snapshot,
      env: { INCARNATIONS: count },
    })
    other.handle.interrupt()
    await expect(other.handle.done).rejects.toThrow('turn interrupted')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await fakes.owner.engineAlive(running.label)).toBe(true)
    expect(fakes.destroyed).toEqual([])
    writeFileSync(release, '')
    await expect(running.handle.done).resolves.toMatchObject({ harnessSessionId: 'pinned-e' })
  })

  it('an acknowledgement releases only the finished host of the exact same turn', async () => {
    fakes = createFakeHosts()
    const dir = tempDir()
    const snapshot = testHarnessSnapshot({ grok: fakeGrok(dir) })
    const sessionId = asSessionId('s-ack')
    const { handle, identity, label } = runTurn({
      owner: fakes.owner,
      spec: { agent: 'grok', cwd: dir, prompt: 'x', sessionUuid: 'pinned-k' },
      sessionId,
      snapshot,
      env: { INCARNATIONS: join(dir, 'n') },
    })
    await handle.done
    await expect(
      acknowledgeHostedTurn(fakes.owner, label, { ...identity, requestDigest: 'b'.repeat(64) }),
    ).rejects.toThrow(/mismatched/)
    expect(fakes.hosts.has(label)).toBe(true)
    await acknowledgeHostedTurn(fakes.owner, label, identity)
    expect(fakes.hosts.has(label)).toBe(false)
    // Nothing left under the label: a repeated acknowledgement is a no-op.
    await expect(acknowledgeHostedTurn(fakes.owner, label, identity)).resolves.toBeUndefined()
  })
})
