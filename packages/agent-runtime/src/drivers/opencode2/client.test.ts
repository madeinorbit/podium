import { describe, expect, it, vi } from 'vitest'
import { createOpencode2Client } from './client.js'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function makeClient(fetch: typeof globalThis.fetch, timeoutMs?: number) {
  return createOpencode2Client({
    baseUrl: 'http://127.0.0.1:41427',
    username: 'opencode',
    password: 'secret',
    directory: '/repo',
    fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

describe('OpenCode 2 client adapter', () => {
  it('configures and admits a prompt through the v2 session API', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ data: {} }))
    const client = makeClient(fetch)

    await client.prompt('ses_v2', {
      model: { providerID: 'openai', modelID: 'gpt-5' },
      agent: 'build',
      system: 'Stay focused.',
      variant: 'high',
      parts: [
        { type: 'text', text: 'Ship it' },
        { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'file:///tmp/notes.txt' },
      ],
    })

    expect(
      fetch.mock.calls.map(([url, init]) => [
        String(url),
        init?.method,
        init?.body && JSON.parse(String(init.body)),
      ]),
    ).toEqual([
      [
        'http://127.0.0.1:41427/api/session/ses_v2/model',
        'POST',
        { model: { providerID: 'openai', id: 'gpt-5', variant: 'high' } },
      ],
      ['http://127.0.0.1:41427/api/session/ses_v2/agent', 'POST', { agent: 'build' }],
      [
        'http://127.0.0.1:41427/api/session/ses_v2/instructions/entries/podium-system',
        'PUT',
        { value: 'Stay focused.' },
      ],
      [
        'http://127.0.0.1:41427/api/session/ses_v2/prompt',
        'POST',
        { text: 'Ship it', files: [{ uri: 'file:///tmp/notes.txt', name: 'notes.txt' }] },
      ],
    ])
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Basic b3BlbmNvZGU6c2VjcmV0',
    })
  })

  it('translates pending forms and replies with field-keyed v2 answers', async () => {
    const form = {
      id: 'frm_1',
      sessionID: 'ses_v2',
      title: 'Release',
      fields: [
        {
          key: 'channel',
          type: 'string',
          title: 'Channel',
          options: [{ value: 'stable', label: 'Stable', description: 'Production' }],
        },
        { key: 'notify', type: 'boolean', title: 'Notify users' },
        {
          key: 'regions',
          type: 'multiselect',
          title: 'Regions',
          options: [
            { value: 'eu', label: 'Europe' },
            { value: 'us', label: 'United States' },
          ],
        },
      ],
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/form') ? json({ data: [form] }) : json({ data: {} }),
    )
    const client = makeClient(fetch)
    await client.getSession('ses_v2').catch(() => undefined)

    await expect(client.questions()).resolves.toEqual([
      {
        id: 'frm_1',
        sessionID: 'ses_v2',
        questions: [
          {
            question: 'Channel',
            header: 'Release',
            options: [{ label: 'Stable', description: 'Production' }],
            multiple: false,
            custom: false,
          },
          {
            question: 'Notify users',
            header: 'Release',
            options: [{ label: 'Yes' }, { label: 'No' }],
            multiple: false,
            custom: false,
          },
          {
            question: 'Regions',
            header: 'Release',
            options: [{ label: 'Europe' }, { label: 'United States' }],
            multiple: true,
            custom: false,
          },
        ],
      },
    ])

    await client.replyQuestion('frm_1', [['Stable'], ['Yes'], ['Europe', 'United States']])
    const [, init] = fetch.mock.calls.at(-1) ?? []
    expect(init?.body && JSON.parse(String(init.body))).toEqual({
      answer: { channel: 'stable', notify: true, regions: ['eu', 'us'] },
    })
  })

  it('maps v2 message history into the shared OpenCode transcript shape', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).includes('cursor=next-page')
        ? json({
            data: [
              {
                id: 'msg_a',
                type: 'assistant',
                time: { created: 2, completed: 3 },
                model: { providerID: 'openai', id: 'gpt-5' },
                content: [{ type: 'text', text: 'Hi' }],
              },
            ],
            cursor: { next: null },
          })
        : json({
            data: [
              {
                id: 'msg_u',
                type: 'user',
                text: 'Hello',
                time: { created: 1 },
              },
            ],
            cursor: { next: 'next-page' },
          }),
    )

    await expect(makeClient(fetch).messages('ses_v2')).resolves.toMatchObject([
      {
        info: { id: 'msg_u', sessionID: 'ses_v2', role: 'user' },
        parts: [{ id: 'msg_u:0', messageID: 'msg_u', text: 'Hello' }],
      },
      {
        info: {
          id: 'msg_a',
          sessionID: 'ses_v2',
          role: 'assistant',
          providerID: 'openai',
          modelID: 'gpt-5',
        },
        parts: [{ id: 'msg_a:0', messageID: 'msg_a', text: 'Hi' }],
      },
    ])
    expect(String(fetch.mock.calls[0]?.[0])).toContain('order=asc&limit=200')
    expect(String(fetch.mock.calls[1]?.[0])).toContain('limit=200&cursor=next-page')
  })

  it('maps live v2 form creation into a shared question ask', async () => {
    const payload = {
      id: 'evt_1',
      created: 10,
      type: 'form.created',
      data: {
        form: {
          id: 'frm_live',
          sessionID: 'ses_v2',
          title: 'Confirm',
          fields: [{ key: 'choice', type: 'boolean', title: 'Proceed?' }],
        },
      },
    }
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(`data:not-json\n\ndata:${JSON.stringify(payload)}\n\n`),
    )
    const controller = new AbortController()
    const iterator = makeClient(fetch).events(controller.signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'question.asked',
        properties: {
          id: 'frm_live',
          sessionID: 'ses_v2',
          questions: [{ question: 'Proceed?', header: 'Confirm' }],
        },
      },
    })
    controller.abort()
    await iterator.return?.()
  })
  it('preserves v2 execution failure and interruption verdicts', async () => {
    const frames = [
      {
        id: 'evt_start',
        type: 'session.execution.started',
        data: { sessionID: 'ses_v2' },
      },
      {
        id: 'evt_fail',
        type: 'session.execution.failed',
        data: {
          sessionID: 'ses_v2',
          error: { type: 'provider.no-route', message: 'Model unavailable' },
        },
      },
      {
        id: 'evt_stop',
        type: 'session.execution.interrupted',
        data: { sessionID: 'ses_v2' },
      },
    ]
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')),
    )
    const iterator = makeClient(fetch).events(new AbortController().signal)[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'session.status',
        properties: { status: { type: 'busy' } },
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'session.error',
        properties: {
          error: { type: 'provider.no-route', message: 'Model unavailable' },
        },
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'session.error',
        properties: { error: { name: 'MessageAborted' } },
      },
    })
  })

  it('bounds a loopback request that never answers', async () => {
    let observed: AbortSignal | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          observed = init?.signal ?? undefined
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        }),
    )

    await expect(makeClient(fetch, 5).health()).resolves.toBe(false)
    expect(observed?.aborted).toBe(true)
  })
})
