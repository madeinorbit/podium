import { asSessionId, type SessionId } from '@podium/model'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ConcertmasterEntryRow, ConcertmasterRepository } from '../../store/concertmaster'
import type { MessageRow } from '../../store/types'
import type { MessageSendInput } from '../messages/types'
import {
  ConcertmasterRefusal,
  ConcertmasterService,
  type ConcertmasterSessionFacts,
} from './service'

const S = asSessionId('s1')
const OTHER = asSessionId('s2')

/** The repository's contract over a list: enough to hold the service to its rules. */
function memoryEntries() {
  const rows: ConcertmasterEntryRow[] = []
  const blank = {
    artifacts: null,
    senderUserId: null,
    attachments: null,
    number: null,
    askKind: null,
    detail: null,
    options: null,
    status: null,
    answer: null,
    settledAt: null,
    settledBy: null,
  }
  const repo = {
    rows,
    entry: async (id: string) => rows.find((row) => row.id === id),
    ask: async (sessionId: SessionId, number: number) =>
      rows.find((row) => row.sessionId === sessionId && row.number === number),
    asks: async (sessionId: SessionId, limit: number) =>
      rows
        .filter((row) => row.sessionId === sessionId && row.number !== null)
        .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
        .slice(0, limit),
    tail: async (sessionId: SessionId) => rows.filter((row) => row.sessionId === sessionId),
    addSay: async (say: {
      id: string
      sessionId: SessionId
      body: string
      artifacts?: readonly string[]
      createdAt: string
    }) => {
      const row = { ...blank, ...say, kind: 'say', artifacts: say.artifacts ?? null }
      rows.push(row)
      return row
    },
    addUserEntry: async (entry: {
      id: string
      sessionId: SessionId
      body: string
      createdAt: string
    }) => {
      if (rows.some((row) => row.id === entry.id)) return null
      const row = { ...blank, ...entry, kind: 'user' } as ConcertmasterEntryRow
      rows.push(row)
      return row
    },
    addAsk: async (ask: {
      id: string
      sessionId: SessionId
      askKind: string
      title: string
      detail?: string
      options?: readonly string[]
      createdAt: string
    }) => {
      const highest = Math.max(
        0,
        ...rows.filter((r) => r.sessionId === ask.sessionId).map((r) => r.number ?? 0),
      )
      const row: ConcertmasterEntryRow = {
        ...blank,
        id: ask.id,
        sessionId: ask.sessionId,
        kind: 'ask',
        body: ask.title,
        createdAt: ask.createdAt,
        number: highest + 1,
        askKind: ask.askKind,
        detail: ask.detail ?? null,
        options: ask.options ?? null,
        status: 'open',
      }
      rows.push(row)
      return row
    },
    rewriteAsk: async (
      id: string,
      words: { title: string; detail: string | null; options: readonly string[] | null },
    ) => {
      const at = rows.findIndex((row) => row.id === id && row.status === 'open')
      if (at < 0) return null
      rows[at] = { ...rows[at]!, body: words.title, detail: words.detail, options: words.options }
      return rows[at]!
    },
    settleAsk: async (
      id: string,
      outcome: { status: string; answer: string | null; settledAt: string; settledBy: string },
    ) => {
      const at = rows.findIndex((row) => row.id === id && row.status === 'open')
      if (at < 0) return null
      rows[at] = { ...rows[at]!, ...outcome }
      return rows[at]!
    },
  }
  return repo
}

