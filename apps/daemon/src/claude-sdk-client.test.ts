// apps/daemon/src/claude-sdk-client.test.ts
//
// The other direction of the bar. claude-sdk-isolation.test.ts proves the SDK
// LEFT the daemon; nothing there can tell "moved" from "moved and broken". These
// tests pin the behaviour on the daemon's side of the pipe, including the case
// the whole split exists to make survivable: the host dies mid-turn.
//
// The fake host is a REAL CHILD PROCESS, not a mock object. The claim under test
// is about what happens when a process dies, and a mock that resolves a promise
// when you call `.kill()` on it would prove nothing about pipes, exit codes,
// signals, or the order events arrive in. These children are killed for real.

import { type ChildProcess, spawn } from 'node:child_process'
import type { HeadlessTurnEvent } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { runClaudeSdkChildTurn } from './claude-sdk-client.js'
import { HeadlessTurnError, type HeadlessTurnSpec } from './headless-drivers.js'

const spec: HeadlessTurnSpec = {
  agent: 'claude-code',
  accountId: 'native:claude-code:test' as HeadlessTurnSpec['accountId'],
  requestDigest: 'a'.repeat(64),
  cwd: process.cwd(),
  prompt: 'hello',
}

const alive: ChildProcess[] = []
afterEach(() => {
  for (const c of alive.splice(0)) c.kill('SIGKILL')
})

/** A stand-in host: runs `script` under node, speaking the same line protocol. */
function fakeHost(script: string): () => ChildProcess {
  return () => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    alive.push(child)
    return child
  }
}

/** Emit frames, then stay up until killed — the shape of a turn in progress. */
const emitsThenHangs = (frames: string) => `${frames}\nsetInterval(() => {}, 1000)`

const say = (frame: unknown) =>
  `process.stdout.write(${JSON.stringify(`${JSON.stringify(frame)}\n`)})`

