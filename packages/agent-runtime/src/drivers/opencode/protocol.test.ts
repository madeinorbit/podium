/**
 * THE RECORDED-FIXTURE PROTOCOL TESTS (POD-1761 W5; plan §5).
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE FOR, AND WHAT THEY ARE NOT
 * ---------------------------------------------------------------------------
 *
 * Every fixture under `./__fixtures__` was captured from a REAL `opencode serve`
 * (1.18.16) doing a real thing: a turn that ran and answered, a bash permission
 * ask answered `once`, a question ask answered by label, and the OpenAPI slices
 * for the ten routes this driver calls. Nothing here is hand-written from a doc,
 * because the plan's own pitfall list says community docs of this API have
 * drifted — and two of its three "repo-unconfirmed" endpoints had in fact moved.
 *
 * So these tests are the VERSION GATE'S EVIDENCE. The gate says "this driver
 * speaks 1.18–1.24"; these say what that sentence is a claim about, replayable
 * on any machine with no opencode installed at all. When upstream renames a
 * field the driver reads, the failure appears here with the field named — not in
 * production as an `undefined` flowing through a mapper.
 */

import { describe, expect, it } from 'vitest'
import permissionEvents from './__fixtures__/events-permission.json'
import questionEvents from './__fixtures__/events-question.json'
import turnEvents from './__fixtures__/events-turn.json'
import messagesFixture from './__fixtures__/messages-permission-turn.json'
import openapiPins from './__fixtures__/openapi-pins.json'
import sessionFixture from './__fixtures__/session-created.json'
import { answerAction, partToItems, permissionAsk, questionAsk } from './map.js'
import {
  eventSessionId,
  eventTimeMs,
  OpencodeMessageWithParts,
  OpencodeProtocolError,
  OpencodeSession,
  parseOpencodeEvent,
} from './protocol.js'

const all = [...turnEvents, ...permissionEvents, ...questionEvents] as unknown[]

const parsed = all.map((raw) => parseOpencodeEvent(raw)).filter((event) => event !== null)

const firstOfType = <T extends string>(type: T) => {
  const found = parsed.find((event) => event.type === type)
  if (!found) throw new Error(`fixture corpus has no '${type}' event`)
  return found
}