function harness() {
  const entries = memoryEntries()
  const sessions = new Map<SessionId, ConcertmasterSessionFacts>([
    [S, { concertmaster: true, agentKind: 'claude-code', headless: false, deleted: false }],
    [OTHER, { concertmaster: false, agentKind: 'claude-code', headless: false, deleted: false }],
  ])
  const sent: MessageSendInput[] = []
  const messages = new Map<string, MessageRow>()
  const state = { enabled: true, disposition: 'queued' as 'queued' | 'dead_letter', clock: 0 }
  const service = new ConcertmasterService({
    entries: entries as unknown as ConcertmasterRepository,
    enabled: () => state.enabled,
    now: () => Date.parse('2026-11-20T10:00:00.000Z') + state.clock++ * 1000,
    mint: () => `t${state.clock}`,
    session: async (id) => sessions.get(id),
    setMark: async (_writer, id, on) => {
      sessions.set(id, { ...sessions.get(id)!, concertmaster: on })
    },
    send: async (_writer, _from, input) => {
      sent.push(input)
      return { ok: true, disposition: state.disposition, message: {} as MessageRow }
    },
    message: async (id) => messages.get(id) ?? null,
  })
  const writer = { commit: async () => ({ result: undefined }) } as never
  return { service, entries, sessions, sent, messages, state, writer }
}

