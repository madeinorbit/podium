import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEvent, SessionSpec } from '../../host.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import type { OpencodeClient } from '../opencode/client.js'
import { deltaItemIdForPart } from '../opencode/map.js'
import { createOpencodeRuntime, type OpencodeRuntimeHost } from '../opencode/runtime.js'
import { createOpencode2Client } from './client.js'

type Frame = {
  kind: string
  label?: string
  status?: number
  path?: string
  body?: { id?: string; text?: string; prompt?: { text: string }; data?: unknown }
  frame?: {
    id: string
    type: string
    data: { sessionID?: string; messageID?: string; inboxID?: string }
  }
  table?: string
  change?: string
  row?: {
    id: string
    s?: string
    session_id?: string
    p?: number | null
    type?: string
    data?: Record<string, unknown>
  }
}

// Recorded on the real CLIs, 2026-09-29 (POD-4864). Stable stays on the v1
// production route; its v2 replies/events are replayed here as receipt evidence.
function measured(lane: string, file = 'timeline.jsonl'): Frame[] {
  return readFileSync(
    new URL(
      `../../../../../../docs/measurements/pod-4834-receipt-proof/opencode-1.18.33/${lane}/${file}`,
      import.meta.url,
    ),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function frame(timeline: Frame[], kind: string, label: string): Frame {
  const found = timeline.find((entry) => entry.kind === kind && entry.label === label)
  if (!found) throw new Error(`Missing measured ${kind} ${label}`)
  return found
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const options = { origin: 'human', delivery: 'when-ready' } as const
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
})

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

async function fixture(lane: string, label = 'S1', file?: string) {
  const timeline = measured(lane, file)
  const send = frame(timeline, 'http.send', label)
  const reply = frame(timeline, 'http.reply', label)
  const sessionID = send.path!.split('/')[3]!
  const messageID = send.body!.id as string
  const text = (send.body!.text ?? send.body!.prompt?.text) as string
  const directory = mkdtempSync(join(tmpdir(), 'opencode-admission-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const databasePath = join(directory, 'opencode.db')
  const db = openDatabase(databasePath)
  cleanups.push(() => db.close())
  if (lane === 'v2') {
    db.exec('CREATE TABLE session_input (id TEXT, session_id TEXT, promoted_seq INTEGER)')
  } else {
    db.exec('CREATE TABLE session_inbox (id TEXT, session_id TEXT, type TEXT)')
  }
  const table = lane === 'v2' ? 'session_input' : 'session_inbox'
  const pending = () => {
    const row = timeline.find((entry) => entry.table === table && entry.row?.id === messageID)?.row
    if (!row) throw new Error('Missing measured pending row')
    db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(
      row.id,
      (row.session_id ?? row.s)!,
      lane === 'v2' ? (row.p ?? null) : row.type!,
    )
  }
  let history: unknown[] = []
  let promptReply = reply
  let dead = false
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (dead) throw new TypeError('fetch failed: connection refused')
    const path = new URL(String(url)).pathname
    if (path === '/api/event') {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller)
            init?.signal?.addEventListener(
              'abort',
              () => {
                streams.delete(controller)
                controller.close()
              },
              { once: true },
            )
          },
        }),
      )
    }
    if (path.endsWith('/prompt')) return json(promptReply.body, promptReply.status)
    if (path.endsWith('/message')) return json({ data: history, cursor: { next: null } })
    if (path.endsWith('/permission') || path.endsWith('/form')) return json({ data: [] })
    return json({ data: { id: sessionID } })
  })
  let client: OpencodeClient
  const readHistoryAfterExit = vi.fn(() => [])
  const host: OpencodeRuntimeHost = {
    driverId: 'opencode2-server',
    launch: async () => ({
      baseUrl: 'http://127.0.0.1:41427',
      username: 'opencode',
      password: 'fixture',
      process: { key: 'fixture-opencode' },
      stop: async () => {},
      kill: async () => {},
      resources: () => undefined,
      engineExit: () => dead ? { code: 0, signal: 9 } : undefined,
      readHistoryAfterExit,
    }),
    adopt: async () => undefined,
    stageAttachment: async () => {
      throw new Error('No attachments in the measured lane')
    },
    attachClient: async () => undefined,
    bindings: { recorded: () => undefined, bound: () => {}, released: () => {} },
    makeClient: (config) => (client = createOpencode2Client({ ...config, fetch, databasePath })),
    randomSecret: () => 'fixture',
    mintSessionId: () => 'fixture' as SessionId,
    now: () => Date.now(),
  }
  const runtime = createOpencodeRuntime(host, createMemoryDriverSlots())
  cleanups.push(() => runtime.dispose())
  const spec: SessionSpec = {
    harness: 'opencode',
    selection: { auth: 'api-key', platform: 'linux', available: ['opencode2-server'] },
    workdir: directory,
    model: {},
    instructions: { supported: false, reason: 'fixture' },
    mcpServers: { supported: false, reason: 'fixture' },
  }
  const handle = await runtime.driver.create(spec)
  const events: RuntimeEvent[] = []
  void (async () => {
    for await (const event of handle.events('bootstrap')) events.push(event)
  })()
  const emit = (type: string, id = messageID, sid = sessionID) => {
    const recorded = timeline.find(
      (entry) =>
        entry.kind === 'sse' &&
        entry.label === 'api-event' &&
        entry.frame?.type === type &&
        (entry.frame.data.messageID ?? entry.frame.data.inboxID) === messageID,
    )?.frame
    const event = recorded
      ? structuredClone(recorded)
      : {
          id: `fixture-${type}`,
          type,
          data: { sessionID: sid },
        }
    event.data.sessionID = sid
    if ('messageID' in event.data) event.data.messageID = id
    if ('inboxID' in event.data) event.data.inboxID = id
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    for (const controller of streams) controller.enqueue(bytes)
  }
  const promote = () => {
    const row = timeline.find(
      (entry) =>
        entry.table === 'session_message' &&
        entry.change === 'insert' &&
        entry.row?.id === messageID,
    )?.row
    if (!row) throw new Error('Missing measured user row')
    history = [{ id: row.id, type: row.type, ...row.data }]
    if (lane === 'v2')
      db.prepare('UPDATE session_input SET promoted_seq = 2 WHERE id = ?').run(messageID)
    else db.prepare('DELETE FROM session_inbox WHERE id = ?').run(messageID)
  }
  const deliveries = () => events.filter((event) => event.t === 'delivery')
  const prompts = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/prompt'))
  return {
    handle,
    events,
    deliveries,
    fetch,
    readHistoryAfterExit,
    prompts,
    emit,
    promote,
    pending,
    sessionID,
    messageID,
    text,
    timeline,
    input: { id: messageID, text },
    entry: deltaItemIdForPart(sessionID, `${messageID}:0`),
    setReply: (value: Frame) => {
      promptReply = value
    },
    setHistory: (value: unknown[]) => {
      history = value
    },
    pendingIds: () => client.pendingPrompts!(sessionID),
    /** The server process is gone: the stream ends and nothing answers. */
    die: () => {
      dead = true
      for (const controller of streams) controller.close()
      streams.clear()
    },
    newOwner: () => runtime.driver.resume({ kind: 'opencode-session', value: sessionID }, spec),
  }
}

