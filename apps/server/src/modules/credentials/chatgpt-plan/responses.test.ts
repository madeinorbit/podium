/**
 * PODIUM'S OWN MODEL CALLS ON A CHATGPT PLAN (credential management §11
 * "Direct inference"; epic Task 14, acceptance 8).
 *
 * `complete` with a real store, vault, keeper and health service; OpenAI's
 * Responses route is a fake that answers the way POD-6894 measured it: a
 * server-sent event stream with no content type, `{"detail"}` admission
 * errors, and a plan limit before or after the stream opens.
 */

import { asUserId, type CredentialId } from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '../../../store'
import { newCredentialId } from '../../../store/credentials'
import { openTestStore } from '../../../test-support/open-test-store'
import { complete } from '../../inference/complete'
import { CredentialHealth, DEFAULT_LIMIT_MS } from '../health'
import { CHATGPT_PLAN_TYPE } from './authorize'
import { FAKE_CLIENT_ID } from './fake-openai'
import { ChatgptPlanKeeper } from './keeper'
import type { ChatgptTokenSet } from './openai'

const OWNER = asUserId('user:responses-owner')
const NOW = Date.parse('2026-11-16T12:00:00Z')
const RESPONSES = 'https://api.openai.com/v1/responses'
const MODELS = 'https://api.openai.com/v1/models'

let store: SessionStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

const sse = (events: Record<string, unknown>[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

const completedText = (text: string) => [
  { type: 'response.created', response: { id: 'resp_FAKE' } },
  { type: 'response.output_text.delta', delta: text.slice(0, 3) },
  { type: 'response.output_text.delta', delta: text.slice(3) },
  {
    type: 'response.output_item.done',
    item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  },
  {
    type: 'response.completed',
    response: {
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 13, output_tokens: 8 },
    },
  },
]

interface Seen {
  url: string
  authorization: string | null
  body: Record<string, unknown> | undefined
}

/** OpenAI's Responses route. Streams carry no content-type header, as measured. */
function fakeResponses(answer: () => Response) {
  const seen: Seen[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    seen.push({
      url: String(url),
      authorization: headers.get('authorization'),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    })
    if (String(url) === MODELS) {
      return Response.json({
        models: [
          { slug: 'fake-hidden', visibility: 'hide' },
          { slug: 'fake-model-first', display_name: 'First', visibility: 'list' },
          { slug: 'fake-model-second', display_name: 'Second', visibility: 'list' },
        ],
      })
    }
    return answer()
  }) as typeof fetch
  return { seen, fetchImpl }
}

const stream = (events: Record<string, unknown>[]) => () => {
  const res = new Response(sse(events), { status: 200 })
  res.headers.delete('content-type')
  return res
}

async function setup(answer: () => Response) {
  store = await openTestStore(':memory:')
  const s = store
  await s.users.create(
    {
      id: OWNER,
      displayName: 'Owner',
      role: 'member',
      createdAt: new Date(NOW).toISOString(),
      disabledAt: null,
    },
    'not-a-real-hash',
  )
  const plan = async (label: string, token: string): Promise<CredentialId> => {
    const id = newCredentialId()
    const set: ChatgptTokenSet = {
      seq: 1,
      clientId: FAKE_CLIENT_ID,
      accessToken: token,
      refreshToken: `${token}-refresh`,
      idToken: 'FAKE.id.token',
      expiresAt: NOW + 3600_000,
      scopes: ['chatgpt.tokens.use.direct'],
      savedAt: NOW,
    }
    const sealed = await s.vault.seal(
      { credentialId: id, type: CHATGPT_PLAN_TYPE, version: 1 },
      Buffer.from(JSON.stringify(set)),
    )
    await s.credentials.insertWithSecret(
      { id, ownerUserId: OWNER, label, type: CHATGPT_PLAN_TYPE },
      sealed,
    )
    return id
  }
  const chosen = await plan('Chosen plan', 'FAKE-access-chosen')
  await plan('Other plan', 'FAKE-access-other')
  const provider = fakeResponses(answer)
  const health = new CredentialHealth({ store: s, now: () => NOW })
  const keeper = new ChatgptPlanKeeper({ store: s, now: () => NOW, fetch: provider.fetchImpl })
  const run = (opts: { model?: string; system?: string } = {}) =>
    complete(
      {
        store: s,
        fetch: provider.fetchImpl,
        chatgptPlan: keeper,
        onCredentialFailure: async (failure) => await health.noteFailure(failure),
      },
      {
        credentialId: chosen,
        model: opts.model ?? 'fake-model',
        messages: [
          ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
          { role: 'user' as const, content: 'Say hello' },
        ],
        actingUserId: OWNER,
      },
    )
  return { s, chosen, provider, run }
}

