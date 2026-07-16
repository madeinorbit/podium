import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseSessionArgs, runSessionCli, type SessionControlClient } from './session-cli'

const STATUS = {
  sessionId: 's1',
  agentKind: 'claude-code',
  status: 'live',
  phase: 'working',
  issue: { seq: 7, stage: 'in_progress', title: 'T', todos: ['[ ] a'] },
  commits: ['abc123 feat: x'],
  files: ['## branch', ' M a.ts'],
  unackedMessages: 2,
}

const READ = {
  items: [{ role: 'assistant', text: 'hello' }],
  cursor: 'c9',
  hasMore: true,
  truncated: false,
}

const RECAP = {
  sessionId: 's1',
  recap: 'Recap: 1 user / 1 assistant turns, 0 tool calls',
  watermark: 'w2',
  newItems: 2,
  delta: true,
}

const ASK = {
  answered: true,
  questionId: 'msg_q1',
  answer: 'the port is 18787',
  ackId: 'msg_a1',
  snapshot: { sessionId: 's1', status: 'live', phase: 'working' },
}

function client(
  result: { ok: boolean; queued?: boolean; reason?: string } = { ok: true },
  ask: unknown = ASK,
  title: { ok: boolean; name?: string; reason?: string } = { ok: true, name: 'Named thing' },
) {
  return {
    sessions: {
      sendText: { mutate: vi.fn(async () => result) },
      resumeAndSend: { mutate: vi.fn(async () => result) },
      continue: { mutate: vi.fn(async () => result) },
      status: { query: vi.fn(async (): Promise<unknown> => STATUS) },
      read: { query: vi.fn(async (): Promise<unknown> => READ) },
      recap: { query: vi.fn(async (): Promise<unknown> => RECAP) },
      ask: { mutate: vi.fn(async (): Promise<unknown> => ask) },
      title: { mutate: vi.fn(async () => title) },
    },
  } satisfies SessionControlClient
}

