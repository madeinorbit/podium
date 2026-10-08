/** POD-4984's real CLI records, not expected text derived from the matcher. */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asSessionId } from '@podium/model'
import { podiumFrameId } from '../../accept-correlation.js'
import { createTerminalRuntime, type TerminalHarnessProfile } from '../../driver/families/terminal/runtime.js'
import type { TerminalHostPorts, TerminalTransport } from '../../driver/families/terminal/host-ports.js'
import { createMemoryDriverSlots } from '../../driver/testing/driver-slots.js'
import { harnessInterrupt, harnessNeedsSubmitVerification, harnessUsesRawFirstTurn, manifestFor } from '../../registry.js'
import { stampOpencodeItems } from '../../store/sources/sqlite.js'
import { declaredValue, encodeCursor } from '../../transcript-types.js'
import { opencodePartToItems, opencodePromptTextMatches } from './transcript.js'

interface NativeRecord {
  label: string
  kind: string
  texts: string[]
  raw: {
    id: string
    message_id?: string
    session_id: string
    time_created: number
    time_updated: number
    data: string
  }
}

const evidenceRoot = new URL(
  '../../../../../docs/measurements/pod-4834-receipt-proof/expanded-input/', import.meta.url,
)
// Literal submitted bytes and frame ids from the measurement's matrix.ts.
const inputs = {
  tabs: { body: 'P4984-tabs\tmiddle\tindented\tEND-tabs', id: 'msg_54e39917-0723-4000-8000-1decc0ae1649' },
  crlf: { body: 'P4984-crlf line-1\r\nP4984-crlf line-2\r\nP4984-crlf END', id: 'msg_cb4f2ef3-3b5f-4000-8000-e1088a26b8bd' },
  'trailing-lf': { body: 'P4984-trailing-lf first\nP4984-trailing-lf END\n', id: 'msg_5c9dbf33-f40f-4000-8000-cf483c4f2404' },
}
function measurements(lane: string) {
  const records = readFileSync(new URL(`${lane}/native-records.jsonl`, evidenceRoot), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as NativeRecord)
  return records.filter(({ label, kind }) => kind === 'prompt' && /\/(tabs|crlf|trailing-lf)-(plain|frame)$/.test(label))
    .map((native) => {
      const name = native.label.slice(native.label.indexOf('/') + 1)
      const shape = name.replace(/-(plain|frame)$/, '') as keyof typeof inputs
      const input = inputs[shape]
      const framed = name.endsWith('-frame')
      if (!input || native.texts.length !== 1) throw new Error(`missing measured input ${lane}/${native.label}`)
      const recorded = native.texts[0]!
      const text = framed ? `[podium message ${input.id} · from agent · to you]\n${input.body}\n[end podium message ${input.id}]` : input.body
      return { lane, ...input, shape, framed, text, native, recorded }
    })
}
const terminal = ['opencode-terminal', 'opencode2-terminal'].flatMap(measurements)
const api = ['opencode-v1', 'opencode-v2', 'opencode2-v2'].flatMap(measurements)
type Measured = typeof terminal[number]
const changed = terminal.filter(({ lane, text, recorded }) => lane === 'opencode-terminal' && text !== recorded)
const plain = changed.filter(({ framed }) => !framed)

function nativeRow(measured: Measured, text = measured.recorded) {
  const raw = measured.native.raw
  if (!raw.message_id) throw new Error('receipt regression requires a native v1 part row')
  return {
    messageId: raw.message_id, partId: raw.id, sessionId: raw.session_id,
    timeCreated: raw.time_created, timeUpdated: raw.time_updated,
    messageData: JSON.stringify({ role: 'user' }),
    // Preserve the native JSON on the successful path; controls alter only the reported text.
    partData: text === measured.recorded ? raw.data : JSON.stringify({ type: 'text', text }),
  }
}