describe('a Claude turn in a child process', () => {
  it("forwards the host's events and resolves with its outcome", async () => {
    const events: HeadlessTurnEvent[] = []
    const handle = runClaudeSdkChildTurn(spec, (e) => events.push(e), {
      spawnHost: fakeHost(
        [
          say({ t: 'event', event: { kind: 'status', status: 'starting' } }),
          say({ t: 'session', harnessSessionId: 'sess-1' }),
          say({ t: 'event', event: { kind: 'partial-text', text: 'par' } }),
          say({ t: 'event', event: { kind: 'partial-text', text: 'partial' } }),
          say({ t: 'done', harnessSessionId: 'sess-1', output: 'the answer' }),
        ].join('\n'),
      ),
    })
    await expect(handle.done).resolves.toEqual({
      harnessSessionId: 'sess-1',
      output: 'the answer',
    })
    expect(events).toEqual([
      { kind: 'status', status: 'starting' },
      { kind: 'partial-text', text: 'par' },
      { kind: 'partial-text', text: 'partial' },
    ])
  })

  it('sends the turn spec to the host on stdin', async () => {
    // The host echoes back whatever prompt it was handed, proving the spec
    // crossed the pipe rather than being reconstructed on the far side.
    const handle = runClaudeSdkChildTurn({ ...spec, prompt: 'MARKER-9f3a' }, () => {}, {
      spawnHost: fakeHost(`
          let buf = ''
          process.stdin.on('data', (d) => {
            buf += d
            const line = buf.split('\\n')[0]
            if (!line) return
            const cmd = JSON.parse(line)
            process.stdout.write(JSON.stringify({
              t: 'done', harnessSessionId: 's', output: cmd.spec.prompt,
            }) + '\\n')
            process.exit(0)
          })
        `),
    })
    await expect(handle.done).resolves.toMatchObject({ output: 'MARKER-9f3a' })
  })

  it('reports a truthful failure when the host is killed mid-turn, and does not hang', async () => {
    let child: ChildProcess | undefined
    const events: HeadlessTurnEvent[] = []
    const handle = runClaudeSdkChildTurn(spec, (e) => events.push(e), {
      spawnHost: () => {
        child = fakeHost(
          emitsThenHangs(
            [
              say({ t: 'event', event: { kind: 'status', status: 'running' } }),
              say({ t: 'session', harnessSessionId: 'sess-mid' }),
              say({ t: 'event', event: { kind: 'partial-text', text: 'half a th' } }),
            ].join('\n'),
          ),
        )()
        return child
      },
    })
    // Wait until the turn is genuinely underway before killing it — killing a
    // child that has not started yet would test the startup path instead.
    await expect
      .poll(() => events.some((e) => e.kind === 'partial-text'), { timeout: 10_000 })
      .toBe(true)

    child?.kill('SIGKILL')

    const err = await handle.done.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HeadlessTurnError)
    // TRUE, and specific enough for a human to act on: it names the process that
    // died and says the turn did not finish. Not a generic 'turn failed', and
    // above all not silence.
    expect((err as Error).message).toContain('Claude model host process exited')
    expect((err as Error).message).toContain('SIGKILL')
    // AND the conversation is not orphaned. The id the host reported before it
    // died comes out with the error, so the thread keeps its transcript binding
    // and the next turn resumes instead of silently starting over.
    expect((err as HeadlessTurnError).harnessSessionId).toBe('sess-mid')
  }, 20_000)

  it('still reports a reason when the host dies before minting a session', async () => {
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(`
        process.stderr.write('cannot allocate memory\\n')
        process.exit(137)
      `),
    })
    const err = await handle.done.then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as Error).message).toContain('Claude model host process exited')
    expect((err as Error).message).toContain('code 137')
    // The host's dying words are carried out — that stderr tail is the only
    // explanation an OOM kill ever leaves behind.
    expect((err as Error).message).toContain('cannot allocate memory')
    expect((err as HeadlessTurnError).harnessSessionId).toBeUndefined()
  })

  it('degrades exactly one session: a sibling turn finishes while its neighbour is killed', async () => {
    // The claim in one test. Two turns, two hosts. One is killed the way an OOM
    // killer would kill it; the other must complete normally, unaware.
    let victim: ChildProcess | undefined
    const victimEvents: HeadlessTurnEvent[] = []
    const dying = runClaudeSdkChildTurn(spec, (e) => victimEvents.push(e), {
      spawnHost: () => {
        victim = fakeHost(
          emitsThenHangs(say({ t: 'event', event: { kind: 'status', status: 'running' } })),
        )()
        return victim
      },
    })
    const survivor = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(`
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            t: 'done', harnessSessionId: 'sess-ok', output: 'unaffected',
          }) + '\\n')
          process.exit(0)
        }, 700)
      `),
    })

    await expect.poll(() => victimEvents.length > 0, { timeout: 10_000 }).toBe(true)
    victim?.kill('SIGKILL')

    await expect(dying.done).rejects.toThrow('Claude model host process exited')
    await expect(survivor.done).resolves.toEqual({
      harnessSessionId: 'sess-ok',
      output: 'unaffected',
    })
  }, 20_000)

  it('turns a host error frame into a failure that keeps the session id', async () => {
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(
        `${say({ t: 'error', message: 'claude turn failed: error_during_execution', harnessSessionId: 'sess-e' })}\nprocess.exit(0)`,
      ),
    })
    const err = await handle.done.then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as Error).message).toBe('claude turn failed: error_during_execution')
    expect((err as HeadlessTurnError).harnessSessionId).toBe('sess-e')
  })

  it('bounds a wedged host: the turn times out and the child is not left running', async () => {
    let child: ChildProcess | undefined
    const handle = runClaudeSdkChildTurn({ ...spec, timeoutMs: 300 }, () => {}, {
      spawnHost: () => {
        // Ignores the interrupt entirely — the case where being in-process
        // meant the daemon had no recourse at all.
        child = fakeHost(emitsThenHangs(say({ t: 'session', harnessSessionId: 'sess-wedged' })))()
        return child
      },
    })
    const err = await handle.done.then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as Error).message).toBe('turn timed out')
    expect((err as HeadlessTurnError).harnessSessionId).toBe('sess-wedged')
  }, 30_000)

  it('never reports a timed-out turn as a successful one', async () => {
    // THE REGRESSION AN ADVERSARIAL REVIEW FOUND. `interrupt` asks the SDK to wind
    // down, and a wound-down stream reports `done` with whatever text it had. So a
    // host that answers `done` AFTER the deadline used to resolve the turn as a
    // success carrying a truncated answer — and the human was shown half a
    // sentence as the assistant's complete reply, with no timeout reported.
    //
    // Reachable in production: a superagent budget clamps the turn timeout as low
    // as 30 seconds, so this is an ordinary short turn, not an exotic case.
    const handle = runClaudeSdkChildTurn({ ...spec, timeoutMs: 300 }, () => {}, {
      spawnHost: fakeHost(`
        let buf = ''
        process.stdout.write(JSON.stringify({ t: 'session', harnessSessionId: 'sess-cut' }) + '\\n')
        process.stdin.on('data', (d) => {
          buf += d
          const lines = buf.split('\\n')
          buf = lines.pop() ?? ''
          // PARSE the command rather than searching the bytes for a word. The
          // turn frame carries the session's cwd, and a checkout whose path
          // happened to contain "interrupt" made this host answer the turn
          // command as though it were the interrupt — the turn then "completed"
          // before its own deadline and this test failed on the directory it was
          // run from.
          if (!lines.some((l) => l.trim() && JSON.parse(l).t === 'interrupt')) return
          // Exactly what a gracefully-interrupted SDK stream does.
          process.stdout.write(JSON.stringify({
            t: 'done', harnessSessionId: 'sess-cut', output: 'half an ans',
          }) + '\\n')
          process.exit(0)
        })
      `),
    })
    const err = await handle.done.then(
      (ok) => ({ resolved: ok }),
      (e: unknown) => ({ rejected: e as Error }),
    )
    expect(
      'rejected' in err,
      `a turn cut off at its deadline resolved as success: ${JSON.stringify(err)}`,
    ).toBe(true)
    const e = (err as { rejected: Error }).rejected
    expect(e.message).toBe('turn timed out')
    // And the conversation still comes out, so the thread is not orphaned.
    expect((e as HeadlessTurnError).harnessSessionId).toBe('sess-cut')
  }, 20_000)

  it("ignores non-protocol noise on the host's stdout", async () => {
    // A dependency that logs to stdout must not be able to fail a live turn.
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(
        [
          `process.stdout.write('Debugger listening on ws://127.0.0.1:9229\\n')`,
          say({ t: 'done', harnessSessionId: 'sess-n', output: 'fine' }),
        ].join('\n'),
      ),
    })
    await expect(handle.done).resolves.toMatchObject({ output: 'fine' })
  })

  it('reports a host that cannot be started at all', async () => {
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: () => {
        const child = spawn('/nonexistent/claude-sdk-host', [], {
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        alive.push(child)
        return child
      },
    })
    await expect(handle.done).rejects.toThrow(/claude sdk host could not start|exited/)
  })

  it('round-trips a structured permission answer to the exact host callback', async () => {
    let handle: ReturnType<typeof runClaudeSdkChildTurn>
    let observed: { id: string; toolName: string } | undefined
    handle = runClaudeSdkChildTurn({ ...spec, structuredPermissions: true }, () => {}, {
      spawnHost: fakeHost(`
          let buf = ''
          let asked = false
          process.stdin.on('data', (d) => {
            buf += d
            const lines = buf.split('\\n')
            buf = lines.pop() || ''
            for (const line of lines) {
              if (!line) continue
              const cmd = JSON.parse(line)
              if (cmd.t === 'turn' && !asked) {
                asked = true
                process.stdout.write(JSON.stringify({
                  t: 'permission', interactionId: 'perm-1', toolName: 'Bash',
                  input: { command: 'git status' }, suggestions: [{ type: 'addRules' }],
                }) + '\\n')
              } else if (cmd.t === 'answer') {
                process.stdout.write(JSON.stringify({
                  t: 'done', harnessSessionId: 'sess-perm', output: JSON.stringify(cmd),
                }) + '\\n')
                process.exit(0)
              }
            }
          })
        `),
      onPermission: (request) => {
        observed = { id: request.id, toolName: request.toolName }
        handle.answerPermission?.(request.id, { decision: 'deny', feedback: 'not this command' })
      },
    })
    const result = await handle.done
    expect(observed).toEqual({ id: 'perm-1', toolName: 'Bash' })
    expect(JSON.parse(result.output)).toMatchObject({
      t: 'answer',
      interactionId: 'perm-1',
      decision: 'deny',
      feedback: 'not this command',
    })
  })

  it('disposes a wedged host immediately when the owning runtime ends', async () => {
    let child: ChildProcess | undefined
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: () => {
        child = fakeHost(emitsThenHangs(''))()
        return child
      },
    })

    handle.dispose?.()
    await expect(handle.done).rejects.toThrow('Claude model host process exited')
    expect(child?.signalCode).toBe('SIGKILL')
  })
})

