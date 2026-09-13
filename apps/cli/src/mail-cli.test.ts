import { MAIL_INBOX_DEFAULT_LIMIT } from '@podium/protocol'
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

function client(
  over?: Partial<Record<'send' | 'inbox' | 'show' | 'status' | 'dismiss' | 'reply', unknown>>,
) {
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
      dismiss: proc(over?.dismiss ?? { ...WIRE, status: 'read' }),
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

  it('[POD-959] --expires-in computes and forwards an ISO expiresAt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T10:00:00.000Z'))
    try {
      const c = client()
      await runMailCli(['send', '--to', '#1', '--body', 'expiry probe', '--expires-in', '2m'], c)
      expect(c.messages.send.mutate).toHaveBeenCalledWith({
        to: '#1',
        body: 'expiry probe',
        expiresAt: '2026-07-18T10:02:00.000Z',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('[POD-959] --expires-in rejects missing, malformed, and non-positive durations', async () => {
    const c = client()
    for (const argv of [
      ['send', '--to', '#1', '--body', 'x', '--expires-in'],
      ['send', '--to', '#1', '--body', 'x', '--expires-in', 'soon'],
      ['send', '--to', '#1', '--body', 'x', '--expires-in', '0m'],
    ]) {
      await expect(runMailCli(argv, c)).rejects.toThrow(/--expires-in/)
    }
    expect(c.messages.send.mutate).not.toHaveBeenCalled()
  })

  it('[POD-845/925] --expires-in converts a duration to absolute expiresAt ISO', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T10:00:00.000Z'))
    try {
      const c = client()
      await runMailCli(
        ['send', '--to', '#845', '--body', 'POD-845/925 verification probe', '--expires-in', '2m'],
        c,
      )
      expect(c.messages.send.mutate).toHaveBeenCalledWith({
        to: '#845',
        body: 'POD-845/925 verification probe',
        expiresAt: '2026-07-18T10:02:00.000Z',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('[POD-845/925] --expires-in rejects bad durations', async () => {
    const c = client()
    await expect(
      runMailCli(['send', '--to', '#1', '--body', 'x', '--expires-in', 'soon'], c),
    ).rejects.toThrow(/--expires-in/)
  })

  it('surfaces the clamp note on a downgraded send', async () => {
    const c = client({ send: { id: 'msg_9', ok: true, queued: true, clamped: true } })
    await expect(runMailCli(['send', '--to', '#1', '--body', 'x'], c)).resolves.toContain(
      'downgraded',
    )
  })

  it('[POD-854] an accepted send tells the sender to query mail status (never a bare success)', async () => {
    const c = client({ send: { id: 'msg_9', ok: true, disposition: 'accepted' } })
    const out = await runMailCli(
      ['send', '--to', 's-abc', '--body', 'x', '--urgency', 'next-turn'],
      c,
    )
    expect(out).toContain('accepted')
    expect(out).toContain('podium mail status msg_9')
  })

  it('[POD-854] a blocking send confirmed delivered reports delivered', async () => {
    const c = client({ send: { id: 'msg_9', ok: true, disposition: 'delivered' } })
    const out = await runMailCli(
      ['send', '--to', 's-abc', '--body', 'x', '--urgency', 'interrupt'],
      c,
    )
    expect(out).toContain('delivered')
  })

  // `delivered` with NO recipient session is not the same fact as `delivered` to a
  // named one, and the sender's instrument must not read them the same [POD-1420].
  // "appeared in the target's transcript — the agent has it" asserted an agent had
  // it while naming nobody, so every sender-side check said the message was fine.
  it('[POD-1420] mail status does not claim an agent has it when no session is named', async () => {
    const c = client({ status: { ...WIRE, status: 'delivered', deliveredAt: 't1' } })
    const out = await runMailCli(['status', 'msg_1'], c)
    expect(out).not.toMatch(/the agent has it/)
    expect(out).toMatch(/no recipient session/i)
  })

  it('mail status corrects a queue that missed its readiness deadline', async () => {
    const c = client({
      status: {
        ...WIRE,
        status: 'dead_letter',
        deadLetteredAt: '2026-08-16T18:00:00.000Z',
        deliveryDeferredAt: '2026-08-16T18:00:00.000Z',
        deliveryDeferredReason: 'never-live',
      },
    })
    const out = await runMailCli(['status', 'msg_1'], c)
    expect(out).toContain('status: dead_letter')
    // The sender is told what actually happened, and told it is over — the old
    // "still queued for retry" line described a wait that nothing was serving.
    expect(out).toContain('never became ready within the deadline')
    expect(out).not.toContain('still queued')
    expect(out).toContain('deferred-reason=never-live')
  })

  it('mail status says a torn-down session was never typed into', async () => {
    const c = client({
      status: {
        ...WIRE,
        status: 'dead_letter',
        deadLetteredAt: '2026-08-16T18:00:00.000Z',
        deliveryDeferredAt: '2026-08-16T18:00:00.000Z',
        deliveryDeferredReason: 'teardown',
      },
    })
    const out = await runMailCli(['status', 'msg_1'], c)
    expect(out).toContain('torn down before it could be typed into')
    expect(out).toContain('deferred-reason=teardown')
  })

  it('[POD-1420] mail status still confirms delivery when a session IS named', async () => {
    const c = client({
      status: { ...WIRE, status: 'delivered', deliveredAt: 't1', deliveredTo: 's-abc' },
    })
    const out = await runMailCli(['status', 'msg_1'], c)
    expect(out).toMatch(/the agent has it/)
    expect(out).toContain('to-session=s-abc')
  })

  it('inbox renders rows (and passes an --issue peek through)', async () => {
    const c = client()
    const out = await runMailCli(['inbox'], c)
    expect(out).toContain('msg_1 issue:#212 -> issue:#228')
    expect(out).toContain('hello')
    await runMailCli(['inbox', '--issue', '#228'], c)
    expect(c.messages.inbox.mutate).toHaveBeenLastCalledWith({
      issue: '#228',
      limit: MAIL_INBOX_DEFAULT_LIMIT,
    })
  })

  it('asks for exactly the page it will show [PDM-407]', async () => {
    const c = client()
    await runMailCli(['inbox'], c)
    // NOT limit + 1. Over-fetching would measure whether older mail exists, but
    // an inbox read MARKS WHAT IT RETURNS READ — the probe row would be consumed
    // and never displayed, which is the read-status defect this issue is about.
    expect(c.messages.inbox.mutate).toHaveBeenLastCalledWith({ limit: MAIL_INBOX_DEFAULT_LIMIT })
    await runMailCli(['inbox', '--limit', '3'], c)
    expect(c.messages.inbox.mutate).toHaveBeenLastCalledWith({ limit: 3 })
    await expect(runMailCli(['inbox', '--limit', 'lots'], c)).rejects.toThrow(/--limit/)
  })

  it('renders NEWEST FIRST so a display cut takes the oldest [PDM-407]', async () => {
    // The defect is a BYTE cut at the display layer, and such a cut always takes
    // the TAIL. Selecting the newest rows and then printing them oldest-first
    // hands the cut exactly the message the reader came for, which is what the
    // first version of this fix did.
    const rows = ['a', 'b', 'c'].map((id) => ({ ...WIRE, id: `msg_${id}` }))
    const out = await runMailCli(['inbox', '--limit', '3'], client({ inbox: rows }))
    const body = out.split('\n').filter((l) => l.includes('msg_'))
    expect(body[0]).toContain('msg_c')
    expect(body.at(-1)).toContain('msg_a')
    // And the full-read route is named up front, not a widening flag: asking for
    // more rows is the wrong answer to an output that was already too long.
    const head = out.split('\n').slice(0, 3).join('\n')
    expect(head).toContain('podium mail show')
    expect(head).not.toMatch(/--limit/)
  })

  it('says MAY on a full page and stays silent on a short one [PDM-407]', async () => {
    // The old notice inferred "older messages are not listed" from
    // length === limit, stating as fact something it could not know: a box
    // holding exactly one page was labelled definitely truncated. A full page
    // now says MAY, and a short page says nothing at all — the admission that
    // stops the banner being printed unconditionally.
    const full = ['a', 'b', 'c'].map((id) => ({ ...WIRE, id: `msg_${id}` }))
    const out = await runMailCli(['inbox', '--limit', '3'], client({ inbox: full }))
    expect(out).toMatch(/MAY be older messages/i)
    expect(out).not.toMatch(/Older messages exist\b/i)

    const short = ['a', 'b'].map((id) => ({ ...WIRE, id: `msg_${id}` }))
    const out2 = await runMailCli(['inbox', '--limit', '3'], client({ inbox: short }))
    expect(out2).not.toMatch(/older messages/i)
  })

  it('THE CONSUMING-BOUNDARY WITNESS: every read-marked row is named [PDM-139]', async () => {
    // `messages.inbox` is a MUTATION — a consuming read — so every row it returns
    // has been marked read by the time this renders. Per-row identity accounting
    // over a maximum page of long bodies: none may go unnamed.
    const long = (t: string) =>
      Array.from({ length: 60 }, (_, i) => `${t} ${i} ${'z'.repeat(90)}`).join('\n')
    // BEYOND THE SUPPORTED PAGE ON PURPOSE. At a supported page the id tier fits
    // the budget, so a renderer that drops rows never reaches its drop path and
    // this witness would pass vacuously — which it did, until a deliberate break
    // showed it could not fail for the reason it exists. Overshooting the bound
    // is the only way to exercise the floor through the REAL boundary, and the
    // never-drop guarantee is unconditional precisely so it still holds here.
    const returned = Array.from({ length: 1500 }, (_, i) => ({
      ...WIRE,
      id: `msg_${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      body: long(`m${i}`),
    }))
    const out = await runMailCli(['inbox', '--limit=500'], client({ inbox: returned }))
    const missing = returned.filter((m) => !out.includes(m.id)).map((m) => m.id)
    expect(missing).toEqual([])
    expect(out.indexOf(returned[1499]!.id)).toBeLessThan(out.indexOf(returned[0]!.id))
  })

  it('show needs an id and renders thread metadata', async () => {
    const c = client()
    await expect(runMailCli(['show'], c)).rejects.toThrow(/message id/)
    const out = await runMailCli(['show', 'msg_1'], c)
    expect(out).toContain('thread=msg_1')
    expect(c.messages.show.query).toHaveBeenCalledWith({ id: 'msg_1' })
  })

  it('dismiss requires an id and clears through its mutation', async () => {
    const c = client()
    await expect(runMailCli(['dismiss'], c)).rejects.toThrow(/message id/)
    const out = await runMailCli(['dismiss', 'msg_1'], c)
    expect(out).toBe('dismissed msg_1')
    expect(c.messages.dismiss.mutate).toHaveBeenCalledWith({ id: 'msg_1' })
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

  it('help documents all mail verbs', async () => {
    const out = await runMailCli(['help'], client())
    for (const verb of ['send --to', 'inbox', 'show <id>', 'dismiss <id>', 'reply <id>'])
      expect(out).toContain(verb)
    expect(out).toContain('--expires-in <duration>')
  })
})

/**
 * POD-3836. `podium mail` already refused a flag no mail command declares, but
 * against ONE set shared by every command — so a flag on the WRONG command
 * (`inbox --to someone`) was accepted and then silently ignored, which is the
 * same defect wearing a different hat.
 */
describe('unknown and misplaced flags on podium mail', () => {
  const client = {
    messages: {
      send: { mutate: vi.fn(), query: vi.fn() },
      inbox: { mutate: vi.fn(async () => []), query: vi.fn() },
      show: { mutate: vi.fn(), query: vi.fn() },
      status: { mutate: vi.fn(), query: vi.fn() },
      dismiss: { mutate: vi.fn(), query: vi.fn() },
      reply: { mutate: vi.fn(), query: vi.fn() },
    },
  }

  it('refuses a flag that belongs to another mail command', async () => {
    await expect(runMailCli(['inbox', '--to', 'someone'], client)).rejects.toThrow(
      /unknown flag --to/,
    )
    expect(client.messages.inbox.mutate).not.toHaveBeenCalled()
  })

  it('names the nearest declared flag on a typo', async () => {
    await expect(runMailCli(['send', '--to', '#1', '--bdy', 'hi'], client)).rejects.toThrow(
      /unknown flag --bdy \(did you mean --body\?\)/,
    )
  })

  it('still accepts every flag send declares', async () => {
    const send = vi.fn(async () => ({ id: 'm1', ok: true, disposition: 'accepted' }))
    const out = await runMailCli(
      [
        'send',
        '--to',
        '#1',
        '--body',
        'hi',
        '--urgency',
        'fyi',
        '--lifecycle',
        'wake',
        '--expect-response',
      ],
      { messages: { ...client.messages, send: { mutate: send, query: vi.fn() } } },
    )
    expect(out).toContain('sent m1')
    expect(send).toHaveBeenCalledWith({
      to: '#1',
      body: 'hi',
      urgency: 'fyi',
      lifecycle: 'wake',
      expectResponse: true,
    })
  })
})