describe('OpenCode expanded terminal input (POD-4984)', () => {
  it.each(terminal)('$lane $native.label matches the measured stored bytes', (measured) => {
    const { native, text, recorded, shape, framed } = measured
    expect(JSON.parse(native.raw.data).text).toBe(recorded)
    if (shape === 'crlf') {
      expect(Buffer.byteLength(text)).toBe(framed ? 196 : 52)
      expect(Buffer.byteLength(recorded)).toBe(
        (framed ? 194 : 50) + (native.label.startsWith('paste/') ? 1 : 0),
      )
    }
    if (shape === 'tabs') {
      expect(Buffer.byteLength(text)).toBe(framed ? 179 : 35)
      expect(Buffer.byteLength(recorded)).toBe(native.label.startsWith('typed/')
        ? (framed ? 176 : 32) : (framed ? 180 : 35))
    }
    if (framed) expect(podiumFrameId(recorded)).toBe(measured.id)
    expect(opencodePromptTextMatches(text, recorded)).toBe(true)
  })

  it.each(api)('$lane $native.label retains the exact API input', (measured) => {
    const { native, text, recorded } = measured
    expect(JSON.parse(native.raw.data).text).toBe(text)
    expect(recorded).toBe(text)
    expect(opencodePromptTextMatches(text, recorded)).toBe(true)
    if (native.raw.message_id) {
      expect(opencodePartToItems(nativeRow(measured))[0]?.text).toBe(text)
    }
  })

  it.each([
    ['LF to CRLF', 'one\ntwo', 'one\r\ntwo'],
    ['tab insertion', 'onetwo', 'one\ttwo'],
    ['tab expansion', 'one\ttwo', 'one    two'],
    ['partial tab removal', 'one\ttwo\tthree', 'onetwo\tthree'],
    ['tab removal with paste space', 'one\ttwo', 'onetwo '],
    ['partial CRLF conversion', 'one\r\ntwo\r\nthree', 'one\ntwo\r\nthree'],
    ['bare CR conversion', 'one\rtwo', 'one\ntwo'],
    ['CR deletion', 'one\rtwo', 'onetwo'],
    ['LF deletion', 'one\ntwo', 'onetwo'],
    ['space deletion', 'one  two', 'one two'],
    ['leading space deletion', ' one\r\ntwo', 'one\ntwo '],
    ['extra paste space', 'one\r\ntwo', 'one\ntwo  '],
    ['CRLF conversion with tab removal', 'one\t\r\ntwo', 'one\ntwo'],
    ['empty after tab removal', '\t', ''],
  ])('rejects unmeasured %s', (_name, submitted, recorded) => {
    expect(opencodePromptTextMatches(submitted, recorded)).toBe(false)
  })
})

function shippedProfile(): TerminalHarnessProfile {
  const manifest = manifestFor('opencode')!
  const terminal = manifest.runtime.terminal
  const interrupt = harnessInterrupt('opencode')
  return {
    ...terminal,
    composerReadiness: manifest.capabilities.composerReadiness,
    instrumentationRequired: declaredValue(manifest.instrumentation) !== undefined,
    needsSubmitVerification: harnessNeedsSubmitVerification('opencode'),
    usesRawFirstTurn: harnessUsesRawFirstTurn('opencode'),
    archivable: declaredValue(manifest.handoffTranscript) !== undefined,
    reportsContextPercent: manifest.capabilities.observationProvider !== 'none',
    interruptBytes: interrupt.bytes, interruptQuitsWhenIdle: interrupt.quitsWhenIdle,
  }
}

