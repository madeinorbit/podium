import { afterEach, describe, expect, it, vi } from 'vitest'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { manifestFor } from '../../../registry.js'
import { pageHistory } from '../../history.js'
import { encodeCursor } from '../../../store/cursor-codec.js'
import { createMemoryDriverSlots } from '../../testing/driver-slots.js'
import { createTerminalRuntime, type TerminalHarnessProfile } from './runtime.js'
import type { TerminalHostPorts, TerminalProofWatch } from './host-ports.js'

const SESSION = asSessionId('receipt-restart')
const START = Date.parse('2026-10-01T08:19:35Z')
const outcomes = (frames: import('@podium/protocol/daemon').DaemonMessage[]) => frames.flatMap((frame) =>
  frame.type === 'runtimeEvent' && frame.event.t === 'delivery' ? [frame.event] : [])

function world(kind: 'claude-code' | 'codex' | 'grok' | 'opencode' = 'claude-code',
  saved = new Map<string, TerminalProofWatch>(), history: TranscriptItem[] = [],
  profileOverrides: Partial<TerminalHarnessProfile> = {}) {
  const frames: import('@podium/protocol/daemon').DaemonMessage[] = []
  const writes: string[] = []
  let count = 0
  const terminal = { live: true, writeBase64(data: string, role?: string) {
    if (role !== 'message') count++
    writes.push(Buffer.from(data, 'base64').toString('utf8'))
  } }
  const host: TerminalHostPorts = {
    send: (frame) => { frames.push(frame) },
    now: () => Date.now(), setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    foreignWrites: { count: () => count, orderTrustworthy: () => false,
      markTyping: () => {}, typingMark: () => 0 },
    proofWatches: {
      load: async () => [...saved.values()],
      save: async (_session, watch) => { saved.set(watch.turnId, structuredClone(watch)) },
      remove: async (_session, turnId) => { saved.delete(turnId) },
    },
    trackedState: () => ({ phase: 'idle', since: new Date(START).toISOString(), nativeSubagentCount: 0 }),
    draftSyncing: () => false, setDraftTarget: () => false,
    processAlive: async () => true, recover: async () => {}, stopSession: async () => true,
    installInstrumentation: async () => ({ args: [] }), launch: async () => {},
    stageAttachment: async () => { throw new Error('no attachments') },
    readHistory: async (_session, range) => pageHistory(history, SESSION, range),
    archiveTranscript: async () => { throw new Error('no archive') },
    readArchiveBytes: async () => new Uint8Array(), resources: () => ({ oomKills: 0 }),
  }
  const runtime = createTerminalRuntime(host, undefined, createMemoryDriverSlots())
  const manifest = manifestFor(kind)!
  const spec = manifest.runtime.terminal
  const profile: TerminalHarnessProfile = {
    ...spec, composerReadiness: 'on-bind', instrumentationRequired: false,
    needsSubmitVerification: false, usesRawFirstTurn: false,
    archivable: false, reportsContextPercent: false,
    interruptBytes: '\x1b', interruptQuitsWhenIdle: false,
    ...profileOverrides,
  }
  const handle = runtime.register({ sessionId: SESSION, agentKind: kind, cwd: '/tmp/receipt',
    resume: { kind: manifest.resumeKind!, value: 'same-conversation' }, terminal, rebind: true }, profile)
  const now = Date.now()
  vi.setSystemTime(now - 6000)
  runtime.observe({ type: 'bind', sessionId: SESSION, cmd: kind, cwd: '/tmp/receipt', agentKind: kind })
  vi.setSystemTime(now)
  const post = (text: string, extra: Partial<TranscriptItem> = {}) => {
    const item = { id: `entry-${history.length}`, role: 'user' as const, text,
      ts: new Date(Date.now()).toISOString(), ...extra }
    history.push(item)
    runtime.observe({ type: 'transcriptDelta', sessionId: SESSION, items: [item] })
  }
  return { runtime, handle, frames, writes, saved, history, terminal, post, count: () => count }
}

