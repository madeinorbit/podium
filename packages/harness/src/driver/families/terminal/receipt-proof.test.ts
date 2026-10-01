import { afterEach, describe, expect, it, vi } from 'vitest'
import { asSessionId, type TranscriptItem } from '@podium/model'
import { manifestFor } from '../../../registry.js'
import { pageHistory } from '../../history.js'
import { createMemoryDriverSlots } from '../../testing/driver-slots.js'
import { createTerminalRuntime, type TerminalHarnessProfile } from './runtime.js'
import type { TerminalHostPorts, TerminalProofWatch } from './host-ports.js'

const SESSION = asSessionId('receipt-restart')
const START = Date.parse('2026-10-01T08:19:35Z')
const outcomes = (frames: import('@podium/protocol/daemon').DaemonMessage[]) => frames.flatMap((frame) =>
  frame.type === 'runtimeEvent' && frame.event.t === 'delivery' ? [frame.event] : [])

function world(kind: 'claude-code' | 'codex' | 'grok' | 'opencode' = 'claude-code',
  saved = new Map<string, TerminalProofWatch>(), history: TranscriptItem[] = []) {
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
    const pending = w.handle.send({ rowId: 'msg-restart', text: 'Yes' }, { origin: 'human', delivery: 'when-ready' })
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
      { id: 'old-yes', role: 'user', text: 'Yes', ts: new Date(START - 1).toISOString() },
      { id: 'offline-yes', role: 'user', text: 'Yes', ts: new Date(START + 120_000).toISOString() },
    ]
    const w = world('claude-code', saved, history)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.writes).toEqual([])
    expect(outcomes(w.frames)).toContainEqual(expect.objectContaining({ outcome: 'delivered', transcriptItem: { id: 'offline-yes' } }))
    w.runtime.dispose()
  })
})