/** Real driver, reader and profile; only terminal writes and time are virtual. */
async function receiptFor(measured: Measured, control: { foreign?: boolean; replay?: boolean; recorded?: string } = {}) {
  const sessionId = asSessionId('50040000-0000-4000-8000-000000000001')
  const id = measured.framed ? measured.id : 'msg_5004a'
  const items = stampOpencodeItems([nativeRow(measured, control.recorded)], measured.native.raw.session_id)
  let foreign = 0
  const marks = new Map<string, number>()
  const writes: string[] = []
  const submitted: string[] = []
  let pasted: string | undefined
  let runtime!: ReturnType<typeof createTerminalRuntime>
  const transport: TerminalTransport = {
    live: true,
    writeBase64(data, role) {
      if (role !== 'message') foreign += 1
      const text = Buffer.from(data, 'base64').toString('utf8')
      writes.push(text)
      if (text.startsWith('\x1b[200~') && text.endsWith('\x1b[201~')) pasted = text.slice(6, -6)
      if (text !== '\r' || pasted === undefined) return
      submitted.push(pasted)
      pasted = undefined
      // Assert that typing actually armed the attribution boundary before the echo.
      expect(marks.get(id)).toBe(0)
      if (control.foreign) transport.writeBase64(Buffer.from('x').toString('base64'))
      runtime.observe({ type: 'transcriptDelta', sessionId, items })
    },
  }
  const host: TerminalHostPorts = {
    foreignWrites: {
      count: () => foreign, orderTrustworthy: () => true,
      markTyping: (_session, turnId) => { marks.set(turnId, foreign) },
      typingMark: (_session, turnId) => marks.get(turnId),
    },
    send: () => {}, installInstrumentation: async () => ({ args: [] }),
    stageAttachment: async () => { throw new Error('no attachment in this regression') },
    trackedState: () => ({ phase: 'idle', since: new Date(Date.now() - 10_000).toISOString(), nativeSubagentCount: 0 }),
    draftSyncing: () => false, setDraftTarget: () => false,
    observationLease: () => undefined, recover: async () => ({ terminal: transport, announce: () => {} }),
    stopSession: async () => true, launch: async () => ({ announce: () => {} }),
    readHistory: async () => ({ items: [], hasMore: false }),
    archiveTranscript: async () => { throw new Error('no archive in this regression') },
    readArchiveBytes: async () => new Uint8Array(), resources: () => undefined,
    now: Date.now, setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
  vi.setSystemTime(measured.native.raw.time_created - 6000)
  runtime = createTerminalRuntime(host, undefined, createMemoryDriverSlots())
  try {
    const handle = runtime.register({
      sessionId, agentKind: 'opencode', cwd: '/repo', terminal: transport,
      resume: { kind: 'opencode-session', value: measured.native.raw.session_id },
    }, shippedProfile())
    runtime.observe({ type: 'bind', sessionId, cmd: 'opencode', cwd: '/repo', agentKind: 'opencode' })
    vi.setSystemTime(measured.native.raw.time_created)
    runtime.observe({
      type: 'transcriptDelta', sessionId, reset: true,
      items: control.replay ? items : [{
        id: 'baseline', role: 'user', text: 'earlier turn',
        cursor: encodeCursor({ fileId: `opencode:${measured.native.raw.session_id}`, offset: measured.native.raw.time_created - 1, uuid: 'baseline', sub: 0 }),
      }],
    })
    const pending = handle.send({ id, text: measured.text }, { origin: measured.framed ? 'mail' : 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(6000)
    // The paste codec canonicalizes CRLF on the wire. The send starts with
    // the original measured bytes; tabs stay on the wire.
    const wireText = measured.text.replace(/\r\n/g, '\n')
    expect(submitted).toEqual([wireText])
    expect(writes.slice(0, 2)).toEqual([`\x1b[200~${wireText}\x1b[201~`, '\r'])
    return { receipt: await pending, item: items[0]! }
  } finally { runtime.dispose() }
}

describe('OpenCode measured terminal receipts', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it.each(plain)('$native.label confirms the arrived plain message', async (measured) => {
    const { receipt, item } = await receiptFor(measured)
    expect(receipt).toMatchObject({ outcome: 'accepted', provenBy: 'transcript-echo', transcriptItem: { id: item.id, cursor: item.cursor } })
  })

  it.each(changed.filter(({ framed }) => framed))('$native.label confirms its frame after a foreign write', async (measured) => {
    const { receipt, item } = await receiptFor(measured, { foreign: true })
    expect(receipt).toMatchObject({ outcome: 'accepted', provenBy: 'transcript-echo', transcriptItem: { id: item.id, cursor: item.cursor } })
  })

  it.each(plain)('$native.label confirms plain text after a foreign write', async (measured) => {
    const { receipt, item } = await receiptFor(measured, { foreign: true })
    expect(receipt).toMatchObject({ outcome: 'accepted', provenBy: 'transcript-echo', transcriptItem: { id: item.id, cursor: item.cursor } })
  })

  it.each(plain)('$native.label cannot confirm a replayed entry', async (measured) => {
    expect((await receiptFor(measured, { replay: true })).receipt.outcome).toBe('unverified')
  })

  it('cannot confirm a CRLF paste with an extra space', async () => {
    const measured = plain.find(({ native }) => native.label === 'paste/crlf-plain')!
    expect((await receiptFor(measured, { recorded: `${measured.recorded} ` })).receipt.outcome).toBe('unverified')
  })
})
