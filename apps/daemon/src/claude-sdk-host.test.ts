// apps/daemon/src/claude-sdk-host.test.ts
//
// The host's own lifecycle, with the SDK stubbed so the turn is controllable.
// The daemon side is covered by claude-sdk-client.test.ts against real child
// processes; what can only be tested here is what the host does when the thing
// on the other end of its stdin goes away.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeSdkHostFrame } from './claude-sdk-protocol.js'

const sdk = vi.hoisted(() => ({
  interruptCalled: false,
  endStream: undefined as (() => void) | undefined,
  scripted: null as unknown[] | null,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    const scripted = sdk.scripted
    if (scripted) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of scripted) yield message
        },
        interrupt: async () => {
          sdk.interruptCalled = true
        },
      }
    }
    let done = false
    const waiters: (() => void)[] = []
    sdk.endStream = () => {
      done = true
      for (const w of waiters.splice(0)) w()
    }
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess-stub' }
        while (!done) await new Promise<void>((r) => waiters.push(r))
      },
      interrupt: async () => {
        sdk.interruptCalled = true
        sdk.endStream?.()
      },
    }
  },
}))

const { runClaudeSdkHost } = await import('./claude-sdk-host.js')

afterEach(() => {
  sdk.interruptCalled = false
  sdk.endStream = undefined
  sdk.scripted = null
})

const TURN = JSON.stringify({
  t: 'turn',
  spec: {
    agent: 'claude-code',
    accountId: 'native:claude-code:test',
    requestDigest: 'a'.repeat(64),
    cwd: process.cwd(),
    prompt: 'hello',
  },
})

/** Commands that arrive, then stop — stdin EOF, i.e. the daemon is gone. */
async function* commandsThenEof(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) {
    yield line
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('the SDK host when its daemon disappears', () => {
  it('winds the turn down instead of outliving the daemon that started it', async () => {
    // THE BUG AN ADVERSARIAL REVIEW FOUND. The stdin-EOF branch used to be
    // `if (!spec) finish()`, so once a turn had started EOF did nothing at all:
    // the daemon died, and this process kept a model session, a working directory
    // and whatever the CLI spawned running with nobody left to stop it. The
    // comment above main() claimed the opposite, which is the worst combination —
    // a promise in prose that the code does not keep.
    //
    // If this regresses, the stream below never ends and this test times out,
    // which is exactly what an orphan is.
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN]),
      send: (f) => frames.push(f),
    })
    expect(sdk.interruptCalled, 'the host must interrupt its turn when stdin closes').toBe(true)
    expect(frames.some((f) => f.t === 'session')).toBe(true)
  }, 20_000)

  it('exits immediately when stdin closes before any turn arrives', async () => {
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({ commands: commandsThenEof([]), send: (f) => frames.push(f) })
    expect(frames).toEqual([])
    expect(sdk.interruptCalled).toBe(false)
  }, 10_000)

  it('honours an interrupt command that arrives while the turn is running', async () => {
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN, JSON.stringify({ t: 'interrupt' })]),
      send: (f) => frames.push(f),
    })
    expect(sdk.interruptCalled).toBe(true)
  }, 10_000)
})

describe('SDK result error frames', () => {
  it('puts a bounded redacted diagnostic on the error frame, not only the subtype', async () => {
    sdk.scripted = [
      { type: 'system', subtype: 'init', session_id: 'sess-limit' },
      {
        type: 'result',
        subtype: 'error_during_execution',
        result: "You've hit your monthly spend limit CLAUDE_CODE_OAUTH_TOKEN=oat_secret",
        errors: ['rate_limit'],
      },
    ]
    const frames: ClaudeSdkHostFrame[] = []
    await runClaudeSdkHost({
      commands: commandsThenEof([TURN]),
      send: (f) => frames.push(f),
    })
    const error = frames.find((f) => f.t === 'error')
    expect(error).toMatchObject({ t: 'error', harnessSessionId: 'sess-limit' })
    expect(error && 'message' in error ? error.message : '').toMatch(/monthly spend limit/i)
    expect(error && 'message' in error ? error.message : '').toMatch(/error_during_execution/)
    expect(error && 'message' in error ? error.message : '').not.toMatch(/oat_secret/)
  }, 10_000)
})