afterEach(() => vi.useRealTimers())
describe('terminal receipt operator regressions', () => {
  it.each(['\x1b[I', 'terminal attach'])('focus/attach write %j retains order credit (POD-4286-A and POD-4720-A)', async (foreign) => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const pending = w.handle.send({ id: 'msg-live', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes).toContain('\r') // the real send and its watch were armed
    w.terminal.writeBase64(Buffer.from(foreign).toString('base64'))
    expect(w.count()).toBeGreaterThan(0)
    w.post('Yes')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ outcome: 'accepted', transcriptItem: { id: 'entry-0' } })
    w.runtime.dispose()
  })

  it.each(['claude-code', 'codex', 'grok'] as const)('%s hook links a differently recorded text only through its saved id', async (kind) => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world(kind)
    const pending = w.handle.send({ id: 'msg-hook', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes).toContain('\r')
    w.runtime.onHookPayload(SESSION, { hook_event_name: 'UserPromptSubmit', hookEventName: 'UserPromptSubmit',
      prompt: 'Yes', prompt_id: 'native-id', promptId: 'native-id', turn_id: 'native-id' })
    await Promise.resolve()
    expect(outcomes(w.frames)).toEqual([]) // a hook by itself is never proof
    const ref = { kind: kind === 'claude-code' ? 'claude-prompt' : kind === 'codex' ? 'codex-turn' : 'grok-prompt', id: 'native-id' }
    w.post('program expanded this text', { harnessRef: [ref] })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ outcome: 'accepted', transcriptItem: { id: 'entry-0' }, harnessRef: [ref] })
    w.runtime.dispose()
  })

  it.each(['same-cursor', 'coarse-timestamp', 'missing-timestamp', 'new-segment'] as const)(
    'a known pre-typing prompt cannot credit a replay with %s, or spend the later-prompt budget', async (replay) => {
      vi.useFakeTimers(); vi.setSystemTime(START)
      const w = world('opencode', new Map(), [], { transcriptTimestamps: { resolutionMs: replay === 'coarse-timestamp' ? 1000 : 1 } })
      const cursor = (fileId: string, offset: number) => encodeCursor({ fileId, offset, uuid: 'old-prompt', sub: 0 })
      const old: Partial<TranscriptItem> = { id: 'old-prompt',
        ts: replay === 'missing-timestamp' ? undefined : new Date(START).toISOString(), cursor: cursor('before', 100) }
      w.post('Yes', old)
      if (replay === 'coarse-timestamp') vi.setSystemTime(START + 500)
      const pending = w.handle.send({ id: 'msg-replayed', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
      await vi.advanceTimersByTimeAsync(300)
      expect(w.writes).toContain('\r')
      // A rewrite may move the record or segment; native identity stays old.
      for (let i = 0; i < 5; i++) w.post('Yes', { ...old,
        cursor: cursor(replay === 'new-segment' ? 'after' : 'before', replay === 'same-cursor' ? 100 : 200 + i) })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toMatchObject({ outcome: 'unverified' })
      expect(w.saved.has('msg-replayed')).toBe(true)
      w.post('Yes', { id: 'genuine-new-prompt', cursor: cursor('after', 300) })
      await vi.advanceTimersByTimeAsync(0)
      expect(outcomes(w.frames)).toContainEqual(expect.objectContaining({ rowId: 'msg-replayed', outcome: 'delivered', transcriptItem: expect.objectContaining({ id: 'genuine-new-prompt' }) }))
      w.runtime.dispose()
    },
  )

  it('a linked prompt still spends the first-entry order of another open send', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const linked = w.handle.send({ id: 'msg-linked', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    const other = w.handle.send({ id: 'msg-other', text: 'Later' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes.filter((bytes) => bytes === '\r')).toHaveLength(2)
    w.runtime.onHookPayload(SESSION, { hook_event_name: 'UserPromptSubmit', prompt: 'Yes', prompt_id: 'linked-id' })
    w.post('expanded prompt', { harnessRef: [{ kind: 'claude-prompt', id: 'linked-id' }] })
    w.post('Later')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await linked).toMatchObject({ outcome: 'accepted' })
    expect(await other).toMatchObject({ outcome: 'unverified' })
    w.runtime.dispose()
  })

  it('framed prompt entries do not spend an unwrapped send\u2019s order (this issue)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const frame = (id: string, body: string) =>
      `[podium message ${id} · from agent · to you]\n${body}\n[end podium message ${id}]`
    const idA = 'msg_11111111-2222-3333-4444-555555555555'
    const idB = 'msg_22222222-3333-4444-5555-666666666666'
    const framedA = frame(idA, 'first framed body')
    const framedB = frame(idB, 'second framed body')
    const words = 'the update is failing when applying to ludovico. figure out why'
    // Two framed mails are typed first, then our unwrapped words; Claude was
    // busy, so all three prompts are recorded together after our typing
    // started, framed first, ours last verbatim.
    const sentA = w.handle.send({ id: idA, text: framedA }, { origin: 'mail', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    const sentB = w.handle.send({ id: idB, text: framedB }, { origin: 'mail', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    const ours = w.handle.send({ id: 'msg_d0117333', text: words }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes.filter((bytes) => bytes === '\r')).toHaveLength(3)
    w.post(framedA)
    w.post(framedB)
    w.post(words)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await sentA).toMatchObject({ outcome: 'accepted' })
    expect(await sentB).toMatchObject({ outcome: 'accepted' })
    expect(await ours).toMatchObject({ outcome: 'accepted' })
    w.runtime.dispose()
  })

  it('four framed mails ahead do not pass an unwrapped send (POD-5436)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const frame = (id: string, body: string) =>
      `[podium message ${id} · from agent · to you]\n${body}\n[end podium message ${id}]`
    const ids = [
      'msg_11111111-2222-3333-4444-555555555555',
      'msg_22222222-3333-4444-5555-666666666666',
      'msg_33333333-4444-5555-6666-777777777777',
      'msg_44444444-5555-6666-7777-888888888888',
    ]
    const framed = ids.map((id, i) => frame(id, `framed body ${i + 1}`))
    const words = 'the update is failing when applying to ludovico. figure out why'
    // Four of our own mails queued ahead of a person's message: all five
    // prompts are recorded after the unwrapped watch started, framed first,
    // ours last verbatim. The framed entries are provably other Podium sends,
    // so they must not count toward the unwrapped watch's later-prompt budget.
    const sents = []
    for (let i = 0; i < framed.length; i++) {
      sents.push(w.handle.send({ id: ids[i]!, text: framed[i]! }, { origin: 'mail', delivery: 'when-ready' }))
      await vi.advanceTimersByTimeAsync(300)
    }
    const ours = w.handle.send({ id: 'msg_d0117333', text: words }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes.filter((bytes) => bytes === '\r')).toHaveLength(5)
    for (const text of framed) w.post(text)
    w.post(words)
    await vi.advanceTimersByTimeAsync(10_000)
    for (const sent of sents) expect(await sent).toMatchObject({ outcome: 'accepted' })
    expect(await ours).toMatchObject({ outcome: 'accepted' })
    w.runtime.dispose()
  })

  it('four foreign entries still pass an unwrapped send (POD-5436 control)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const words = 'the update is failing when applying to ludovico. figure out why'
    const ours = w.handle.send({ id: 'msg_d0117333', text: words }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes).toContain('\r')
    // Unexplained prompts are evidence the history moved past the send: after
    // four of them the watch passes, so a later verbatim entry cannot confirm.
    w.post('foreign one')
    w.post('foreign two')
    w.post('foreign three')
    w.post('foreign four')
    w.post(words)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await ours).toMatchObject({ outcome: 'unverified' })
    w.runtime.dispose()
  })

  it('a re-read of an entry credited elsewhere does not spend our order (POD-5436)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const words = 'the update is failing when applying to ludovico. figure out why'
    const other = w.handle.send({ id: 'msg_other-first', text: 'First' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    const ours = w.handle.send({ id: 'msg_d0117333', text: words }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes.filter((bytes) => bytes === '\r')).toHaveLength(2)
    // 'First' credits the other watch, which resolves and is removed. Ours
    // records it (dedupe) without spending order or budget.
    w.post('First', { id: 'reread-first' })
    // A history re-check delivers the same items again: the duplicate must be
    // deduped, not treated as a new foreign entry that spends our order.
    w.post('First', { id: 'reread-first' })
    w.post(words)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await other).toMatchObject({ outcome: 'accepted' })
    expect(await ours).toMatchObject({ outcome: 'accepted' })
    w.runtime.dispose()
  })

  it('framed queue records do not spend an unwrapped send\u2019s queue order (this issue)', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const frame = (id: string, body: string) =>
      `[podium message ${id} · from agent · to you]\n${body}\n[end podium message ${id}]`
    const idA = 'msg_11111111-2222-3333-4444-555555555555'
    const idB = 'msg_22222222-3333-4444-5555-666666666666'
    const framedA = frame(idA, 'first framed body')
    const framedB = frame(idB, 'second framed body')
    const words = 'the update is failing when applying to ludovico. figure out why'
    const sentA = w.handle.send({ id: idA, text: framedA }, { origin: 'mail', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    const sentB = w.handle.send({ id: idB, text: framedB }, { origin: 'mail', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    const ours = w.handle.send({ id: 'msg_d0117333', text: words }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes.filter((bytes) => bytes === '\r')).toHaveLength(3)
    // All three queue records arrive after our typing started, framed first,
    // ours last verbatim: ours must still be held.
    w.post(framedA, { id: '', role: 'system', queued: true, promptEntry: false })
    w.post(framedB, { id: '', role: 'system', queued: true, promptEntry: false })
    w.post(words, { id: '', role: 'system', queued: true, promptEntry: false })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await sentA).toMatchObject({ outcome: 'accepted', held: 'memory' })
    expect(await sentB).toMatchObject({ outcome: 'accepted', held: 'memory' })
    expect(await ours).toMatchObject({ outcome: 'accepted', held: 'memory' })
    w.runtime.dispose()
  })

  it('keeps empty-id queue/drop records distinct and ordered within one native record', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const cursor = (offset: number, sub: number) => encodeCursor({ fileId: 'proof-only', offset, uuid: null, sub })
    w.post('older queued prompt', { id: '', role: 'system', queued: true, promptEntry: false, cursor: cursor(0, 0) })
    w.post('informational display item', { id: 'display', role: 'assistant', cursor: cursor(10, 0) })
    const pending = w.handle.send({ id: 'msg-queue-drop', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes).toContain('\r')
    w.post('Yes', { id: '', role: 'system', queued: true, promptEntry: false, cursor: cursor(10, 1) })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ outcome: 'accepted', held: 'memory' })
    w.post('Yes', { id: '', role: 'system', dropped: true, promptEntry: false, cursor: cursor(10, 2) })
    await vi.advanceTimersByTimeAsync(0)
    expect(outcomes(w.frames)).toContainEqual(expect.objectContaining({ rowId: 'msg-queue-drop', outcome: 'failed', cause: 'dropped-by-agent' }))
    expect(w.saved.has('msg-queue-drop')).toBe(false)
    w.runtime.dispose()
  })

  it('links a saved prompt even when the history tail arrives before its timely hook', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const pending = w.handle.send({ id: 'msg-history-first', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes).toContain('\r')
    const harnessRef = [{ kind: 'claude-prompt', id: 'history-first' }]
    w.post('expanded recorded text', { harnessRef })
    await vi.advanceTimersByTimeAsync(100)
    w.runtime.onHookPayload(SESSION, { hook_event_name: 'UserPromptSubmit', prompt: 'Yes', prompt_id: 'history-first' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ outcome: 'accepted', harnessRef })
    w.runtime.dispose()
  })

  it.each(['wrong-text', 'late-hook', 'before-enter', 'wrong-id'] as const)('does not infer proof from %s', async (fault) => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const pending = w.handle.send({ id: 'msg-negative', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(fault === 'before-enter' ? 0 : fault === 'late-hook' ? 1800 : 300)
    w.runtime.onHookPayload(SESSION, { hook_event_name: 'UserPromptSubmit',
      prompt: fault === 'wrong-text' ? 'No' : 'Yes', prompt_id: 'native-id' })
    w.post('different recorded text', { harnessRef: [{ kind: 'claude-prompt', id: fault === 'wrong-id' ? 'other' : 'native-id' }] })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ outcome: 'unverified' })
    w.runtime.dispose()
  })

  it('falls back to order plus text when the hook names the running turn, keeping the saved prompt id', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const pending = w.handle.send({ id: 'msg-fallback', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes).toContain('\r')
    w.runtime.onHookPayload(SESSION, { hook_event_name: 'UserPromptSubmit', prompt: 'Yes', prompt_id: 'running-turn' })
    w.post('Yes', { harnessRef: [{ kind: 'claude-prompt', id: 'saved-prompt' }] })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ outcome: 'accepted', harnessRef: [{ kind: 'claude-prompt', id: 'saved-prompt' }] })
    w.runtime.dispose()
  })

  it('re-arms after a daemon restart and confirms an entry recorded two minutes after typing', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    // The daemon forwards the durable message id as both turn id and row id.
    const pending = w.handle.send({ id: 'msg-restart', rowId: 'msg-restart', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ outcome: 'queued' })
    expect(w.writes).toContain('\r')
    expect(w.saved.get('msg-restart')?.typingStartedAt).toBe(new Date(START).toISOString())
    expect(outcomes(w.frames)).toContainEqual(expect.objectContaining({ outcome: 'failed', cause: 'unconfirmed' }))
    w.runtime.dispose()
    await vi.advanceTimersByTimeAsync(110_000)
    const restarted = world('claude-code', w.saved, w.history)
    await vi.advanceTimersByTimeAsync(0)
    expect(restarted.writes).toEqual([]) // recovery watches; it never retypes
    restarted.post('Yes')
    await vi.advanceTimersByTimeAsync(0)
    expect(outcomes(restarted.frames)).toContainEqual(expect.objectContaining({ rowId: 'msg-restart', outcome: 'delivered' }))
    restarted.runtime.dispose()
  })

  it.each(['fifth-entry', '31-minutes'] as const)('leaves an exhausted restarted watch unknown at %s', async (limit) => {
    vi.useFakeTimers(); vi.setSystemTime(START + (limit === '31-minutes' ? 31 * 60_000 : 120_000))
    const saved = new Map([['msg-expired', { turnId: 'msg-expired', text: '[podium message msg_a · from agent · to you]\nYes\n[end podium message msg_a]',
      typingStartedAt: new Date(START).toISOString() }]])
    const w = world('claude-code', saved)
    await vi.advanceTimersByTimeAsync(0)
    if (limit === 'fifth-entry') for (let i = 0; i < 4; i++) w.post(`later ${i}`)
    w.post(saved.get('msg-expired')?.text ?? '[podium message msg_a · from agent · to you]\nYes\n[end podium message msg_a]')
    await vi.advanceTimersByTimeAsync(0)
    expect(outcomes(w.frames).filter((ev) => ev.outcome === 'delivered')).toEqual([])
    w.runtime.dispose()
  })

  it('keeps a program-proven failure final through a daemon restart', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START)
    const w = world()
    const pending = w.handle.send({ id: 'msg-failed', rowId: 'msg-failed', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
    await vi.advanceTimersByTimeAsync(300)
    expect(w.writes).toContain('\r')
    w.post('Yes', { dropped: true, promptEntry: false })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ outcome: 'queued' })
    expect(outcomes(w.frames)).toContainEqual(expect.objectContaining({ rowId: 'msg-failed', outcome: 'failed', cause: 'dropped-by-agent' }))
    expect(w.saved.has('msg-failed')).toBe(false)
    w.runtime.dispose()
    const restarted = world('claude-code', w.saved, w.history)
    await vi.advanceTimersByTimeAsync(0)
    restarted.post('Yes')
    await vi.advanceTimersByTimeAsync(0)
    expect(outcomes(restarted.frames)).toEqual([])
    restarted.runtime.dispose()
  })

  it('a fourth entry still proves a restarted watch, and re-reading one entry does not consume its budget', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START + 120_000)
    const text = '[podium message msg_a · from agent · to you]\nYes\n[end podium message msg_a]'
    const saved = new Map([['msg-budget', { turnId: 'msg-budget', text, typingStartedAt: new Date(START).toISOString() }]])
    const w = world('claude-code', saved)
    await vi.advanceTimersByTimeAsync(0)
    expect(saved.has('msg-budget')).toBe(true)
    w.post('foreign one', { id: 'same-entry' })
    w.post('foreign one', { id: 'same-entry' })
    w.post('foreign two')
    w.post('foreign three')
    expect(saved.has('msg-budget')).toBe(true)
    w.post(text)
    await vi.advanceTimersByTimeAsync(0)
    expect(outcomes(w.frames)).toContainEqual(expect.objectContaining({ rowId: 'msg-budget', outcome: 'delivered' }))
    w.runtime.dispose()
  })

  it('recovers a prompt saved while the daemon was down, using time rather than the current tail position', async () => {
    vi.useFakeTimers(); vi.setSystemTime(START + 125_000)
    const saved = new Map([['msg-offline', { turnId: 'msg-offline', text: 'Yes', typingStartedAt: new Date(START).toISOString() }]])
    const history: TranscriptItem[] = [
      { id: 'old-yes', role: 'user', text: 'Yes', ts: new Date(START - 1).toISOString(), cursor: encodeCursor({ fileId: 'recovered', offset: 1, uuid: 'old-yes', sub: 0 }) },
      { id: 'offline-yes', role: 'user', text: 'Yes', ts: new Date(START + 120_000).toISOString(), cursor: encodeCursor({ fileId: 'recovered', offset: 2, uuid: 'offline-yes', sub: 0 }) },
    ]
    const w = world('claude-code', saved, history)
    // The observer's bootstrap may run while recovery reads its saved floor.
    // Its current tail position must not replace that older typing-start time.
    w.runtime.observe({ type: 'transcriptDelta', sessionId: SESSION, items: history, reset: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(w.writes).toEqual([])
    expect(outcomes(w.frames)).toContainEqual(expect.objectContaining({ outcome: 'delivered', transcriptItem: expect.objectContaining({ id: 'offline-yes' }) }))
    w.runtime.dispose()
  })
})