describe.each([
  ['1.18.33', 'v2', 'session.next.prompt.admitted', 'session.next.prompted'],
  ['beta-18866', 'v2-beta-18866', 'session.inbox.enqueued', 'session.inbox.delivered'],
])('OpenCode %s durable receipts', (_build, lane, admitted, promoted) => {
  it('accepts the 200 durably without inventing a conversation entry', async () => {
    const f = await fixture(lane)
    f.pending()
    expect(await f.pendingIds()).toEqual([f.messageID])
    const receipt = await f.handle.send(f.input, options)
    expect(receipt).toMatchObject({ outcome: 'accepted', held: 'durable' })
    expect(receipt).not.toHaveProperty('transcriptItem')
    expect(receipt).toMatchObject({
      harnessRef: expect.arrayContaining([{ kind: 'opencode-message', id: f.messageID }]),
    })
    f.emit(admitted)
    await flush()
    expect(f.deliveries().filter((event) => event.outcome === 'delivered')).toEqual([])
  })

  it('confirms only the promoted user row, matching our id and naming its entry once', async () => {
    const f = await fixture(lane)
    f.pending()
    await f.handle.send({ ...f.input, rowId: f.messageID }, options)
    await flush()
    expect(f.deliveries()).toMatchObject([{ outcome: 'accepted', held: 'durable' }])
    f.emit(promoted, 'msg_other')
    f.emit(promoted, f.messageID, 'ses_other')
    f.setHistory([
      { id: f.messageID, type: 'user' },
      { id: 'msg_other', type: 'user', text: f.text },
      { id: f.messageID, type: 'assistant', content: [{ type: 'text', text: f.text }] },
    ])
    f.emit(promoted) // The row is still unavailable: no guessed confirmation.
    await flush()
    expect(f.deliveries()).toHaveLength(1)
    f.promote()
    expect(await f.pendingIds()).toEqual([])
    f.emit(promoted)
    await flush()
    expect(f.deliveries()).toMatchObject([
      { outcome: 'accepted', held: 'durable' },
      { outcome: 'delivered', transcriptItem: { id: f.entry } },
    ])
    f.emit(promoted)
    await flush()
    expect(f.deliveries()).toHaveLength(2)
    expect(
      (await f.handle.transcript.history({ limit: 200 })).items.some((item) => item.id === f.entry),
    ).toBe(true)
  })

  it('keeps a held row accepted across an interrupt and a long idle window', async () => {
    vi.useFakeTimers()
    const f = await fixture(lane, 'S6b.B')
    f.pending()
    await f.handle.send({ ...f.input, rowId: f.messageID }, options)
    await flush()
    f.emit('session.execution.interrupted')
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(f.deliveries()).toMatchObject([{ outcome: 'accepted', held: 'durable' }])
    f.promote()
    f.emit(promoted)
    await flush()
    expect(f.deliveries().at(-1)).toMatchObject({
      outcome: 'delivered',
      transcriptItem: { id: f.entry },
    })
  })

  it('rechecks the pending admission after a kill, without resending it', async () => {
    const recovery =
      lane === 'v2' ? 'timeline-pending-repeat-and-recovery.jsonl' : 'timeline-recovery.jsonl'
    const f = await fixture(lane, 'S6e.1', recovery)
    f.pending()
    await f.handle.send({ ...f.input, rowId: f.messageID }, options)
    await flush()
    await f.handle.kill()
    const owner = await f.newOwner()
    const observed: RuntimeEvent[] = []
    void (async () => {
      for await (const event of owner.events('bootstrap')) observed.push(event)
    })()
    await owner.send(
      { ...f.input, rowId: f.messageID, deliveryRecovery: true, held: 'durable' },
      options,
    )
    await flush()
    expect(f.prompts()).toHaveLength(1)
    expect(observed.filter((event) => event.t === 'delivery')).toEqual([])
    f.promote()
    f.emit(promoted)
    await flush()
    expect(observed.filter((event) => event.t === 'delivery')).toMatchObject([
      { outcome: 'delivered', transcriptItem: { id: f.entry } },
    ])
    expect(f.prompts()).toHaveLength(1)
  })

  it('finds promotion missed while the daemon was down, without a resend or live event', async () => {
    const f = await fixture(lane)
    f.pending()
    await f.handle.send({ ...f.input, rowId: f.messageID }, options)
    await flush()
    await f.handle.kill()
    f.promote()
    const owner = await f.newOwner()
    const observed: RuntimeEvent[] = []
    void (async () => {
      for await (const event of owner.events('bootstrap')) observed.push(event)
    })()
    await owner.send(
      { ...f.input, rowId: f.messageID, deliveryRecovery: true, held: 'durable' },
      options,
    )
    await flush()
    expect(observed.filter((event) => event.t === 'delivery')).toMatchObject([
      { outcome: 'delivered', transcriptItem: { id: f.entry } },
    ])
    expect(f.prompts()).toHaveLength(1)
  })

  /**
   * AN ADMISSION OUTLIVES ITS PROCESS (POD-4887; POD-4819 §4, §6.1 N4). Measured
   * (POD-4864, S6e): a v2 admission survives a SIGKILL, pending and unrun, and
   * a resend under the same id starts it. So the exit of the server, however
   * observed, never proves it is not in the conversation: no `failed`.
   */
  it('an observed server exit never fails a pending admission', async () => {
    vi.useFakeTimers()
    const f = await fixture(lane)
    f.pending()
    await f.handle.send({ ...f.input, rowId: f.messageID }, options)
    await flush()
    f.die()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.events.some((event) => event.t === 'process' && event.ev.ev === 'exited')).toBe(true)
    expect(f.deliveries()).toMatchObject([{ outcome: 'accepted', held: 'durable' }])
    expect(f.readHistoryAfterExit).not.toHaveBeenCalled()
  })

  it('rechecks history when the promotion event is lost', async () => {
    vi.useFakeTimers()
    const f = await fixture(lane)
    await f.handle.send({ ...f.input, rowId: f.messageID }, options)
    await flush()
    f.promote()
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.deliveries()).toMatchObject([
      { outcome: 'accepted', held: 'durable' },
      { outcome: 'delivered', transcriptItem: { id: f.entry } },
    ])
    expect(f.prompts()).toHaveLength(1)
  })

  it('an explicit resend keeps the same id and text and names the single original row', async () => {
    const f = await fixture(lane, 'S5a.1')
    const first = await f.handle.send(f.input, options)
    expect(first).toMatchObject({ held: 'durable' })
    f.emit('session.execution.succeeded')
    await flush()
    f.promote()
    f.setReply(frame(f.timeline, 'http.reply', 'S5a.2'))
    const repeat = await f.handle.send(f.input, options)
    expect(repeat).toMatchObject({ outcome: 'accepted' })
    await flush()
    expect(
      f
        .deliveries()
        .every((event) => event.outcome === 'delivered' && event.transcriptItem?.id === f.entry),
    ).toBe(true)
    expect(f.deliveries().length).toBeGreaterThan(0)
    const bodies = f.prompts().map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies).toEqual([bodies[0], bodies[0]])
    expect(bodies[0]).toMatchObject({ id: f.messageID, text: f.text })
  })

  it.each([
    'S10.baddelivery',
    'S10.nosession',
  ])('reports measured %s as failed/rejected-by-agent', async (label) => {
    const f = await fixture(lane, label)
    await f.handle.send({ ...f.input, rowId: f.messageID }, options)
    await flush()
    expect(f.deliveries()).toMatchObject([{ outcome: 'failed', cause: 'rejected-by-agent' }])
  })

  it('a cross-session 409 never becomes a definite failure', async () => {
    const f = await fixture(lane, 'S5f.cross')
    await f.handle.send({ ...f.input, rowId: f.messageID }, options)
    await flush()
    expect(
      f.deliveries().some((event) => event.outcome === 'failed' && event.cause !== 'unconfirmed'),
    ).toBe(false)
    expect(f.prompts()).toHaveLength(1)
  })
})

it('a stable pending different-text 409 is still accepted/durable', async () => {
  const f = await fixture('v2', 'S5e.2')
  f.pending()
  await expect(f.handle.send(f.input, options)).resolves.toMatchObject({
    outcome: 'accepted',
    held: 'durable',
  })
})

it('a stable delivered different-text 409 confirms the original user row', async () => {
  const f = await fixture('v2', 'S5d.2')
  const history = frame(f.timeline, 'http.reply', 'S5d.after')
  f.setHistory(history.body!.data as unknown[])
  await expect(f.handle.send(f.input, options)).resolves.toMatchObject({
    outcome: 'accepted',
    transcriptItem: { id: f.entry },
  })
})