describe('ConcertmasterService', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  it('refuses every agent command while the feature is off, and for an unmarked session', async () => {
    h.state.enabled = false
    await expect(h.service.say(S, { body: 'hi' })).rejects.toThrow(ConcertmasterRefusal)
    h.state.enabled = true
    await expect(h.service.say(OTHER, { body: 'hi' })).rejects.toThrow(/not a Concertmaster/)
    expect(h.entries.rows).toHaveLength(0)
  })

  it('records what the agent says, and holds a message to its limits', async () => {
    await h.service.say(S, { body: '  Done with the login fix.  ', artifacts: ['shot.png'] })
    expect(h.entries.rows[0]).toMatchObject({
      kind: 'say',
      body: 'Done with the login fix.',
      artifacts: ['shot.png'],
    })
    await expect(h.service.say(S, { body: '   ' })).rejects.toThrow(/1\.\.16000/)
    await expect(h.service.say(S, { body: 'x', artifacts: 'shot.png' })).rejects.toThrow(/list/)
  })

  it('numbers asks per session and holds each kind to its shape', async () => {
    expect((await h.service.ask(S, { title: 'Which database?' })).number).toBe(1)
    expect(
      (await h.service.ask(S, { kind: 'decision', title: 'Ship?', options: ['Yes', 'No'] })).number,
    ).toBe(2)
    await expect(
      h.service.ask(S, { kind: 'decision', title: 'Ship?', options: ['Yes'] }),
    ).rejects.toThrow(/two options/)
    await expect(
      h.service.ask(S, { kind: 'todo', title: 'Rotate key', options: ['a', 'b'] }),
    ).rejects.toThrow(/no options/)
    await expect(h.service.ask(S, { kind: 'poll', title: 'x' })).rejects.toThrow(
      /question, decision, todo/,
    )
    await expect(h.service.ask(S, { title: '' })).rejects.toThrow(/one line/)
  })

  it('lets the agent settle an ask once, and says so the second time', async () => {
    const { number } = await h.service.ask(S, { title: 'Which database?' })
    expect(await h.service.resolve(S, { number, answer: 'Postgres' })).toEqual({
      number,
      settled: true,
    })
    const again = await h.service.retract(S, { number })
    expect(again.settled).toBe(false)
    expect(again.notice).toMatch(/already answered/)
    expect(h.entries.rows[0]).toMatchObject({
      status: 'answered',
      answer: 'Postgres',
      settledBy: 'agent',
    })
    await expect(h.service.update(S, { number, title: 'New words' })).rejects.toThrow(
      /can no longer change/,
    )
    expect((await h.service.list(S)).asks).toHaveLength(0)
    expect((await h.service.list(S, { show: 'all' })).asks).toHaveLength(1)
  })

  it("settles an ask with the person's response and tells the agent in their words", async () => {
    await h.service.ask(S, { kind: 'decision', title: 'Ship?', options: ['Yes', 'No'] })
    const ask = h.entries.rows[0]!
    const from = { kind: 'operator' as const }
    await expect(
      h.service.respond(h.writer, from, { sessionId: S, entryId: ask.id, response: 'done' }),
    ).rejects.toThrow(/answered, not marked done/)
    await expect(
      h.service.respond(h.writer, from, {
        sessionId: OTHER,
        entryId: ask.id,
        response: 'dismissed',
      }),
    ).rejects.toThrow(/unknown ask/)
    expect(
      await h.service.respond(h.writer, from, {
        sessionId: S,
        entryId: ask.id,
        response: 'answered',
        text: 'Yes',
      }),
    ).toEqual({ settled: true, status: 'answered' })
    expect(h.entries.rows[0]).toMatchObject({
      status: 'answered',
      answer: 'Yes',
      settledBy: 'user',
    })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({
      to: { kind: 'session', id: S },
      lifecycle: 'wake',
      body: 'Answer to ask #1 (decision: "Ship?"): Yes',
    })
    expect(h.sent[0]!.messageId).toMatch(/^cmask:/)
    // Settled already: nothing more is sent.
    expect(
      await h.service.respond(h.writer, from, {
        sessionId: S,
        entryId: ask.id,
        response: 'dismissed',
      }),
    ).toEqual({ settled: false, status: 'answered' })
    expect(h.sent).toHaveLength(1)
  })

  it('refuses a response it could not deliver', async () => {
    await h.service.ask(S, { kind: 'todo', title: 'Rotate key' })
    h.state.disposition = 'dead_letter'
    await expect(
      h.service.respond(
        h.writer,
        { kind: 'operator' },
        {
          sessionId: S,
          entryId: h.entries.rows[0]!.id,
          response: 'done',
        },
      ),
    ).rejects.toThrow(/could not be delivered/)
  })

  it('marks a session once and briefs its agent; clearing tells it too', async () => {
    expect(await h.service.assign(h.writer, OTHER, true)).toEqual({
      concertmaster: true,
      changed: true,
    })
    expect(await h.service.assign(h.writer, OTHER, true)).toEqual({
      concertmaster: true,
      changed: false,
    })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.body).toContain('podium concertmaster say')
    expect(h.sent[0]!.lifecycle).toBe('wait')
    await h.service.assign(h.writer, OTHER, false)
    expect(h.sent[1]!.body).toContain('cleared the Concertmaster mark')
    h.sessions.set(OTHER, {
      concertmaster: false,
      agentKind: 'shell',
      headless: false,
      deleted: false,
    })
    await expect(h.service.assign(h.writer, OTHER, true)).rejects.toThrow(/agent session/)
  })

  it("records a person's confirmed message once, and nothing else", async () => {
    const message = (over: Partial<MessageRow>): MessageRow =>
      ({
        id: 'msg_1',
        fromKind: 'operator',
        toKind: 'session',
        toId: S,
        body: 'Please also fix the footer',
        createdAt: '2026-11-20T09:59:00.000Z',
        deliveryStatus: 'confirmed',
        ...over,
      }) as MessageRow
    h.messages.set('msg_1', message({}))
    h.messages.set('msg_2', message({ id: 'msg_2', deliveryStatus: 'typed' }))
    h.messages.set('msg_3', message({ id: 'msg_3', fromKind: 'agent' }))
    h.messages.set('cmask:x:1', message({ id: 'cmask:x:1' }))
    expect(await h.service.recordDelivered(S, 'msg_1')).toBe(true)
    expect(await h.service.recordDelivered(S, 'msg_1')).toBe(false)
    expect(await h.service.recordDelivered(S, 'msg_2')).toBe(false)
    expect(await h.service.recordDelivered(S, 'msg_3')).toBe(false)
    expect(await h.service.recordDelivered(S, 'cmask:x:1')).toBe(false)
    expect(await h.service.recordDelivered(OTHER, 'msg_1')).toBe(false)
    expect(h.entries.rows).toHaveLength(1)
    expect(h.entries.rows[0]).toMatchObject({ kind: 'user', body: 'Please also fix the footer' })
  })
})