describe('acceptance 8: the Responses request', () => {
  it('has store false, stream true, system text in instructions, no system item and no unsupported field; reads the unlabelled stream', async () => {
    const { run, provider, chosen } = await setup(stream(completedText('Hello, world!')))
    const result = await run({ system: 'Be terse.' })
    expect(result).toMatchObject({ text: 'Hello, world!', servedBy: chosen, label: 'Chosen plan' })
    const call = provider.seen.find((x) => x.url === RESPONSES)
    expect(call?.authorization).toBe('Bearer FAKE-access-chosen')
    const body = call?.body ?? {}
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe('Be terse.')
    expect(body.input).toEqual([{ role: 'user', content: 'Say hello' }])
    expect(JSON.stringify(body.input)).not.toContain('"system"')
    for (const field of [
      'max_output_tokens',
      'temperature',
      'top_p',
      'metadata',
      'user',
      'previous_response_id',
      'background',
      'conversation',
      'truncation',
    ]) {
      expect(body).not.toHaveProperty(field)
    }
  })

  it('with no model chosen, uses the first model the plan lists', async () => {
    const { run, provider } = await setup(stream(completedText('hi')))
    await run({ model: 'auto' })
    expect(provider.seen.find((x) => x.url === RESPONSES)?.body?.model).toBe('fake-model-first')
  })

  it('a stream that ends without response.completed is a failure', async () => {
    const { run } = await setup(stream(completedText('cut off').slice(0, 3)))
    await expect(run()).rejects.toThrow(/without response.completed/)
  })

  it('reads a tool call from the completed response', async () => {
    const { run } = await setup(
      stream([
        {
          type: 'response.completed',
          response: {
            output: [
              { type: 'function_call', call_id: 'call_FAKE', name: 'lookup', arguments: '{"q":1}' },
            ],
          },
        },
      ]),
    )
    expect((await run()).toolCalls).toEqual([
      { id: 'call_FAKE', name: 'lookup', arguments: '{"q":1}' },
    ])
  })

  const limitAnswers = {
    'before the stream (429)': () =>
      Response.json(
        {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'usage limit (fake)',
          },
        },
        { status: 429 },
      ),
    'after the stream opened (response.failed)': stream([
      { type: 'response.created', response: { id: 'resp_FAKE' } },
      {
        type: 'response.failed',
        response: {
          status: 'failed',
          error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit (fake)' },
        },
      },
    ]),
  }

  it.each(
    Object.entries(limitAnswers),
  )('a plan limit %s sets limitReachedUntil to the default back-off, not attention, and tries no other credential', async (_name, answer) => {
    const { run, provider, s, chosen } = await setup(answer)
    await expect(run()).rejects.toThrow(/429/)
    const record = await s.credentials.get(chosen)
    expect(record?.status).toBe('ok')
    expect(record?.limitReachedUntil).toBe(new Date(NOW + DEFAULT_LIMIT_MS).toISOString())
    const tokens = provider.seen.map((x) => x.authorization)
    expect(tokens).toEqual(['Bearer FAKE-access-chosen'])
  })

  it('a disconnected grant (401 token_revoked, JSON under text/plain) moves it to attention', async () => {
    const { run, s, chosen } = await setup(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Encountered invalidated oauth token for user, failing request',
              type: null,
              code: 'token_revoked',
              param: null,
            },
            status: 401,
          }),
          { status: 401, headers: { 'content-type': 'text/plain' } },
        ),
    )
    await expect(run()).rejects.toThrow(/401: token_revoked/)
    const record = await s.credentials.get(chosen)
    expect(record?.status).toBe('attention')
    expect(record?.statusReason).toMatch(/token_revoked/)
  })

  it('an admission refusal shows its detail text', async () => {
    const { run, s, chosen } = await setup(() =>
      Response.json({ detail: 'System messages are not allowed' }, { status: 400 }),
    )
    await expect(run()).rejects.toThrow(/400: System messages are not allowed/)
    expect((await s.credentials.get(chosen))?.status).toBe('ok')
  })
})
