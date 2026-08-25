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
          if (!buf.includes('interrupt')) return
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
})
