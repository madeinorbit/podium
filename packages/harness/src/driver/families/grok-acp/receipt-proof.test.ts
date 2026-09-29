/** Receipt proof from the Grok 1.0.44 frames measured in POD-4837. */
import type { HarnessRef, SessionId, TranscriptItemRef } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { AgentSessionHandle } from '../../driver.js'
import type { SessionSpec } from '../../session-spec.js'
import { createMemoryDriverSlots } from '../../testing/index.js'
import promptAck from './__fixtures__/prompt-ack.json' with { type: 'json' }
import type { GrokAcpTransport } from './client.js'
import { GrokAcpFrame, parseGrokAcpSessionUpdate } from './protocol.js'
import { createGrokAcpRuntime, type GrokAcpRuntimeHost } from './runtime.js'

type Frame = GrokAcpFrame
type Scenario = keyof typeof promptAck.scenarios

function scenario(name: Scenario): { frames: Frame[]; recorded: Frame[] } {
  const measured = promptAck.scenarios[name] as unknown as {
    frames: { dir: string; frame?: unknown }[]
    recordedUpdates: unknown[]
  }
  return {
    frames: measured.frames.filter((entry) => entry.dir === 'in' && entry.frame)
      .map((entry) => GrokAcpFrame.parse(entry.frame)),
    recorded: measured.recordedUpdates.map((frame) => GrokAcpFrame.parse(frame)),
  }
}

const updateKind = (frame: Frame): string | undefined =>
  parseGrokAcpSessionUpdate(frame)?.params.update.sessionUpdate as string | undefined

const spec: SessionSpec = {
  harness: 'grok',
  selection: {
    auth: 'subscription', platform: 'linux', available: ['grok-acp'], preference: 'grok-acp',
  },
  workdir: '/tmp/grok-receipt-proof',
  model: {},
  instructions: { supported: false, reason: 'fixture' },
  mcpServers: { supported: false, reason: 'fixture' },
}

/** The live pipe and updates.jsonl advance independently, as on the real CLI. */
function world(grokSessionId: string) {
  let handler: Parameters<GrokAcpTransport['onLine']>[0] | undefined
  let history = ''
  let reads = 0
  let readable = true
  const prompts: Frame[] = []
  const receive = (frame: Frame): void => {
    const inbound = frame.method === undefined && prompts.length > 0
      ? { ...frame, id: prompts.at(-1)!.id }
      : frame
    handler?.line(JSON.stringify(inbound))
  }
  const host: GrokAcpRuntimeHost = {
    now: () => Date.now(),
    mintSessionId: () => 'grok-receipt-proof' as SessionId,
    nativeArchivePollMs: 1,
    bindings: { recorded: () => undefined, bound() {}, released() {} },
    async launch() {
      return {
        process: { key: 'grok-receipt-proof' },
        alive: () => true,
        async stop() {},
        async kill() {},
        resources: () => undefined,
        transport: {
          onLine(next) { handler = next },
          close() {},
          write(line) {
            const request = GrokAcpFrame.parse(JSON.parse(line))
            if (request.method === 'session/prompt') {
              prompts.push(request)
              return
            }
            if (request.method === 'session/load') {
              for (const record of history.trim().split('\n').filter(Boolean)) {
                receive(GrokAcpFrame.parse(JSON.parse(record)))
              }
            }
            receive({
              jsonrpc: '2.0', id: request.id,
              result: request.method === 'initialize'
                ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
                : { sessionId: grokSessionId },
            })
          },
        },
      }
    },
    async readNativeUpdates({ offset }) {
      reads += 1
      if (!readable) throw new Error('temporarily unreadable')
      const bytes = new TextEncoder().encode(history)
      const start = bytes.length < offset ? 0 : offset
      return { offset: start, bytes: bytes.subarray(start) }
    },
  }
  const runtime = createGrokAcpRuntime(host, createMemoryDriverSlots())
  return {
    runtime, receive, prompts,
    readCount: () => reads,
    readable: (value: boolean) => { readable = value },
    append: (...frames: Frame[]) => { history += frames.map((frame) => JSON.stringify(frame) + '\n').join('') },
    appendBytes: (bytes: string) => { history += bytes },
    async create() { return runtime.driver.create(spec) },
  }
}