describe('opencode protocol — recorded fixtures (1.18.16)', () => {
  it('parses every recorded frame the driver consumes, and ignores the rest', () => {
    // The corpus is ~130 real frames across three sessions. A driver that threw
    // on an arm it does not consume would break every time upstream shipped a
    // feature, so the assertion is that nothing THROWS and that the arms we do
    // read are all present.
    expect(parsed.length).toBeGreaterThan(50)
    const types = new Set(parsed.map((event) => event.type))
    for (const required of [
      'session.created',
      'session.status',
      'session.idle',
      'message.updated',
      'message.part.updated',
      'message.part.delta',
      'permission.asked',
      'permission.replied',
      'question.asked',
      'question.replied',
    ] as const) {
      expect(types, `the recording is missing a '${required}'`).toContain(required)
    }
  })

  it('THROWS when an arm it reads stops matching — the gate with teeth', () => {
    // A shape the driver depends on, broken the way a real upstream rename
    // breaks it. Silence here would mean the version pin protects nothing.
    expect(() =>
      parseOpencodeEvent({
        id: 'evt_x',
        type: 'permission.asked',
        properties: { id: 'per_x', sessionID: 'ses_x', permission: 'bash' },
      }),
    ).toThrow(OpencodeProtocolError)
  })

  it('drops an unconsumed arm rather than failing on it', () => {
    expect(parseOpencodeEvent({ id: 'evt_x', type: 'pty.created', properties: {} })).toBeNull()
    // The single most common frame on the stream, and it is not in `/doc`'s
    // union at all. It must cost one comparison, not an exception.
    expect(parseOpencodeEvent({ id: 'evt_x', type: 'server.heartbeat', properties: {} })).toBeNull()
  })

  it('reads a real session-create response', () => {
    const session = OpencodeSession.parse(sessionFixture)
    expect(session.id).toMatch(/^ses/)
    // THE KEY NAME THAT BITES: a session's model is `id`, a prompt's is
    // `modelID`. Pinned here so the asymmetry cannot be "fixed" in one place.
    expect(session.model?.id).toBe('laguna-s-2.1-free')
    expect(session.model?.providerID).toBe('opencode')
  })

  it('reads a real message history and maps it through the shared transcript mapper', () => {
    const messages = (messagesFixture as unknown[]).map((row) => OpencodeMessageWithParts.parse(row))
    expect(messages.length).toBeGreaterThan(1)
    const items = messages.flatMap((message) =>
      message.parts.flatMap((part) => partToItems(message.info.sessionID, message.info, part)),
    )
    // The mapper is `packages/transcript`'s, unchanged — the point is that the
    // SSE/REST payloads feed it without a second opencode→item implementation.
    expect(items.some((item) => item.role === 'user')).toBe(true)
    expect(items.some((item) => item.role === 'assistant')).toBe(true)
    // A real bash tool call rode this turn; its item must carry the tool name.
    expect(items.some((item) => item.role === 'tool' && item.toolName === 'bash')).toBe(true)
    // Every stamped item has the stable per-part cursor a delta reconciles on.
    expect(items.every((item) => typeof item.cursor === 'string' && item.cursor.length > 0)).toBe(true)
  })

  it('carries the session id on every session-scoped arm — the child-session filter', () => {
    // Subagents ride the same bus with their own `ses_…`. If an arm the driver
    // consumes did not carry the id, the filter could not be written at all.
    for (const event of parsed) {
      if (event.type === 'server.connected') continue
      expect(eventSessionId(event), `${event.type} carries no sessionID`).toMatch(/^ses/)
    }
  })

  it('takes event time from the payload where opencode publishes one', () => {
    // `message.part.updated` is the arm that matters — it is what a transcript
    // item is stamped from — and it is the one arm with a real per-event time.
    const part = firstOfType('message.part.updated')
    expect(eventTimeMs(part)).toBeGreaterThan(1_700_000_000_000)
    // …and the arms with no time say so rather than inventing one.
    expect(eventTimeMs(firstOfType('session.idle'))).toBeUndefined()
    expect(eventTimeMs(firstOfType('permission.asked'))).toBeUndefined()
  })
})

describe('opencode protocol — the ten routes, pinned from a live /doc', () => {
  const paths = (openapiPins as { paths: Record<string, Record<string, unknown>> }).paths

  it('is an OpenAPI 3.1 document', () => {
    expect((openapiPins as { openapi: string }).openapi).toBe('3.1.0')
  })

  it('has every route the client calls, at the name the client calls it', () => {
    // THE THREE THE PLAN COULD NOT CONFIRM FROM THE REPO are the first three
    // here, and the permission reply is the one whose name the plan got wrong.
    for (const [path, method] of [
      ['/session', 'post'],
      ['/session/{sessionID}/prompt_async', 'post'],
      ['/permission/{requestID}/reply', 'post'],
      ['/session/{sessionID}', 'get'],
      ['/session/{sessionID}/abort', 'post'],
      ['/session/{sessionID}/message', 'get'],
      ['/question/{requestID}/reply', 'post'],
      ['/question/{requestID}/reject', 'post'],
      ['/event', 'get'],
      ['/global/health', 'get'],
    ] as const) {
      expect(paths[path]?.[method], `${method.toUpperCase()} ${path} is not in the pinned doc`).toBeDefined()
    }
  })

  it('takes `directory` as a query parameter on the routes the client scopes', () => {
    // Omitting it is SILENT: `/event` without `directory` yields heartbeats and
    // no session events at all, which reads exactly like an idle agent. The
    // client applies it centrally; this is what says it must.
    for (const [path, method] of [
      ['/session', 'post'],
      ['/session/{sessionID}/prompt_async', 'post'],
      ['/permission/{requestID}/reply', 'post'],
      ['/event', 'get'],
    ] as const) {
      const op = paths[path]?.[method] as { parameters?: { name: string; in: string }[] }
      expect(
        op.parameters?.some((p) => p.name === 'directory' && p.in === 'query'),
        `${method.toUpperCase()} ${path} lost its directory query parameter`,
      ).toBe(true)
    }
  })

  it('keeps the permission reply vocabulary at once/always/reject', () => {
    const op = paths['/permission/{requestID}/reply']?.post as {
      requestBody: { content: Record<string, { schema: { properties: { reply: { enum: string[] } } } }> }
    }
    const schema = Object.values(op.requestBody.content)[0]?.schema
    // Spec §4 asked for exactly this vocabulary; it is opencode's own, which is
    // why the contract's `PermissionAnswer` maps onto it without a translation
    // table nobody could audit.
    expect(schema?.properties.reply.enum).toEqual(['once', 'always', 'reject'])
  })

  it('answers a question by LABEL, not by index', () => {
    const op = paths['/question/{requestID}/reply']?.post as {
      requestBody: { content: Record<string, { schema: { properties: { answers: { description?: string } } } }> }
    }
    const schema = Object.values(op.requestBody.content)[0]?.schema
    // If this ever became indices, every answer this driver sends would silently
    // start answering a different option whenever the menu reordered.
    expect(schema?.properties.answers.description ?? '').toContain('labels')
  })
})