describe('podium session CLI', () => {
  it('parses boolean flags without consuming positionals', () => {
    expect(parseSessionArgs(['send', '--wake', 's1', '--text', 'hello'])).toEqual({
      command: 'send',
      args: { wake: true, text: 'hello' },
      positionals: ['s1'],
    })
  })

  it('sends a real turn to a running session', async () => {
    const c = client()
    await expect(runSessionCli(['send', 's1', '--text', 'hello'], c)).resolves.toBe('sent')
    expect(c.sessions.sendText.mutate).toHaveBeenCalledWith({ sessionId: 's1', text: 'hello' })
    expect(c.sessions.resumeAndSend.mutate).not.toHaveBeenCalled()
  })

  it('wake-send uses the durable resumeAndSend path', async () => {
    const c = client({ ok: true, queued: true })
    await expect(runSessionCli(['send', 's1', '--text', 'continue', '--wake'], c)).resolves.toBe(
      'queued for delivery',
    )
    expect(c.sessions.resumeAndSend.mutate).toHaveBeenCalledWith({
      sessionId: 's1',
      text: 'continue',
    })
  })

  it('continue uses the phase-gated session operation', async () => {
    const c = client()
    await expect(runSessionCli(['continue', 's1'], c)).resolves.toBe('continued')
    expect(c.sessions.continue.mutate).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('surfaces a rejected session operation', async () => {
    await expect(
      runSessionCli(
        ['send', 's1', '--text', 'hello'],
        client({ ok: false, reason: 'not running' }),
      ),
    ).rejects.toThrow('not running')
  })

  it('help documents direct, wake, and continue semantics', async () => {
    const out = await runSessionCli(['help'], client())
    expect(out).toContain('send <session-id>')
    expect(out).toContain('resume-and-send')
    expect(out).toContain('continue <session-id>')
  })
})

// #490 — `podium session title "…"`. The one session command with no session id:
// the server binds the CALLING session from the relay capability.
describe('podium session title (#490)', () => {
  it('sends the title with NO session id — it can only ever name the caller', async () => {
    const c = client()
    const out = await runSessionCli(['title', 'Session name source column'], c, { hasRelay: true })
    expect(c.sessions.title.mutate).toHaveBeenCalledWith({ name: 'Session name source column' })
    expect(out).toContain('Named thing')
  })

  it('accepts an unquoted multi-word title rather than silently taking the first word', async () => {
    const c = client({ ok: true }, ASK, { ok: true, name: 'Merge lock lease expiry' })
    await runSessionCli(['title', 'Merge', 'lock', 'lease', 'expiry'], c, { hasRelay: true })
    expect(c.sessions.title.mutate).toHaveBeenCalledWith({ name: 'Merge lock lease expiry' })
  })

  it('PRINTS the refusal when the user already named the session', async () => {
    const c = client({ ok: true }, ASK, {
      ok: false,
      reason:
        'this session was named by the user ("Mike\'s pet session") — an agent cannot rename it',
    })
    await expect(runSessionCli(['title', 'Something else'], c, { hasRelay: true })).rejects.toThrow(
      /named by the user/,
    )
  })

  it('requires the relay — outside an agent session there is no calling session to name', async () => {
    await expect(runSessionCli(['title', 'X'], client(), { hasRelay: false })).rejects.toThrow(
      /PODIUM_AGENT_RELAY is not set/,
    )
  })

  it('needs a title, and documents itself in --help', async () => {
    await expect(runSessionCli(['title'], client(), { hasRelay: true })).rejects.toThrow(
      /needs a title/,
    )
    expect(await runSessionCli(['help'], client())).toContain('title "<title>"')
  })
})

describe('podium session status/read (#237 read toolkit)', () => {
  it('status renders phase, issue, commits, files, and the unacked count', async () => {
    const c = client()
    const out = await runSessionCli(['status', 's1'], c)
    expect(c.sessions.status.query).toHaveBeenCalledWith({ ref: 's1' })
    expect(out).toContain('live/working')
    expect(out).toContain('issue #7 [in_progress] T')
    expect(out).toContain('abc123 feat: x')
    expect(out).toContain('unacked messages: 2')
    expect(out).not.toContain('transcript')
  })

  it('status accepts an issue ref and needs exactly one positional', async () => {
    const c = client()
    await runSessionCli(['status', '#7'], c)
    expect(c.sessions.status.query).toHaveBeenCalledWith({ ref: '#7' })
    await expect(runSessionCli(['status'], c)).rejects.toThrow(/needs a session id or #issue/)
  })

  it('read forwards turns/cursor, validates --turns, and renders the paging hint', async () => {
    const c = client()
    const out = await runSessionCli(['read', 's1', '--turns', '5', '--cursor', 'c3'], c)
    expect(c.sessions.read.query).toHaveBeenCalledWith({ sessionId: 's1', turns: 5, cursor: 'c3' })
    expect(out).toContain('hello')
    expect(out).toContain('--cursor c9')
    await expect(runSessionCli(['read', 's1', '--turns', 'lots'], c)).rejects.toThrow(
      /positive integer/,
    )
  })
})

describe('podium session recap/ask (#237 read toolkit tiers 3–4)', () => {
  it('recap forwards --since and renders the recap + persisted-watermark hint', async () => {
    const c = client()
    const out = await runSessionCli(['recap', 's1', '--since', 'w1'], c)
    expect(c.sessions.recap.query).toHaveBeenCalledWith({ sessionId: 's1', since: 'w1' })
    expect(out).toContain('Recap: 1 user / 1 assistant turns')
    expect(out).toContain('watermark: w2')
  })

  it('recap without --since relies on the server-persisted watermark', async () => {
    const c = client()
    await runSessionCli(['recap', 's1'], c)
    expect(c.sessions.recap.query).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('ask sends the question with a bounded timeout and prints the answer', async () => {
    const c = client()
    const out = await runSessionCli(['ask', 's1', '--question', 'which port?', '--timeout', '5'], c)
    expect(c.sessions.ask.mutate).toHaveBeenCalledWith({
      sessionId: 's1',
      question: 'which port?',
      timeoutSeconds: 5,
    })
    expect(out).toBe('the port is 18787')
  })

  it('ask renders "no answer yet" + snapshot when the bounded wait expires', async () => {
    const c = client(
      { ok: true },
      {
        answered: false,
        questionId: 'msg_q1',
        snapshot: { sessionId: 's1', status: 'live', phase: 'working' },
      },
    )
    const out = await runSessionCli(['ask', 's1', '--question', 'q'], c)
    expect(out).toContain('no answer yet')
    expect(out).toContain('live/working')
  })

  it('ask validates --question and --timeout', async () => {
    const c = client()
    await expect(runSessionCli(['ask', 's1'], c)).rejects.toThrow(/needs --question/)
    await expect(
      runSessionCli(['ask', 's1', '--question', 'q', '--timeout', 'soon'], c),
    ).rejects.toThrow(/whole number/)
  })
})

// Real-binary smoke (repo norm: skip-if-absent, same pattern as mail-cli):
// drive the actual runnable CLI entry with bun. Help must render without a
// server; unknown commands must exit non-zero.
const cliEntry = join(__dirname, '../../../scripts/cli.ts')
const hasBun = (() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' })
    return existsSync(cliEntry)
  } catch {
    return false
  }
})()

describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !hasBun)('podium session real-binary smoke', () => {
  it('renders help (status/read verbs included) without a server', () => {
    const out = execFileSync('bun', [cliEntry, 'session', '--help'], { encoding: 'utf8' })
    expect(out).toContain('podium session <command>')
    expect(out).toContain('status <session-id|#issue>')
    expect(out).toContain('read <session-id>')
    expect(out).toContain('recap <session-id>')
    expect(out).toContain('ask <session-id> --question')
  })

  it('fails fast on an unknown session command', () => {
    expect(() =>
      execFileSync('bun', [cliEntry, 'session', 'bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    ).toThrow()
  })
})