function prompt(name: Scenario, promptId: string) {
  const measured = promptAck.scenarios[name] as unknown as { frames: { frame?: Frame }[] }
  const request = measured.frames.map((entry) => entry.frame).find((frame) =>
    frame?.method === 'session/prompt' &&
    (frame.params as { _meta?: { promptId?: string } })._meta?.promptId === promptId,
  )!
  return request.params as { sessionId: string; prompt: { text: string }[] }
}

async function send(handle: AgentSessionHandle, w: ReturnType<typeof world>, name: Scenario, id: string) {
  const request = prompt(name, id)
  const named: { item: TranscriptItemRef; harnessRef?: HarnessRef }[] = []
  const unrecorded: string[] = []
  const sent = handle.send({ id, text: request.prompt[0]!.text }, {
    origin: 'human', delivery: 'when-ready',
    onTranscriptItem: (item, harnessRef) => { named.push({ item, harnessRef }) },
    onUnrecorded: (reason) => { unrecorded.push(reason) },
  })
  await expect.poll(() => w.prompts.length).toBeGreaterThan(0)
  return { sent, named, unrecorded }
}

describe('Grok ACP confirms only from its recorded prompt', () => {
  const allowed = scenario('userPromptSubmitHook')
  const allowedId = 'podmsg-H'
  const allowedRequest = prompt('userPromptSubmitHook', allowedId)
  const queueAck = allowed.frames.find((frame) => frame.method === '_x.ai/queue/changed')!
  const hook = allowed.frames.find((frame) => updateKind(frame) === 'hook_execution')!
  const output = allowed.frames.find((frame) => updateKind(frame) === 'agent_message_chunk')!
  const chunk = allowed.recorded.find((frame) => updateKind(frame) === 'user_message_chunk')!
  const stamp = allowed.recorded.find((frame) => updateKind(frame) === 'agent_message_chunk')!

  it('returns accepted, held in memory, when the queue ack names our id', async () => {
    const w = world(allowedRequest.sessionId)
    try {
      const handle = await w.create()
      const result = await send(handle, w, 'userPromptSubmitHook', allowedId)
      w.receive(queueAck)
      await expect(result.sent).resolves.toMatchObject({
        outcome: 'accepted', held: 'memory', provenBy: 'protocol-ack',
        harnessRef: [{ kind: 'grok-prompt', id: allowedId }],
      })
      expect(result.named).toEqual([])
    } finally { w.runtime.dispose() }
  })

  it.each([['an allowing hook', hook], ['the first live output', output]] as const)(
    'does not confirm from %s without a user record', async (_label, frame) => {
      const w = world(allowedRequest.sessionId)
      try {
        const handle = await w.create()
        const result = await send(handle, w, 'userPromptSubmitHook', allowedId)
        w.receive(queueAck)
        await result.sent
        w.receive(frame)
        expect(result.named).toEqual([])
        expect((await handle.transcript.history({ limit: 100 })).items.filter((item) => item.role === 'user')).toEqual([])
      } finally { w.runtime.dispose() }
    },
  )

  it('binds the file chunk to its following stamped record, even if that update was already seen live', async () => {
    const w = world(allowedRequest.sessionId)
    try {
      const handle = await w.create()
      const result = await send(handle, w, 'userPromptSubmitHook', allowedId)
      w.receive(queueAck)
      await result.sent
      w.receive(stamp)
      expect(result.named).toEqual([])
      w.append(chunk)
      const before = w.readCount()
      await expect.poll(w.readCount).toBeGreaterThan(before)
      expect(result.named).toEqual([])
      w.append(stamp)
      await expect.poll(() => result.named).toEqual([{
        item: { id: `grok-user-${allowedId}` },
        harnessRef: [{ kind: 'grok-prompt', id: allowedId }],
      }])
      expect((await handle.transcript.history({ limit: 100 })).items).toContainEqual(expect.objectContaining({
        role: 'user', id: `grok-user-${allowedId}`, text: 'hotel eight',
      }))
      w.receive(stamp)
      expect(result.named).toHaveLength(1)
    } finally { w.runtime.dispose() }
  })

  it('retains a partial file line across polls', async () => {
    const w = world(allowedRequest.sessionId)
    try {
      const handle = await w.create()
      const result = await send(handle, w, 'userPromptSubmitHook', allowedId)
      w.receive(queueAck)
      await result.sent
      const line = JSON.stringify(chunk)
      w.appendBytes(line.slice(0, line.length - 8))
      const before = w.readCount()
      await expect.poll(w.readCount).toBeGreaterThan(before)
      expect(result.named).toEqual([])
      w.appendBytes(line.slice(-8) + '\n')
      w.append(stamp)
      await expect.poll(() => result.named.length).toBe(1)
    } finally { w.runtime.dispose() }
  })

  it('confirms the measured 402 turn from its chunk and turn_completed, before any model output', async () => {
    const failed = scenario('providerFailure')
    const id = 'podmsg-K'
    const w = world(prompt('providerFailure', id).sessionId)
    try {
      const handle = await w.create()
      const result = await send(handle, w, 'providerFailure', id)
      w.receive(failed.frames.find((frame) => frame.method === '_x.ai/queue/changed')!)
      await result.sent
      // The provider reply cannot substitute for the file; a read failure keeps the watch open.
      w.readable(false)
      for (const frame of failed.frames.filter((frame) => frame.method !== '_x.ai/queue/changed')) w.receive(frame)
      expect(result.named).toEqual([])
      expect(result.unrecorded).toEqual([])
      w.append(...failed.recorded)
      w.readable(true)
      await expect.poll(() => result.named).toEqual([{
        item: { id: `grok-user-${id}` }, harnessRef: [{ kind: 'grok-prompt', id }],
      }])
      expect(result.unrecorded).toEqual([])
    } finally { w.runtime.dispose() }
  })

  it('reports the measured HookDenied for our prompt once, without naming an entry', async () => {
    const deniedId = 'podmsg-I'
    const w = world(prompt('userPromptSubmitHook', deniedId).sessionId)
    const denied = allowed.frames.filter((frame) => {
      const params = frame.params as { entries?: { id: string }[]; runningPromptId?: string } | undefined
      const parsed = parseGrokAcpSessionUpdate(frame)
      return params?.entries?.some((entry) => entry.id === deniedId) || params?.runningPromptId === deniedId ||
        parsed?.params.update.prompt_id === deniedId
    })
    try {
      const handle = await w.create()
      const result = await send(handle, w, 'userPromptSubmitHook', deniedId)
      for (const frame of denied) w.receive(frame)
      await result.sent
      expect(result.unrecorded).toEqual(['dropped by a Grok hook'])
      expect(result.named).toEqual([])
      w.receive(denied.at(-1)!)
      expect(result.unrecorded).toHaveLength(1)
    } finally { w.runtime.dispose() }
  })

  it('does not attribute a HookDenied from another prompt to ours', async () => {
    const w = world(allowedRequest.sessionId)
    try {
      const handle = await w.create()
      const result = await send(handle, w, 'userPromptSubmitHook', allowedId)
      w.receive(queueAck)
      await result.sent
      w.receive(allowed.frames.find((frame) => updateKind(frame) === 'turn_completed' &&
        parseGrokAcpSessionUpdate(frame)?.params.update.prompt_id === 'podmsg-I')!)
      expect(result.unrecorded).toEqual([])
      expect(result.named).toEqual([])
    } finally { w.runtime.dispose() }
  })

  it('ignores an identical text recorded for a different turn', async () => {
    const w = world(allowedRequest.sessionId)
    try {
      const handle = await w.create()
      const result = await send(handle, w, 'userPromptSubmitHook', allowedId)
      w.receive(queueAck)
      await result.sent
      const foreign = JSON.parse(JSON.stringify(stamp)) as Frame
      ;(foreign.params as { _meta: { promptId: string } })._meta.promptId = 'foreign-turn'
      w.append(chunk, foreign)
      const before = w.readCount()
      await expect.poll(w.readCount).toBeGreaterThan(before)
      expect(result.named).toEqual([])
    } finally { w.runtime.dispose() }
  })

  it('does not resend the same id when the file already holds its recorded prompt', async () => {
    const w = world(allowedRequest.sessionId)
    try {
      const handle = await w.create()
      w.append(chunk, stamp)
      const sent = handle.send({ id: allowedId, text: 'hotel eight' }, { origin: 'human', delivery: 'when-ready' })
      // If a broken driver writes a duplicate, let the test finish with evidence of that write.
      await expect.poll(() => w.readCount() + w.prompts.length).toBeGreaterThan(0)
      if (w.prompts.length) w.receive(queueAck)
      await expect(sent).resolves.toMatchObject({
        outcome: 'accepted', provenBy: 'transcript-echo', transcriptItem: { id: `grok-user-${allowedId}` },
      })
      expect(w.prompts).toEqual([])
    } finally { w.runtime.dispose() }
  })
})