describe('opencode protocol — the recorded asks become contract asks', () => {
  it('maps the recorded bash permission ask', () => {
    const asked = firstOfType('permission.asked')
    if (asked.type !== 'permission.asked') throw new Error('narrowing')
    const ask = permissionAsk({
      id: asked.properties.id,
      sessionId: 'sess_podium',
      permission: asked.properties.permission,
      patterns: asked.properties.patterns,
      metadata: asked.properties.metadata,
      always: asked.properties.always,
      askedAt: '2026-08-14T00:00:00.000Z',
    })
    if (ask.kind !== 'permission') throw new Error('narrowing')
    expect(ask.id).toMatch(/^per/)
    expect(ask.payload.toolName).toBe('bash')
    // `metadata.command` is the field that says what it would DO.
    expect(ask.payload.inputSummary).toBe('echo hello')
    // A non-empty `always` IS the always-allow offer, and its contents are the
    // rule patterns `PermissionAsk.suggestions` was reserved for.
    expect(ask.payload.canAlwaysAllow).toBe(true)
    expect(ask.payload.suggestions).toEqual(['echo *'])
    // The two fields that keep this driver off the terminal family's exemptions.
    expect(ask.source).toBe('protocol')
    expect(ask.answerable).toBe('structured')
  })

  it('maps the recorded question ask, and answers it by the labels opencode wants', () => {
    const asked = firstOfType('question.asked')
    if (asked.type !== 'question.asked') throw new Error('narrowing')
    const ask = questionAsk({
      id: asked.properties.id,
      sessionId: 'sess_podium',
      questions: asked.properties.questions,
      askedAt: '2026-08-14T00:00:00.000Z',
    })
    if (ask.kind !== 'question') throw new Error('narrowing')
    const prompt = ask.payload.questions[0]
    expect(prompt?.question).toContain('tabs or spaces')
    expect(prompt?.options.map((o) => o.label)).toEqual(['Tabs', 'Spaces'])
    // opencode's options carry no `preview`, so the side-by-side dialog POD-770
    // documents cannot occur — and claiming it could would tell a surface to
    // refuse free text on a menu that accepts it.
    expect(prompt?.previewLayout).toBe(false)
    expect(prompt?.multiSelect).toBe(false)

    // 1-based on the wire, labels on opencode's.
    const action = answerAction(ask, { kind: 'question', selections: [{ optionIndices: [1] }] })
    expect(action).toEqual({ call: 'question', answers: [['Tabs']] })
    // …and it is the SAME payload the live server accepted in the recording.
    const replied = firstOfType('question.replied')
    if (replied.type !== 'question.replied') throw new Error('narrowing')
    expect(replied.properties.answers).toEqual([['Tabs']])
  })

  it('refuses an always-allow the ask never offered', () => {
    const ask = permissionAsk({
      id: 'per_no_always',
      sessionId: 'sess_podium',
      permission: 'edit',
      patterns: ['src/main.ts'],
      metadata: {},
      always: [],
      askedAt: '2026-08-14T00:00:00.000Z',
    })
    const action = answerAction(ask, { kind: 'permission', decision: 'allow-always' })
    // Downgrading to `once` would report a persistent grant that was never made.
    expect(action.call).toBe('refuse')
  })
})
