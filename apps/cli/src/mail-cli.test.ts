import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type MailClient, parseMailArgs, runMailCli } from './mail-cli'

const WIRE = {
  id: 'msg_1',
  threadId: 'msg_1',
  inReplyTo: null,
  from: 'issue:#212',
  to: 'issue:#228',
  kind: 'message',
  urgency: 'next-turn',
  lifecycle: 'wait',
  body: 'hello',
  createdAt: 't0',
  status: 'delivered',
  ackedBy: null,
}

function client(over?: Partial<Record<'send' | 'inbox' | 'show' | 'reply', unknown>>) {
  const proc = (result: unknown) => ({
    mutate: vi.fn(async () => result),
    query: vi.fn(async () => result),
  })
  return {
    messages: {
      send: proc(over?.send ?? { id: 'msg_9', ok: true, queued: true }),
      inbox: proc(over?.inbox ?? [WIRE]),
      show: proc(over?.show ?? WIRE),
      reply: proc(over?.reply ?? { id: 'msg_r', ok: true, acked: true }),
    },
  } satisfies MailClient
}

describe('podium mail CLI (argv shape)', () => {
  it('parses flags and positionals', () => {
    expect(
      parseMailArgs(['send', '--to', '#228', '--body', 'hi', '--urgency', 'next-turn']),
    ).toEqual({
      command: 'send',
      args: { to: '#228', body: 'hi', urgency: 'next-turn' },
      positionals: [],
    })
    expect(parseMailArgs(['reply', 'msg_1', '--body=done', '--json'])).toEqual({
      command: 'reply',
      args: { body: 'done', json: true },
      positionals: ['msg_1'],
    })
  })

  it('send requires --to and --body, validates axes, forwards them', async () => {
    const c = client()
    await expect(runMailCli(['send', '--body', 'x'], c)).rejects.toThrow(/--to/)
    await expect(runMailCli(['send', '--to', '#1'], c)).rejects.toThrow(/--body/)
    await expect(
      runMailCli(['send', '--to', '#1', '--body', 'x', '--urgency', 'shout'], c),
    ).rejects.toThrow(/--urgency/)
    await expect(
      runMailCli(['send', '--to', '#1', '--body', 'x', '--lifecycle', 'spawn'], c),
    ).rejects.toThrow(/--lifecycle/)
    const out = await runMailCli(
      ['send', '--to', 's-abc', '--body', 'x', '--urgency', 'next-turn', '--lifecycle', 'wake'],
      c,
    )
    expect(out).toContain('sent msg_9')
    expect(c.messages.send.mutate).toHaveBeenCalledWith({
      to: 's-abc',
      body: 'x',
      urgency: 'next-turn',
      lifecycle: 'wake',
    })
  })

  it('surfaces the clamp note on a downgraded send', async () => {
    const c = client({ send: { id: 'msg_9', ok: true, queued: true, clamped: true } })
    await expect(runMailCli(['send', '--to', '#1', '--body', 'x'], c)).resolves.toContain(
      'downgraded',
    )
  })

  it('inbox renders rows (and passes an --issue peek through)', async () => {
    const c = client()
    const out = await runMailCli(['inbox'], c)
    expect(out).toContain('msg_1 issue:#212 -> issue:#228')
    expect(out).toContain('hello')
    await runMailCli(['inbox', '--issue', '#228'], c)
    expect(c.messages.inbox.mutate).toHaveBeenLastCalledWith({ issue: '#228' })
  })

  it('show needs an id and renders thread metadata', async () => {
    const c = client()
    await expect(runMailCli(['show'], c)).rejects.toThrow(/message id/)
    const out = await runMailCli(['show', 'msg_1'], c)
    expect(out).toContain('thread=msg_1')
    expect(c.messages.show.query).toHaveBeenCalledWith({ id: 'msg_1' })
  })

  it('reply defaults to an ack and validates --kind', async () => {
    const c = client()
    await expect(runMailCli(['reply', 'msg_1'], c)).rejects.toThrow(/--body/)
    await expect(
      runMailCli(['reply', 'msg_1', '--body', 'x', '--kind', 'shout'], c),
    ).rejects.toThrow(/--kind/)
    const out = await runMailCli(['reply', 'msg_1', '--body', 'did it'], c)
    expect(out).toContain('acked msg_1')
    expect(c.messages.reply.mutate).toHaveBeenCalledWith({ id: 'msg_1', body: 'did it' })
  })

  it('rejects unknown flags and commands; --json wraps results', async () => {
    const c = client()
    await expect(
      runMailCli(['send', '--to', '#1', '--body', 'x', '--nope', 'y'], c),
    ).rejects.toThrow(/--nope/)
    await expect(runMailCli(['frobnicate'], c)).rejects.toThrow(/unknown command/)
    const out = await runMailCli(['reply', 'msg_1', '--body', 'x', '--json'], c)
    expect(JSON.parse(out)).toMatchObject({ command: 'reply', ok: true })
  })

  it('help documents all four verbs', async () => {
    const out = await runMailCli(['help'], client())
    for (const verb of ['send --to', 'inbox', 'show <id>', 'reply <id>'])
      expect(out).toContain(verb)
  })
})

// Real-binary smoke (repo norm: skip-if-absent): drive the actual runnable CLI
// entry (scripts/cli.ts — the composition root; apps/cli/src/cli.ts only
// exports main) with bun. Help must render without a server; unknown commands
// must exit non-zero.
const cliEntry = join(__dirname, '../../../scripts/cli.ts')
const hasBun = (() => {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' })
    return existsSync(cliEntry)
  } catch {
    return false
  }
})()

describe.skipIf(process.env.PODIUM_REAL_CLI !== '1' || !hasBun)('podium mail real-binary smoke', () => {
  it('renders help without a server', () => {
    const out = execFileSync('bun', [cliEntry, 'mail', '--help'], { encoding: 'utf8' })
    expect(out).toContain('podium mail <command>')
    expect(out).toContain('reply <id>')
  })

  it('fails fast on an unknown mail command', () => {
    expect(() =>
      execFileSync('bun', [cliEntry, 'mail', 'bogus'], { encoding: 'utf8', stdio: 'pipe' }),
    ).toThrow()
  })
})