// THE DAEMON'S HALF OF THE INTERRUPT RECEIPT.
//
// `interrupt()` was a write with no read: a line went down the pipe and nothing
// ever came back, so the daemon could not tell an interrupt the provider had
// honoured from one it had refused from one that had reached a host already
// dead. All three surfaced to the operator as the same silent success.
//
// These run against real child processes for the same reason the rest of this
// file does — the interesting cases are a pipe closing and a process dying, and
// a mock that resolves a promise proves nothing about either.
describe('the daemon reads back what the host did with an interrupt', () => {
  /** These cases are about the interrupt receipt, not the turn; the turn is
   *  ended by afterEach's SIGKILL, and that rejection is expected. */
  const ignoreTeardown = (handle: { done: Promise<unknown> }): void => {
    handle.done.catch(() => {})
  }

  /** Answers one interrupt with `ack`, then stays up. */
  const hostAnswering = (ack: Record<string, unknown>) => `
    let buf = ''
    process.stdout.write(JSON.stringify({ t: 'session', harnessSessionId: 'sess-i' }) + '\\n')
    process.stdin.on('data', (d) => {
      buf += d
      const lines = buf.split('\\n')
      buf = lines.pop() ?? ''
      const line = lines.find((l) => l.trim() && JSON.parse(l).t === 'interrupt')
      if (!line) return
      const cmd = JSON.parse(line)
      process.stdout.write(JSON.stringify({ ...${JSON.stringify(ack)}, requestId: cmd.requestId }) + '\\n')
    })
    setInterval(() => {}, 1000)
  `

  it('reports an accepted interrupt as accepted, under the id it asked with', async () => {
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(hostAnswering({ t: 'interrupt-ack', accepted: true })),
    })
    ignoreTeardown(handle)
    await expect(handle.requestInterrupt()).resolves.toEqual({ outcome: 'accepted' })
  }, 20_000)

  it("reports a refused interrupt as refused, carrying the provider's reason", async () => {
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(
        hostAnswering({ t: 'interrupt-ack', accepted: false, detail: 'no turn to interrupt' }),
      ),
    })
    ignoreTeardown(handle)
    await expect(handle.requestInterrupt()).resolves.toEqual({
      outcome: 'rejected',
      detail: 'no turn to interrupt',
    })
  }, 20_000)

  it('reports an unanswered interrupt as unconfirmed when the host dies', async () => {
    // NOT `rejected` and NOT `accepted`. The request went out and was never
    // answered; claiming either verdict here would be inventing one.
    let child: ChildProcess | undefined
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: () => {
        child = fakeHost(emitsThenHangs(say({ t: 'session', harnessSessionId: 'sess-d' })))()
        return child
      },
    })
    ignoreTeardown(handle)
    const answered = handle.requestInterrupt()
    child?.kill('SIGKILL')
    const ack = await answered
    expect(ack.outcome).toBe('unconfirmed')
    expect(ack).toMatchObject({ detail: expect.stringContaining('exited') })
  }, 20_000)

  it('reports an unconfirmed interrupt when a live host simply never answers', async () => {
    // The OTHER way a verdict fails to arrive, and a different code path from
    // the death above: the host is alive and holding the pipe open, it just
    // never says what the provider did. Waiting forever would strand the
    // operator's stop in the one state they cannot see; the deadline turns it
    // into a truthful "we do not know" instead.
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(emitsThenHangs(say({ t: 'session', harnessSessionId: 'sess-mute' }))),
    })
    ignoreTeardown(handle)
    const ack = await handle.requestInterrupt()
    expect(ack.outcome).toBe('unconfirmed')
    expect(ack).toMatchObject({ detail: expect.stringContaining('in time') })
  }, 20_000)

  it('answers each interrupt separately when two are outstanding', async () => {
    // One press must not consume another's receipt: the ids are what keep two
    // stops from collapsing into one answer.
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(`
        let buf = ''
        process.stdin.on('data', (d) => {
          buf += d
          const lines = buf.split('\\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const cmd = JSON.parse(line)
            if (cmd.t !== 'interrupt') continue
            process.stdout.write(JSON.stringify({
              t: 'interrupt-ack', requestId: cmd.requestId, accepted: true,
            }) + '\\n')
          }
        })
        setInterval(() => {}, 1000)
      `),
    })
    ignoreTeardown(handle)
    const [first, second] = await Promise.all([
      handle.requestInterrupt(),
      handle.requestInterrupt(),
    ])
    expect([first, second]).toEqual([{ outcome: 'accepted' }, { outcome: 'accepted' }])
  }, 20_000)
})

