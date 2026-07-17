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

function client(over?: Partial<Record<'send' | 'inbox' | 'show' | 'status' | 'reply', unknown>>) {
  const proc = (result: unknown) => ({
    mutate: vi.fn(async () => result),
    query: vi.fn(async () => result),
  })
  return {
    messages: {
      send: proc(over?.send ?? { id: 'msg_9', ok: true, queued: true }),
      inbox: proc(over?.inbox ?? [WIRE]),
      show: proc(over?.show ?? WIRE),
      status: proc(over?.status ?? WIRE),
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

  it('[POD-835] --expect-response is a bool flag, forwarded, and surfaced on the receipt', async () => {
    const c = client({
      send: { id: 'msg_9', ok: true, queued: true, expectsResponse: true },
    })
    const out = await runMailCli(
      ['send', '--to', '#1', '--body', 'confirm the shape?', '--expect-response'],
      c,
    )
    expect(c.messages.send.mutate).toHaveBeenCalledWith({
      to: '#1',
      body: 'confirm the shape?',
      expectResponse: true,
    })
    expect(out).toContain('response expected')
  })

  it('[POD-835] no --expect-response means no flag forwarded (receipt is mechanical)', async () => {
    const c = client()
    await runMailCli(['send', '--to', '#1', '--body', 'landed the fix'], c)
    expect(c.messages.send.mutate).toHaveBeenCalledWith({ to: '#1', body: 'landed the fix' })
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
