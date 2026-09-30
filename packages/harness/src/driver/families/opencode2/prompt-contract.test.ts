import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { DriverId } from '../../../manifest.js'
import { AGENT_MANIFESTS } from '../../../registry.js'
import { createOpencodeClient } from '../opencode/client.js'
import {
  evaluateOpencode2VersionProbe,
  evaluateOpencodeVersionProbe,
} from '../opencode/engine-host.js'
import { createOpencode2Client } from './client.js'

// Real HTTP requests and replies measured on 2026-09-29 (POD-4864).
interface Frame<T = unknown> {
  kind: string
  label: string
  method: string
  path: string
  status: number
  body: T
}

function measured(lane: string): Frame[] {
  return readFileSync(
    new URL(
      `../../../../../../docs/measurements/pod-4834-receipt-proof/opencode-1.18.33/${lane}/timeline.jsonl`,
      import.meta.url,
    ),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Frame)
}

const stable = measured('v2')
const beta = measured('v2-beta-18866')
const v1 = measured('v1')

function frame<T = unknown>(timeline: Frame[], kind: string, label: string): Frame<T> {
  const found = timeline.find((entry) => entry.kind === kind && entry.label === label)
  if (!found) throw new Error(`Missing measured ${kind} ${label}`)
  return found as Frame<T>
}

interface PromptBody {
  id: string
  text?: string
  prompt?: { text: string }
  delivery: string
}

function inputFor(send: Frame<PromptBody>) {
  const text = send.body.text ?? send.body.prompt?.text
  if (text === undefined) throw new Error('Missing measured prompt text')
  return { messageID: send.body.id, parts: [{ type: 'text' as const, text }] }
}

function sessionFor(send: Frame): string {
  const sessionId = send.path.split('/')[3]
  if (!sessionId) throw new Error('Missing measured v2 session id')
  return sessionId
}

function response(reply: Frame): Response {
  return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json' },
  })
}

function config(fetch: typeof globalThis.fetch) {
  return {
    baseUrl: 'http://127.0.0.1:41427',
    username: 'opencode',
    password: 'secret',
    directory: '/repo',
    fetch,
  }
}