describe('the daemon carries the tool record across the pipe (POD-3050)', () => {
  it('delivers calls and results to their callbacks in frame order', async () => {
    // Order is not reconstructed on this side — it is the order the frames
    // arrived in, which is the order the provider reported them. A buffer here
    // would be the one place a result could overtake its own call.
    const seen: string[] = []
    const handle = runClaudeSdkChildTurn(spec, () => {}, {
      spawnHost: fakeHost(
        [
          say({ t: 'session', harnessSessionId: 'sess-tools' }),
          say({
            t: 'tool-call',
            toolUseId: 'toolu_1',
            toolName: 'Bash',
            input: { command: 'cat x' },
          }),
          say({ t: 'tool-result', toolUseId: 'toolu_1', output: 'MARKER' }),
          say({ t: 'tool-call', toolUseId: 'toolu_2', toolName: 'Read' }),
          say({ t: 'tool-result', toolUseId: 'toolu_2', output: '', isError: true }),
          say({ t: 'done', harnessSessionId: 'sess-tools', output: 'ok' }),
        ].join('\n'),
      ),
      onToolCall: (c) =>
        seen.push(`call:${c.toolUseId}:${c.toolName}:${JSON.stringify(c.input ?? null)}`),
      onToolResult: (r) =>
        seen.push(`result:${r.toolUseId}:${JSON.stringify(r.output)}:${r.isError ?? false}`),
    })
    await expect(handle.done).resolves.toMatchObject({ harnessSessionId: 'sess-tools' })
    expect(seen).toEqual([
      'call:toolu_1:Bash:{"command":"cat x"}',
      'result:toolu_1:"MARKER":false',
      'call:toolu_2:Read:null',
      'result:toolu_2:"":true',
    ])
  })
})