describe('OpenCode version selects the request contract', () => {
  it.each([
    ['1.18.0', 'opencode-server'],
    ['1.18.33', 'opencode-server'],
    ['1.19.0', 'opencode-server'],
    ['0.0.0-beta-18743', 'opencode2-server'],
    ['0.0.0-beta-18866', 'opencode2-server'],
    ['0.0.0-beta-18867', 'generic-pty'],
  ] as const)('routes %s to %s, including an explicit v2 preference', (version, driver) => {
    const available: DriverId[] = ['generic-pty']
    if (evaluateOpencodeVersionProbe(version, true).drivable) available.push('opencode-server')
    if (evaluateOpencode2VersionProbe(version, true).drivable) available.push('opencode2-server')
    expect(
      AGENT_MANIFESTS.opencode.runtime.select({
        auth: 'api-key',
        platform: 'linux',
        available,
        preference: 'opencode2-server',
      }),
    ).toBe(driver)
  })

  it.each([
    '0.0.0-beta-18866-dev',
    '0.0.0-beta-188660',
    '1.18.33\n0.0.0-beta-18866',
  ])('does not admit a preview substring in %s', (version) => {
    expect(evaluateOpencode2VersionProbe(version, true).drivable).toBe(false)
  })

  it.each([
    '0.0.0-beta-18743',
    '0.0.0-beta-18866',
  ])('does not admit %s from a failed probe', (version) => {
    expect(evaluateOpencode2VersionProbe(version, false)).toMatchObject({
      drivable: false,
      reason: 'unprobeable',
    })
  })

  it('prefers stable v1 when stable and preview binaries are both available', () => {
    expect(
      AGENT_MANIFESTS.opencode.runtime.select({
        auth: 'api-key',
        platform: 'linux',
        available: ['opencode-server', 'opencode2-server', 'generic-pty'],
      }),
    ).toBe('opencode-server')
  })

  it('keeps 1.18.33 on its measured v1 request, carrying both sender ids', async () => {
    const send = frame<{ messageID: string; parts: [{ type: 'text'; text: string; id: string }] }>(
      v1,
      'http.send',
      'S1w',
    )
    const reply = frame(v1, 'http.reply', 'S1w')
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(send.path)
      expect(init?.method).toBe(send.method)
      expect(JSON.parse(String(init?.body))).toEqual(send.body)
      return response(reply)
    })
    const sessionId = send.path.split('/')[2]
    if (!sessionId) throw new Error('Missing measured v1 session id')
    await expect(createOpencodeClient(config(fetch)).prompt(sessionId, send.body)).resolves.toEqual(
      {},
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('excludes stable v2 even though its nested prompt shape was accepted', () => {
    const send = frame<PromptBody>(stable, 'http.send', 'S1')
    const reply = frame<{ data: { id: string; prompt: { text: string } } }>(
      stable,
      'http.reply',
      'S1',
    )
    expect(send.body).toEqual({
      id: reply.body.data.id,
      prompt: { text: 'V2S1 ALPHA idle queue' },
      delivery: 'queue',
    })
    expect(reply.status).toBe(200)
    expect(reply.body.data.prompt).toEqual(send.body.prompt)
    expect(evaluateOpencode2VersionProbe('1.18.33', true)).toMatchObject({
      drivable: false,
      reason: 'unsupported',
    })
  })
})

describe('OpenCode measured v2 wire frames', () => {
  it.each([
    'S1',
    'S5a.1',
    'S5a.2',
    'S5d.2',
    'S5e.2',
  ])('sends the accepted beta-18866 body and sender id for %s', async (label) => {
    const send = frame<PromptBody>(beta, 'http.send', label)
    const reply = frame(beta, 'http.reply', label)
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(send.path)
      expect(init?.method).toBe(send.method)
      expect(JSON.parse(String(init?.body))).toEqual(send.body)
      return response(reply)
    })
    await expect(
      createOpencode2Client(config(fetch)).prompt(sessionFor(send), inputFor(send)),
    ).resolves.toEqual({ held: 'durable' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('replays stable 400 Missing key prompt for the preview shape without a lookup', async () => {
    const send = frame<PromptBody>(stable, 'http.send', 'S10.othershape')
    const reply = frame<{ message: string }>(stable, 'http.reply', 'S10.othershape')
    expect(reply.body.message).toBe('Missing key\n  at ["prompt"]')
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual(send.body)
      return response(reply)
    })
    await expect(
      createOpencode2Client(config(fetch)).prompt(sessionFor(send), inputFor(send)),
    ).rejects.toMatchObject({ name: 'OpencodeHttpError', status: 400 })
    expect(fetch).toHaveBeenCalledOnce()
    expect(evaluateOpencode2VersionProbe('1.18.33', true).drivable).toBe(false)
  })

  it('resolves stable same-session 409 only from the original user history record', async () => {
    const send = frame<PromptBody>(stable, 'http.send', 'S5d.2')
    const conflict = frame(stable, 'http.reply', 'S5d.2')
    const history = frame(stable, 'http.reply', 'S5d.after')
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === 'POST') return response(conflict)
      expect(new URL(String(url)).pathname).toBe(history.path.split('?')[0])
      if (new URL(String(url)).searchParams.has('cursor')) {
        return new Response(JSON.stringify({ data: [], cursor: { next: null } }))
      }
      return response(history)
    })
    await expect(
      createOpencode2Client(config(fetch)).prompt(sessionFor(send), inputFor(send)),
    ).resolves.toEqual({ textPartId: `${send.body.id}:0` })
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'GET')).toBe(true)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it.each([
    ['1.18.33', stable],
    ['beta-18866', beta],
  ] as const)('leaves %s cross-session 409 unproven after a scoped lookup', async (_version, timeline) => {
    const send = frame<PromptBody>(timeline, 'http.send', 'S5f.cross')
    const conflict = frame(timeline, 'http.reply', 'S5f.cross')
    const history = frame(timeline, 'http.reply', 'S5f.other-after')
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      if (init?.method === 'POST') return response(conflict)
      expect(new URL(String(url)).pathname).toBe(history.path.split('?')[0])
      return response(history)
    })
    await expect(
      createOpencode2Client(config(fetch)).prompt(sessionFor(send), inputFor(send)),
    ).rejects.toMatchObject({ name: 'OpencodeHttpError', status: 409 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    400, 404, 500,
  ])('preserves the original 409 when the lookup answers %s', async (status) => {
    const send = frame<PromptBody>(beta, 'http.send', 'S5f.cross')
    const conflict = frame(beta, 'http.reply', 'S5f.cross')
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === 'POST'
        ? response(conflict)
        : new Response(JSON.stringify({ error: 'lookup failed' }), { status }),
    )
    await expect(
      createOpencode2Client(config(fetch)).prompt(sessionFor(send), inputFor(send)),
    ).rejects.toMatchObject({ name: 'OpencodeHttpError', status: 409 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    { type: 'user' },
    { type: 'assistant', content: [{ type: 'text', text: 'assistant output' }] },
    { type: 'user', id: 'msg_other', text: 'another prompt' },
  ])('never credits a 409 from an unrelated or text-less history row: %j', async (row) => {
    const send = frame<PromptBody>(beta, 'http.send', 'S5f.cross')
    const conflict = frame(beta, 'http.reply', 'S5f.cross')
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
      init?.method === 'POST'
        ? response(conflict)
        : new Response(JSON.stringify({ data: [{ id: send.body.id, ...row }] })),
    )
    await expect(
      createOpencode2Client(config(fetch)).prompt(sessionFor(send), inputFor(send)),
    ).rejects.toMatchObject({ name: 'OpencodeHttpError', status: 409 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not credit a 200 admission naming a different message id', async () => {
    const send = frame<PromptBody>(beta, 'http.send', 'S1')
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ data: { id: 'msg_other', sessionID: sessionFor(send) } })),
    )
    await expect(
      createOpencode2Client(config(fetch)).prompt(sessionFor(send), inputFor(send)),
    ).rejects.toThrow(/did not admit/)
  })
})
